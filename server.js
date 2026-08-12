// Dedicated Railway backend for the fictional-stock game.
// This project intentionally contains NO real-stock ticker mappings or routes.
// Fictional stocks and crypto are simulated here. Crypto uses zero real-world crypto data.

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
// Fully fictional cryptocurrency
// ============================
// IMPORTANT:
// These assets are original in-game simulations. They have no mapping to any
// real cryptocurrency, and this section makes
// no outbound request to any real crypto-data provider.
//
// Crypto uses the same accelerated game clock as the stock simulation, but it
// trades 24/7, including fictional nights and weekends.
const CRYPTO_SYMBOLS = ["GYLD", "KRVN", "ZYPH", "QNTA", "VEXL"];

const FICTIONAL_CRYPTO_SEEDS = [
  {
    symbol: "GYLD",
    name: "Gyldra",
    initialPrice: 82.40,
    annualGrowth: 0.18,
    annualVolatility: 0.62,
    totalSupply: 25000000,
    liquidity: 0.95,
    baseVolumePerGameMinute: 46000
  },
  {
    symbol: "KRVN",
    name: "Korvane",
    initialPrice: 14.75,
    annualGrowth: 0.24,
    annualVolatility: 0.88,
    totalSupply: 90000000,
    liquidity: 0.82,
    baseVolumePerGameMinute: 76000
  },
  {
    symbol: "ZYPH",
    name: "Zyphra",
    initialPrice: 0.842,
    annualGrowth: 0.12,
    annualVolatility: 1.15,
    totalSupply: 1400000000,
    liquidity: 0.72,
    baseVolumePerGameMinute: 145000
  },
  {
    symbol: "QNTA",
    name: "Quentara",
    initialPrice: 235.60,
    annualGrowth: 0.20,
    annualVolatility: 0.55,
    totalSupply: 12000000,
    liquidity: 0.92,
    baseVolumePerGameMinute: 33000
  },
  {
    symbol: "VEXL",
    name: "Vexalon",
    initialPrice: 0.0315,
    annualGrowth: 0.05,
    annualVolatility: 1.85,
    totalSupply: 18000000000,
    liquidity: 0.58,
    baseVolumePerGameMinute: 390000
  }
];

function normalizeCryptoSymbol(value) {
  const symbol = String(value || "").toUpperCase().replace(/[^A-Z]/g, "");
  return CRYPTO_SYMBOLS.includes(symbol) ? symbol : "";
}

function makeFictionalCryptoFromSeed(seed) {
  const price = Math.max(0.00000001, Number(seed.initialPrice) || 1);
  return {
    symbol: seed.symbol,
    name: seed.name,
    initialPrice: price,
    price,
    dayOpenPrice: price,
    annualGrowth: Number(seed.annualGrowth) || 0,
    annualVolatility: Math.max(0.01, Number(seed.annualVolatility) || 0.5),
    totalSupply: Math.max(1, Number(seed.totalSupply) || 1),
    liquidity: clamp(Number(seed.liquidity) || 0.7, 0.05, 1),
    baseVolumePerGameMinute: Math.max(1, Number(seed.baseVolumePerGameMinute) || 10000),
    volume24h: 0,
    lastDayIndex: null,
    candles: {}
  };
}

function buildInitialSimulatedCryptoMap() {
  const cryptos = {};
  for (const seed of FICTIONAL_CRYPTO_SEEDS) {
    cryptos[seed.symbol] = makeFictionalCryptoFromSeed(seed);
  }
  return cryptos;
}

function ensureSimulatedCryptoState(state) {
  if (!state || typeof state !== "object") return;

  if (!state.cryptos || typeof state.cryptos !== "object" || Array.isArray(state.cryptos)) {
    state.cryptos = {};
  }

  for (const seed of FICTIONAL_CRYPTO_SEEDS) {
    let asset = state.cryptos[seed.symbol];
    if (!asset || typeof asset !== "object") {
      asset = makeFictionalCryptoFromSeed(seed);
      state.cryptos[seed.symbol] = asset;
    }

    asset.symbol = seed.symbol;
    asset.name = seed.name;

    if (!(asNumber(asset.initialPrice) > 0)) asset.initialPrice = seed.initialPrice;
    if (!(asNumber(asset.price) > 0)) asset.price = seed.initialPrice;
    if (!(asNumber(asset.dayOpenPrice) > 0)) asset.dayOpenPrice = asset.price;

    asset.annualGrowth = Number(seed.annualGrowth) || 0;
    asset.annualVolatility = Math.max(0.01, Number(seed.annualVolatility) || 0.5);
    asset.totalSupply = Math.max(1, Number(seed.totalSupply) || 1);
    asset.liquidity = clamp(Number(seed.liquidity) || 0.7, 0.05, 1);
    asset.baseVolumePerGameMinute = Math.max(1, Number(seed.baseVolumePerGameMinute) || 10000);
    asset.volume24h = Math.max(0, Number(asset.volume24h) || 0);
    asset.lastDayIndex = Number.isFinite(Number(asset.lastDayIndex))
      ? Number(asset.lastDayIndex)
      : null;
    asset.candles = asset.candles && typeof asset.candles === "object"
      ? asset.candles
      : {};
  }

  // Remove no-longer-supported fictional crypto entries if the catalog changes.
  for (const symbol of Object.keys(state.cryptos)) {
    if (!CRYPTO_SYMBOLS.includes(symbol)) {
      delete state.cryptos[symbol];
    }
  }
}

