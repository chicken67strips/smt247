// Dedicated Railway backend for the fictional-stock game.
// This project intentionally contains NO real-stock ticker mappings or routes.
// Fictional stocks are simulated here; crypto and commodities use real data.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 8080;
app.use(express.json({ limit: "25kb" }));

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
};
const asNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

async function fetchJson(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

function randomNormal() {
  const u = Math.max(Math.random(), Number.EPSILON);
  const v = Math.max(Math.random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function withRsi(candles, period = 14) {
  if (!Array.isArray(candles)) return [];
  let averageGain = 0;
  let averageLoss = 0;
  return candles.map((candle, index) => {
    const output = { ...candle };
    if (index === 0) return output;
    const prior = Number(candles[index - 1].c ?? candles[index - 1].close);
    const current = Number(candle.c ?? candle.close);
    const change = current - prior;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (index <= period) {
      averageGain += gain / period;
      averageLoss += loss / period;
      if (index < period) return output;
    } else {
      averageGain = ((averageGain * (period - 1)) + gain) / period;
      averageLoss = ((averageLoss * (period - 1)) + loss) / period;
    }
    output.rsi = averageLoss === 0 ? 100 : round(100 - (100 / (1 + averageGain / averageLoss)), 2);
    return output;
  });
}

function makeRealCandle(timestamp, open, high, low, close, volume, session) {
  const o = round(open, 8);
  const h = round(Math.max(high, open, close, low), 8);
  const l = round(Math.min(low, open, close, high), 8);
  const c = round(close, 8);
  const v = Math.max(0, Number(volume) || 0);
  return {
    t: timestamp,
    ts: timestamp,
    time: timestamp,
    timestamp,
    datetime: new Date(timestamp * 1000).toISOString(),
    o, h, l, c, v,
    open: o, high: h, low: l, close: c, volume: v,
    session
  };
}

// ============================
// Real cryptocurrency
// ============================
const CRYPTO_SYMBOLS = ["BTC", "ETH", "SOL", "DOGE", "LTC"];
const CRYPTO_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  DOGE: "dogecoin",
  LTC: "litecoin"
};
const COINBASE_PRODUCTS = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
  DOGE: "DOGE-USD",
  LTC: "LTC-USD"
};
const cryptoPriceCache = {};
const cryptoCandleCache = new Map();
const CRYPTO_PRICE_TTL_MS = 1500;
const CRYPTO_CANDLE_TTL_MS = 8000;
const CRYPTO_PROVIDER_MAX_AGE_MS = 2 * 60 * 1000;
const COINGECKO_PROVIDER_MAX_AGE_MS = 5 * 60 * 1000;

function cryptoProviderTimeIsCurrent(timestampMs, maxAgeMs = CRYPTO_PROVIDER_MAX_AGE_MS) {
  const value = Number(timestampMs);
  if (!Number.isFinite(value) || value <= 0) return false;
  const age = Date.now() - value;
  return age >= -30000 && age <= maxAgeMs;
}

function cryptoRowIsCurrent(row, maxAgeMs = COINGECKO_PROVIDER_MAX_AGE_MS) {
  if (!row || !(asNumber(row.price) > 0)) return false;
  const providerTimeMs = (asNumber(row.lastUpdated) || 0) * 1000;
  const receivedAtMs = asNumber(row.receivedAtMs) || 0;
  return cryptoProviderTimeIsCurrent(providerTimeMs, maxAgeMs)
    && receivedAtMs > 0
    && Date.now() - receivedAtMs <= maxAgeMs;
}

function normalizeCryptoSymbol(value) {
  const symbol = String(value || "").toUpperCase().replace(/[^A-Z]/g, "");
  return CRYPTO_SYMBOLS.includes(symbol) ? symbol : "";
}

async function fetchBinanceTicker(symbol, host) {
  const response = await fetchJson(
    `https://${host}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol + "USDT")}`,
    { headers: { Accept: "application/json" } },
    6500
  );
  if (!response.ok || !response.data) throw new Error(`${host} HTTP ${response.status}`);
  const price = asNumber(response.data.lastPrice);
  if (!(price > 0)) throw new Error(`${host} returned no price`);
  const providerTimeMs = asNumber(response.data.closeTime);
  if (!cryptoProviderTimeIsCurrent(providerTimeMs)) {
    throw new Error(`${host} returned a stale ${symbol} quote`);
  }
  return {
    symbol,
    price,
    change24h: asNumber(response.data.priceChangePercent) || 0,
    volume24h: asNumber(response.data.quoteVolume) || 0,
    source: host.includes("binance.us") ? "Binance.US" : "Binance",
    lastUpdated: Math.floor(providerTimeMs / 1000),
    receivedAtMs: Date.now()
  };
}

async function fetchCoinbaseTicker(symbol) {
  const product = COINBASE_PRODUCTS[symbol];
  if (!product) throw new Error(`Coinbase does not support ${symbol}`);

  const [tickerResult, statsResult] = await Promise.allSettled([
    fetchJson(
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/ticker`,
      { headers: { Accept: "application/json", "User-Agent": "Godly-Exchange/1.0" } },
      7000
    ),
    fetchJson(
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/stats`,
      { headers: { Accept: "application/json", "User-Agent": "Godly-Exchange/1.0" } },
      7000
    )
  ]);

  if (tickerResult.status !== "fulfilled" || !tickerResult.value.ok) {
    throw new Error(`Coinbase ${symbol} ticker unavailable`);
  }

  const ticker = tickerResult.value.data || {};
  const price = asNumber(ticker.price);
  const providerTimeMs = Date.parse(String(ticker.time || ""));
  if (!(price > 0)) throw new Error(`Coinbase returned no ${symbol} price`);
  if (!cryptoProviderTimeIsCurrent(providerTimeMs)) {
    throw new Error(`Coinbase returned a stale ${symbol} trade`);
  }

  const stats = statsResult.status === "fulfilled" && statsResult.value.ok
    ? (statsResult.value.data || {})
    : {};
  const open = asNumber(stats.open);
  const baseVolume = asNumber(stats.volume);

  return {
    symbol,
    price,
    change24h: open > 0 ? ((price - open) / open) * 100 : 0,
    volume24h: baseVolume >= 0 ? baseVolume * price : 0,
    source: "Coinbase Exchange USD spot",
    lastUpdated: Math.floor(providerTimeMs / 1000),
    receivedAtMs: Date.now()
  };
}

async function fetchCoinGeckoPrices(symbols) {
  const ids = symbols.map(symbol => CRYPTO_IDS[symbol]).filter(Boolean);
  const response = await fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_last_updated_at=true`,
    { headers: { Accept: "application/json", "User-Agent": "Godly-Exchange/1.0" } },
    8000
  );
  if (!response.ok || !response.data) throw new Error(`CoinGecko HTTP ${response.status}`);
  const rows = {};
  for (const symbol of symbols) {
    const row = response.data[CRYPTO_IDS[symbol]];
    const price = row && asNumber(row.usd);
    const providerTimeMs = row && asNumber(row.last_updated_at) * 1000;
    if (price > 0 && cryptoProviderTimeIsCurrent(providerTimeMs, COINGECKO_PROVIDER_MAX_AGE_MS)) {
      rows[symbol] = {
        symbol,
        price,
        change24h: asNumber(row.usd_24h_change) || 0,
        volume24h: asNumber(row.usd_24h_vol) || 0,
        source: "CoinGecko",
        lastUpdated: asNumber(row.last_updated_at) || Math.floor(Date.now() / 1000),
        receivedAtMs: Date.now()
      };
    }
  }
  return rows;
}

async function getCryptoPrices(symbols, force = false) {
  const now = Date.now();
  const wanted = symbols.filter(symbol => CRYPTO_SYMBOLS.includes(symbol));
  // Even with fresh=1, do not hammer ten provider endpoints every 1.25 seconds.
  // Four seconds is still responsive while keeping the public feeds reliable.
  const refreshTtlMs = force ? 4000 : CRYPTO_PRICE_TTL_MS;
  const needs = wanted.filter(symbol => !cryptoRowIsCurrent(cryptoPriceCache[symbol]) || now - cryptoPriceCache[symbol].receivedAtMs > refreshTtlMs);
  if (needs.length) {
    const failed = [];
    await Promise.all(needs.map(async symbol => {
      try {
        let row;
        try { row = await fetchBinanceTicker(symbol, "api.binance.com"); }
        catch (_) { row = await fetchCoinbaseTicker(symbol); }
        cryptoPriceCache[symbol] = row;
      } catch (error) {
        failed.push(symbol);
      }
    }));
    if (failed.length) {
      try {
        const fallback = await fetchCoinGeckoPrices(failed);
        Object.assign(cryptoPriceCache, fallback);
      } catch (_) {}
    }
  }
  const prices = {};
  for (const symbol of wanted) {
    if (cryptoRowIsCurrent(cryptoPriceCache[symbol])) prices[symbol] = cryptoPriceCache[symbol];
  }
  return { success: Object.keys(prices).length > 0, prices, updatedAt: Math.floor(Date.now() / 1000) };
}

async function getCryptoCandles(symbol, interval) {
  const intervalMap = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "1d": "1d" };
  if (!intervalMap[interval]) return { symbol, interval, error: "Unsupported crypto interval." };
  const cacheKey = `${symbol}:${interval}`;
  const cached = cryptoCandleCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CRYPTO_CANDLE_TTL_MS) return { ...cached.data, cached: true };

  let lastError = null;
  for (const host of ["api.binance.com", "api.binance.us"]) {
    try {
      const response = await fetchJson(
        `https://${host}/api/v3/klines?symbol=${encodeURIComponent(symbol + "USDT")}&interval=${intervalMap[interval]}&limit=500`,
        { headers: { Accept: "application/json" } },
        8000
      );
      if (!response.ok || !Array.isArray(response.data)) throw new Error(`${host} HTTP ${response.status}`);
      const candles = response.data.map(row => makeRealCandle(
        Math.floor(Number(row[0]) / 1000), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5]), "crypto"
      )).filter(candle => candle.o > 0 && candle.h > 0 && candle.l > 0 && candle.c > 0);
      if (!candles.length) throw new Error("No usable crypto candles.");
      const data = {
        success: true,
        symbol,
        ticker: symbol,
        interval,
        candles: withRsi(candles),
        source: host.includes("binance.us") ? "Binance.US" : "Binance",
        assetType: "crypto",
        extendedHoursIncluded: true,
        indicators: { rsiPeriod: 14, rsiSource: "candle-close" }
      };
      cryptoCandleCache.set(cacheKey, { at: Date.now(), data });
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  if (cached) return { ...cached.data, cached: true, stale: true };
  return { symbol, interval, error: lastError ? lastError.message : "Crypto candle request failed." };
}

