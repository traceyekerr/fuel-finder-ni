/**
 * FuelWatch UK – Backend Proxy Server
 * ------------------------------------
 * - Exchanges Client ID + Secret for an OAuth token
 * - Fetches paginated PFS station metadata AND fuel prices
 * - Merges them and serves to the frontend
 */

require('dotenv').config();
const express = require('express');
const path    = require('path');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Env vars ────────────────────────────────────────────────
const CLIENT_ID     = process.env.FUEL_FINDER_CLIENT_ID;
const CLIENT_SECRET = process.env.FUEL_FINDER_CLIENT_SECRET;
const TOKEN_URL     = process.env.FUEL_FINDER_TOKEN_URL
  || 'https://www.fuel-finder.service.gov.uk/api/v1/oauth/generate_access_token';
const PFS_URL       = process.env.FUEL_FINDER_PFS_URL
  || 'https://www.fuel-finder.service.gov.uk/api/v1/pfs';
const PRICES_URL    = process.env.FUEL_FINDER_PRICES_URL
  || 'https://www.fuel-finder.service.gov.uk/api/v1/pfs/fuel-prices';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  Missing FUEL_FINDER_CLIENT_ID or FUEL_FINDER_CLIENT_SECRET in .env');
  process.exit(1);
}

// ── Caches ──────────────────────────────────────────────────
let cachedToken    = null;
let tokenExpiresAt = 0;
let cachedData     = null;
let cachedDataAt   = 0;
const DATA_CACHE_MS = 5 * 60 * 1000;

// ── HTTP helper ─────────────────────────────────────────────
// NOTE: The Fuel Finder API sits behind AWS CloudFront/WAF, which
// blocks requests without a proper User-Agent. We set browser-like
// headers on every request to avoid being filtered out.
const COMMON_HEADERS = {
  'User-Agent':      'FuelWatch-UK/1.0 (Node.js; contact admin@example.com)',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'identity', // disable gzip so we can read raw body easily
  'Origin':          'https://www.fuel-finder.service.gov.uk',
  'Referer':         'https://www.fuel-finder.service.gov.uk/',
};

// Optional extra API / subscription key (if your registration provided one)
const API_KEY = process.env.FUEL_FINDER_API_KEY;

function request(method, url, { headers = {}, body } = {}) {
  const mergedHeaders = { ...COMMON_HEADERS, ...headers };
  if (API_KEY) mergedHeaders['x-api-key'] = API_KEY;

  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method,
      headers:  mergedHeaders,
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── OAuth token ─────────────────────────────────────────────
async function fetchToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 120_000) return cachedToken;

  console.log('🔑  Fetching new OAuth token…');

  // Try standard form-encoded first
  const formBody = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  }).toString();

  let res = await request('POST', TOKEN_URL, {
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Accept':         'application/json',
      'Content-Length': Buffer.byteLength(formBody),
    },
    body: formBody,
  });

  // Fall back to JSON body if the endpoint expects that
  if (res.status >= 400) {
    console.log(`   Form-encoded → ${res.status}, retrying with JSON body…`);
    const jsonBody = JSON.stringify({
      grant_type:    'client_credentials',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    res = await request('POST', TOKEN_URL, {
      headers: {
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        'Content-Length': Buffer.byteLength(jsonBody),
      },
      body: jsonBody,
    });
  }

  if (res.status >= 400) {
    throw new Error(`Token endpoint returned ${res.status}: ${res.body.slice(0, 500)}`);
  }

  let data;
  try { data = JSON.parse(res.body); }
  catch { throw new Error(`Token endpoint returned non-JSON: ${res.body.slice(0, 200)}`); }

  // Some APIs nest the token under a "data" wrapper (like this one),
  // others return it at the root. Handle both.
  const payload = data.data || data;
  const token   = payload.access_token || payload.accessToken || payload.token;
  if (!token) throw new Error(`No token in response: ${JSON.stringify(data).slice(0, 300)}`);

  const expiresIn = payload.expires_in || payload.expiresIn || 3600;
  cachedToken    = token;
  tokenExpiresAt = Date.now() + expiresIn * 1000;

  console.log(`✅  Token obtained – expires in ${Math.round(expiresIn/60)} min`);
  return cachedToken;
}

// ── Paginated fetch ─────────────────────────────────────────
// Transient errors (504 gateway timeout, 502 bad gateway, 503 unavailable,
// network blips) are common when downloading 30+ batches in a row, so we
// retry each batch up to 3 times with exponential backoff (1s, 2s, 4s).
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchBatchWithRetry(url, token, batch, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await request('GET', url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
      },
    });

    // Success or clean "no more data" → return immediately
    if (res.status < 400 || res.status === 404 || res.status === 204) {
      return res;
    }

    // Transient errors → retry after a delay
    const isTransient = [502, 503, 504, 408, 429, 500].includes(res.status);
    if (!isTransient || attempt === maxAttempts) {
      // Give a readable error instead of a wall of HTML
      const snippet = res.body.slice(0, 200).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      throw new Error(`Batch ${batch} failed after ${attempt} attempt(s) – status ${res.status}: ${snippet || '(no body)'}`);
    }

    const wait = 1000 * Math.pow(2, attempt - 1);   // 1s, 2s, 4s…
    console.log(`   ⏳  Batch ${batch} returned ${res.status} (attempt ${attempt}/${maxAttempts}) – retrying in ${wait/1000}s…`);
    await sleep(wait);
    lastErr = res;
  }
  throw lastErr;
}

