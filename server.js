// ============================================================================
//  Comparador de stablecoins vs Buda — UN SOLO ARCHIVO, SIN DEPENDENCIAS.
//  Usa solo módulos nativos de Node (http, fs) — no requiere `npm install`.
//  Sirve index.html y cbp.html desde la misma carpeta.
//  Fuentes: CriptoYa, Buda, Bitso, Binance/OKX/Bybit P2P, captura manual, Plenti, Mural (B2B).
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const COINS = ['usdc', 'usdt'];
const FIAT = 'cop';
const DEFAULT_VOLUME = 1000;
const TIMEOUT = 9000;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// --- Clasificador de tipo de precio -----------------------------------------
const SPOT_BOOKS = new Set(['buda', 'bitso']);
function classifyVenue(venue) {
  const v = String(venue || '').toLowerCase();
  if (/p2p/.test(v)) return 'p2p';
  if (SPOT_BOOKS.has(v)) return 'spot';
  return 'platform';
}

async function getJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal,
      headers: { Accept: 'application/json', ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// --- Fuentes retail ---------------------------------------------------------
async function fetchCriptoya(coin, fiat, volume) {
  const raw = await getJSON(`https://criptoya.com/api/${coin}/${fiat}/${volume}`);
  const rows = [];
  for (const [venue, q] of Object.entries(raw || {})) {
    if (!q || typeof q !== 'object') continue;
    const totalAsk = num(q.totalAsk), totalBid = num(q.totalBid);
    if (totalAsk === null && totalBid === null) continue;
    rows.push({ source: 'criptoya', venue, coin: coin.toUpperCase(), fiat: fiat.toUpperCase(),
      type: classifyVenue(venue), feeBasis: 'fee-inclusive',
      ask: num(q.ask), totalAsk, bid: num(q.bid), totalBid, time: num(q.time), isBuda: venue === 'buda' });
  }
  return rows;
}
async function fetchBuda(coin, fiat) {
  const j = await getJSON(`https://www.buda.com/api/v2/markets/${coin.toLowerCase()}-${fiat.toLowerCase()}/ticker.json`);
  const tk = j.ticker || {}; const pair = (x) => (Array.isArray(x) ? num(x[0]) : num(x));
  const ask = pair(tk.min_ask), bid = pair(tk.max_bid);
  if (ask === null && bid === null) return [];
  return [{ source: 'buda-direct', venue: 'buda', coin: coin.toUpperCase(), fiat: fiat.toUpperCase(),
    type: 'spot', feeBasis: 'raw', ask, totalAsk: ask, bid, totalBid: bid, time: Date.now() / 1000 | 0, isBuda: true }];
}
async function fetchBitso(coin, fiat) {
  if (coin.toLowerCase() !== 'usdt' || fiat.toLowerCase() !== 'cop') return [];
  const j = await getJSON('https://api.bitso.com/v3/ticker?book=usdt_cop');
  if (!j.success) return [];
  const p = j.payload || {}; const ask = num(p.ask), bid = num(p.bid);
  if (ask === null && bid === null) return [];
  return [{ source: 'bitso-direct', venue: 'bitso', coin: coin.toUpperCase(), fiat: fiat.toUpperCase(),
    type: 'spot', feeBasis: 'raw', ask, totalAsk: ask, bid, totalBid: bid, time: Date.now() / 1000 | 0, isBuda: false }];
}
async function binanceBest(coin, fiat, tradeType, volume) {
  const j = await getJSON('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fiat: fiat.toUpperCase(), asset: coin.toUpperCase(), tradeType, page: 1, rows: 5, payTypes: [], transAmount: String(volume) }) });
  const first = (j.data || [])[0]; return first && first.adv ? num(first.adv.price) : null;
}
async function fetchBinanceP2P(coin, fiat, volume) {
  const [ask, bid] = await Promise.all([
    binanceBest(coin, fiat, 'BUY', volume).catch(() => null),
    binanceBest(coin, fiat, 'SELL', volume).catch(() => null) ]);
  if (ask === null && bid === null) return [];
  return [{ source: 'binance-p2p-direct', venue: 'binancep2p', coin: coin.toUpperCase(), fiat: fiat.toUpperCase(),
    type: 'p2p', feeBasis: 'ad-price', ask, totalAsk: ask, bid, totalBid: bid, time: Date.now() / 1000 | 0, isBuda: false }];
}
async function okxSide(base, quote, side) {
  const qs = new URLSearchParams({ quoteCurrency: quote, baseCurrency: base, side, paymentMethod: 'all', userType: 'all',
    showFollow: 'false', showAlreadyTraded: 'false', isAbleFilter: 'false', receivingAds: 'false' });
  const j = await getJSON(`https://www.okx.com/v3/c2c/tradingOrders/books?${qs}`);
  const list = j && j.data && Array.isArray(j.data[side]) ? j.data[side] : [];
  return list.map((a) => num(a.price)).filter((p) => p !== null);
}
async function fetchOkxP2P(coin, fiat) {
  const base = { usdt: 'USDT', usdc: 'USDC' }[coin.toLowerCase()];
  if (!base || fiat.toLowerCase() !== 'cop') return [];
  const quote = fiat.toUpperCase();
  const [sell, buy] = await Promise.all([ okxSide(base, quote, 'sell').catch(() => []), okxSide(base, quote, 'buy').catch(() => []) ]);
  const ask = sell.length ? Math.min(...sell) : null, bid = buy.length ? Math.max(...buy) : null;
  if (ask === null && bid === null) return [];
  return [{ source: 'okx-p2p-direct', venue: 'okexp2p', coin: coin.toUpperCase(), fiat: quote,
    type: 'p2p', feeBasis: 'ad-price', ask, totalAsk: ask, bid, totalBid: bid, time: Date.now() / 1000 | 0, isBuda: false }];
}
async function bybitSide(tokenId, currencyId, side) {
  const j = await getJSON('https://api2.bybit.com/fiat/otc/item/online', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId, currencyId, side, page: '1', size: '10', payment: [], amount: '' }) });
  const items = j && j.result && Array.isArray(j.result.items) ? j.result.items : [];
  return items.map((it) => num(it.price)).filter((p) => p !== null);
}
async function fetchBybitP2P(coin, fiat) {
  const tokenId = { usdt: 'USDT', usdc: 'USDC' }[coin.toLowerCase()];
  if (!tokenId || fiat.toLowerCase() !== 'cop') return [];
  const currencyId = fiat.toUpperCase();
  const [a, b] = await Promise.all([ bybitSide(tokenId, currencyId, '1').catch(() => []), bybitSide(tokenId, currencyId, '0').catch(() => []) ]);
  const ask = a.length ? Math.min(...a) : null, bid = b.length ? Math.max(...b) : null;
  if (ask === null && bid === null) return [];
  return [{ source: 'bybit-p2p-direct', venue: 'bybitp2p', coin: coin.toUpperCase(), fiat: currencyId,
    type: 'p2p', feeBasis: 'ad-price', unverified: true, ask, totalAsk: ask, bid, totalBid: bid, time: Date.now() / 1000 | 0, isBuda: false }];
}