// ============================
// Real commodities
// ============================
const COMMODITIES = {
  GOLD: { yahoo: "GC=F", name: "Gold Spot", unit: "per troy oz", min: 100, max: 10000 },
  SILVER: { yahoo: "SI=F", name: "Silver Spot", unit: "per troy oz", min: 1, max: 1000 },
  OIL: { yahoo: "CL=F", name: "WTI Crude Oil", unit: "per barrel", min: 1, max: 1000 }
};
const commodityPriceCache = {};
const commodityCandleCache = new Map();
const COMMODITY_PRICE_TTL_MS = 10000;
const COMMODITY_CANDLE_TTL_MS = 15000;

function normalizeCommodityTicker(value) {
  const ticker = String(value || "").toUpperCase().replace(/[^A-Z]/g, "");
  return COMMODITIES[ticker] ? ticker : "";
}

function validCommodityPrice(ticker, value) {
  const definition = COMMODITIES[ticker];
  const price = Number(value);
  return Boolean(definition && Number.isFinite(price) && price >= definition.min && price <= definition.max);
}

async function fetchYahooChart(yahooSymbol, range, interval) {
  let lastError = null;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const response = await fetchJson(
        `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=true&events=div%2Csplits&_=${Date.now()}`,
        { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } },
        8500
      );
      const chart = response.data && response.data.chart;
      const result = chart && Array.isArray(chart.result) && chart.result[0];
      if (!response.ok || !result) throw new Error(chart?.error?.description || `Yahoo HTTP ${response.status}`);
      return result;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error("Yahoo request failed.");
}

async function refreshCommodityTicker(ticker, force = false) {
  const cached = commodityPriceCache[ticker];
  if (!force && cached && Date.now() - cached.receivedAtMs < COMMODITY_PRICE_TTL_MS) return cached;
  const definition = COMMODITIES[ticker];
  try {
    const result = await fetchYahooChart(definition.yahoo, "1d", "1m");
    const meta = result.meta || {};
    const quote = result.indicators?.quote?.[0] || {};
    const closes = Array.isArray(quote.close) ? quote.close.filter(value => validCommodityPrice(ticker, value)) : [];
    const price = asNumber(meta.regularMarketPrice) || closes[closes.length - 1];
    if (!validCommodityPrice(ticker, price)) throw new Error("Yahoo returned an invalid commodity price.");
    const prevClose = asNumber(meta.previousClose) || asNumber(meta.chartPreviousClose) || price;
    const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    commodityPriceCache[ticker] = {
      ticker,
      name: definition.name,
      assetType: "commodity",
      price: round(price, 6),
      prevClose: round(prevClose, 6),
      changePct: round(changePct, 2),
      unit: definition.unit,
      source: "Yahoo Finance commodity futures",
      lastUpdated: asNumber(meta.regularMarketTime) || Math.floor(Date.now() / 1000),
      receivedAtMs: Date.now()
    };
    return commodityPriceCache[ticker];
  } catch (error) {
    if (cached) return { ...cached, stale: true, providerError: error.message };
    throw error;
  }
}

async function getCommodityCandles(ticker, requestedInterval) {
  const intervals = {
    "1m": { yahoo: "1m", range: "5d" },
    "5m": { yahoo: "5m", range: "5d" },
    "15m": { yahoo: "15m", range: "1mo" },
    "30m": { yahoo: "30m", range: "1mo" },
    "1h": { yahoo: "60m", range: "3mo" },
    "1d": { yahoo: "1d", range: "2y" }
  };
  const config = intervals[requestedInterval];
  if (!config) return { ticker, interval: requestedInterval, error: "Unsupported commodity interval." };
  const key = `${ticker}:${requestedInterval}`;
  const cached = commodityCandleCache.get(key);
  if (cached && Date.now() - cached.at < COMMODITY_CANDLE_TTL_MS) return { ...cached.data, cached: true };
  try {
    const result = await fetchYahooChart(COMMODITIES[ticker].yahoo, config.range, config.yahoo);
    const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
    const quote = result.indicators?.quote?.[0] || {};
    const candles = [];
    for (let index = 0; index < timestamps.length; index += 1) {
      const o = asNumber(quote.open?.[index]);
      const h = asNumber(quote.high?.[index]);
      const l = asNumber(quote.low?.[index]);
      const c = asNumber(quote.close?.[index]);
      if (![o, h, l, c].every(value => validCommodityPrice(ticker, value))) continue;
      candles.push(makeRealCandle(Number(timestamps[index]), o, h, l, c, asNumber(quote.volume?.[index]) || 0, "commodity"));
    }
    if (!candles.length) throw new Error("Yahoo returned no usable commodity candles.");
    const data = {
      success: true,
      ticker,
      interval: requestedInterval,
      candles: withRsi(candles.slice(-500)),
      commodity: true,
      assetType: "commodity",
      source: "Yahoo Finance commodity futures",
      extendedHoursIncluded: true,
      indicators: { rsiPeriod: 14, rsiSource: "candle-close" }
    };
    commodityCandleCache.set(key, { at: Date.now(), data });
    return data;
  } catch (error) {
    if (cached) return { ...cached.data, cached: true, stale: true };
    return { ticker, interval: requestedInterval, commodity: true, error: error.message };
  }
}

