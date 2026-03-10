const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 6 TWELVE DATA API KEYS ──────────────────────────────────────
const API_KEYS = [
  '50fb20a8aeaf407aae301786a8d373ef',
  'f184cceb11df484d8ace518d9fe7b295',
  '09e44de867594efcb2732e61a1bc4578',
  'ef3effbd4d5c41b6ae6475eca12e4fcd',
  'b985bf51ba6445a69e5f9fffda21a7b1',
  'fa65357e2cf742cf95972de805699e78',
];

// Time-based key rotation — each key covers 4 hours
function getActiveKey() {
  const hour = new Date().getUTCHours();
  const slot = Math.floor(hour / 4) % API_KEYS.length;
  return API_KEYS[slot];
}

// ── STOCK LISTS ──────────────────────────────────────────────────
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

// ── CACHE ────────────────────────────────────────────────────────
const cache = { india: { data: null, ts: 0 }, us: { data: null, ts: 0 }, search: {} };
const CACHE_TTL  = 10 * 60 * 1000; // 10 min
const SEARCH_TTL =  5 * 60 * 1000; // 5 min

// ── FETCH FROM TWELVE DATA ───────────────────────────────────────
async function fetchQuotes(symbols, exchange) {
  const key    = getActiveKey();
  const symStr = symbols.join(',');

  // Use /price for simple price, /quote for full data
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symStr)}&exchange=${exchange}&apikey=${key}&dp=2`;

  try {
    const res  = await axios.get(url, { timeout: 20000 });
    const data = res.data;
    const out  = {};

    // If single symbol, wrap it
    const items = symbols.length === 1 ? { [symbols[0]]: data } : data;

    for (const [sym, q] of Object.entries(items)) {
      if (!q || q.status === 'error' || q.code === 400 || q.code === 404) {
        console.log(`Skip ${sym}:`, q?.message || 'no data');
        continue;
      }

      // Twelve Data uses 'close' for latest price in /quote
      const price  = parseFloat(q.close || q.price || 0);
      if (!price || price <= 0) continue;

      const open   = parseFloat(q.open  || price);
      const high   = parseFloat(q.high  || price);
      const low    = parseFloat(q.low   || price);
      const prev   = parseFloat(q.previous_close || open);
      const change = parseFloat(q.percent_change || (prev ? ((price - prev) / prev * 100) : 0));

      out[sym.toUpperCase()] = {
        symbol:   sym.toUpperCase(),
        name:     q.name || sym,
        price,
        change:   parseFloat(change.toFixed(2)),
        high,
        low,
        open,
        prev,
        exchange: q.exchange || exchange,
        currency: q.currency || (exchange === 'NSE' ? 'INR' : 'USD'),
        volume:   parseInt(q.volume || 0)
      };
    }
    console.log(`[${exchange}] Got ${Object.keys(out).length}/${symbols.length} quotes`);
    return out;
  } catch (err) {
    console.error(`fetchQuotes error [${exchange}]:`, err.message);
    return {};
  }
}

// Fetch in batches of 55
async function fetchAllQuotes(symbols, exchange) {
  const BATCH = 55;
  const out   = {};
  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk   = symbols.slice(i, i + BATCH);
    const results = await fetchQuotes(chunk, exchange);
    Object.assign(out, results);
    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 1000));
  }
  return out;
}

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  const slot = Math.floor(new Date().getUTCHours() / 4);
  res.json({
    status: 'ok',
    service: 'SignalPro API',
    keySlot: slot + 1,
    nextRotationIn: `${4 - (new Date().getUTCHours() % 4)}h`,
    cache: {
      india: cache.india.data ? `${Object.keys(cache.india.data).length} stocks` : 'empty',
      us:    cache.us.data    ? `${Object.keys(cache.us.data).length} stocks`    : 'empty',
    }
  });
});

// India stocks
app.get('/api/india', async (req, res) => {
  const now = Date.now();
  if (cache.india.data && (now - cache.india.ts) < CACHE_TTL) {
    console.log('[India] Serving from cache');
    return res.json({ source: 'cache', data: cache.india.data });
  }
  console.log('[India] Fetching fresh data...');
  const data = await fetchAllQuotes(INDIA_STOCKS, 'NSE');
  if (Object.keys(data).length > 0) cache.india = { data, ts: now };
  res.json({ source: 'live', data: cache.india.data || {} });
});

// US stocks
app.get('/api/us', async (req, res) => {
  const now = Date.now();
  if (cache.us.data && (now - cache.us.ts) < CACHE_TTL) {
    console.log('[US] Serving from cache');
    return res.json({ source: 'cache', data: cache.us.data });
  }
  console.log('[US] Fetching fresh data...');
  const data = await fetchAllQuotes(US_STOCKS, 'NASDAQ');
  if (Object.keys(data).length > 0) cache.us = { data, ts: now };
  res.json({ source: 'live', data: cache.us.data || {} });
});

// Search any stock
app.get('/api/search', async (req, res) => {
  const { q, exchange } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing q param' });

  const sym  = q.toUpperCase().trim().replace('.NS','').replace('.BO','');
  const exch = exchange ? exchange.toUpperCase() : null;
  const ckey = `${sym}_${exch || 'auto'}`;
  const now  = Date.now();

  if (cache.search[ckey] && (now - cache.search[ckey].ts) < SEARCH_TTL) {
    return res.json({ source: 'cache', data: cache.search[ckey].data });
  }

  // Try NSE first if no exchange specified or if it looks Indian
  const isIndia = exch === 'NSE' || INDIA_STOCKS.includes(sym);
  const exchanges = isIndia ? ['NSE','BSE'] : (exch ? [exch] : ['NASDAQ','NYSE','NSE']);

  for (const ex of exchanges) {
    const data = await fetchQuotes([sym], ex);
    if (data[sym]) {
      cache.search[ckey] = { data: data[sym], ts: now };
      return res.json({ source: 'live', data: data[sym] });
    }
  }
  res.status(404).json({ error: `${sym} not found` });
});

app.listen(PORT, () => {
  console.log(`✅ SignalPro API running on port ${PORT}`);
  console.log(`   Key slot: ${Math.floor(new Date().getUTCHours() / 4) + 1}/6`);
});