// --- Captura manual (Plenti, Littio, VIIO, Wenia) ---------------------------
const MANUAL_FILE = path.join(__dirname, 'platform-rates.json');
const MANUAL_STALE_HOURS = 12;
const MANUAL_KNOWN = { plenti: 'Plenti', littio: 'Littio', viio: 'VIIO', wenia: 'Wenia' };
function manualRead() { try { return JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8')) || {}; } catch { return {}; } }
function manualWrite(s) { fs.writeFileSync(MANUAL_FILE, JSON.stringify(s, null, 2)); }
function manualRecord({ venue, coin, fiat, ask, bid, observer }) {
  const v = String(venue || '').toLowerCase(), c = String(coin || '').toLowerCase(), f = String(fiat || '').toLowerCase();
  if (!v || !c || !f) throw new Error('venue, coin y fiat son obligatorios');
  if (num(ask) === null && num(bid) === null) throw new Error('se requiere ask y/o bid numérico');
  const s = manualRead(); s[v] = s[v] || {};
  s[v][`${c}_${f}`] = { ask: num(ask), bid: num(bid), observedAt: Date.now(), observer: observer || null };
  manualWrite(s); return s[v][`${c}_${f}`];
}
function fetchManual(coin, fiat) {
  const s = manualRead(), key = `${coin.toLowerCase()}_${fiat.toLowerCase()}`, rows = [];
  for (const [venue, pairs] of Object.entries(s)) {
    const e = pairs && pairs[key]; if (!e) continue;
    const ask = num(e.ask), bid = num(e.bid); if (ask === null && bid === null) continue;
    const ageHours = e.observedAt ? +((Date.now() - e.observedAt) / 3.6e6).toFixed(1) : null;
    rows.push({ source: 'manual', venue, coin: coin.toUpperCase(), fiat: fiat.toUpperCase(), type: 'platform',
      feeBasis: 'manual-capture', ask, totalAsk: ask, bid, totalBid: bid, observedAt: e.observedAt || null,
      observer: e.observer || null, ageHours, stale: ageHours != null ? ageHours > MANUAL_STALE_HOURS : true,
      time: e.observedAt ? (e.observedAt / 1000 | 0) : null, isBuda: false });
  }
  return rows;
}

// --- Plenti (cotizador web, via PLENTI_ENDPOINT_JSON) -----------------------
function plentiCfg() { try { return JSON.parse(process.env.PLENTI_ENDPOINT_JSON || 'null'); } catch { return null; } }
function pick(obj, dotted) { return dotted ? String(dotted).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) : undefined; }
async function fetchPlenti(coin, fiat) {
  const cfg = plentiCfg();
  if (!cfg || !cfg.url || !cfg.askPath) return [];
  if (fiat.toLowerCase() !== 'cop' || coin.toLowerCase() !== (cfg.coin || 'usdc').toLowerCase()) return [];
  let url = cfg.url;
  if ((cfg.method || 'GET') !== 'POST' && cfg.query) { const u = new URL(cfg.url); for (const [k, v] of Object.entries(cfg.query)) u.searchParams.set(k, String(v)); url = u.toString(); }
  const opts = { method: cfg.method || 'GET', headers: cfg.headers || {} };
  if ((cfg.method || 'GET') === 'POST' && cfg.body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(cfg.body); }
  const json = await getJSON(url, opts);
  const ask = num(pick(json, cfg.askPath)), bid = num(pick(json, cfg.bidPath || cfg.askPath));
  if (ask === null && bid === null) return [];
  return [{ source: 'plenti-web', venue: 'plenti', coin: coin.toUpperCase(), fiat: fiat.toUpperCase(),
    type: 'platform', feeBasis: 'web-published', ask, totalAsk: ask, bid, totalBid: bid, time: Date.now() / 1000 | 0, isBuda: false }];
}

// --- Orquestador ------------------------------------------------------------
const RETAIL = [
  (c, f, v) => fetchCriptoya(c, f, v), (c, f) => fetchBuda(c, f), (c, f) => fetchBitso(c, f),
  (c, f, v) => fetchBinanceP2P(c, f, v), (c, f) => fetchOkxP2P(c, f), (c, f) => fetchBybitP2P(c, f),
  (c, f) => Promise.resolve(fetchManual(c, f)), (c, f) => fetchPlenti(c, f),
];
const RETAIL_IDS = ['criptoya', 'buda-direct', 'bitso-direct', 'binance-p2p-direct', 'okx-p2p-direct', 'bybit-p2p-direct', 'manual', 'plenti-web'];
function pickBuda(rows) { return rows.find((r) => r.isBuda && r.source === 'buda-direct') || rows.find((r) => r.isBuda) || null; }
function withDeltas(rows) {
  const buda = pickBuda(rows);
  return rows.map((r) => { const o = { ...r };
    if (buda && r.venue !== 'buda') {
      if (r.totalAsk != null && buda.totalAsk) { o.buyDeltaCop = +(r.totalAsk - buda.totalAsk).toFixed(2); o.buyDeltaPct = +(((r.totalAsk - buda.totalAsk) / buda.totalAsk) * 100).toFixed(3); }
      if (r.totalBid != null && buda.totalBid) { o.sellDeltaCop = +(r.totalBid - buda.totalBid).toFixed(2); o.sellDeltaPct = +(((r.totalBid - buda.totalBid) / buda.totalBid) * 100).toFixed(3); }
    } return o; });
}
function flagDiscrepancies(rows) {
  const byVenue = {}; for (const r of rows) (byVenue[r.venue] = byVenue[r.venue] || []).push(r);
  for (const list of Object.values(byVenue)) {
    if (list.length < 2) continue;
    const asks = list.map((r) => r.totalAsk).filter((v) => v != null); if (asks.length < 2) continue;
    const mn = Math.min(...asks), mx = Math.max(...asks); const d = mn ? +(((mx - mn) / mn) * 100).toFixed(3) : 0;
    list.forEach((r) => { r.crossCheckPct = d; });
  } return rows;
}
async function gather(coin, volume) {
  const settled = await Promise.allSettled(RETAIL.map((fn) => fn(coin, FIAT, volume)));
  const rows = [], errors = [];
  settled.forEach((res, i) => { if (res.status === 'fulfilled') rows.push(...res.value);
    else errors.push({ source: RETAIL_IDS[i], error: String(res.reason && res.reason.message || res.reason) }); });
  return { rows: flagDiscrepancies(withDeltas(rows)), errors };
}

// --- B2B: Mural -------------------------------------------------------------
async function fetchMural(fiatAmount) {
  const KEY = process.env.MURAL_API_KEY; if (!KEY) throw new Error('define MURAL_API_KEY');
  const BASE = process.env.MURAL_API_BASE || 'https://api.muralpay.com';
  const out = [];
  for (const rail of ['cop', 'cop-bre-b']) {
    try {
      const arr = await getJSON(`${BASE}/api/payouts/fees/fiat-to-token`, { method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiatFeeRequests: [{ fiatAmount, tokenSymbol: 'USDC', fiatAndRailCode: rail }] }) });
      const q = Array.isArray(arr) ? arr[0] : null; if (!q || q.type !== 'success') continue;
      const tokenReq = num(q.estimatedTokenAmountRequired && q.estimatedTokenAmountRequired.tokenAmount);
      const fa = num(q.fiatAmount && q.fiatAmount.fiatAmount) || fiatAmount;
      out.push({ provider: 'mural', direction: 'USDC->COP', token: 'USDC', fiat: 'COP', rail,
        quotedRatePerToken: num(q.exchangeRate), feePct: num(q.exchangeFeePercentage),
        transactionFeeToken: num(q.transactionFee && q.transactionFee.tokenAmount),
        allInRatePerToken: tokenReq ? +(fa / tokenReq).toFixed(2) : null,
        minToken: num(q.minTransactionValue && q.minTransactionValue.tokenAmount), time: Date.now() / 1000 | 0 });
    } catch (_) { /* rail no disponible */ }
  }
  if (!out.length) throw new Error('Mural sin cotizaciones (revisar API key / rieles)');
  return out;
}
const B2B_PENDING = [
  { id: 'cobre', label: 'Cobre', note: 'API B2B con credenciales; Mural liquida COP vía cop-cobre-balance' },
  { id: 'supra', label: 'Supra', note: 'paytech cross-border pymes (respaldo Citi); tasa por operación, sin API pública' },
];

