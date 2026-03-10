const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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

// ── CACHE ────────────────────────────────────────────────────────
const cache = { india: { data: null, ts: 0 }, us: { data: null, ts: 0 } };
const CACHE_TTL = 15 * 60 * 1000; // 15 min

// ── SOURCE 1: Yahoo Finance v7 ───────────────────────────────────
async function fetchYahooV7(symbols) {
  const BATCH = 20;
  const out   = {};
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH).join(',');
    try {
      // Try v7 first
      let quotes = [];
      try {
        const r = await axios.get(
          `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk)}`,
          { timeout: 12000, headers }
        );
        quotes = r.data?.quoteResponse?.result || [];
      } catch {
        // Try v8 as fallback
        const r = await axios.get(
          `https://query2.finance.yahoo.com/v8/finance/quote?symbols=${encodeURIComponent(chunk)}`,
          { timeout: 12000, headers }
        );
        quotes = r.data?.quoteResponse?.result || [];
      }

      for (const q of quotes) {
        const price = q.regularMarketPrice;
        if (!price || price <= 0) continue;
        const sym = q.symbol.toUpperCase();
        out[sym] = {
          symbol:   sym,
          name:     q.shortName || q.longName || sym,
          price:    parseFloat(price.toFixed(2)),
          change:   parseFloat((q.regularMarketChangePercent || 0).toFixed(2)),
          high:     parseFloat((q.regularMarketDayHigh  || price).toFixed(2)),
          low:      parseFloat((q.regularMarketDayLow   || price).toFixed(2)),
          open:     parseFloat((q.regularMarketOpen     || price).toFixed(2)),
          currency: q.currency || 'USD'
        };
      }
    } catch (err) {
      console.error(`Yahoo batch ${i/BATCH+1} error:`, err.message);
    }
    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 300));
  }
  return out;
}

// ── SOURCE 2: Stooq (no key needed, very reliable) ───────────────
async function fetchStooqSingle(symbol) {
  // Stooq URL format: RELIANCE.NS → RELIANCE.NS at stooq
  try {
    const r = await axios.get(
      `https://stooq.com/q/l/?s=${symbol.toLowerCase()}&f=sd2t2ohlcvn&h&e=csv`,
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const lines = r.data.trim().split('\n');
    if (lines.length < 2) return null;
    const cols = lines[1].split(',');
    // Symbol,Date,Time,Open,High,Low,Close,Volume,Name
    const price = parseFloat(cols[6]);
    if (!price || price <= 0 || isNaN(price)) return null;
    const open  = parseFloat(cols[3]) || price;
    const high  = parseFloat(cols[4]) || price;
    const low   = parseFloat(cols[5]) || price;
    const chg   = open > 0 ? parseFloat(((price - open) / open * 100).toFixed(2)) : 0;
    return { price, open, high, low, change: chg, name: cols[8]?.trim() || symbol };
  } catch { return null; }
}

async function fetchStooqBatch(symbols) {
  const out = {};
  const promises = symbols.map(async sym => {
    const q = await fetchStooqSingle(sym);
    if (q) {
      out[sym.toUpperCase()] = {
        symbol:   sym.toUpperCase(),
        name:     q.name,
        price:    q.price,
        change:   q.change,
        high:     q.high,
        low:      q.low,
        open:     q.open,
        currency: sym.endsWith('.NS') || sym.endsWith('.BO') ? 'INR' : 'USD'
      };
    }
  });
  // Run 10 at a time
  const CONC = 10;
  for (let i = 0; i < promises.length; i += CONC) {
    await Promise.all(promises.slice(i, i + CONC));
    if (i + CONC < promises.length) await new Promise(r => setTimeout(r, 500));
  }
  return out;
}

// ── MAIN FETCH WITH FALLBACK CHAIN ───────────────────────────────
async function fetchWithFallback(symbols, market) {
  console.log(`[${market}] Trying Yahoo Finance...`);
  let data = await fetchYahooV7(symbols);
  const yahooCount = Object.keys(data).length;
  console.log(`[${market}] Yahoo: ${yahooCount}/${symbols.length}`);

  // If Yahoo got less than 50% → try Stooq for missing ones
  if (yahooCount < symbols.length * 0.5) {
    console.log(`[${market}] Yahoo low, trying Stooq for missing...`);
    const missing = symbols.filter(s => !data[s.toUpperCase()]);
    const stooqData = await fetchStooqBatch(missing);
    const stooqCount = Object.keys(stooqData).length;
    console.log(`[${market}] Stooq got ${stooqCount} more`);
    Object.assign(data, stooqData);
  }

  const total = Object.keys(data).length;
  console.log(`[${market}] Total: ${total} stocks`);
  return data;
}

// ── ROUTES ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'ok',
    service: 'SignalPro API',
    sources: ['Yahoo Finance v7/v8', 'Stooq (fallback)'],
    cache: {
      india: cache.india.data ? `${Object.keys(cache.india.data).length} stocks` : 'empty',
      us:    cache.us.data    ? `${Object.keys(cache.us.data).length} stocks`    : 'empty',
    }
  });
});

app.get('/api/india', async (req, res) => {
  const now = Date.now();
  if (cache.india.data && (now - cache.india.ts) < CACHE_TTL) {
    console.log('[India] Cache hit');
    return res.json({ source: 'cache', data: cache.india.data });
  }
  const data = await fetchWithFallback(INDIA_STOCKS, 'India');
  if (Object.keys(data).length > 0) cache.india = { data, ts: now };
  res.json({ source: 'live', data: cache.india.data || {} });
});

app.get('/api/us', async (req, res) => {
  const now = Date.now();
  if (cache.us.data && (now - cache.us.ts) < CACHE_TTL) {
    console.log('[US] Cache hit');
    return res.json({ source: 'cache', data: cache.us.data });
  }
  const data = await fetchWithFallback(US_STOCKS, 'US');
  if (Object.keys(data).length > 0) cache.us = { data, ts: now };
  res.json({ source: 'live', data: cache.us.data || {} });
});

app.listen(PORT, () => {
  console.log(`✅ SignalPro API on port ${PORT} — Yahoo + Stooq dual source`);
});