// ============================
// Fictional stock exchange
// ============================
const GAME_MS_PER_MINUTE = 5000;
const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = 10080;
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const FICTIONAL_TRADE_SECRET = String(process.env.FICTIONAL_MARKET_SECRET || "");
const STATE_FILE = String(
  process.env.FICTIONAL_STATE_FILE ||
  (fs.existsSync("/data") ? "/data/fictional-market-state.json" : path.join(process.cwd(), "fictional-market-state.json"))
);
const CLOCK_START_MINUTE = clamp(Math.floor(Number(process.env.FICTIONAL_CLOCK_START_MINUTE) || 0), 0, MINUTES_PER_WEEK - 1);
const FICTIONAL_INTERVALS = {
  "1m": { minutes: 1, limit: 540 },
  "5m": { minutes: 5, limit: 576 },
  "15m": { minutes: 15, limit: 672 },
  "30m": { minutes: 30, limit: 672 },
  "1h": { minutes: 60, limit: 720 },
  "1d": { minutes: 1440, limit: 420 }
};

const INITIAL_COMPANIES = [
  ["AURX", "Aurix Semiconductor", "Technology", "mega", 186.0, 122.40, 0.24, 0.43, 0.000, 0.82],
  ["NBLT", "Northbolt Energy", "Energy", "mega", 128.0, 74.80, 0.08, 0.27, 0.031, 0.90],
  ["VRTN", "Veriton Health", "Healthcare", "mega", 151.0, 96.30, 0.14, 0.25, 0.012, 0.88],
  ["HBRM", "HarborMart Retail", "Consumer Defensive", "mega", 94.0, 58.25, 0.055, 0.16, 0.026, 0.94],
  ["QNTA", "QuantaGrid Utilities", "Utilities", "mega", 112.0, 43.60, 0.045, 0.12, 0.043, 0.98],
  ["STRL", "Starline Aerospace", "Industrials", "mega", 84.0, 88.10, 0.12, 0.31, 0.006, 0.83],
  ["CDRM", "Cedar Mutual Banking", "Financials", "mega", 76.0, 51.90, 0.065, 0.18, 0.032, 0.95],
  ["PLSE", "Pulse Social", "Communication Services", "mid", 35.0, 29.75, 0.19, 0.52, 0.000, 0.58],
  ["FRGE", "ForgeWorks Industrial", "Industrials", "mid", 43.0, 67.35, 0.075, 0.24, 0.018, 0.83],
  ["VYNE", "Veyne Pharma", "Healthcare", "mid", 27.0, 38.80, 0.15, 0.46, 0.000, 0.62],
  ["BLNK", "BlueLink Logistics", "Industrials", "mid", 31.0, 46.20, 0.09, 0.25, 0.013, 0.78],
  ["CRST", "Crestline Insurance", "Financials", "mid", 39.0, 72.15, 0.06, 0.17, 0.036, 0.93],
  ["OMNI", "Omnitech Systems", "Technology", "mid", 52.0, 84.45, 0.17, 0.36, 0.004, 0.72],
  ["GRVL", "Greenvale Foods", "Consumer Defensive", "mid", 24.0, 33.90, 0.04, 0.15, 0.039, 0.92],
  ["RIVR", "Rivermark Beverages", "Consumer Defensive", "mid", 29.0, 55.10, 0.05, 0.18, 0.028, 0.90],
  ["AXON", "Axonix Robotics", "Technology", "mid", 21.0, 41.25, 0.22, 0.55, 0.000, 0.55],
  ["SUNV", "Sunvale Solar", "Energy", "mid", 18.0, 24.70, 0.13, 0.49, 0.000, 0.57],
  ["MTRX", "Matrix Cloud", "Technology", "mid", 47.0, 91.60, 0.18, 0.38, 0.000, 0.68],
  ["KNTC", "Kinetic Motors", "Consumer Cyclical", "mid", 33.0, 62.40, 0.07, 0.35, 0.009, 0.73],
  ["ECHO", "Echo Entertainment", "Communication Services", "small", 8.2, 18.35, 0.03, 0.42, 0.000, 0.48],
  ["SERA", "Sera Beauty", "Consumer Cyclical", "small", 6.7, 27.20, 0.11, 0.32, 0.000, 0.59],
  ["TRNX", "Terranex Mining", "Materials", "small", 9.4, 14.85, -0.025, 0.47, 0.021, 0.52],
  ["ALTO", "Alto Telecom", "Communication Services", "small", 12.0, 22.10, 0.025, 0.20, 0.052, 0.80],
  ["BRCK", "Brickhouse Construction", "Industrials", "small", 7.5, 31.65, 0.06, 0.34, 0.015, 0.61],
  ["NEON", "Neon Gaming", "Communication Services", "small", 5.3, 16.90, 0.21, 0.61, 0.000, 0.39],
  ["WAVE", "Wavefront Media", "Communication Services", "small", 4.8, 12.75, -0.04, 0.51, 0.000, 0.43],
  ["PRSM", "Prism Security", "Technology", "small", 11.0, 36.50, 0.16, 0.41, 0.000, 0.55],
  ["GLDR", "Gilder Properties REIT", "Real Estate", "small", 13.0, 25.40, 0.035, 0.19, 0.064, 0.84],
  ["BCRX", "Beacon BioScience", "Healthcare", "small", 3.4, 9.80, -0.13, 0.72, 0.000, 0.30],
  ["NEXA", "Nexa Defense", "Industrials", "small", 14.0, 48.75, 0.10, 0.29, 0.012, 0.72]
];

const IPO_NAME_PARTS = {
  Technology: [["Vector", "Logic"], ["Nimbus", "Data"], ["Cipher", "Labs"], ["Nova", "Compute"]],
  Healthcare: [["Lumen", "Therapeutics"], ["Arbor", "Medical"], ["Helix", "Bio"], ["Cobalt", "Health"]],
  Industrials: [["Summit", "Machines"], ["Ironwood", "Systems"], ["Atlas", "Freight"], ["Pioneer", "Works"]],
  Financials: [["Granite", "Financial"], ["Oakline", "Bank"], ["Meridian", "Payments"], ["Crown", "Insurance"]],
  Energy: [["Everlight", "Power"], ["Redstone", "Energy"], ["Horizon", "Resources"], ["Tidal", "Renewables"]],
  Consumer: [["Willow", "Brands"], ["Brighton", "Foods"], ["Juniper", "Retail"], ["Mosaic", "Goods"]]
};

let marketState = null;
let saveTimer = null;
let lastPeriodicSaveAt = Date.now();