// --- Servidor HTTP nativo (sin dependencias) --------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
function sendJSON(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(buf);
  });
}
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => resolve(d)); });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  try {
    if (p === '/health') return sendJSON(res, 200, { ok: true });

    if (p === '/api/quotes') {
      const volume = num(u.searchParams.get('volume')) || DEFAULT_VOLUME;
      const data = {}; for (const coin of COINS) data[coin] = await gather(coin, volume);
      return sendJSON(res, 200, { fiat: FIAT.toUpperCase(), volume, generatedAt: Date.now(),
        sourcesActive: RETAIL_IDS.map((id) => ({ id })),
        sourcesPending: [{ id: 'littio', label: 'Littio' }, { id: 'viio', label: 'VIIO' }, { id: 'wenia', label: 'Wenia' }], data });
    }

    if (p === '/api/cbp-benchmark') {
      const fiatAmount = num(u.searchParams.get('fiatAmount')) || 4000000;
      let rows = [], errors = [];
      try { rows = await fetchMural(fiatAmount); } catch (e) { errors.push({ provider: 'mural', error: String(e.message || e) }); }
      return sendJSON(res, 200, { fiatAmount, generatedAt: Date.now(),
        providersActive: process.env.MURAL_API_KEY ? [{ id: 'mural', label: 'Mural Pay' }] : [], providersPending: B2B_PENDING, rows, errors });
    }

    if (p === '/api/platform-rates' && req.method === 'GET')
      return sendJSON(res, 200, { known: MANUAL_KNOWN, staleHours: MANUAL_STALE_HOURS, stored: manualRead() });
    if (p === '/api/platform-rates' && req.method === 'POST') {
      const body = await readBody(req); let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'JSON inválido' }); }
      try { return sendJSON(res, 200, { ok: true, saved: manualRecord(parsed) }); }
      catch (e) { return sendJSON(res, 400, { ok: false, error: String(e.message || e) }); }
    }

    // Estáticos: / -> index.html ; /cbp.html ; etc. (solo dentro de esta carpeta)
    let file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    file = path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, '');
    const abs = path.join(__dirname, file);
    if (!abs.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
    return sendFile(res, abs);
  } catch (err) {
    return sendJSON(res, 502, { error: 'Error interno', detail: String(err && err.message || err) });
  }
});

server.listen(PORT, () => console.log(`Comparador escuchando en :${PORT}`));
