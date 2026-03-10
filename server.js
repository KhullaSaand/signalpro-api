const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 6 TWELVE DATA API KEYS ──────────────────────────────────────
const API_KEYS = [
  '50fb20a8aeaf407aae301786a8d373ef',  // Key 1
  'f184cceb11df484d8ace518d9fe7b295',  // Key 2
  '09e44de867594efcb2732e61a1bc4578',  // Key 3
  'ef3effbd4d5c41b6ae6475eca12e4fcd',  // Key 4
  'b985bf51ba6445a69e5f9fffda21a7b1',  // Key 5
  'fa65357e2cf742cf95972de805699e78',  // Key 6
];

// ── KEY ROTATION: each key covers 4 hours of the day ────────────
function getActiveKey() {
  const hour = new Date().getUTCHours(); // 0-23
  const slot = Math.floor(hour / 4);    // 0-5 (6 slots of 4 hours)
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
  'APOLLOHOSP','BAJAJ_AUTO','BRITANNIA','LTIM','TATACONSUM',
  'TATASTEEL','UPL','VEDL'
];

const US_STOCKS = [
  'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','BRK.B',
  'UNH','JNJ','JPM','V','PG','MA','HD','CVX','MRK','ABBV',
  'PEP','KO','AVGO','COST','WMT','TMO','CSCO','ABT','ACN',
  'MCD','NEE','LIN','DHR','ADBE','NFLX','CRM','TXN','AMD',
  'QCOM','INTC','IBM','GE','BAC','WFC','MS','GS','AMGN',
  'GILD','BMY','SBUX','PYPL','UBER'
];

// ── CACHE ────────────────────────────────────────────────────────
const cache = {
  india:  { data: null, ts: 0 },
  us:     { data: null, ts: 0 },
  search: {}  // symbol -> { data, ts }
};
const CACHE_TTL     = 10 * 60 * 1000; // 10 minutes for pre-loaded
const SEARCH_TTL    =  5 * 60 * 1000; // 5 minutes for search results

