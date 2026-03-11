const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── STOCK LISTS ──────────────────────────────────────────────────
// Stooq format: NSE stocks use .ns suffix, US stocks use .us suffix
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
  'AAPL.US','MSFT.US','GOOGL.US','AMZN.US','NVDA.US','META.US','TSLA.US',
  'UNH.US','JNJ.US','JPM.US','V.US','PG.US','MA.US','HD.US','CVX.US',
  'MRK.US','ABBV.US','PEP.US','KO.US','AVGO.US','COST.US','WMT.US',
  'TMO.US','CSCO.US','ABT.US','ACN.US','MCD.US','NEE.US','LIN.US',
  'DHR.US','ADBE.US','NFLX.US','CRM.US','TXN.US','AMD.US','QCOM.US',
  'INTC.US','IBM.US','GE.US','BAC.US','WFC.US','MS.US','GS.US',
  'AMGN.US','GILD.US','BMY.US','SBUX.US','PYPL.US','UBER.US'
];

// ── CACHE ─────────────────────────────────────────────────────────
const cache = { india: { data: null, ts: 0 }, us: { data: null, ts: 0 } };
const CACHE_TTL = 15 * 60 * 1000; // 15 min

// ── STOOQ FETCH (confirmed working on Render) ─────────────────────
async function fetchStooq(symbols) {
  const out  = {};
  const CONC = 10; // concurrent requests

  async function fetchOne(sym) {
    try {
      const s = sym.toLowerCase();
      const r = await axios.get(
        `https://stooq.com/q/l/?s=${s}&f=sd2t2ohlcvn&h&e=csv`,
        { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const lines = r.data.trim().split('\n');
      if (lines.length < 2) return;
      const cols  = lines[1].split(',');
      // cols: Symbol,Date,Time,Open,High,Low,Close,Volume,Name
      const close = parseFloat(cols[6]);
      if (!close || close <= 0 || isNaN(close)) return;
      const open  = parseFloat(cols[3]) || close;
      const high  = parseFloat(cols[4]) || close;
      const low   = parseFloat(cols[5]) || close;
      const chg   = open > 0 ? parseFloat(((close - open) / open * 100).toFixed(2)) : 0;

      // Key without exchange suffix for frontend lookup
      const key = sym.toUpperCase();
      out[key] = {
        symbol:   key,
        name:     (cols[8] || sym).trim(),
        price:    parseFloat(close.toFixed(2)),
        change:   chg,
        high:     parseFloat(high.toFixed(2)),
        low:      parseFloat(low.toFixed(2)),
        open:     parseFloat(open.toFixed(2)),
        currency: sym.includes('.NS') || sym.includes('.BO') ? 'INR' : 'USD'
      };
    } catch(e) {
      console.log(`Stooq failed for ${sym}: ${e.message}`);
    }
  }

  // Process in concurrent batches
  for (let i = 0; i < symbols.length; i += CONC) {
    await Promise.all(symbols.slice(i, i + CONC).map(fetchOne));
    if (i + CONC < symbols.length) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Stooq: got ${Object.keys(out).length}/${symbols.length}`);
  return out;
}

// ── ROUTES ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'ok',
    service: 'SignalPro API',
    source:  'Stooq',
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
  console.log('[India] Fetching from Stooq...');
  const data = await fetchStooq(INDIA_STOCKS);
  if (Object.keys(data).length > 0) cache.india = { data, ts: now };
  res.json({ source: 'live', data: cache.india.data || {} });
});

app.get('/api/us', async (req, res) => {
  const now = Date.now();
  if (cache.us.data && (now - cache.us.ts) < CACHE_TTL) {
    console.log('[US] Cache hit');
    return res.json({ source: 'cache', data: cache.us.data });
  }
  console.log('[US] Fetching from Stooq...');
  const data = await fetchStooq(US_STOCKS);
  if (Object.keys(data).length > 0) cache.us = { data, ts: now };
  res.json({ source: 'live', data: cache.us.data || {} });
});

app.get('/api/test', async (req, res) => {
  const results = {};
  try {
    const r = await axios.get(
      'https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcvn&h&e=csv',
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const price = r.data.trim().split('\n')[1]?.split(',')?.[6];
    results.stooq = price && parseFloat(price) > 0 ? `OK - AAPL $${price}` : 'empty';
    // Also test India
    const r2 = await axios.get(
      'https://stooq.com/q/l/?s=reliance.ns&f=sd2t2ohlcvn&h&e=csv',
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const price2 = r2.data.trim().split('\n')[1]?.split(',')?.[6];
    results.stooq_india = price2 && parseFloat(price2) > 0 ? `OK - RELIANCE ₹${price2}` : 'empty';
  } catch(e) { results.stooq = `FAILED: ${e.message}`; }
  res.json(results);
});

app.listen(PORT, () => {
  console.log(`✅ SignalPro API on port ${PORT} — Stooq only`);
});
