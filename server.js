const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── FREE API KEYS (Alpha Vantage — 25 req/day each, use multiple) ─
// Get free keys at: alphavantage.co/support/#api-key
const AV_KEYS = [
  'LB7ETS093ZQWNKWB',   // existing key
  'demo',               // fallback demo
];
let avKeyIndex = 0;
function getAVKey() {
  return AV_KEYS[avKeyIndex % AV_KEYS.length];
}

// ── STOCK LISTS ──────────────────────────────────────────────────
const INDIA_STOCKS = [
  'RELIANCE.NS','TCS.NS','HDFCBANK.NS','INFY.NS','ICICIBANK.NS',
  'HINDUNILVR.NS','ITC.NS','SBIN.NS','BHARTIARTL.NS','KOTAKBANK.NS',
  'LT.NS','AXISBANK.NS','ASIANPAINT.NS','MARUTI.NS','SUNPHARMA.NS',
  'TITAN.NS','ULTRACEMCO.NS','NESTLEIND.NS','WIPRO.NS','POWERGRID.NS',
  'NTPC.NS','TATAMOTORS.NS','ONGC.NS','TECHM.NS','BAJFINANCE.NS',
  'BAJAJFINSV.NS','HCLTECH.NS','INDUSINDBK.NS','DIVISLAB.NS','CIPLA.NS',
  'DRREDDY.NS','EICHERMOT.NS','BPCL.NS','COALINDIA.NS','GRASIM.NS',
  'HEROMOTOCO.NS','HINDALCO.NS','JSWSTEEL.NS','MM.NS','SBILIFE.NS',
  'ADANIENT.NS','ADANIPORTS.NS','APOLLOHOSP.NS','BRITANNIA.NS',
  'LTIM.NS','TATACONSUM.NS','TATASTEEL.NS','VEDL.NS'
];

const US_STOCKS = [
  'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA',
  'UNH','JNJ','JPM','V','PG','MA','HD','CVX','MRK','ABBV',
  'PEP','KO','AVGO','COST','WMT','TMO','CSCO','ABT','ACN',
  'MCD','NEE','LIN','DHR','ADBE','NFLX','CRM','TXN','AMD',
  'QCOM','INTC','IBM','GE','BAC','WFC','MS','GS','AMGN',
  'GILD','BMY','SBUX','PYPL','UBER'
];

// ── CACHE ─────────────────────────────────────────────────────────
const cache = { india: { data: null, ts: 0 }, us: { data: null, ts: 0 } };
const CACHE_TTL = 15 * 60 * 1000;

// ── SOURCE 1: Yahoo Finance (multiple endpoints + cookies) ────────
async function fetchYahoo(symbols) {
  const out = {};
  const BATCH = 20;
  
  // Get a crumb/cookie first
  let crumb = null;
  try {
    const cookieRes = await axios.get('https://fc.yahoo.com', { timeout: 5000 });
    const cookies = cookieRes.headers['set-cookie']?.join(';') || '';
    const crumbRes = await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      timeout: 5000,
      headers: { Cookie: cookies, 'User-Agent': 'Mozilla/5.0' }
    });
    crumb = crumbRes.data;
    console.log('Yahoo crumb obtained:', crumb ? 'yes' : 'no');
  } catch(e) {
    console.log('Yahoo crumb failed, trying without:', e.message);
  }

  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH).join(',');
    const urls = [
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk)}${crumb ? '&crumb='+crumb : ''}`,
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk)}`,
      `https://query1.finance.yahoo.com/v8/finance/quote?symbols=${encodeURIComponent(chunk)}`,
    ];

    let got = false;
    for (const url of urls) {
      try {
        const r = await axios.get(url, {
          timeout: 12000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://finance.yahoo.com',
            'Referer': 'https://finance.yahoo.com/'
          }
        });
        const quotes = r.data?.quoteResponse?.result || [];
        if (quotes.length > 0) {
          for (const q of quotes) {
            const price = q.regularMarketPrice;
            if (!price) continue;
            const sym = q.symbol.toUpperCase();
            out[sym] = {
              symbol: sym,
              name: q.shortName || q.longName || sym,
              price: parseFloat(price.toFixed(2)),
              change: parseFloat((q.regularMarketChangePercent || 0).toFixed(2)),
              high: parseFloat((q.regularMarketDayHigh || price).toFixed(2)),
              low: parseFloat((q.regularMarketDayLow || price).toFixed(2)),
              open: parseFloat((q.regularMarketOpen || price).toFixed(2)),
              currency: q.currency || 'USD'
            };
          }
          got = true;
          break;
        }
      } catch(e) {
        console.log(`Yahoo URL failed: ${e.message}`);
      }
    }
    if (!got) console.log(`Yahoo batch ${i/BATCH+1} failed all URLs`);
    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 400));
  }
  return out;
}