function sessionForMinute(totalMinute) {
  const dayIndex = Math.floor(totalMinute / MINUTES_PER_DAY);
  const weekdayIndex = ((dayIndex % 7) + 7) % 7;
  const minuteOfDay = ((totalMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (weekdayIndex >= 5) return "closed";
  if (minuteOfDay >= 240 && minuteOfDay < 570) return "pre-market";
  if (minuteOfDay >= 570 && minuteOfDay < 960) return "open";
  if (minuteOfDay >= 960 && minuteOfDay < 1200) return "after-hours";
  return "closed";
}

function nextSessionText(dayOfWeekIndex, minuteOfDay, session) {
  if (dayOfWeekIndex >= 5) return "Next pre-market: Monday 4:00 AM ET";
  if (session === "pre-market") return "Regular market opens at 9:30 AM ET";
  if (session === "open") return "Regular market closes at 4:00 PM ET";
  if (session === "after-hours") return "After-hours closes at 8:00 PM ET";
  if (minuteOfDay < 240) return "Pre-market opens at 4:00 AM ET";
  if (dayOfWeekIndex === 4) return "Next pre-market: Monday 4:00 AM ET";
  return `Next pre-market: ${DAY_NAMES[dayOfWeekIndex + 1]} 4:00 AM ET`;
}

function marketClock(nowMs = Date.now()) {
  const anchor = Number(marketState?.clockAnchorRealMs) || nowMs;
  const elapsedGameSeconds = Math.max(0, (nowMs - anchor) * 60 / GAME_MS_PER_MINUTE);
  const totalMinutes = Math.floor(elapsedGameSeconds / 60);
  const gameSecond = Math.floor(elapsedGameSeconds % 60);
  const dayIndex = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const minuteOfDay = totalMinutes % MINUTES_PER_DAY;
  const dayOfWeekIndex = dayIndex % 7;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const session = sessionForMinute(totalMinutes);
  const displayHour = ((hour + 11) % 12) + 1;
  const exactTime = `${displayHour}:${String(minute).padStart(2, "0")}:${String(gameSecond).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
  return {
    totalMinutes, gameSecond, dayIndex, dayOfWeekIndex,
    dayName: DAY_NAMES[dayOfWeekIndex],
    week: Math.floor(dayIndex / 7) + 1,
    minuteOfDay, hour, minute, exactTime, session,
    label: session === "open" ? "MARKET OPEN" : session === "pre-market" ? "PRE-MARKET" : session === "after-hours" ? "AFTER HOURS" : "MARKET CLOSED",
    isWeekday: dayOfWeekIndex < 5,
    isOpen: session !== "closed",
    isRegularHours: session === "open",
    isTradingAllowed: session !== "closed",
    nextEventText: nextSessionText(dayOfWeekIndex, minuteOfDay, session)
  };
}

function companyFromSeed(seed, listedGameMinute = 0) {
  const [ticker, name, sector, capGroup, valueBillions, ipoPrice, annualGrowth, annualVolatility, dividendYield, liquidity] = seed;
  const companyValue = valueBillions * 1e9;
  const sharesOutstanding = companyValue / ipoPrice;
  return {
    ticker, name, sector, capGroup, companyValue, sharesOutstanding,
    price: ipoPrice, prevClose: ipoPrice, initialPrice: ipoPrice,
    annualGrowth, annualVolatility, dividendYield,
    quarterlyDividend: dividendYield > 0 ? ipoPrice * dividendYield / 4 : 0,
    liquidity,
    profitability: annualGrowth < -0.05 ? "loss-making" : annualGrowth > 0.15 ? "high-growth" : "profitable",
    listedGameMinute,
    ipoWeek: Math.floor(listedGameMinute / MINUTES_PER_WEEK) + 1,
    ipoPrice,
    ipoActiveUntil: listedGameMinute + MINUTES_PER_DAY,
    temporaryGrowth: 0,
    temporaryGrowthUntil: 0,
    buyVolume: 0,
    sellVolume: 0,
    candles: {}
  };
}

function initialNews(companies) {
  const events = [
    ["AURX", "Aurix Semiconductor opens the week with strong chip demand", "Sector outlook", "positive", "Demand supports a high-growth outlook, but the shares remain volatile."],
    ["QNTA", "QuantaGrid Utilities confirms its quarterly dividend policy", "Dividend update", "positive", "The low-volatility utility continues to prioritize stable cash returns."],
    ["BCRX", "Beacon BioScience warns that its next trial milestone carries execution risk", "Clinical risk", "negative", "The loss-making biotech may react sharply to future research updates."],
    ["NBLT", "Northbolt Energy begins a new capacity expansion program", "Capital investment", "neutral", "The investment may lift long-term value while increasing near-term spending."],
    ["GLDR", "Gilder Properties REIT reports steady tenant collections", "Operating update", "positive", "Stable collections support the company's higher dividend profile."],
    ["NEON", "Neon Gaming prepares a major product launch", "Product pipeline", "neutral", "The small-cap company has high upside potential and high event risk."]
  ];
  return events.map(([ticker, headline, eventType, sentiment, summary]) => ({
    id: crypto.randomUUID(), ticker, displayTicker: ticker,
    assetType: "fictional-stock", fictional: true,
    companyName: companies[ticker].name, sector: companies[ticker].sector,
    headline, summary, eventType, eventText: "Opening company brief",
    expectedResult: "Player order flow and later company events will determine the traded price.",
    sentiment, impactPct: 0, gameDayName: "Monday", gameTime: "12:00:00 AM",
    publishedAtGameMinute: 0, publishedAt: Math.floor(Date.now() / 1000), url: ""
  }));
}

function newMarketState() {
  const companies = {};
  for (const seed of INITIAL_COMPANIES) companies[seed[0]] = companyFromSeed(seed, 0);
  return {
    version: 3,
    clockAnchorRealMs: Date.now() - CLOCK_START_MINUTE * GAME_MS_PER_MINUTE,
    lastUpdatedGameMinute: CLOCK_START_MINUTE,
    lastIpoWeek: Math.floor(CLOCK_START_MINUTE / MINUTES_PER_WEEK) + 1,
    nextNewsGameMinute: CLOCK_START_MINUTE + 120,
    companies,
    news: initialNews(companies),
    tradeReceipts: {}
  };
}

function saveStateNow() {
  if (!marketState) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const temporary = `${STATE_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(marketState));
    fs.renameSync(temporary, STATE_FILE);
  } catch (error) {
    console.error(`[FICTIONAL] State save failed: ${error.message}`);
  }
}

function queueSave(delayMs = 1000) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStateNow();
  }, delayMs);
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed?.companies || !parsed.clockAnchorRealMs) throw new Error("state is missing required fields");
    marketState = parsed;
    marketState.news = Array.isArray(marketState.news) ? marketState.news : [];
    marketState.tradeReceipts = marketState.tradeReceipts || {};
    console.log(`[FICTIONAL] Loaded ${Object.keys(marketState.companies).length} companies from persistent state.`);
  } catch (error) {
    marketState = newMarketState();
    saveStateNow();
    console.log(`[FICTIONAL] Started a new dedicated 30-company market (${error.code || error.message}).`);
  }
}

function marketStateName(session) {
  return session === "open" ? "REGULAR" : session === "pre-market" ? "PRE" : session === "after-hours" ? "POST" : "CLOSED";
}

function companyRow(company, clock = marketClock()) {
  const fairPrice = company.companyValue / company.sharesOutstanding;
  const changePct = company.prevClose > 0 ? ((company.price - company.prevClose) / company.prevClose) * 100 : 0;
  const ipoActive = clock.totalMinutes < Number(company.ipoActiveUntil || 0);
  return {
    ticker: company.ticker,
    companyName: company.name,
    name: company.name,
    sector: company.sector,
    capGroup: company.capGroup,
    assetType: "fictional-stock",
    fictional: true,
    price: round(company.price, 4),
    fairValue: round(fairPrice, 4),
    companyValue: round(company.companyValue, 2),
    marketCap: round(company.price * company.sharesOutstanding, 2),
    sharesOutstanding: round(company.sharesOutstanding, 0),
    floatShares: round(company.sharesOutstanding * 0.76, 0),
    publicFloat: round(company.sharesOutstanding * 0.76, 0),
    prevClose: round(company.prevClose, 4),
    changePct: round(changePct, 2),
    annualGrowth: round(company.annualGrowth * 100, 2),
    volatility: round(company.annualVolatility * 100, 2),
    volatilityBand: company.annualVolatility >= 0.48 ? "High" : company.annualVolatility <= 0.22 ? "Low" : "Medium",
    dividendYield: round(company.dividendYield * 100, 2),
    quarterlyDividend: round(company.quarterlyDividend, 4),
    paysDividend: company.dividendYield > 0,
    profitability: company.profitability,
    liquidity: round(company.liquidity, 3),
    buyVolume: round(company.buyVolume, 3),
    sellVolume: round(company.sellVolume, 3),
    ipoPrice: round(company.ipoPrice, 4),
    ipoWeek: company.ipoWeek,
    ipoActive,
    marketState: ipoActive ? "IPO" : marketStateName(clock.session),
    session: clock.session,
    source: "Godly Exchange Simulation",
    lastUpdated: Math.floor(Date.now() / 1000)
  };
}

