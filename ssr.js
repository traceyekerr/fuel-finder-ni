/**
 *  Author(s)   : rutht
 *  Created     : Thu Sep 17 14:02:11 BST 2026
 *
 *  Server-side rendering for the home page.
 *
 *  The map and the price list are built in the browser, so the HTML we served
 *  carried no prices at all: the stats bar read "—", the station list was an
 *  empty <div>, and the status line said "Connecting…". Anything reading the
 *  page without running JavaScript saw that shell — crawlers, link previews,
 *  and the AdSense content review among them.
 *
 *  These helpers fill those existing nodes in from the price cache before the
 *  HTML goes out. Nothing new is added to the page: the client script
 *  recomputes the same values and replaces the same nodes as soon as it has
 *  loaded, so this changes what the document *contains*, never what the
 *  finished page looks like. The logic below deliberately mirrors buildList()
 *  in public/index.html so the markup matches what the client would produce.
 */

// Mirrors BRAND_COLORS in public/index.html — keep the two in sync.
const BRAND_COLORS = {
  'BP':'#009900', 'SHELL':'#FFD500', 'ESSO':'#FF0000', 'TEXACO':'#E91414',
  'JET':'#C8102E', 'GULF':'#FF6600', 'MURCO':'#0066A6',
  'TESCO':'#00539F', 'ASDA':'#78BE20', 'MORRISONS':'#FFD700',
  "SAINSBURY'S":'#FF8000','SAINSBURYS':'#FF8000',
  'MAXOL':'#0050A0', 'SOLO':'#0050A0', 'GO':'#F37021',
  'APPLEGREEN':'#44A33B', 'CIRCLE K':'#E31837', 'TOPAZ':'#E24000',
  'NICHOLL OILS':'#C8102E', 'EMO':'#D50032',
  'SPAR':'#006B3F', 'EUROSPAR':'#006B3F', 'MACE':'#E60012',
  'CENTRA':'#E30613', 'VIVO':'#0068B3', 'VALERO':'#0046AD',
  'HENDERSON RETAIL':'#1F5F98', 'NISA':'#E30613',
  'MOTO':'#0066CC', 'WELCOME BREAK':'#E30613', 'ROADCHEF':'#00A4D5',
  'MFG':'#C8102E', 'ASCONA':'#00A651', 'RONTEC':'#004B87',
  'SGN':'#6B7280', 'HARVEST ENERGY':'#F7941D', 'EG GROUP':'#CC092F',
  'OTHER':'#6B7280',
};

const brandColor = b => BRAND_COLORS[(b || '').toUpperCase().trim()] || '#6B7280';

function brandTextColor(hex) {
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return '#fff';
  const lum = 0.299 * parseInt(h.slice(0, 2), 16)
            + 0.587 * parseInt(h.slice(2, 4), 16)
            + 0.114 * parseInt(h.slice(4, 6), 16);
  return lum > 145 ? '#000' : '#fff';
}

const fmtPrice = p => (p == null ? '—' : p.toFixed(1) + 'p');

const getPrice = (s, f) => {
  const p = (s.prices || []).find(x => x.fuelType === f);
  return p ? p.price : null;
};

const titleCase = s => {
  if (!s) return '';
  return s.toLowerCase()
    .replace(/\b(\w)/g, c => c.toUpperCase())
    .replace(/\bBp\b/g, 'BP')
    .replace(/\bUk\b/g, 'UK')
    .replace(/\bPfs\b/g, 'PFS')
    .replace(/\b([A-Z]{1,2}\d[A-Z\d]?)\s+(\d[A-Z]{2})\b/gi,
             (m, a, b) => `${a.toUpperCase()} ${b.toUpperCase()}`);
};

// Station names come from a public API, so escape before putting them in HTML.
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function percentileThresholds(prices) {
  if (prices.length === 0) return { p33: 0, p67: 0 };
  const sorted = [...prices].sort((a, b) => a - b);
  const pct = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return { p33: pct(0.33), p67: pct(0.67) };
}

function priceClass(p, t) {
  if (p <= t.p33) return 'price-cheap';
  if (p <= t.p67) return 'price-mid';
  return 'price-pricey';
}

function stationCard(s, p, i, thresholds) {
  const rank    = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-n';
  const colour  = brandColor(s.brand);
  const textCol = brandTextColor(colour);
  return `<div class="station-card" data-id="${esc(s.id)}">` +
      `<div class="brand-bar" style="background:${colour}"></div>` +
      `<div class="card-body">` +
        `<div class="rank-badge ${rank}">${i + 1}</div>` +
        `<div class="station-info">` +
          `<div class="station-name">` +
            `<span class="station-brand" style="background:${colour};color:${textCol}">${esc(s.brand)}</span>` +
            `${esc(titleCase(s.name))}` +
          `</div>` +
          `<div class="station-addr">${esc(titleCase(s.address))}</div>` +
        `</div>` +
        `<div class="price-pill ${priceClass(p, thresholds)}">${fmtPrice(p)}</div>` +
      `</div>` +
    `</div>`;
}

/**
 * Fill the home page's price nodes in from the cache.
 *
 * @param {string} html      the raw index.html
 * @param {object} cache     cachedData, or null when the cache is cold
 * @param {object} opts
 *   @param {string}   opts.regionNoun  e.g. "NI stations" — matches the client's status line
 *   @param {function} [opts.filter]    optional station filter (the NI site shows NI only)
 *   @param {string}   [opts.fuel]      fuel code to render; must match the tab marked active
 *   @param {number}   [opts.limit]     how many stations to render into the list
 * @returns {string} html — unchanged if there is nothing to render
 */
function renderHome(html, cache, opts = {}) {
  const { regionNoun = 'stations', filter = null, fuel = 'B7', limit = 20 } = opts;

  if (!cache || !Array.isArray(cache.stations) || cache.stations.length === 0) return html;

  const regional = filter ? cache.stations.filter(filter) : cache.stations;
  if (regional.length === 0) return html;

  const priced = regional
    .map(s => ({ s, p: getPrice(s, fuel) }))
    .filter(x => x.p != null)
    .sort((a, b) => a.p - b.p);

  if (priced.length === 0) return html;

  const prices = priced.map(x => x.p);
  const lo     = prices[0];
  const hi     = prices[prices.length - 1];
  const avg    = prices.reduce((a, b) => a + b, 0) / prices.length;

  const thresholds = percentileThresholds(prices);
  const cards = priced.slice(0, limit)
    .map((x, i) => stationCard(x.s, x.p, i, thresholds))
    .join('');

  // The map opens fitted to the whole region, so at first paint "in view" and
  // "total" are the same set — use the client's default wording either way.
  const countText = `${priced.length} station${priced.length !== 1 ? 's' : ''} in view`;

  const time = cache.fetchedAt
    ? new Date(cache.fetchedAt).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })
    : '';
  const statusText = `Live · ${regional.length} ${regionNoun} · ${time}`;

  return html
    .replace('id="stat-low">—</div>',   `id="stat-low">${fmtPrice(lo)}</div>`)
    .replace('id="stat-avg">—</div>',   `id="stat-avg">${fmtPrice(avg)}</div>`)
    .replace('id="stat-high">—</div>',  `id="stat-high">${fmtPrice(hi)}</div>`)
    .replace('<span id="station-count">Loading…</span>',
             `<span id="station-count">${countText}</span>`)
    .replace('<span id="data-label">Connecting…</span>',
             `<span id="data-label">${esc(statusText)}</span>`)
    .replace('<div id="station-list"></div>',
             `<div id="station-list">${cards}</div>`);
}

module.exports = { renderHome };