// ── SOURCE 2: Stooq CSV (no key, very reliable) ───────────────────
async function fetchStooq(symbols) {
  const out = {};
  const CONC = 8;

  async function fetchOne(sym) {
    try {
      const s = sym.toLowerCase().replace('.ns', '.ns').replace('.bo', '.bo');
      const r = await axios.get(
        `https://stooq.com/q/l/?s=${s}&f=sd2t2ohlcvn&h&e=csv`,
        { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const lines = r.data.trim().split('\n');
      if (lines.length < 2) return;
      const cols = lines[1].split(',');
      const close = parseFloat(cols[6]);
      if (!close || close <= 0 || isNaN(close)) return;
      const open  = parseFloat(cols[3]) || close;
      const high  = parseFloat(cols[4]) || close;
      const low   = parseFloat(cols[5]) || close;
      const chg   = open > 0 ? parseFloat(((close-open)/open*100).toFixed(2)) : 0;
      const key   = sym.toUpperCase();
      out[key] = {
        symbol: key,
        name: (cols[8] || sym).trim(),
        price: close,
        change: chg,
        high, low, open,
        currency: sym.includes('.NS') || sym.includes('.BO') ? 'INR' : 'USD'
      };
    } catch(e) {
      // silent fail per symbol
    }
  }

  for (let i = 0; i < symbols.length; i += CONC) {
    await Promise.all(symbols.slice(i, i + CONC).map(fetchOne));
    if (i + CONC < symbols.length) await new Promise(r => setTimeout(r, 600));
  }
  return out;
}

// ── MAIN: Try Yahoo → fallback Stooq ─────────────────────────────
async function fetchAll(symbols, market) {
  // Try Yahoo first
  let data = await fetchYahoo(symbols);
  const yahooCount = Object.keys(data).length;
  console.log(`[${market}] Yahoo: ${yahooCount}/${symbols.length}`);

  // Fill missing with Stooq
  const missing = symbols.filter(s => !data[s.toUpperCase()]);
  if (missing.length > 0) {
    console.log(`[${market}] Stooq filling ${missing.length} missing...`);
    const stooq = await fetchStooq(missing);
    const stooqCount = Object.keys(stooq).length;
    console.log(`[${market}] Stooq: ${stooqCount}`);
    Object.assign(data, stooq);
  }

  console.log(`[${market}] Final: ${Object.keys(data).length} stocks`);
  return data;
}

// ── ROUTES ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok', service: 'SignalPro API',
    sources: ['Yahoo Finance', 'Stooq'],
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
  const data = await fetchAll(INDIA_STOCKS, 'India');
  if (Object.keys(data).length > 0) cache.india = { data, ts: now };
  res.json({ source: 'live', data: cache.india.data || {} });
});

app.get('/api/us', async (req, res) => {
  const now = Date.now();
  if (cache.us.data && (now - cache.us.ts) < CACHE_TTL)
    return res.json({ source: 'cache', data: cache.us.data });
  const data = await fetchAll(US_STOCKS, 'US');
  if (Object.keys(data).length > 0) cache.us = { data, ts: now };
  res.json({ source: 'live', data: cache.us.data || {} });
});

// ── TEST ENDPOINT (use this to debug) ────────────────────────────
app.get('/api/test', async (req, res) => {
  const results = { yahoo: 'untested', stooq: 'untested' };
  
  // Test Yahoo with 1 symbol
  try {
    const r = await axios.get(
      'https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL',
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const q = r.data?.quoteResponse?.result?.[0];
    results.yahoo = q ? `OK - AAPL $${q.regularMarketPrice}` : 'empty response';
  } catch(e) { results.yahoo = `FAILED: ${e.message}`; }

  // Test Stooq with 1 symbol  
  try {
    const r = await axios.get(
      'https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcvn&h&e=csv',
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const lines = r.data.trim().split('\n');
    const price = lines[1]?.split(',')?.[6];
    results.stooq = price && parseFloat(price) > 0 ? `OK - AAPL $${price}` : 'empty response';
  } catch(e) { results.stooq = `FAILED: ${e.message}`; }

  res.json(results);
});

app.listen(PORT, () => {
  console.log(`✅ SignalPro API on port ${PORT}`);
});