function candleRecord(bucketMinute, open, high, low, close, volume, session) {
  const dayIndex = Math.floor(bucketMinute / MINUTES_PER_DAY);
  const minuteOfDay = ((bucketMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const o = round(open, 4);
  const h = round(Math.max(high, open, close, low), 4);
  const l = round(Math.max(0.01, Math.min(low, open, close, high)), 4);
  const c = round(close, 4);
  const v = Math.max(1, Math.round(volume));
  return {
    t: bucketMinute * 60, ts: bucketMinute * 60, time: bucketMinute * 60, timestamp: bucketMinute * 60,
    datetime: `${DAY_NAMES[((dayIndex % 7) + 7) % 7]} ${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`,
    o, h, l, c, v, open: o, high: h, low: l, close: c, volume: v, session,
    gameDayIndex: dayIndex,
    gameDayName: DAY_NAMES[((dayIndex % 7) + 7) % 7],
    gameMinuteOfDay: minuteOfDay
  };
}

function ensureCandleSeries(company, intervalKey) {
  company.candles = company.candles || {};
  if (Array.isArray(company.candles[intervalKey]) && company.candles[intervalKey].length) return company.candles[intervalKey];
  const spec = FICTIONAL_INTERVALS[intervalKey];
  if (!spec) return [];
  const nowMinute = marketClock().totalMinutes;
  const buckets = [];
  let cursor = Math.floor(nowMinute / spec.minutes) * spec.minutes;
  let safety = 0;
  while (buckets.length < 220 && safety < 50000) {
    const session = sessionForMinute(cursor);
    if (intervalKey === "1d" || session !== "closed") buckets.push(cursor);
    cursor -= spec.minutes;
    safety += 1;
  }
  buckets.reverse();
  const series = [];
  let price = Math.max(0.05, Number(company.initialPrice || company.price));
  for (const bucket of buckets) {
    const session = sessionForMinute(bucket);
    const open = price;
    const scale = company.annualVolatility * Math.sqrt(spec.minutes / (252 * 960));
    price = Math.max(0.05, open * Math.exp(company.annualGrowth * spec.minutes / (252 * 960) + randomNormal() * scale));
    const wick = Math.abs(randomNormal()) * scale * open * 0.45;
    series.push(candleRecord(bucket, open, Math.max(open, price) + wick, Math.min(open, price) - wick, price, 1000 + Math.random() * 80000, session === "closed" ? "regular" : session));
  }
  if (series.length) {
    const ratio = company.price / series[series.length - 1].close;
    for (const candle of series) {
      candle.open = candle.o = round(candle.open * ratio, 4);
      candle.high = candle.h = round(candle.high * ratio, 4);
      candle.low = candle.l = round(candle.low * ratio, 4);
      candle.close = candle.c = round(candle.close * ratio, 4);
    }
  }
  company.candles[intervalKey] = series.slice(-spec.limit);
  return company.candles[intervalKey];
}

function updateCandles(company, priorPrice, price, clock, playerVolume = 0) {
  for (const [intervalKey, spec] of Object.entries(FICTIONAL_INTERVALS)) {
    const series = ensureCandleSeries(company, intervalKey);
    const bucket = Math.floor(clock.totalMinutes / spec.minutes) * spec.minutes;
    const current = series[series.length - 1];
    const currentBucket = current ? current.gameDayIndex * MINUTES_PER_DAY + current.gameMinuteOfDay : null;
    const volume = Math.max(1, Math.round((120 + Math.random() * 900) * spec.minutes * company.liquidity + playerVolume));
    if (!current || currentBucket !== bucket) {
      series.push(candleRecord(bucket, priorPrice, Math.max(priorPrice, price), Math.min(priorPrice, price), price, volume, clock.session));
      if (series.length > spec.limit) series.splice(0, series.length - spec.limit);
    } else {
      current.high = current.h = round(Math.max(current.high, price), 4);
      current.low = current.l = round(Math.min(current.low, price), 4);
      current.close = current.c = round(price, 4);
      current.volume = current.v = Math.round((current.volume || 0) + volume);
      current.session = clock.session;
    }
  }
}

function updateCompany(company, elapsedGameMinutes, clock) {
  if (!(elapsedGameMinutes > 0)) return;
  const effectiveGrowth = company.annualGrowth + (clock.totalMinutes < Number(company.temporaryGrowthUntil || 0) ? Number(company.temporaryGrowth || 0) : 0);
  const valueMove = effectiveGrowth * elapsedGameMinutes / (365 * MINUTES_PER_DAY) +
    company.annualVolatility * 0.28 * randomNormal() * Math.sqrt(elapsedGameMinutes / (365 * MINUTES_PER_DAY));
  company.companyValue = Math.max(2e6, company.companyValue * Math.exp(valueMove));
  if (!clock.isTradingAllowed) return;
  const fairPrice = company.companyValue / company.sharesOutstanding;
  const randomMove = company.annualVolatility * (clock.session === "open" ? 1 : 0.52) * randomNormal() * Math.sqrt(elapsedGameMinutes / (252 * 960));
  const fairPull = ((fairPrice - company.price) / Math.max(company.price, 0.01)) * clamp(elapsedGameMinutes / 240, 0, 0.22);
  const prior = company.price;
  company.price = Math.max(0.05, company.price * Math.exp(randomMove + fairPull));
  updateCandles(company, prior, company.price, clock);
}

function newsTemplate(positive) {
  const templates = positive ? [
    ["raises its outlook after stronger demand", "raised guidance", 0.035],
    ["reports a major customer agreement", "new contract", 0.028],
    ["beats internal revenue expectations", "earnings beat", 0.042],
    ["announces an efficiency breakthrough", "operating improvement", 0.024],
    ["wins favorable analyst coverage", "analyst upgrade", 0.018]
  ] : [
    ["cuts its outlook as demand softens", "lowered guidance", -0.038],
    ["faces an unexpected product delay", "product delay", -0.027],
    ["misses internal revenue expectations", "earnings miss", -0.043],
    ["reports rising operating costs", "margin pressure", -0.022],
    ["receives an analyst downgrade", "analyst downgrade", -0.019]
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

function generateCompanyNews(clock) {
  const companies = Object.values(marketState.companies);
  if (!companies.length) return;
  const company = companies[Math.floor(Math.random() * companies.length)];
  const positive = Math.random() < (company.annualGrowth < 0 ? 0.38 : 0.55);
  const [phrase, eventType, baseShock] = newsTemplate(positive);
  const magnitude = baseShock * (0.70 + Math.random() * 0.75) * (0.75 + company.annualVolatility);
  company.companyValue = Math.max(2e6, company.companyValue * (1 + magnitude));
  company.temporaryGrowth = clamp(magnitude * 1.8, -0.12, 0.12);
  company.temporaryGrowthUntil = clock.totalMinutes + 720;
  const article = {
    id: crypto.randomUUID(), ticker: company.ticker, displayTicker: company.ticker,
    assetType: "fictional-stock", fictional: true,
    companyName: company.name, sector: company.sector,
    headline: `${company.name} ${phrase}`,
    summary: `${company.name} announced a ${eventType}. Investors are reassessing the company's value and forward growth assumptions.`,
    eventType,
    eventText: positive ? "Positive company event" : "Negative company event",
    expectedResult: positive ? "Company value and buying interest may rise." : "Company value and buying interest may fall.",
    sentiment: positive ? "positive" : "negative",
    impactPct: round(magnitude * 100, 2),
    gameDayName: clock.dayName, gameTime: clock.exactTime,
    publishedAtGameMinute: clock.totalMinutes,
    publishedAt: Math.floor(Date.now() / 1000), url: ""
  };
  marketState.news.unshift(article);
  marketState.news = marketState.news.slice(0, 300);
  marketState.nextNewsGameMinute = clock.totalMinutes + 90 + Math.floor(Math.random() * 151);
  console.log(`[FICTIONAL NEWS] ${article.headline} (${article.impactPct}%)`);
  queueSave();
}

function tickerFromName(name) {
  const words = String(name).toUpperCase().replace(/[^A-Z ]/g, "").split(/\s+/).filter(Boolean);
  let base = words.length > 1 ? words[0].slice(0, 2) + words[1].slice(0, 2) : words[0].slice(0, 4);
  base = (base + "XAAA").slice(0, 4);
  if (!marketState.companies[base]) return base;
  for (let index = 0; index < 100; index += 1) {
    const ticker = `${base.slice(0, 3)}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;
    if (!marketState.companies[ticker]) return ticker;
  }
  return `I${String(Object.keys(marketState.companies).length).padStart(3, "0").slice(-3)}`;
}

function createWeeklyIpo(week, clock) {
  const sectors = Object.keys(IPO_NAME_PARTS);
  const sectorKey = sectors[Math.floor(Math.random() * sectors.length)];
  const choices = IPO_NAME_PARTS[sectorKey];
  const parts = choices[Math.floor(Math.random() * choices.length)];
  let name = `${parts[0]} ${parts[1]}`;
  if (Object.values(marketState.companies).some(company => company.name === name)) name += ` Group ${week}`;
  const ticker = tickerFromName(name);
  const valueBillions = round(0.8 + Math.random() * 18, 3);
  const sharesMillions = 45 + Math.random() * 480;
  const companyValue = valueBillions * 1e9;
  const ipoPrice = clamp(companyValue / (sharesMillions * 1e6), 4, 180);
  const annualGrowth = clamp(-0.09 + Math.random() * 0.34, -0.12, 0.28);
  const volatility = clamp(0.20 + Math.random() * 0.48, 0.18, 0.74);
  const dividendYield = annualGrowth < 0.11 && Math.random() < 0.38 ? 0.01 + Math.random() * 0.05 : 0;
  const capGroup = valueBillions >= 15 ? "mid" : "small";
  const company = companyFromSeed([
    ticker, name, sectorKey === "Consumer" ? "Consumer Cyclical" : sectorKey,
    capGroup, valueBillions, ipoPrice, annualGrowth, volatility, dividendYield,
    0.35 + Math.random() * 0.48
  ], clock.totalMinutes);
  company.sharesOutstanding = sharesMillions * 1e6;
  company.companyValue = company.sharesOutstanding * ipoPrice;
  company.price = company.prevClose = company.initialPrice = ipoPrice;
  marketState.companies[ticker] = company;
  marketState.news.unshift({
    id: crypto.randomUUID(), ticker, displayTicker: ticker,
    assetType: "fictional-stock", fictional: true,
    companyName: name, sector: company.sector,
    headline: `${name} lists on the exchange at $${round(ipoPrice, 2).toFixed(2)}`,
    summary: `The Week ${week} IPO values ${name} at $${round(company.companyValue / 1e9, 2)}B. Its opening price equals company value divided by shares outstanding.`,
    eventType: "IPO", eventText: "Weekly IPO",
    expectedResult: "Early trading may be more volatile while players discover a price.",
    sentiment: "neutral", impactPct: 0,
    gameDayName: clock.dayName, gameTime: clock.exactTime,
    publishedAtGameMinute: clock.totalMinutes,
    publishedAt: Math.floor(Date.now() / 1000), url: ""
  });
  marketState.news = marketState.news.slice(0, 300);
  marketState.lastIpoWeek = week;
  console.log(`[FICTIONAL IPO] Week ${week}: ${ticker} ${name} at $${ipoPrice.toFixed(2)}`);
  queueSave(0);
}

function engineStep() {
  if (!marketState) return;
  const clock = marketClock();
  const elapsedGameMinutes = clamp(clock.totalMinutes - Number(marketState.lastUpdatedGameMinute || 0), 0, MINUTES_PER_DAY);
  if (elapsedGameMinutes > 0) {
    for (const company of Object.values(marketState.companies)) updateCompany(company, elapsedGameMinutes, clock);
    marketState.lastUpdatedGameMinute = clock.totalMinutes;
  }
  if (clock.totalMinutes >= Number(marketState.nextNewsGameMinute || 0)) generateCompanyNews(clock);
  const reachedListingWindow = clock.dayOfWeekIndex < 5 && (clock.dayOfWeekIndex > 0 || clock.minuteOfDay >= 570);
  if (clock.week > Number(marketState.lastIpoWeek || 1) && reachedListingWindow) createWeeklyIpo(clock.week, clock);
  if (clock.minuteOfDay === 960 && clock.dayOfWeekIndex < 5 && Number(marketState.lastCloseDayIndex) !== clock.dayIndex) {
    for (const company of Object.values(marketState.companies)) company.prevClose = company.price;
    marketState.lastCloseDayIndex = clock.dayIndex;
  }
  if (Date.now() - lastPeriodicSaveAt >= 30000) {
    lastPeriodicSaveAt = Date.now();
    queueSave();
  }
}

function normalizeFictionalTicker(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
}

function authorizeFictionalTrade(req, res) {
  if (!FICTIONAL_TRADE_SECRET) {
    res.status(503).json({ success: false, error: "FICTIONAL_MARKET_SECRET is not configured." });
    return false;
  }
  const supplied = String(req.get("x-fictional-market-secret") || req.body?.secret || "");
  const expectedBuffer = Buffer.from(FICTIONAL_TRADE_SECRET);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    res.status(401).json({ success: false, error: "Unauthorized." });
    return false;
  }
  return true;
}

// ============================
// Roblox group-role synchronization
// ============================
const ROBLOX_GROUP_ID = String(process.env.ROBLOX_GROUP_ID || "15696460");
const ROBLOX_OPEN_CLOUD_API_KEY = String(process.env.ROBLOX_OPEN_CLOUD_API_KEY || "");
const GROUP_SYNC_SECRET = String(process.env.GROUP_SYNC_SECRET || "");

function roleCandidates(environmentName, ...fallbacks) {
  return [...new Set([process.env[environmentName], ...fallbacks].map(value => String(value || "").trim()).filter(Boolean))];
}

const ROLE_CANDIDATES = {
  "Intern Trader": roleCandidates("GROUP_ROLE_INTERN_NAME", "Intern Trader", "Intern"),
  "Rookie Trader": roleCandidates("GROUP_ROLE_ROOKIE_NAME", "Rookie Trader"),
  "Intermediate Trader": roleCandidates("GROUP_ROLE_INTERMEDIATE_NAME", "Intermediate Trader"),
  "Day Trader": roleCandidates("GROUP_ROLE_DAY_TRADER_NAME", "Day Trader"),
  "Professional Trader": roleCandidates("GROUP_ROLE_PROFESSIONAL_NAME", "Professional Trader"),
  "Top Trader at GCF": roleCandidates("GROUP_ROLE_TOP_TRADER_NAME", "Top Trader at GCF", "Top Trader"),
  "Trading Firm Manager at GCF": roleCandidates("GROUP_ROLE_TRADING_MANAGER_NAME", "Trading Firm Manager at GCF", "Trading Firm Manager"),
  "Chief Financial Officer at GCF": roleCandidates("GROUP_ROLE_CFO_NAME", "Chief Financial Officer at GCF", "Chief Financial Officer"),
  "Chief Executive Officer at GCF": roleCandidates("GROUP_ROLE_CEO_NAME", "Chief Executive Officer at GCF", "Chief Executive Officer"),
  "Independent Professional Trader": roleCandidates("GROUP_ROLE_INDEPENDENT_NAME", "Independent Professional Trader"),
  "Multi-Millionaire Trader": roleCandidates("GROUP_ROLE_MULTI_MILLIONAIRE_NAME", "Multi-Millionaire Trader")
};
const ROLE_ALIASES = {
  "intern": "Intern Trader", "intern trader": "Intern Trader",
  "rookie": "Rookie Trader", "rookie trader": "Rookie Trader",
  "intermediate": "Intermediate Trader", "intermediate trader": "Intermediate Trader",
  "day trader": "Day Trader", "professional trader": "Professional Trader",
  "top trader": "Top Trader at GCF", "top trader at gcf": "Top Trader at GCF",
  "trading firm manager": "Trading Firm Manager at GCF", "trading firm manager at gcf": "Trading Firm Manager at GCF",
  "chief financial officer": "Chief Financial Officer at GCF", "chief financial officer at gcf": "Chief Financial Officer at GCF",
  "chief executive officer": "Chief Executive Officer at GCF", "chief executive officer at gcf": "Chief Executive Officer at GCF",
  "independent professional trader": "Independent Professional Trader",
  "multi millionaire trader": "Multi-Millionaire Trader", "multi-millionaire trader": "Multi-Millionaire Trader"
};

function normalizeGameRole(value) {
  const raw = String(value || "").replace(/^\d+\.\s*/, "").trim();
  if (ROLE_CANDIDATES[raw]) return raw;
  return ROLE_ALIASES[raw.toLowerCase().replace(/\s+/g, " ").trim()] || "";
}

function groupAuthorized(req) {
  if (!GROUP_SYNC_SECRET) return false;
  return String(req.get("x-gc-group-sync-secret") || req.body?.secret || "") === GROUP_SYNC_SECRET;
}

async function openCloud(url, options = {}) {
  if (!ROBLOX_OPEN_CLOUD_API_KEY) throw new Error("ROBLOX_OPEN_CLOUD_API_KEY is not configured.");
  const response = await fetchJson(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "x-api-key": ROBLOX_OPEN_CLOUD_API_KEY,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  }, 12000);
  if (!response.ok) {
    const error = new Error(String(response.data?.message || response.data?.error || response.data?.raw || `Open Cloud HTTP ${response.status}`));
    error.status = response.status;
    error.data = response.data;
    throw error;
  }
  return response.data || {};
}

function roleResource(role) {
  const resource = String(role?.path || role?.name || "");
  if (/^groups\/\d+\/roles\/\d+$/.test(resource)) return resource;
  const id = String(role?.id || role?.roleId || "");
  return /^\d+$/.test(id) ? `groups/${ROBLOX_GROUP_ID}/roles/${id}` : "";
}

async function getGroupRoles() {
  const roles = {};
  let pageToken = "";
  do {
    const data = await openCloud(`https://apis.roblox.com/cloud/v2/groups/${ROBLOX_GROUP_ID}/roles?maxPageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    for (const role of data.groupRoles || data.roles || data.data || []) {
      const displayName = String(role.displayName || role.roleName || role.name || "").replace(/^groups\/\d+\/roles\/\d+$/, "").trim();
      const resource = roleResource(role);
      if (displayName && resource) roles[displayName] = { displayName, resource, rank: Number(role.rank || 0) };
    }
    pageToken = String(data.nextPageToken || "");
  } while (pageToken);
  return roles;
}

function membershipResource(membership) {
  const resource = String(membership?.path || membership?.name || "");
  if (/^groups\/\d+\/memberships\/[A-Za-z0-9_-]+$/.test(resource)) return resource;
  const id = String(membership?.id || membership?.membershipId || membership?.groupMembershipId || "");
  return id ? `groups/${ROBLOX_GROUP_ID}/memberships/${id}` : "";
}

function membershipUserId(membership) {
  const direct = Number(membership?.userId || membership?.memberUserId || membership?.user?.id || membership?.user?.userId);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const match = String(membership?.user?.path || membership?.user?.name || membership?.user || membership?.userPath || "").match(/users\/(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function findMembership(userId) {
  const filters = [`user == "users/${userId}"`, `user=='users/${userId}'`];
  for (const filter of filters) {
    try {
      const data = await openCloud(`https://apis.roblox.com/cloud/v2/groups/${ROBLOX_GROUP_ID}/memberships?maxPageSize=25&filter=${encodeURIComponent(filter)}`);
      const found = (data.groupMemberships || data.memberships || data.data || []).find(item => membershipUserId(item) === userId);
      if (found && membershipResource(found)) return { membership: found, resource: membershipResource(found), lookupMethod: "filter" };
    } catch (_) {}
  }
  let pageToken = "";
  for (let page = 0; page < 25; page += 1) {
    const data = await openCloud(`https://apis.roblox.com/cloud/v2/groups/${ROBLOX_GROUP_ID}/memberships?maxPageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    const found = (data.groupMemberships || data.memberships || data.data || []).find(item => membershipUserId(item) === userId);
    if (found && membershipResource(found)) return { membership: found, resource: membershipResource(found), lookupMethod: "groupScan" };
    pageToken = String(data.nextPageToken || "");
    if (!pageToken) break;
  }
  const error = new Error(`No group membership found for user ${userId}.`);
  error.status = 404;
  throw error;
}

async function assignGroupRole(userId, desiredRoleResource) {
  const lookup = await findMembership(userId);
  const currentRoles = [lookup.membership.role, lookup.membership.topRole, ...(lookup.membership.roles || [])]
    .map(role => typeof role === "string" ? role : roleResource(role));
  if (currentRoles.includes(desiredRoleResource)) return { ...lookup, method: "alreadyAssigned" };
  await openCloud(`https://apis.roblox.com/cloud/v2/${lookup.resource}:assignRole`, {
    method: "POST",
    body: JSON.stringify({ role: desiredRoleResource })
  });
  return { ...lookup, method: "assignRole" };
}

// ============================
// Routes
// ============================
app.get("/health", (_req, res) => {
  const clock = marketClock();
  res.json({
    status: "ok",
    backend: "dedicated-fictional-exchange",
    companyCount: Object.keys(marketState.companies).length,
    gameWeek: clock.week,
    gameDay: clock.dayName,
    gameTime: clock.exactTime,
    session: clock.session,
    persistentStateFile: STATE_FILE,
    fictionalTradeSecretConfigured: Boolean(FICTIONAL_TRADE_SECRET),
    groupSyncConfigured: Boolean(GROUP_SYNC_SECRET && ROBLOX_OPEN_CLOUD_API_KEY),
    cryptoCached: Object.keys(cryptoPriceCache).length,
    commodityCached: Object.keys(commodityPriceCache).length
  });
});

app.get("/crypto/prices", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const symbols = String(req.query.symbols || CRYPTO_SYMBOLS.join(","))
    .toUpperCase().replace(/\s+/g, "").replace(/\+/g, ",").split(",")
    .map(normalizeCryptoSymbol).filter(Boolean);
  const unique = [...new Set(symbols.length ? symbols : CRYPTO_SYMBOLS)];
  res.json(await getCryptoPrices(unique, req.query.fresh === "1" || req.query.fresh === "true"));
});

app.get("/crypto/debug", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const symbol = normalizeCryptoSymbol(req.query.symbol || "BTC");
  if (!symbol) return res.status(400).json({ error: "Unsupported crypto symbol." });
  const result = await getCryptoPrices([symbol], true);
  const row = result.prices && result.prices[symbol];
  res.json({
    symbol,
    price: row && row.price,
    source: row && row.source,
    providerTimestamp: row && row.lastUpdated,
    receivedAtMs: row && row.receivedAtMs,
    providerAgeSeconds: row && row.lastUpdated
      ? Math.max(0, Math.floor(Date.now() / 1000) - Number(row.lastUpdated))
      : null,
    error: row ? null : "No current validated quote was returned."
  });
});

app.get("/crypto/candles", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const symbol = normalizeCryptoSymbol(req.query.symbol || req.query.ticker || "BTC");
  if (!symbol) return res.status(400).json({ error: "Unsupported crypto symbol." });
  res.json(await getCryptoCandles(symbol, String(req.query.interval || "1m").toLowerCase()));
});

app.get("/commodity/prices", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const force = req.query.fresh === "1" || req.query.fresh === "true";
  await Promise.allSettled(Object.keys(COMMODITIES).map(ticker => refreshCommodityTicker(ticker, force)));
  const prices = {};
  for (const ticker of Object.keys(COMMODITIES)) if (commodityPriceCache[ticker]) prices[ticker] = commodityPriceCache[ticker];
  res.json({ success: Object.keys(prices).length > 0, prices, source: "Yahoo Finance commodity futures", updatedAt: Math.floor(Date.now() / 1000) });
});

app.get("/commodity/price", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const ticker = normalizeCommodityTicker(req.query.ticker);
  if (!ticker) return res.status(400).json({ error: "Unknown commodity ticker." });
  try { res.json(await refreshCommodityTicker(ticker, req.query.fresh === "1")); }
  catch (error) { res.status(502).json({ ticker, error: error.message }); }
});

app.get("/commodity/candles", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const ticker = normalizeCommodityTicker(req.query.ticker);
  if (!ticker) return res.status(400).json({ error: "Unknown commodity ticker." });
  res.json(await getCommodityCandles(ticker, String(req.query.interval || "1m").toLowerCase()));
});