// ── FETCH FROM TWELVE DATA ───────────────────────────────────────
async function fetchQuotes(symbols, exchange) {
  const key     = getActiveKey();
  const symStr  = symbols.join(',');
  const url     = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symStr)}&exchange=${exchange}&apikey=${key}`;

  try {
    const res  = await axios.get(url, { timeout: 15000 });
    const data = res.data;
    const out  = {};

    // Twelve Data returns single object if 1 symbol, array-like object if multiple
    const items = symbols.length === 1
      ? { [symbols[0]]: data }
      : data;

    for (const [sym, q] of Object.entries(items)) {
      if (q.status === 'error' || !q.close) continue;
      const price  = parseFloat(q.close);
      const open   = parseFloat(q.open  || price);
      const high   = parseFloat(q.high  || price);
      const low    = parseFloat(q.low   || price);
      const prev   = parseFloat(q.previous_close || open);
      const change = prev ? ((price - prev) / prev) * 100 : 0;

      out[sym.toUpperCase()] = {
        symbol: sym.toUpperCase(),
        name:   q.name || sym,
        price,
        change: parseFloat(change.toFixed(2)),
        high,
        low,
        open,
        prev,
        exchange: q.exchange || exchange,
        currency: q.currency || (exchange === 'NSE' ? 'INR' : 'USD'),
        volume:   parseInt(q.volume || 0)
      };
    }
    return out;
  } catch (err) {
    console.error(`fetchQuotes error [${exchange}]:`, err.message);
    return {};
  }
}

// ── FETCH IN BATCHES (Twelve Data allows up to 120 symbols/req on free) ──
async function fetchAllQuotes(symbols, exchange) {
  const BATCH = 55; // safe batch size for free tier
  const out   = {};

  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk   = symbols.slice(i, i + BATCH);
    const results = await fetchQuotes(chunk, exchange);
    Object.assign(out, results);
    if (i + BATCH < symbols.length) {
      await new Promise(r => setTimeout(r, 500)); // small delay between batches
    }
  }
  return out;
}

// ── CORS: allow any origin (GitHub Pages + custom domain) ────────
app.use(cors());
app.use(express.json());

// ── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SignalPro API',
    activeKey: getActiveKey().slice(0, 8) + '...',
    keySlot: Math.floor(new Date().getUTCHours() / 4) + 1,
    nextRotation: `${4 - (new Date().getUTCHours() % 4)}h`,
    cache: {
      india: cache.india.data ? `${Object.keys(cache.india.data).length} stocks` : 'empty',
      us:    cache.us.data    ? `${Object.keys(cache.us.data).length} stocks`    : 'empty',
    }
  });
});

// ── INDIA STOCKS ENDPOINT ────────────────────────────────────────
app.get('/api/india', async (req, res) => {
  const now = Date.now();
  if (cache.india.data && (now - cache.india.ts) < CACHE_TTL) {
    return res.json({ source: 'cache', data: cache.india.data });
  }

  console.log(`[India] Fetching ${INDIA_STOCKS.length} stocks with key slot ${Math.floor(new Date().getUTCHours() / 4) + 1}`);
  const data = await fetchAllQuotes(INDIA_STOCKS, 'NSE');

  if (Object.keys(data).length > 0) {
    cache.india = { data, ts: now };
  }

  res.json({ source: 'live', data: cache.india.data || {} });
});

// ── US STOCKS ENDPOINT ───────────────────────────────────────────
app.get('/api/us', async (req, res) => {
  const now = Date.now();
  if (cache.us.data && (now - cache.us.ts) < CACHE_TTL) {
    return res.json({ source: 'cache', data: cache.us.data });
  }

  console.log(`[US] Fetching ${US_STOCKS.length} stocks with key slot ${Math.floor(new Date().getUTCHours() / 4) + 1}`);
  const data = await fetchAllQuotes(US_STOCKS, 'NASDAQ');

  if (Object.keys(data).length > 0) {
    cache.us = { data, ts: now };
  }

  res.json({ source: 'live', data: cache.us.data || {} });
});

// ── SEARCH ENDPOINT ──────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, exchange } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing q param' });

  const sym    = q.toUpperCase().trim();
  const exch   = (exchange || 'auto').toUpperCase();
  const ckey   = `${sym}_${exch}`;
  const now    = Date.now();
  const cached = cache.search[ckey];

  if (cached && (now - cached.ts) < SEARCH_TTL) {
    return res.json({ source: 'cache', data: cached.data });
  }

  // Auto-detect exchange
  const isIndia = exch === 'NSE' || sym.endsWith('.NS') ||
    INDIA_STOCKS.includes(sym.replace('.NS',''));
  const resolvedExchange = isIndia ? 'NSE' : (exch === 'NYSE' ? 'NYSE' : 'NASDAQ');
  const cleanSym = sym.replace('.NS', '');

  console.log(`[Search] ${cleanSym} on ${resolvedExchange}`);
  const data = await fetchQuotes([cleanSym], resolvedExchange);

  // If not found on NASDAQ, try NYSE
  let result = data[cleanSym];
  if (!result && resolvedExchange === 'NASDAQ') {
    const retry = await fetchQuotes([cleanSym], 'NYSE');
    result = retry[cleanSym];
  }

  if (result) {
    cache.search[ckey] = { data: result, ts: now };
    res.json({ source: 'live', data: result });
  } else {
    res.status(404).json({ error: `Symbol ${cleanSym} not found` });
  }
});

// ── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ SignalPro API running on port ${PORT}`);
  console.log(`   Active key slot: ${Math.floor(new Date().getUTCHours() / 4) + 1}/6`);
  console.log(`   Next rotation in: ${4 - (new Date().getUTCHours() % 4)}h`);
});