function makeFictionalCryptoCandle(bucketMinute, open, high, low, close, volume) {
  const safeBucket = Math.max(0, Math.floor(Number(bucketMinute) || 0));
  const dayIndex = Math.floor(safeBucket / MINUTES_PER_DAY);
  const dayOfWeekIndex = ((dayIndex % 7) + 7) % 7;
  const minuteOfDay = ((safeBucket % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;

  const o = round(Math.max(0.00000001, Number(open) || 0), 8);
  const c = round(Math.max(0.00000001, Number(close) || o), 8);
  const h = round(Math.max(o, c, Number(high) || o), 8);
  const l = round(Math.max(0.00000001, Math.min(o, c, Number(low) || o)), 8);
  const v = Math.max(0, Math.round(Number(volume) || 0));

  return {
    t: safeBucket * 60,
    ts: safeBucket * 60,
    time: safeBucket * 60,
    timestamp: safeBucket * 60,
    bucketMinute: safeBucket,
    datetime: `${DAY_NAMES[dayOfWeekIndex]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    o, h, l, c, v,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    session: "crypto",
    fictional: true,
    assetType: "crypto",
    gameDayIndex: dayIndex,
    gameDayName: DAY_NAMES[dayOfWeekIndex],
    gameMinuteOfDay: minuteOfDay
  };
}

function ensureCryptoCandleSeries(asset, intervalKey) {
  asset.candles = asset.candles || {};
  if (Array.isArray(asset.candles[intervalKey]) && asset.candles[intervalKey].length) {
    return asset.candles[intervalKey];
  }

  const spec = FICTIONAL_INTERVALS[intervalKey];
  if (!spec) return [];

  const nowMinute = marketClock().totalMinutes;
  const buckets = [];
  let cursor = Math.floor(nowMinute / spec.minutes) * spec.minutes;

  while (buckets.length < 220) {
    buckets.push(cursor);
    cursor -= spec.minutes;
  }

  buckets.reverse();

  const series = [];
  let price = Math.max(0.00000001, Number(asset.initialPrice || asset.price) || 1);

  for (const bucket of buckets) {
    const open = price;
    const elapsedMinutes = spec.minutes;
    const drift =
      asset.annualGrowth * elapsedMinutes / (365 * MINUTES_PER_DAY);
    const sigma =
      asset.annualVolatility * Math.sqrt(elapsedMinutes / (365 * MINUTES_PER_DAY));

    price = Math.max(
      0.00000001,
      open * Math.exp(drift + randomNormal() * sigma)
    );

    const wickSize = Math.abs(randomNormal()) * sigma * open * 0.55;
    const volume =
      asset.baseVolumePerGameMinute
      * elapsedMinutes
      * (0.55 + Math.random() * 0.90);

    series.push(
      makeFictionalCryptoCandle(
        bucket,
        open,
        Math.max(open, price) + wickSize,
        Math.max(0.00000001, Math.min(open, price) - wickSize),
        price,
        volume
      )
    );
  }

  if (series.length) {
    const lastClose = Number(series[series.length - 1].close) || asset.price;
    const ratio = lastClose > 0 ? asset.price / lastClose : 1;

    for (const candle of series) {
      candle.open = candle.o = round(candle.open * ratio, 8);
      candle.high = candle.h = round(candle.high * ratio, 8);
      candle.low = candle.l = round(Math.max(0.00000001, candle.low * ratio), 8);
      candle.close = candle.c = round(candle.close * ratio, 8);
    }
  }

  asset.candles[intervalKey] = series.slice(-spec.limit);
  return asset.candles[intervalKey];
}

function updateCryptoCandles(asset, priorPrice, price, clock, elapsedGameMinutes = 0) {
  for (const [intervalKey, spec] of Object.entries(FICTIONAL_INTERVALS)) {
    const series = ensureCryptoCandleSeries(asset, intervalKey);
    const bucket = Math.floor(clock.totalMinutes / spec.minutes) * spec.minutes;
    const current = series[series.length - 1];
    const currentBucket = current ? Number(current.bucketMinute) : null;

    const volume =
      asset.baseVolumePerGameMinute
      * Math.max(0, Number(elapsedGameMinutes) || 0)
      * (0.60 + Math.random() * 0.80);

    if (!current || currentBucket !== bucket) {
      series.push(
        makeFictionalCryptoCandle(
          bucket,
          priorPrice,
          Math.max(priorPrice, price),
          Math.min(priorPrice, price),
          price,
          volume
        )
      );
      if (series.length > spec.limit) {
        series.splice(0, series.length - spec.limit);
      }
    } else {
      current.high = current.h = round(Math.max(Number(current.high) || price, price), 8);
      current.low = current.l = round(
        Math.max(0.00000001, Math.min(Number(current.low) || price, price)),
        8
      );
      current.close = current.c = round(price, 8);
      current.volume = current.v = Math.round((Number(current.volume) || 0) + volume);
      current.session = "crypto";
      current.fictional = true;
      current.assetType = "crypto";
    }

    if (intervalKey === "1m") {
      asset.volume24h += volume;
    }
  }
}

function updateSimulatedCrypto(asset, elapsedGameMinutes, clock) {
  if (!(elapsedGameMinutes > 0)) return;

  if (Number(asset.lastDayIndex) !== clock.dayIndex) {
    asset.lastDayIndex = clock.dayIndex;
    asset.dayOpenPrice = Math.max(0.00000001, Number(asset.price) || asset.initialPrice);
    asset.volume24h = 0;
  }

  const prior = Math.max(0.00000001, Number(asset.price) || asset.initialPrice);

  const drift =
    asset.annualGrowth * elapsedGameMinutes / (365 * MINUTES_PER_DAY);

  const volatility =
    asset.annualVolatility
    * randomNormal()
    * Math.sqrt(elapsedGameMinutes / (365 * MINUTES_PER_DAY));

  // Very small mean reversion prevents a pure random walk from wandering into
  // absurd price ranges over long-lived servers while still allowing trends.
  const reference = Math.max(0.00000001, Number(asset.initialPrice) || prior);
  const referencePull =
    Math.log(reference / prior)
    * clamp(elapsedGameMinutes / (14 * MINUTES_PER_DAY), 0, 0.0015);

  asset.price = Math.max(
    0.00000001,
    prior * Math.exp(drift + volatility + referencePull)
  );

  updateCryptoCandles(asset, prior, asset.price, clock, elapsedGameMinutes);
}

function fictionalCryptoRow(asset) {
  const price = Math.max(0.00000001, Number(asset.price) || asset.initialPrice);
  const dayOpen = Math.max(0.00000001, Number(asset.dayOpenPrice) || price);

  return {
    symbol: asset.symbol,
    ticker: asset.symbol,
    name: asset.name,
    assetType: "crypto",
    fictional: true,
    simulated: true,
    price: round(price, 8),
    change24h: round(((price - dayOpen) / dayOpen) * 100, 4),
    volume24h: round(Math.max(0, Number(asset.volume24h) || 0) * price, 2),
    marketCap: round(price * Math.max(1, Number(asset.totalSupply) || 1), 2),
    source: "Godly Capital fictional crypto simulation",
    lastUpdated: Math.floor(Date.now() / 1000)
  };
}

async function getCryptoPrices(symbols) {
  engineStep();
  ensureSimulatedCryptoState(marketState);

  const wanted = symbols.filter(symbol => CRYPTO_SYMBOLS.includes(symbol));
  const prices = {};

  for (const symbol of wanted) {
    const asset = marketState.cryptos[symbol];
    if (asset) prices[symbol] = fictionalCryptoRow(asset);
  }

  return {
    success: Object.keys(prices).length > 0,
    fictional: true,
    simulated: true,
    streamHealthy: true,
    stale: false,
    source: "Godly Capital fictional crypto simulation",
    prices,
    updatedAt: Math.floor(Date.now() / 1000)
  };
}

async function getCryptoCandles(symbol, interval) {
  engineStep();
  ensureSimulatedCryptoState(marketState);

  if (!FICTIONAL_INTERVALS[interval]) {
    return {
      symbol,
      interval,
      fictional: true,
      error: "Unsupported crypto interval."
    };
  }

  const asset = marketState.cryptos[symbol];
  if (!asset) {
    return {
      symbol,
      interval,
      fictional: true,
      error: "Unknown fictional crypto symbol."
    };
  }

  return {
    success: true,
    symbol,
    ticker: symbol,
    name: asset.name,
    interval,
    fictional: true,
    simulated: true,
    assetType: "crypto",
    source: "Godly Capital fictional crypto simulation",
    extendedHoursIncluded: true,
    candles: withRsi(ensureCryptoCandleSeries(asset, interval)),
    indicators: {
      rsiPeriod: 14,
      rsiSource: "candle-close"
    }
  };
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
// Fictional stock exchange - MAIN GAME CATALOG
// ============================
// Stock prices/candles/news are fully simulated and are not derived from real-stock feeds.
// Crypto and commodities remain on their existing real-data code paths above.
const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = 10080;
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const REAL_SECONDS_PER_GAME_MINUTE = clamp(
  Number(process.env.FICTIONAL_REAL_SECONDS_PER_GAME_MINUTE) || 30,
  1,
  60
);
const GAME_MS_PER_MINUTE = REAL_SECONDS_PER_GAME_MINUTE * 1000;
const CLOCK_START_MINUTE = clamp(
  Math.floor(Number(process.env.FICTIONAL_CLOCK_START_MINUTE) || 570),
  0,
  MINUTES_PER_WEEK - 1
);
const FICTIONAL_CATALOG_VERSION = "main-game-current-tickers-v7-yahoo-handoff-nil-fix-2026-08-09";
const FICTIONAL_TRADE_SECRET = String(process.env.FICTIONAL_MARKET_SECRET || "");
const STATE_FILE = String(
  process.env.FICTIONAL_STATE_FILE ||
  (fs.existsSync("/data") ? "/data/fictional-market-state.json" : path.join(process.cwd(), "fictional-market-state.json"))
);
const AUTO_HANDOFF_RETRY_MS = clamp(
  Number(process.env.FICTIONAL_HANDOFF_RETRY_MS) || 15000,
  5000,
  120000
);

const HANDOFF_REAL_TICKERS = {
  ORNG: "AAPL",
  MHRD: "MSFT",
  MVDO: "NVDA",
  AMZG: "AMZN",
  ELPHT: "GOOGL",
  DATA: "META",
  NKLA: "TSLA",
  SKYX: "SPCX",
  BKSG: "BRK-B",
  HCC: "AVGO",
  ELLY: "LLY",
  PMK: "JPM",
  M: "V",
  FMT: "WMT",
  DVS: "UNH",
  WXM: "XOM",
  ABMD: "AMD",
  NFKS: "NFLX",
  BUM: "CRM",
  DGBE: "ADBE",
  REVL: "ORCL",
  MNEY: "COST",
  VKNEE: "DIS",
  BEAR: "BA",
  NICY: "NKE",
  PPL: "PYPL",
  INFO: "INTC",
  OVER: "UBER",
  WBAB: "ABNB",
  SMNY: "SBUX",
  BC: "KO",
  RBLX: "RBLX",
  CHHD: "SCHD",
  VSS: "VOO",
  MASK: "MASK",
  MNTS: "MNTS",
  DSY: "DSY",
  ERNA: "ERNA",
  CLDI: "CLDI",
  AZI: "AZI",
  DXST: "DXST",
  WCT: "WCT",
  AIXI: "AIXI",
  CODX: "CODX",
  GOVX: "GOVX",
  CHAI: "CHAI",
  CDLX: "CDLX",
  DCX: "DCX",
  CLPR: "CLPR"
};

const YAHOO_HANDOFF_CONCURRENCY = clamp(
  Number(process.env.YAHOO_HANDOFF_CONCURRENCY) || 6,
  1,
  10
);

const FICTIONAL_INTERVALS = {
  "1m": { minutes: 1, limit: 540 },
  "5m": { minutes: 5, limit: 576 },
  "15m": { minutes: 15, limit: 672 },
  "30m": { minutes: 30, limit: 672 },
  "1h": { minutes: 60, limit: 720 },
  "1d": { minutes: 1440, limit: 420 }
};

const INITIAL_COMPANIES = [
  ["ORNG", "Orange Inc.", "Technology", "mega", 310, 185.00, 0.1100, 0.2700, 0.0056, 0.96],
  ["MHRD", "MacroHard Corporation", "Technology", "mega", 430, 418.00, 0.1000, 0.2500, 0.0087, 0.97],
  ["MVDO", "Mvideo Corporation", "Technology", "mega", 280, 142.00, 0.1800, 0.4800, 0.0003, 0.91],
  ["AMZG", "Amazing.com Inc.", "Consumer Cyclical", "mega", 250, 205.00, 0.1300, 0.3400, 0.0000, 0.94],
  ["ELPHT", "Elephant Inc.", "Communication Services", "mega", 210, 172.00, 0.1200, 0.2900, 0.0049, 0.95],
  ["DATA", "Data Platforms Inc.", "Communication Services", "mega", 185, 465.00, 0.1600, 0.3600, 0.0045, 0.92],
  ["NKLA", "Nikola Inc.", "Consumer Cyclical", "mega", 115, 286.00, 0.1400, 0.5500, 0.0000, 0.86],
  ["SKYX", "Sky Examination Corporation", "Industrials", "mega", 150, 112.00, 0.2000, 0.6000, 0.0000, 0.68],
  ["BKSG", "Bookstore Getaways Inc.", "Financials", "mega", 275, 492.00, 0.0700, 0.1800, 0.0000, 0.98],
  ["HCC", "HiCap Communications Inc.", "Technology", "mega", 165, 318.00, 0.1500, 0.3600, 0.0074, 0.91],
  ["ELLY", "Elly and Company", "Healthcare", "mega", 145, 742.00, 0.1000, 0.3100, 0.0081, 0.93],
  ["PMK", "PJMonroe Kevin and Company", "Financials", "mega", 190, 242.00, 0.0700, 0.2000, 0.0231, 0.97],
  ["M", "Masters Inc.", "Financials", "mega", 155, 345.00, 0.0900, 0.2200, 0.0068, 0.96],
  ["FMT", "Floor-Mart Inc.", "Consumer Defensive", "mega", 130, 104.00, 0.0600, 0.1600, 0.0090, 0.98],
  ["DVS", "DividedShield Group Inc.", "Healthcare", "mega", 155, 355.00, 0.0700, 0.2500, 0.0249, 0.94],
  ["WXM", "Mobile Waxbar Corporation", "Energy", "mega", 125, 118.00, 0.0450, 0.2400, 0.0336, 0.95],
  ["ABMD", "Abnormally Massive Devices, Inc.", "Technology", "mid", 82, 158.00, 0.1700, 0.4500, 0.0000, 0.87],
  ["NFKS", "NutFlakes Inc.", "Communication Services", "mid", 76, 920.00, 0.1400, 0.4100, 0.0000, 0.86],
  ["BUM", "Buyers Union Inc.", "Technology", "mid", 68, 272.00, 0.1200, 0.3100, 0.0000, 0.84],
  ["DGBE", "Digobe Inc.", "Technology", "mid", 62, 405.00, 0.1000, 0.3000, 0.0000, 0.83],
  ["REVL", "Revelation Corporation", "Technology", "mid", 70, 182.00, 0.0900, 0.2800, 0.0110, 0.88],
  ["MNEY", "MoneyWise Wholesale Corporation", "Consumer Defensive", "mid", 79, 905.00, 0.0800, 0.2000, 0.0057, 0.92],
  ["VKNEE", "The Vaulted Knee Company", "Communication Services", "mid", 54, 116.00, 0.0400, 0.3100, 0.0172, 0.84],
  ["BEAR", "The Bearing Company", "Industrials", "mid", 58, 224.00, 0.0600, 0.3500, 0.0000, 0.82],
  ["NICY", "Nicely Inc.", "Consumer Cyclical", "mid", 48, 78.00, 0.0500, 0.3000, 0.0205, 0.85],
  ["PPL", "Peoples Holdings Inc", "Financials", "mid", 44, 73.00, 0.0800, 0.3600, 0.0000, 0.83],
  ["INFO", "Informed Corporation", "Technology", "mid", 46, 29.00, 0.0300, 0.4200, 0.0000, 0.89],
  ["OVER", "Over Technologies Inc.", "Technology", "mid", 52, 91.00, 0.1500, 0.4000, 0.0000, 0.82],
  ["WBAB", "Water Bread and Breakfast Inc.", "Consumer Cyclical", "mid", 39, 148.00, 0.0900, 0.3800, 0.0000, 0.74],
  ["SMNY", "SpaceMoney Corporation", "Consumer Cyclical", "mid", 37, 94.00, 0.0600, 0.3000, 0.0260, 0.81],
  ["BC", "The Bloxy-Cola Company", "Consumer Defensive", "mega", 105, 71.00, 0.0450, 0.1400, 0.0287, 0.98],
  ["RBLX", "Roblox Corporation", "Communication Services", "mid", 38, 72.00, 0.1200, 0.5100, 0.0000, 0.76],
  ["CHHD", "Chuck U.S. High Dividend ETF", "ETF", "mega", 92, 29.00, 0.0550, 0.1300, 0.0359, 0.99],
  ["VSS", "VehicleShield S&P 500 ETF", "ETF", "mega", 510, 615.00, 0.0800, 0.1400, 0.0117, 0.99],
  ["MASK", "MaskTech Industries", "Technology", "small", 7.2, 21.50, 0.1400, 0.5200, 0.0000, 0.52],
  ["MNTS", "Mantis Robotics", "Technology", "small", 4.8, 13.80, 0.2000, 0.6400, 0.0000, 0.43],
  ["DSY", "Daisy Systems", "Technology", "small", 6.5, 28.40, 0.1100, 0.4800, 0.0000, 0.55],
  ["ERNA", "Extraordinary Biotechnologies Inc.", "Healthcare", "small", 3.2, 8.60, -0.0500, 0.7200, 0.0000, 0.31],
  ["CLDI", "Cloudi Networks", "Technology", "small", 8.4, 34.75, 0.1600, 0.5100, 0.0000, 0.58],
  ["AZI", "Azimuth Dynamics", "Industrials", "small", 5.9, 17.20, 0.0800, 0.4500, 0.0000, 0.57],
  ["DXST", "Dexstar Technologies", "Technology", "small", 7.6, 26.80, 0.1300, 0.5400, 0.0000, 0.53],
  ["WCT", "WeConnect Telecom", "Communication Services", "small", 4.7, 11.90, 0.0400, 0.3700, 0.0000, 0.60],
  ["AIXI", "AIXI Labs", "Technology", "small", 5.5, 19.40, 0.2200, 0.6800, 0.0000, 0.39],
  ["CODX", "CodeX Software", "Technology", "small", 6.1, 24.10, 0.1800, 0.5800, 0.0000, 0.48],
  ["GOVX", "GovX Defense", "Industrials", "small", 9.2, 31.50, 0.1000, 0.3900, 0.0000, 0.66],
  ["CHAI", "Chai Beverage Group", "Consumer Defensive", "small", 4.3, 15.70, 0.0600, 0.3300, 0.0000, 0.64],
  ["CDLX", "Cradle Holdings", "Financials", "small", 5.0, 18.90, 0.0700, 0.4100, 0.0000, 0.61],
  ["DCX", "DCX Logistics", "Industrials", "small", 6.8, 23.60, 0.0800, 0.4300, 0.0000, 0.63],
  ["CLPR", "Caliper Energy", "Energy", "small", 5.7, 16.30, 0.0500, 0.4900, 0.0000, 0.55]
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
let automaticHandoffInProgress = false;
let automaticHandoffAttemptCount = 0;
let automaticHandoffLastError = "";
let automaticHandoffMissingTickers = [];
let automaticHandoffLastAttemptAt = 0;

function sessionForMinute(totalMinute) {
  const safeMinute = Math.max(0, Math.floor(Number(totalMinute) || 0));
  const dayIndex = Math.floor(safeMinute / MINUTES_PER_DAY);
  const dayOfWeekIndex = ((dayIndex % 7) + 7) % 7;
  const minuteOfDay = ((safeMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  if (dayOfWeekIndex >= 5) return "closed";
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
  const anchorRealMs = Number(marketState?.clockAnchorRealMs) || nowMs;
  const anchorGameSeconds = Number.isFinite(Number(marketState?.clockAnchorGameSeconds))
    ? Number(marketState.clockAnchorGameSeconds)
    : CLOCK_START_MINUTE * 60;

  const elapsedRealMs = Math.max(0, nowMs - anchorRealMs);
  const elapsedGameSeconds = elapsedRealMs * 60 / GAME_MS_PER_MINUTE;
  const totalGameSeconds = Math.max(0, Math.floor(anchorGameSeconds + elapsedGameSeconds));
  const totalMinutes = Math.floor(totalGameSeconds / 60);
  const gameSecond = totalGameSeconds % 60;
  const dayIndex = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const dayOfWeekIndex = ((dayIndex % 7) + 7) % 7;
  const minuteOfDay = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const session = sessionForMinute(totalMinutes);
  const displayHour = ((hour + 11) % 12) + 1;
  const exactTime = `${displayHour}:${String(minute).padStart(2, "0")}:${String(gameSecond).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;

  return {
    totalGameSeconds,
    totalMinutes,
    gameSecond,
    dayIndex,
    dayOfWeekIndex,
    dayName: DAY_NAMES[dayOfWeekIndex],
    week: Math.floor(dayIndex / 7) + 1,
    minuteOfDay,
    hour,
    minute,
    exactTime,
    session,
    label: session === "open"
      ? "MARKET OPEN"
      : session === "pre-market"
        ? "PRE-MARKET"
        : session === "after-hours"
          ? "AFTER HOURS"
          : "MARKET CLOSED",
    isWeekday: dayOfWeekIndex < 5,
    isOpen: session !== "closed",
    isRegularHours: session === "open",
    isTradingAllowed: session !== "closed",
    isHoliday: false,
    holidayName: "",
    earlyClose: false,
    earlyCloseName: "",
    regularCloseMinute: 960,
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
  const clock = marketClock();
  const events = [
    ["ORNG", "Orange Inc. starts the session with steady device demand", "Operating update", "positive", "Management sees healthy demand while continuing to invest in future products."],
    ["MVDO", "Mvideo Corporation expands its next-generation computing roadmap", "Product roadmap", "positive", "Investors are weighing high growth potential against elevated volatility."],
    ["PMK", "PJMonroe Kevin and Company reports stable credit conditions", "Banking update", "neutral", "Credit quality remains stable and the company continues to prioritize disciplined growth."],
    ["CHHD", "Chuck U.S. High Dividend ETF enters the session with a defensive income tilt", "ETF update", "neutral", "The fund remains focused on mature dividend-paying companies."],
    ["ERNA", "Extraordinary Biotechnologies highlights execution risk around its research pipeline", "Clinical risk", "negative", "The small-cap biotech may react sharply to future research results."],
    ["GOVX", "GovX Defense announces a new long-term development program", "Contract pipeline", "positive", "The program could support future revenue if execution remains on schedule."]
  ];
  return events
    .filter(([ticker]) => companies[ticker])
    .map(([ticker, headline, eventType, sentiment, summary]) => ({
      id: crypto.randomUUID(),
      ticker,
      displayTicker: ticker,
      assetType: "fictional-stock",
      fictional: true,
      companyName: companies[ticker].name,
      sector: companies[ticker].sector,
      headline,
      summary,
      eventType,
      eventText: "Opening company brief",
      expectedResult: "Company fundamentals, simulated market movement, and player order flow can move the stock price.",
      sentiment,
      impactPct: 0,
      gameDayName: clock.dayName,
      gameTime: clock.exactTime,
      publishedAtGameMinute: clock.totalMinutes,
      publishedAt: Math.floor(Date.now() / 1000),
      url: ""
    }));
}

function newMarketState() {
  const companies = {};
  for (const seed of INITIAL_COMPANIES) {
    const company = companyFromSeed(seed, CLOCK_START_MINUTE);
    // These are the exchange's established starting listings, not fresh IPOs.
    company.ipoWeek = 0;
    company.ipoActiveUntil = 0;
    companies[seed[0]] = company;
  }

  const state = {
    version: 5,
    catalogVersion: FICTIONAL_CATALOG_VERSION,
    clockMode: "accelerated-fictional-week",
    clockAnchorRealMs: Date.now(),
    clockAnchorGameSeconds: CLOCK_START_MINUTE * 60,
    realSecondsPerGameMinute: REAL_SECONDS_PER_GAME_MINUTE,
    lastUpdatedGameMinute: CLOCK_START_MINUTE,
    lastUpdatedGameSecond: CLOCK_START_MINUTE * 60,
    lastIpoWeek: 0,
    nextNewsGameMinute: CLOCK_START_MINUTE + 120,
    companies,
    cryptos: buildInitialSimulatedCryptoMap(),
    news: [],
    tradeReceipts: {},
    handoffReady: false,
    handoffPriceCount: 0,
    handoffSource: "",
    handoffAt: 0,
    realPriceBootstrapped: false,
    realPriceBootstrapCount: 0,
    realPriceBootstrapSource: ""
  };

  // marketClock() reads marketState, so temporarily expose this fresh state while
  // creating the opening news timestamps.
  const priorState = marketState;
  marketState = state;
  state.news = initialNews(companies);
  marketState = priorState;

  return state;
}


function requiredHandoffTickers() {
  return INITIAL_COMPANIES.map(seed => seed[0]);
}

function handoffStatusPayload() {
  return {
    success: true,
    handoffReady: marketState?.handoffReady === true,
    handoffPriceCount: Number(marketState?.handoffPriceCount) || 0,
    handoffSource: String(marketState?.handoffSource || ""),
    handoffAt: Number(marketState?.handoffAt) || 0,
    requiredTickerCount: INITIAL_COMPANIES.length,
    requiredTickers: requiredHandoffTickers(),
    catalogVersion: FICTIONAL_CATALOG_VERSION
  };
}

function applyExactHandoffPrices(inputRows, source = "Roblox realistic-market handoff") {
  if (!marketState) throw new Error("Market state is unavailable.");
  if (!inputRows || typeof inputRows !== "object" || Array.isArray(inputRows)) {
    throw new Error("Handoff prices must be an object keyed by in-game ticker.");
  }

  // Validate EVERYTHING first. Never partially seed the market.
  const prepared = [];
  const missing = [];

  for (const company of Object.values(marketState.companies)) {
    const raw = inputRows[company.ticker];
    const row = raw && typeof raw === "object" ? raw : { price: raw };
    const price = asNumber(row && row.price);
    const prevClose = asNumber(row && row.prevClose);

    if (!(price > 0)) {
      missing.push(company.ticker);
      continue;
    }

    prepared.push({
      company,
      price,
      prevClose: prevClose > 0 ? prevClose : price,
      source: String((row && row.source) || source || "Roblox realistic-market handoff")
    });
  }

  if (missing.length > 0 || prepared.length !== INITIAL_COMPANIES.length) {
    const error = new Error(
      `Exact handoff refused: ${missing.length} ticker(s) are missing a valid real-market price: ${missing.join(", ")}`
    );
    error.code = "INCOMPLETE_HANDOFF";
    error.missingTickers = missing;
    throw error;
  }

  // Only after all required prices validate do we mutate a single company.
  const nowUnix = Math.floor(Date.now() / 1000);
  for (const item of prepared) {
    const company = item.company;
    const livePrice = item.price;

    company.price = livePrice;
    company.prevClose = item.prevClose;
    company.initialPrice = livePrice;
    company.ipoPrice = livePrice;

    // Keep the simulation's company-value scale, but make fair value exactly
    // equal the handoff price at the instant fictional trading takes over.
    company.sharesOutstanding = Math.max(1, company.companyValue / livePrice);
    company.quarterlyDividend = company.dividendYield > 0
      ? livePrice * company.dividendYield / 4
      : 0;

    company.candles = {};
    company.handoffPrice = livePrice;
    company.handoffPrevClose = item.prevClose;
    company.handoffAt = nowUnix;
    company.handoffSource = item.source;
  }

  // The fictional clock starts NOW, not when Railway happened to deploy.
  marketState.clockAnchorRealMs = Date.now();
  marketState.clockAnchorGameSeconds = CLOCK_START_MINUTE * 60;
  marketState.lastUpdatedGameMinute = CLOCK_START_MINUTE;
  marketState.lastUpdatedGameSecond = CLOCK_START_MINUTE * 60;
  marketState.nextNewsGameMinute = CLOCK_START_MINUTE + 120;
  marketState.lastCloseDayIndex = null;

  marketState.handoffReady = true;
  marketState.handoffPriceCount = prepared.length;
  marketState.handoffSource = String(source || "Roblox realistic-market handoff");
  marketState.handoffAt = nowUnix;

  // Keep compatibility with the diagnostics fields from the previous build.
  marketState.realPriceBootstrapped = true;
  marketState.realPriceBootstrapCount = prepared.length;
  marketState.realPriceBootstrapSource = marketState.handoffSource;
  marketState.realPriceBootstrapAt = nowUnix;

  saveStateNow();

  console.log(
    `[FICTIONAL HANDOFF] EXACT handoff completed for ${prepared.length}/${INITIAL_COMPANIES.length} tickers. ` +
    `VSS=$${Number(marketState.companies.VSS?.price || 0).toFixed(4)}`
  );

  return handoffStatusPayload();
}


function normalizeRealHandoffRow(raw, fallbackSource) {
  if (!raw || typeof raw !== "object") return null;
  const price = asNumber(raw.price);
  if (!(price > 0)) return null;
  const prevClose = asNumber(raw.prevClose);
  return {
    price,
    prevClose: prevClose > 0 ? prevClose : price,
    source: String(raw.source || fallbackSource || "realistic backend"),
    lastUpdated: asNumber(raw.lastUpdated) || 0
  };
}

function missingRealHandoffTickers(rows) {
  return requiredHandoffTickers().filter(ticker => {
    const row = rows && rows[ticker];
    return !row || !(asNumber(row.price) > 0);
  });
}

function yahooHandoffPriceFromChart(result) {
  if (!result || typeof result !== "object") return null;

  const meta = result.meta || {};
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] || {};
  const closes = Array.isArray(quote.close) ? quote.close : [];

  // Because includePrePost=true, the newest usable candle is the closest match
  // to what the realistic game was displaying at the handoff instant.
  let latestClose = null;
  let latestTimestamp = 0;

  for (let index = Math.min(timestamps.length, closes.length) - 1; index >= 0; index -= 1) {
    const close = asNumber(closes[index]);
    const ts = asNumber(timestamps[index]);
    if (close > 0) {
      latestClose = close;
      latestTimestamp = ts || 0;
      break;
    }
  }

  const regularPrice = asNumber(meta.regularMarketPrice);
  const price = latestClose > 0 ? latestClose : regularPrice;
  if (!(price > 0)) return null;

  const prevClose =
    asNumber(meta.previousClose) ||
    asNumber(meta.chartPreviousClose) ||
    price;

  return {
    price,
    prevClose: prevClose > 0 ? prevClose : price,
    source: "Yahoo Finance exact handoff",
    lastUpdated: latestTimestamp || asNumber(meta.regularMarketTime) || 0
  };
}

async function fetchYahooHandoffTicker(displayTicker) {
  const realTicker = HANDOFF_REAL_TICKERS[displayTicker];
  if (!realTicker) {
    throw new Error(`No real ticker mapping exists for ${displayTicker}.`);
  }

  let lastError = null;

  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const response = await fetchJson(
        `https://${host}/v8/finance/chart/${encodeURIComponent(realTicker)}` +
        `?range=5d&interval=1m&includePrePost=true&events=div%2Csplits&_=${Date.now()}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0"
          }
        },
        15000
      );

      const chart = response.data && response.data.chart;
      const result = chart && Array.isArray(chart.result) && chart.result[0];

      if (!response.ok || !result) {
        throw new Error(
          String(chart?.error?.description || chart?.error?.code || `Yahoo HTTP ${response.status}`)
        );
      }

      const row = yahooHandoffPriceFromChart(result);
      if (!row) throw new Error("Yahoo returned no usable price.");

      return row;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Yahoo handoff request failed.");
}

async function collectExactYahooSnapshot() {
  const required = requiredHandoffTickers();
  const rows = {};
  const failures = {};

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= required.length) return;

      const ticker = required[index];

      try {
        rows[ticker] = await fetchYahooHandoffTicker(ticker);
      } catch (error) {
        failures[ticker] = String(error?.message || error);
      }
    }
  }

  const workerCount = Math.min(YAHOO_HANDOFF_CONCURRENCY, required.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const missing = missingRealHandoffTickers(rows);

  if (missing.length) {
    console.warn(
      `[FICTIONAL HANDOFF] Yahoo exact snapshot missing ${missing.length}: ` +
      missing.map(ticker => `${ticker}(${failures[ticker] || "no price"})`).join(", ")
    );
  }

  return { rows, missing, failures };
}

async function attemptAutomaticExactHandoff() {
  if (!marketState || marketState.handoffReady === true) return true;
  if (automaticHandoffInProgress) return false;

  automaticHandoffInProgress = true;
  automaticHandoffAttemptCount += 1;
  automaticHandoffLastAttemptAt = Math.floor(Date.now() / 1000);

  try {
    const snapshot = await collectExactYahooSnapshot();
    automaticHandoffMissingTickers = snapshot.missing;

    if (snapshot.missing.length > 0) {
      automaticHandoffLastError =
        `Waiting for ${snapshot.missing.length} Yahoo handoff ticker(s): ${snapshot.missing.join(", ")}`;
      console.warn(`[FICTIONAL HANDOFF] ${automaticHandoffLastError}. Fictional seed prices remain blocked.`);
      return false;
    }

    const vss = snapshot.rows.VSS && snapshot.rows.VSS.price;
    console.log(
      `[FICTIONAL HANDOFF] Collected exact Yahoo snapshot ${requiredHandoffTickers().length}/${requiredHandoffTickers().length}. ` +
      `VSS=$${Number(vss || 0).toFixed(4)}`
    );

    applyExactHandoffPrices(
      snapshot.rows,
      "Automatic exact snapshot from Yahoo Finance using current-game ticker mapping"
    );

    automaticHandoffMissingTickers = [];
    automaticHandoffLastError = "";
    console.log("[FICTIONAL HANDOFF] AUTO HANDOFF COMPLETE. Fictional prices may now be served.");
    return true;
  } catch (error) {
    automaticHandoffLastError = String(error?.message || error);
    console.warn(`[FICTIONAL HANDOFF] Automatic handoff attempt failed: ${automaticHandoffLastError}`);
    return false;
  } finally {
    automaticHandoffInProgress = false;
  }
}

function startAutomaticHandoffLoop() {
  const run = async () => {
    if (!marketState || marketState.handoffReady === true) return;
    await attemptAutomaticExactHandoff();
    if (marketState && marketState.handoffReady !== true) {
      setTimeout(run, AUTO_HANDOFF_RETRY_MS);
    }
  };

  setTimeout(run, 250);
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
    if (!parsed?.companies) throw new Error("state is missing required fields");
    if (parsed.catalogVersion !== FICTIONAL_CATALOG_VERSION) {
      throw new Error(`catalog changed (${parsed.catalogVersion || "legacy"} -> ${FICTIONAL_CATALOG_VERSION})`);
    }

    for (const seed of INITIAL_COMPANIES) {
      if (!parsed.companies[seed[0]]) {
        throw new Error(`state is missing current ticker ${seed[0]}`);
      }
    }

    marketState = parsed;
    ensureSimulatedCryptoState(marketState);
    marketState.news = Array.isArray(marketState.news) ? marketState.news : [];
    marketState.tradeReceipts = marketState.tradeReceipts || {};
    marketState.catalogVersion = FICTIONAL_CATALOG_VERSION;
    marketState.clockMode = "accelerated-fictional-week";
    marketState.handoffReady = marketState.handoffReady === true;
    marketState.handoffPriceCount = Number(marketState.handoffPriceCount) || 0;
    marketState.handoffSource = String(marketState.handoffSource || "");
    marketState.handoffAt = Number(marketState.handoffAt) || 0;

    if (!Number.isFinite(Number(marketState.clockAnchorRealMs))) {
      marketState.clockAnchorRealMs = Date.now();
    }
    if (!Number.isFinite(Number(marketState.clockAnchorGameSeconds))) {
      marketState.clockAnchorGameSeconds = CLOCK_START_MINUTE * 60;
    }

    const priorSpeed = Number(marketState.realSecondsPerGameMinute);
    if (Number.isFinite(priorSpeed) && priorSpeed > 0 && Math.abs(priorSpeed - REAL_SECONDS_PER_GAME_MINUTE) > 1e-9) {
      // Preserve the current fictional time if the speed is changed later.
      const nowMs = Date.now();
      const elapsedRealMs = Math.max(0, nowMs - Number(marketState.clockAnchorRealMs));
      marketState.clockAnchorGameSeconds = Math.max(
        0,
        Math.floor(Number(marketState.clockAnchorGameSeconds) + elapsedRealMs * 60 / (priorSpeed * 1000))
      );
      marketState.clockAnchorRealMs = nowMs;
    }
    marketState.realSecondsPerGameMinute = REAL_SECONDS_PER_GAME_MINUTE;

    const clock = marketClock();
    if (!Number.isFinite(Number(marketState.lastUpdatedGameMinute))) {
      marketState.lastUpdatedGameMinute = clock.totalMinutes;
    }
    if (!Number.isFinite(Number(marketState.lastUpdatedGameSecond))) {
      // Upgrade existing v7 persistent state in place. Start second-resolution
      // evolution from NOW so deployment does not create a price jump.
      marketState.lastUpdatedGameSecond = clock.totalGameSeconds;
    }
    if (!Number.isFinite(Number(marketState.nextNewsGameMinute)) || Number(marketState.nextNewsGameMinute) < clock.totalMinutes - 1440) {
      marketState.nextNewsGameMinute = clock.totalMinutes + 120;
    }

    console.log(`[FICTIONAL] Loaded ${Object.keys(marketState.companies).length} main-game companies from persistent state.`);
    return false;
  } catch (error) {
    marketState = newMarketState();
    saveStateNow();
    console.log(`[FICTIONAL] Started a new ${INITIAL_COMPANIES.length}-company main-game market (${error.code || error.message}).`);
    return true;
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
  const safeBucket = Math.max(0, Math.floor(Number(bucketMinute) || 0));
  const dayIndex = Math.floor(safeBucket / MINUTES_PER_DAY);
  const dayOfWeekIndex = ((dayIndex % 7) + 7) % 7;
  const minuteOfDay = ((safeBucket % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const o = round(open, 4);
  const h = round(Math.max(high, open, close, low), 4);
  const l = round(Math.max(0.01, Math.min(low, open, close, high)), 4);
  const c = round(close, 4);
  const v = Math.max(1, Math.round(volume));

  return {
    t: safeBucket * 60,
    ts: safeBucket * 60,
    time: safeBucket * 60,
    timestamp: safeBucket * 60,
    bucketMinute: safeBucket,
    datetime: `${DAY_NAMES[dayOfWeekIndex]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    o, h, l, c, v,
    open: o, high: h, low: l, close: c, volume: v,
    session,
    gameDayIndex: dayIndex,
    gameDayName: DAY_NAMES[dayOfWeekIndex],
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
    if (intervalKey === "1d") {
      const dayIndex = Math.floor(cursor / MINUTES_PER_DAY);
      const dayOfWeekIndex = ((dayIndex % 7) + 7) % 7;
      if (dayOfWeekIndex < 5) buckets.push(cursor);
    } else if (session !== "closed") {
      buckets.push(cursor);
    }
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

function updateCandles(company, priorPrice, price, clock, playerVolume = 0, elapsedGameMinutes = 0) {
  for (const [intervalKey, spec] of Object.entries(FICTIONAL_INTERVALS)) {
    const series = ensureCandleSeries(company, intervalKey);
    const bucket = Math.floor(clock.totalMinutes / spec.minutes) * spec.minutes;
    const current = series[series.length - 1];
    const currentBucket = current ? Number(current.bucketMinute) : null;

    // Natural volume is a flow over game time. With sub-minute price ticks,
    // scale it by the actual elapsed game minutes instead of repeatedly adding
    // a full timeframe's volume on every tick.
    const naturalVolume = (120 + Math.random() * 900)
      * Math.max(0, Number(elapsedGameMinutes) || 0)
      * company.liquidity;
    const volume = Math.max(1, Math.round(
      naturalVolume + Math.max(0, Number(playerVolume) || 0)
    ));

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
  updateCandles(company, prior, company.price, clock, 0, elapsedGameMinutes);
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
  marketState.nextNewsGameMinute = clock.totalMinutes + 8 + Math.floor(Math.random() * 18);
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
  if (marketState.handoffReady !== true) return;
  const clock = marketClock();

  // Evolve prices at game-second resolution while candles remain grouped into
  // 1m/5m/15m/etc. buckets. At 2x time, one real second advances roughly two
  // game seconds, so the active candle can visibly move before it closes.
  const lastGameSecond = Number.isFinite(Number(marketState.lastUpdatedGameSecond))
    ? Number(marketState.lastUpdatedGameSecond)
    : clock.totalGameSeconds;
  const elapsedGameSeconds = clamp(
    clock.totalGameSeconds - lastGameSecond,
    0,
    MINUTES_PER_DAY * 60
  );
  const elapsedGameMinutes = elapsedGameSeconds / 60;

  if (elapsedGameSeconds > 0) {
    for (const company of Object.values(marketState.companies)) {
      updateCompany(company, elapsedGameMinutes, clock);
    }

    ensureSimulatedCryptoState(marketState);
    for (const asset of Object.values(marketState.cryptos)) {
      updateSimulatedCrypto(asset, elapsedGameMinutes, clock);
    }

    marketState.lastUpdatedGameSecond = clock.totalGameSeconds;
    marketState.lastUpdatedGameMinute = clock.totalMinutes;
  }

  if (clock.totalMinutes >= Number(marketState.nextNewsGameMinute || 0)) {
    generateCompanyNews(clock);
  }

  // The main Roblox game already owns GCFC/player-company IPO logic.
  // Do not inject random new exchange tickers here.
  marketState.lastIpoWeek = 0;

  // Snapshot regular-session close once per Eastern trading day.
  if (clock.minuteOfDay >= 960 && clock.dayOfWeekIndex < 5 && Number(marketState.lastCloseDayIndex) !== clock.dayIndex) {
    for (const company of Object.values(marketState.companies)) {
      company.prevClose = company.price;
    }
    marketState.lastCloseDayIndex = clock.dayIndex;
    queueSave();
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
    backend: "main-game-fictional-exchange",
    companyCount: Object.keys(marketState.companies).length,
    gameWeek: clock.week,
    gameDay: clock.dayName,
    gameTime: clock.exactTime,
    session: clock.session,
    persistentStateFile: STATE_FILE,
    catalogVersion: FICTIONAL_CATALOG_VERSION,
    clockMode: "accelerated-fictional-week",
    realSecondsPerGameMinute: REAL_SECONDS_PER_GAME_MINUTE,
    realSecondsPerGameDay: REAL_SECONDS_PER_GAME_MINUTE * MINUTES_PER_DAY,
    automaticIposEnabled: false,
    handoffReady: marketState.handoffReady === true,
    automaticHandoffInProgress,
    automaticHandoffAttemptCount,
    automaticHandoffLastAttemptAt,
    automaticHandoffLastError,
    automaticHandoffMissingTickers,
    handoffProvider: "Yahoo Finance direct chart snapshot",
    handoffPriceCount: Number(marketState.handoffPriceCount) || 0,
    handoffSource: String(marketState.handoffSource || ""),
    handoffAt: Number(marketState.handoffAt) || 0,
    requiredHandoffTickerCount: INITIAL_COMPANIES.length,
    realPriceBootstrapped: marketState.realPriceBootstrapped === true,
    realPriceBootstrapCount: Number(marketState.realPriceBootstrapCount) || 0,
    realPriceBootstrapSource: String(marketState.realPriceBootstrapSource || ""),
    fictionalTradeSecretConfigured: Boolean(FICTIONAL_TRADE_SECRET),
    groupSyncConfigured: Boolean(GROUP_SYNC_SECRET && ROBLOX_OPEN_CLOUD_API_KEY),
    cryptoCached: marketState?.cryptos ? Object.keys(marketState.cryptos).length : 0,
    commodityCached: Object.keys(commodityPriceCache).length
  });
});

app.get("/crypto/prices", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const symbols = String(req.query.symbols || CRYPTO_SYMBOLS.join(","))
    .toUpperCase().replace(/\s+/g, "").replace(/\+/g, ",").split(",")
    .map(normalizeCryptoSymbol).filter(Boolean);
  const unique = [...new Set(symbols.length ? symbols : CRYPTO_SYMBOLS)];
  res.json(await getCryptoPrices(unique));
});

app.get("/crypto/debug", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const symbol = normalizeCryptoSymbol(req.query.symbol || "GYLD");
  if (!symbol) return res.status(400).json({ error: "Unsupported crypto symbol." });
  const result = await getCryptoPrices([symbol]);
  const row = result.prices && result.prices[symbol];
  res.json({
    symbol,
    name: row && row.name,
    price: row && row.price,
    fictional: true,
    simulated: true,
    source: row && row.source,
    updatedAt: row && row.lastUpdated,
    externalCryptoDataUsed: false,
    error: row ? null : "No fictional crypto quote was returned."
  });
});

app.get("/crypto/candles", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const symbol = normalizeCryptoSymbol(req.query.symbol || req.query.ticker || "GYLD");
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

app.get("/fictional/handoff/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(handoffStatusPayload());
});

app.post("/fictional/handoff", (req, res) => {
  if (!authorizeFictionalTrade(req, res)) return;

  // Idempotent: once the exact handoff is complete, later Roblox servers may
  // check/post without ever resetting the shared market price.
  if (marketState.handoffReady === true) {
    return res.json({
      ...handoffStatusPayload(),
      alreadyReady: true
    });
  }

  try {
    const prices = req.body?.prices;
    const source = String(req.body?.source || "Roblox realistic-market handoff").slice(0, 160);
    const result = applyExactHandoffPrices(prices, source);
    return res.json(result);
  } catch (error) {
    return res.status(409).json({
      success: false,
      handoffReady: false,
      error: error.message,
      code: error.code || "HANDOFF_FAILED",
      missingTickers: Array.isArray(error.missingTickers) ? error.missingTickers : []
    });
  }
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
    realSecondsPerGameMinute: REAL_SECONDS_PER_GAME_MINUTE,
    realSecondsPerGameDay: REAL_SECONDS_PER_GAME_MINUTE * MINUTES_PER_DAY,
    clockMode: "accelerated-fictional-week",
    companyCount: Object.keys(marketState.companies).length,
    lastIpoWeek: 0,
    automaticIposEnabled: false,
    handoffReady: marketState.handoffReady === true,
    handoffPriceCount: Number(marketState.handoffPriceCount) || 0,
    nextNewsGameMinute: marketState.nextNewsGameMinute
  });
});

app.get("/fictional/prices", (_req, res) => {
  if (marketState.handoffReady !== true) {
    return res.status(503).json({
      success: false,
      handoffReady: false,
      error: "Fictional market is waiting for an exact real-price handoff. Seed/fallback prices are not being served."
    });
  }
  engineStep();
  const clock = marketClock();
  const prices = {};
  for (const company of Object.values(marketState.companies)) prices[company.ticker] = companyRow(company, clock);
  res.json(prices);
});

app.get("/fictional/price", (req, res) => {
  if (marketState.handoffReady !== true) {
    return res.status(503).json({
      success: false,
      handoffReady: false,
      error: "Fictional market is waiting for an exact real-price handoff."
    });
  }
  engineStep();
  const ticker = normalizeFictionalTicker(req.query.ticker);
  const company = marketState.companies[ticker];
  if (!company) return res.status(404).json({ error: "Unknown fictional ticker." });
  res.json(companyRow(company));
});

app.get("/fictional/candles", (req, res) => {
  if (marketState.handoffReady !== true) {
    return res.status(503).json({
      success: false,
      handoffReady: false,
      error: "Fictional market is waiting for an exact real-price handoff."
    });
  }
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

app.get("/fictional/news/watchlist", (req, res) => {
  engineStep();
  const rawAssets = String(req.query.assets || "");
  const requested = rawAssets.split(",").map(item => item.trim()).filter(Boolean).slice(0, 50);
  const items = [];

  for (const raw of requested) {
    const splitAt = raw.indexOf(":");
    const requestedType = splitAt >= 0 ? raw.slice(0, splitAt).toLowerCase() : "stock";
    const ticker = normalizeFictionalTicker(splitAt >= 0 ? raw.slice(splitAt + 1) : raw);

    if (requestedType === "stock" && marketState.companies[ticker]) {
      const article = marketState.news.find(item => item.ticker === ticker) || null;
      items.push({
        ticker,
        assetType: "stock",
        success: true,
        latestStrongNews: article,
        article
      });
    } else {
      // This endpoint is specifically for simulated-stock news. Crypto/commodity
      // watchlist rows can remain present without accidentally requesting real-stock news.
      items.push({
        ticker,
        assetType: requestedType,
        success: true,
        latestStrongNews: null,
        article: null
      });
    }
  }

  res.json({ success: true, fictional: true, items, fetchedAt: Math.floor(Date.now() / 1000) });
});

app.get("/fictional/ipo/current", (_req, res) => {
  engineStep();
  res.json({
    success: true,
    automaticIposEnabled: false,
    ipo: null,
    message: "Backend-generated IPOs are disabled; the Roblox game owns GCFC and player-company IPOs."
  });
});

app.post("/fictional/trade", (req, res) => {
  if (!authorizeFictionalTrade(req, res)) return;
  if (marketState.handoffReady !== true) {
    return res.status(503).json({
      success: false,
      handoffReady: false,
      error: "Fictional market is waiting for an exact real-price handoff."
    });
  }
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
  updateCandles(company, priorPrice, company.price, clock, quantity, 0);
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

async function startServer() {
  loadState();

  if (marketState.handoffReady !== true) {
    console.log("[FICTIONAL HANDOFF] Taking exact one-time Yahoo snapshot before opening the fictional market...");
    await attemptAutomaticExactHandoff();
  }

  setInterval(engineStep, 1000);

  if (marketState.handoffReady !== true) {
    startAutomaticHandoffLoop();
  }

  app.listen(PORT, () => {
    const clock = marketClock();
    console.log(`[SERVER] Main-game fictional exchange ready on port ${PORT}.`);
    console.log(`[SERVER] ${Object.keys(marketState.companies).length} simulated main-game stocks; 5 fully fictional cryptocurrencies enabled; commodities remain separate.`);
console.log(`[SERVER] Fictional stock prices evolve at game-second resolution; candles retain normal timeframe buckets.`);
    console.log(`[SERVER] Fictional clock configured for ${clock.dayName} ${clock.exactTime}; 1 game minute = ${REAL_SECONDS_PER_GAME_MINUTE} real seconds.`);
    if (marketState.handoffReady === true) {
      console.log(`[SERVER] Exact price handoff is READY for ${marketState.handoffPriceCount || 0} tickers.`);
    } else {
      console.warn(`[SERVER] WAITING FOR EXACT YAHOO PRICE HANDOFF. Fictional seed prices remain blocked while Railway retries.`);
    }
  });
}

startServer().catch(error => {
  console.error(`[SERVER] Startup failed: ${error && error.stack || error}`);
  process.exit(1);
});