app.get("/fictional/market/status", (_req, res) => {
  engineStep();
  const clock = marketClock();
  res.json({
    success: true,
    ...clock,
    second: clock.gameSecond,
    timeText: `${clock.dayName} | ${clock.exactTime} ET`,
    holidaysIgnored: true,
    realSecondsPerGameMinute: GAME_MS_PER_MINUTE / 1000,
    realSecondsPerGameDay: 7200,
    companyCount: Object.keys(marketState.companies).length,
    lastIpoWeek: marketState.lastIpoWeek,
    nextNewsGameMinute: marketState.nextNewsGameMinute
  });
});

app.get("/fictional/prices", (_req, res) => {
  engineStep();
  const clock = marketClock();
  const prices = {};
  for (const company of Object.values(marketState.companies)) prices[company.ticker] = companyRow(company, clock);
  res.json(prices);
});

app.get("/fictional/price", (req, res) => {
  engineStep();
  const ticker = normalizeFictionalTicker(req.query.ticker);
  const company = marketState.companies[ticker];
  if (!company) return res.status(404).json({ error: "Unknown fictional ticker." });
  res.json(companyRow(company));
});

app.get("/fictional/candles", (req, res) => {
  engineStep();
  const ticker = normalizeFictionalTicker(req.query.ticker);
  const interval = String(req.query.interval || "1m").toLowerCase();
  const company = marketState.companies[ticker];
  if (!company) return res.status(404).json({ ticker, interval, error: "Unknown fictional ticker." });
  if (!FICTIONAL_INTERVALS[interval]) return res.status(400).json({ ticker, interval, error: "Unsupported interval." });
  res.json({
    success: true,
    ticker,
    interval,
    fictional: true,
    companyName: company.name,
    candles: withRsi(ensureCandleSeries(company, interval)),
    indicators: { rsiPeriod: 14, rsiSource: "candle-close" }
  });
});

