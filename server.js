const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── STOCK LISTS ───────────────────────────────────────────────────
const INDIA_STOCKS = [
  'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','HINDUNILVR','ITC',
  'SBIN','BHARTIARTL','KOTAKBANK','LT','AXISBANK','ASIANPAINT',
  'MARUTI','SUNPHARMA','TITAN','ULTRACEMCO','NESTLEIND','WIPRO',
  'POWERGRID','NTPC','TATAMOTORS','ONGC','TECHM','BAJFINANCE',
  'BAJAJFINSV','HCLTECH','INDUSINDBK','DIVISLAB','CIPLA',
  'DRREDDY','EICHERMOT','BPCL','COALINDIA','GRASIM','HEROMOTOCO',
  'HINDALCO','JSWSTEEL','MM','SBILIFE','ADANIENT','ADANIPORTS',
  'APOLLOHOSP','BRITANNIA','LTIM','TATACONSUM','TATASTEEL','VEDL'
];

const US_STOCKS = [
  'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA',
  'UNH','JNJ','JPM','V','PG','MA','HD','CVX','MRK','ABBV',
  'PEP','KO','AVGO','COST','WMT','TMO','CSCO','ABT','ACN',
  'MCD','NEE','LIN','DHR','ADBE','NFLX','CRM','TXN','AMD',
  'QCOM','INTC','IBM','GE','BAC','WFC','MS','GS','AMGN',
  'GILD','BMY','SBUX','PYPL','UBER'
];

// ── CACHE ──────────────────────────────────────────────────────────
const cache = { india: { data: null, ts: 0 }, us: { data: null, ts: 0 } };
const CACHE_TTL = 15 * 60 * 1000;

// ── US: Stooq (confirmed working) ─────────────────────────────────
async function fetchStooqUS(symbols) {
  const out  = {};
  const CONC = 10;

  async function fetchOne(sym) {
    try {
      const r = await axios.get(
        `https://stooq.com/q/l/?s=${sym.toLowerCase()}.us&f=sd2t2ohlcvn&h&e=csv`,
        { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const lines = r.data.trim().split('\n');
      if (lines.length < 2) return;
      const cols  = lines[1].split(',');
      const close = parseFloat(cols[6]);
      if (!close || close <= 0 || isNaN(close)) return;
      const open  = parseFloat(cols[3]) || close;
      const high  = parseFloat(cols[4]) || close;
      const low   = parseFloat(cols[5]) || close;
      const chg   = open > 0 ? parseFloat(((close - open) / open * 100).toFixed(2)) : 0;
      out[sym.toUpperCase()] = {
        symbol: sym.toUpperCase(),
        name: (cols[8] || sym).trim(),
        price: parseFloat(close.toFixed(2)),
        change: chg, high: parseFloat(high.toFixed(2)),
        low: parseFloat(low.toFixed(2)), open: parseFloat(open.toFixed(2)),
        currency: 'USD'
      };
    } catch(e) { console.log(`Stooq US fail ${sym}: ${e.message}`); }
  }

  for (let i = 0; i < symbols.length; i += CONC) {
    await Promise.all(symbols.slice(i, i + CONC).map(fetchOne));
    if (i + CONC < symbols.length) await new Promise(r => setTimeout(r, 500));
  }
  console.log(`[US Stooq] ${Object.keys(out).length}/${symbols.length}`);
  return out;
}

// ── INDIA: NSEIndia unofficial JSON API ───────────────────────────
async function fetchNSE(symbols) {
  const out = {};
  try {
    // NSE provides a public JSON endpoint for all stocks
    const r = await axios.get(
      'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050',
      {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.nseindia.com/',
          'Connection': 'keep-alive',
        }
      }
    );
    const stocks = r.data?.data || [];
    for (const s of stocks) {
      const sym = (s.symbol || '').toUpperCase();
      if (!sym || !s.lastPrice) continue;
      out[sym] = {
        symbol: sym,
        name: s.meta?.companyName || sym,
        price: parseFloat(s.lastPrice),
        change: parseFloat((s.pChange || 0).toFixed(2)),
        high: parseFloat(s.dayHigh || s.lastPrice),
        low: parseFloat(s.dayLow || s.lastPrice),
        open: parseFloat(s.open || s.lastPrice),
        currency: 'INR'
      };
    }
    console.log(`[India NSE] ${Object.keys(out).length} stocks`);
  } catch(e) {
    console.log(`NSE failed: ${e.message}`);
  }
  return out;
}

// ── INDIA FALLBACK: Groww public API ──────────────────────────────
async function fetchGrowwIndia(symbols) {
  const out  = {};
  const CONC = 8;

  async function fetchOne(sym) {
    try {
      const r = await axios.get(
        `https://groww.in/v1/api/stocks_data/v1/accord_points/segment/CASH/exchange/NSE/ticker/${sym}`,
        { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const d = r.data;
      if (!d || !d.ltp) return;
      out[sym.toUpperCase()] = {
        symbol: sym.toUpperCase(),
        name: d.companyShortName || sym,
        price: parseFloat(d.ltp.toFixed(2)),
        change: parseFloat((d.dayChangePerc || 0).toFixed(2)),
        high: parseFloat(d.high || d.ltp),
        low: parseFloat(d.low || d.ltp),
        open: parseFloat(d.open || d.ltp),
        currency: 'INR'
      };
    } catch(e) { /* silent */ }
  }

  for (let i = 0; i < symbols.length; i += CONC) {
    await Promise.all(symbols.slice(i, i + CONC).map(fetchOne));
    if (i + CONC < symbols.length) await new Promise(r => setTimeout(r, 400));
  }
  console.log(`[India Groww] ${Object.keys(out).length}/${symbols.length}`);
  return out;
}

// ── INDIA: Try NSE first, fill missing with Groww ─────────────────
async function fetchIndia(symbols) {
  let data = await fetchNSE(symbols);
  
  const missing = symbols.filter(s => !data[s.toUpperCase()]);
  if (missing.length > 0) {
    console.log(`[India] Trying Groww for ${missing.length} missing...`);
    const groww = await fetchGrowwIndia(missing);
    Object.assign(data, groww);
  }
  console.log(`[India] Final: ${Object.keys(data).length} stocks`);
  return data;
}

// ── ROUTES ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok', service: 'SignalPro API',
    sources: { us: 'Stooq', india: 'NSEIndia + Groww' },
    cache: {
      india: cache.india.data ? `${Object.keys(cache.india.data).length} stocks` : 'empty',
      us:    cache.us.data    ? `${Object.keys(cache.us.data).length} stocks`    : 'empty',
    }
  });
});