async function fetchAllBatches(baseUrl, token) {
  const all = [];
  const MAX_BATCHES = 200;

  for (let batch = 1; batch <= MAX_BATCHES; batch++) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}batch-number=${batch}`;

    const res = await fetchBatchWithRetry(url, token, batch);

    if (res.status === 404 || res.status === 204) break;

    let data;
    try { data = JSON.parse(res.body); }
    catch { throw new Error(`Non-JSON response from ${url}`); }

    // This API wraps responses as { success: true, data: { ... } }
    const payload = data.data || data;

    const items = payload.pfs
               || payload.stations
               || payload.fuelPrices
               || payload.prices
               || payload.data
               || payload.records
               || payload.items
               || (Array.isArray(payload) ? payload : null);

    if (!items || items.length === 0) break;
    all.push(...items);
    console.log(`   Batch ${batch}: ${items.length} records (total ${all.length})`);
  }

  return all;
}

// ── Merge metadata + prices ─────────────────────────────────
// Actual API shape (confirmed from live data):
//   STATION: { node_id, trading_name, brand_name, public_phone_number,
//              temporary_closure, permanent_closure,
//              location:{ address_line_1/2, city, county, country, postcode, latitude, longitude },
//              amenities:[], opening_times:{}, fuel_types:[] }
//   PRICE:   { node_id, trading_name, fuel_prices:[
//              { fuel_type:'E10'|'B7_STANDARD'|'B7_PREMIUM'|…, price:153.9,
//                price_last_updated, price_change_effective_timestamp } ] }

// Normalise the API's fuel-type codes to canonical ones the frontend uses.
// Grades currently supported by Fuel Finder: E10, E5, B7 Standard, B7 Premium,
//   B10, HVO.  (B10 and HVO were rolled out in April 2026.)
// Canonical codes the UI understands: E10, E5, B7, SDV (B7 Premium), B10, HVO
// NI counties come in many spellings: "ANTRIM", "Co Antrim", "County Antrim",
// "LONDONDERRY", "DERRY", etc.  Normalise to the canonical county name, or ''
// if we can't determine.  (Used for the sidebar county filter.)
function normaliseCounty(raw) {
  const c = (raw || '').toUpperCase().trim();
  if (c.includes('ANTRIM'))                             return 'Antrim';
  if (c.includes('ARMAGH'))                             return 'Armagh';
  if (c.includes('DOWN'))                               return 'Down';
  if (c.includes('FERMANAGH'))                          return 'Fermanagh';
  if (c.includes('LONDONDERRY') || c.includes('DERRY')) return 'Londonderry';
  if (c.includes('TYRONE'))                             return 'Tyrone';
  return '';
}

function normaliseFuelType(raw) {
  const ft = (raw || '').toUpperCase().trim();
  // Strip _STANDARD suffix — it's just the default grade
  let out = ft.replace(/_STANDARD$/, '');
  // B7_PREMIUM is "premium diesel" — map to canonical SDV
  if (out === 'B7_PREMIUM') out = 'SDV';
  return out;
}

// Brand names in the API are often entered inconsistently at forecourt
// registration — e.g. "Go Omagh", "Centra Go Service", "Nicholl", "Maxol
// Ballyholme".  Collapse these variants into a consistent display brand so
// all Go stations are tagged "GO", all Maxol stations "Maxol", etc.
function normaliseBrand(raw) {
  if (!raw) return 'Other';
  const b = raw.toUpperCase().trim();

  // Specific cleanups for messily-entered NI brands
  if (/\bNICHOLL\b/.test(b) || b.includes('NICHOLL'))   return 'Nicholl Oils';
  if (/\bMAXOL\b/.test(b))               return 'Maxol';
  if (/\bSOLO\b/.test(b))                return 'Solo';
  if (/\bGO\b/.test(b))                  return 'GO';
  if (/\bAPPLEGREEN\b/.test(b))          return 'Applegreen';
  if (/\bCIRCLE\s*K\b/.test(b))          return 'Circle K';
  if (/\bTOPAZ\b/.test(b))               return 'Topaz';
  if (/\bHENDERSON\b/.test(b))           return 'Henderson Retail';
  if (/\bCENTRA\b/.test(b))              return 'Centra';
  if (/\bSPAR\b/.test(b))                return 'Spar';
  if (/\bMACE\b/.test(b))                return 'Mace';
  if (/\bBP\b/.test(b))                  return 'BP';
  if (/\bSHELL\b/.test(b))               return 'Shell';
  if (/\bESSO\b/.test(b))                return 'Esso';
  if (/\bTEXACO\b/.test(b))              return 'Texaco';
  if (/\bJET\b/.test(b))                 return 'Jet';
  if (/\bTESCO\b/.test(b))               return 'Tesco';
  if (/\bASDA\b/.test(b))                return 'Asda';
  if (/\bMORRISONS?\b/.test(b))          return 'Morrisons';
  if (/\bSAINSBURY/.test(b))             return "Sainsbury's";

  // Fall back to Title Case of whatever was entered
  return raw.trim().replace(/\w\S*/g, w =>
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );
}

function mergeStationsWithPrices(stations, priceRecords) {
  // Collect raw fuel codes for diagnostics — logged once per fetch
  const rawFuelTypes = new Set();

  // Lookup: node_id → fuel_prices array
  const priceMap = {};
  for (const rec of priceRecords) {
    if (rec.node_id && Array.isArray(rec.fuel_prices)) {
      priceMap[rec.node_id] = rec.fuel_prices;
      rec.fuel_prices.forEach(p => p.fuel_type && rawFuelTypes.add(p.fuel_type));
    }
  }

  if (rawFuelTypes.size > 0) {
    console.log(`📊  Raw fuel codes in API: ${Array.from(rawFuelTypes).sort().join(', ')}`);
  }

  const out = stations
    // Drop closed stations
    .filter(s => !s.permanent_closure && !s.temporary_closure)
    // Require coords
    .filter(s => s.location?.latitude != null && s.location?.longitude != null)
    .map(s => {
      const loc      = s.location || {};
      const postcode = (loc.postcode || '').trim();
      const country  = (loc.country || '').toUpperCase();

      const rawPrices = priceMap[s.node_id] || [];
      const prices = rawPrices.map(p => ({
        fuelType:    normaliseFuelType(p.fuel_type),
        price:       p.price,
        lastUpdated: p.price_last_updated,
      })).filter(p => p.fuelType && p.price != null);

      return {
        id:        s.node_id,
        name:      s.trading_name || 'Unknown station',
        brand:     normaliseBrand(s.brand_name),
        address:   [loc.address_line_1, loc.address_line_2, loc.city, postcode.toUpperCase()]
                     .filter(Boolean).join(', '),
        postcode:  postcode.toUpperCase(),
        country:   loc.country || '',
        county:    normaliseCounty(loc.county),
        phone:     s.public_phone_number || null,
        amenities: s.amenities || [],
        openingTimes:  s.opening_times || null,
        isMotorway:    !!s.is_motorway_service_station,
        isSupermarket: !!s.is_supermarket_service_station,
        isNI:      country === 'NORTHERN IRELAND' || /^BT\d/i.test(postcode.replace(/\s+/g, '')),
        location:  { lat: loc.latitude, lng: loc.longitude },
        prices,
      };
    });

  // Log canonical fuel-type coverage, specifically for NI, so we can see
  // how many stations stock each fuel grade we're surfacing in the UI.
  const niStations = out.filter(s => s.isNI && s.prices.length > 0);
  const counts = { E10: 0, E5: 0, B7: 0, SDV: 0, B10: 0, HVO: 0 };
  niStations.forEach(s => s.prices.forEach(p => {
    if (counts[p.fuelType] !== undefined) counts[p.fuelType]++;
  }));
  console.log(`📊  NI fuel coverage:  E10=${counts.E10}  E5=${counts.E5}  B7=${counts.B7}  B7 Premium=${counts.SDV}  B10=${counts.B10}  HVO=${counts.HVO}`);

  // Count NI stations per county (helps verify county detection)
  const countyCounts = {};
  niStations.forEach(s => {
    const key = s.county || '(unknown)';
    countyCounts[key] = (countyCounts[key] || 0) + 1;
  });
  const countyLog = Object.entries(countyCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}=${n}`)
    .join('  ');
  console.log(`🗺️   NI county coverage:  ${countyLog}`);

  return out;
}