app.get("/fictional/news/all", (req, res) => {
  engineStep();
  const limit = clamp(Math.floor(Number(req.query.limit) || 80), 1, 200);
  res.json({ success: true, fictional: true, articles: marketState.news.slice(0, limit) });
});

app.get("/fictional/news", (req, res) => {
  engineStep();
  const ticker = normalizeFictionalTicker(req.query.ticker);
  if (CRYPTO_SYMBOLS.includes(ticker)) {
    return res.json({ success: true, ticker, assetType: "crypto", articles: [] });
  }
  if (!marketState.companies[ticker]) return res.status(404).json({ success: false, ticker, articles: [], error: "Unknown fictional ticker." });
  res.json({ success: true, fictional: true, ticker, articles: marketState.news.filter(article => article.ticker === ticker).slice(0, 60) });
});

app.get("/fictional/ipo/current", (_req, res) => {
  engineStep();
  const clock = marketClock();
  const company = Object.values(marketState.companies)
    .filter(item => Number(item.ipoWeek) === Number(marketState.lastIpoWeek))
    .sort((a, b) => Number(b.listedGameMinute) - Number(a.listedGameMinute))[0];
  res.json({ success: true, week: clock.week, ipo: company ? companyRow(company, clock) : null });
});

app.post("/fictional/trade", (req, res) => {
  if (!authorizeFictionalTrade(req, res)) return;
  engineStep();
  const ticker = normalizeFictionalTicker(req.body?.ticker);
  const side = String(req.body?.side || "").toLowerCase();
  const quantity = Number(req.body?.quantity);
  const requestId = String(req.body?.requestId || "").slice(0, 160);
  const company = marketState.companies[ticker];
  const clock = marketClock();
  if (!company) return res.status(404).json({ success: false, error: "Unknown fictional ticker." });
  if (side !== "buy" && side !== "sell") return res.status(400).json({ success: false, error: "Side must be buy or sell." });
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e9) return res.status(400).json({ success: false, error: "Invalid quantity." });
  if (!clock.isTradingAllowed) return res.status(409).json({ success: false, marketClosed: true, session: clock.session, error: "The fictional stock market is closed." });
  if (requestId && marketState.tradeReceipts[requestId]) return res.json(marketState.tradeReceipts[requestId]);

  const priorPrice = company.price;
  const notional = priorPrice * quantity;
  const liquidityNotional = Math.max(250000, company.companyValue * (0.00005 + company.liquidity * 0.00018));
  const rawImpact = (notional / liquidityNotional) * (0.0008 + company.annualVolatility * 0.0028);
  const sessionMultiplier = clock.session === "open" ? 1 : 1.7;
  const impact = clamp(rawImpact * sessionMultiplier, 0.00001, 0.075);
  const signedImpact = side === "buy" ? impact : -impact;
  const spread = (0.00025 + (1 - company.liquidity) * 0.0018) * sessionMultiplier;
  const executionPrice = priorPrice * (1 + (side === "buy" ? spread / 2 : -spread / 2) + signedImpact / 2);
  company.price = Math.max(0.05, priorPrice * (1 + signedImpact));
  if (side === "buy") company.buyVolume += quantity; else company.sellVolume += quantity;
  updateCandles(company, priorPrice, company.price, clock, quantity);
  const result = {
    success: true, requestId, ticker, side, quantity,
    executionPrice: round(executionPrice, 4),
    priorPrice: round(priorPrice, 4),
    newPrice: round(company.price, 4),
    impactPct: round(signedImpact * 100, 4),
    session: clock.session,
    market: companyRow(company, clock)
  };
  if (requestId) {
    marketState.tradeReceipts[requestId] = result;
    const ids = Object.keys(marketState.tradeReceipts);
    if (ids.length > 5000) for (const id of ids.slice(0, ids.length - 4000)) delete marketState.tradeReceipts[id];
  }
  queueSave();
  res.json(result);
});