app.get('/api/india', async (req, res) => {
  const now = Date.now();
  if (cache.india.data && (now - cache.india.ts) < CACHE_TTL)
    return res.json({ source: 'cache', data: cache.india.data });
  const data = await fetchIndia(INDIA_STOCKS);
  if (Object.keys(data).length > 0) cache.india = { data, ts: now };
  res.json({ source: 'live', data: cache.india.data || {} });
});

app.get('/api/us', async (req, res) => {
  const now = Date.now();
  if (cache.us.data && (now - cache.us.ts) < CACHE_TTL)
    return res.json({ source: 'cache', data: cache.us.data });
  const data = await fetchStooqUS(US_STOCKS);
  if (Object.keys(data).length > 0) cache.us = { data, ts: now };
  res.json({ source: 'live', data: cache.us.data || {} });
});

app.get('/api/test', async (req, res) => {
  const results = {};
  // Test US Stooq
  try {
    const r = await axios.get('https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcvn&h&e=csv',
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const price = r.data.trim().split('\n')[1]?.split(',')?.[6];
    results.stooq_us = price && parseFloat(price) > 0 ? `OK - AAPL $${price}` : 'empty';
  } catch(e) { results.stooq_us = `FAILED: ${e.message}`; }

  // Test NSE India
  try {
    const r = await axios.get(
      'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050',
      { timeout: 10000, headers: {
        'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.nseindia.com/',
        'Accept': 'application/json'
      }}
    );
    const count = r.data?.data?.length || 0;
    results.nse_india = count > 0 ? `OK - ${count} stocks` : 'empty';
  } catch(e) { results.nse_india = `FAILED: ${e.message}`; }

  // Test Groww
  try {
    const r = await axios.get(
      'https://groww.in/v1/api/stocks_data/v1/accord_points/segment/CASH/exchange/NSE/ticker/RELIANCE',
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    results.groww_india = r.data?.ltp ? `OK - RELIANCE ₹${r.data.ltp}` : 'empty';
  } catch(e) { results.groww_india = `FAILED: ${e.message}`; }

  res.json(results);
});

app.listen(PORT, () => {
  console.log(`✅ SignalPro API on port ${PORT}`);
  console.log(`   US: Stooq | India: NSEIndia + Groww`);
});
