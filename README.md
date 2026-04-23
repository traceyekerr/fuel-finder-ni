# ⛽ FuelWatch UK

Live UK fuel price map powered by the GOV.UK Fuel Finder API.

## Quick Start

### 1. Install Node.js
Download from https://nodejs.org (version 18 or higher).

### 2. Install dependencies
Open a terminal in this folder and run:
```
npm install
```

### 3. Add your credentials
Copy the example env file:
```
cp .env.example .env
```
Then open `.env` in a text editor and fill in your Client ID and Client Secret
from the GOV.UK Fuel Finder developer portal.

### 4. Start the server
```
npm start
```

### 5. Open the app
Go to http://localhost:3000 in your browser.

---

## How it works

```
Browser  →  Your Node.js server  →  GOV.UK Fuel Finder API
             (handles OAuth)
```

Your credentials never touch the browser. The server:
- Exchanges your Client ID + Secret for an OAuth 2.0 Bearer token
- Caches the token and auto-refreshes it before it expires
- Serves the live price data to your browser via `/api/prices`

## Hosting online

To make the site publicly accessible, you can deploy to:
- **Railway** (railway.app) – free tier available, easy Node.js deploy
- **Render** (render.com) – free tier, connect your GitHub repo
- **Fly.io** – free tier, Docker-based

Set your `FUEL_FINDER_CLIENT_ID` and `FUEL_FINDER_CLIENT_SECRET` as
environment variables in whichever platform you choose.

## Troubleshooting

**"Missing credentials" on startup**
→ Make sure you've created a `.env` file (not just `.env.example`)

**"Token endpoint returned 401"**
→ Double-check your Client ID and Secret are correct

**"Token endpoint returned 400"**
→ The token URL might be different. Check the Fuel Finder developer
  portal docs and update `FUEL_FINDER_TOKEN_URL` in your `.env`

**Map loads but no stations appear**
→ The data API URL may differ. Check the IFR API docs and update
  `FUEL_FINDER_DATA_URL` in your `.env`