app.get("/group-role/status", async (req, res) => {
  if (!groupAuthorized(req)) return res.status(401).json({ ok: false, error: "Unauthorized." });
  try {
    const roles = await getGroupRoles();
    res.json({ ok: true, groupId: ROBLOX_GROUP_ID, openCloudKeyPresent: Boolean(ROBLOX_OPEN_CLOUD_API_KEY), roleCandidates: ROLE_CANDIDATES, availableGroupRoles: Object.values(roles) });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message, details: error.data || null });
  }
});

app.post("/group-role/debug-user", async (req, res) => {
  if (!groupAuthorized(req)) return res.status(401).json({ ok: false, error: "Unauthorized." });
  const userId = Number(req.body?.userId);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ ok: false, error: "Invalid userId." });
  try {
    const lookup = await findMembership(userId);
    res.json({ ok: true, userId, groupId: ROBLOX_GROUP_ID, membershipResource: lookup.resource, membership: lookup.membership });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message, details: error.data || null });
  }
});

app.post("/group-role/sync", async (req, res) => {
  if (!groupAuthorized(req)) return res.status(401).json({ ok: false, error: "Unauthorized." });
  const userId = Number(req.body?.userId);
  const username = String(req.body?.username || "");
  const gameRole = normalizeGameRole(req.body?.role);
  const groupRank = Number(req.body?.groupRank);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ ok: false, error: "Invalid userId." });
  if (!gameRole) return res.status(400).json({ ok: false, error: "Invalid game role.", requestedRole: req.body?.role, allowedRoles: Object.keys(ROLE_CANDIDATES) });
  if (Number.isFinite(groupRank) && groupRank >= 255) return res.json({ ok: true, skipped: true, reason: "The group owner's role cannot be changed.", userId, username, gameRole });
  try {
    const roles = await getGroupRoles();
    const desired = ROLE_CANDIDATES[gameRole].map(name => roles[name]).find(Boolean);
    if (!desired) return res.status(400).json({ ok: false, error: `No matching group role exists for ${gameRole}.`, wantedGroupRoleNames: ROLE_CANDIDATES[gameRole], availableGroupRoles: Object.keys(roles) });
    const result = await assignGroupRole(userId, desired.resource);
    res.json({ ok: true, userId, username, gameRole, groupRole: desired.displayName, groupRoleResource: desired.resource, membershipResource: result.resource, lookupMethod: result.lookupMethod, syncMethod: result.method });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message, details: error.data || null });
  }
});

loadState();
setInterval(engineStep, 1000);

app.listen(PORT, () => {
  console.log(`[SERVER] Dedicated fictional exchange ready on port ${PORT}.`);
  console.log(`[SERVER] ${Object.keys(marketState.companies).length} fictional stocks; real crypto and commodities enabled.`);
});