// ── Routes ──────────────────────────────────────────────────
// No-cache headers so browser always picks up latest HTML/JS
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma',        'no-cache');
    res.setHeader('Expires',       '0');
  },
}));

app.get('/api/prices', async (req, res) => {
  const t = new Date().toISOString().slice(11, 19); // HH:MM:SS
  try {
    // Serve from 5-min cache unless ?refresh=1
    if (!req.query.refresh && cachedData && (Date.now() - cachedDataAt) < DATA_CACHE_MS) {
      const ageSec = Math.round((Date.now() - cachedDataAt) / 1000);
      const freshIn = Math.round((DATA_CACHE_MS - (Date.now() - cachedDataAt)) / 1000);
      console.log(`[${t}] 📋  Served cached (${ageSec}s old, refresh available in ${freshIn}s) – ${cachedData.stations.length} stations`);
      return res.json(cachedData);
    }

    console.log(`\n[${t}] 🔄  Fetching fresh data from Fuel Finder…`);
    const token = await fetchToken();

    console.log('📥  Fetching station metadata…');
    const stations = await fetchAllBatches(PFS_URL, token);
    console.log(`   → ${stations.length} stations total`);

    console.log('💷  Fetching fuel prices…');
    const prices = await fetchAllBatches(PRICES_URL, token);
    console.log(`   → ${prices.length} price records total`);

    const merged     = mergeStationsWithPrices(stations, prices);
    const withPrices = merged.filter(s => s.prices.length > 0);

    cachedData = {
      stations:  withPrices,
      fetchedAt: new Date().toISOString(),
      counts: {
        total:      merged.length,
        withPrices: withPrices.length,
        ni:         withPrices.filter(s => s.isNI).length,
      },
    };
    cachedDataAt = Date.now();

    console.log(`📦  Served ${withPrices.length} stations (${cachedData.counts.ni} NI)\n`);
    res.json(cachedData);

  } catch (err) {
    console.error(`[${t}] ❌  /api/prices error:`, err.message);

    // If we have *any* cached data (even stale), serve that rather than failing outright
    if (cachedData) {
      const ageMin = Math.round((Date.now() - cachedDataAt) / 60000);
      console.log(`[${t}] 🛟  Serving stale cache (${ageMin} min old) as fallback`);
      return res.json({ ...cachedData, stale: true, error: err.message });
    }

    res.status(502).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    tokenCached:    !!(cachedToken && Date.now() < tokenExpiresAt),
    tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null,
    dataCached:     !!cachedData,
    dataFetchedAt:  cachedData?.fetchedAt,
    counts:         cachedData?.counts,
    urls: { token: TOKEN_URL, pfs: PFS_URL, prices: PRICES_URL },
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n⛽  FuelWatch UK running at http://localhost:${PORT}`);
  console.log(`    Client ID:   ${CLIENT_ID.slice(0, 8)}…`);
  console.log(`    Token URL:   ${TOKEN_URL}`);
  console.log(`    PFS URL:     ${PFS_URL}`);
  console.log(`    Prices URL:  ${PRICES_URL}\n`);
});
