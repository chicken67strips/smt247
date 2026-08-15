// Dedicated Railway backend for the fictional-stock game.
// This project intentionally contains NO real-stock ticker mappings or routes.
// Fictional stocks and crypto are simulated here. Crypto uses zero real-world crypto data.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.disable("x-powered-by");
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
    // Compact internal/API representation. Roblox already accepts the short
    // OHLCV keys and can derive the day name from gameDayIndex.
    t: safeBucket * 60,
    bucketMinute: safeBucket,
    o, h, l, c, v,
    session: "crypto",
    gameDayIndex: dayIndex,
    gameMinuteOfDay: minuteOfDay
  };
}

function ensureCryptoCandleSeries(asset, intervalKey) {
  asset.candles = asset.candles || {};

  if (Array.isArray(asset.candles[intervalKey]) && asset.candles[intervalKey].length) {
    touchCandleSeries("crypto", asset.symbol, intervalKey);
    return asset.candles[intervalKey];
  }

  const spec = FICTIONAL_INTERVALS[intervalKey];
  if (!spec) return [];

  const nowMinute = marketClock().totalMinutes;
  const buckets = [];
  let cursor = Math.floor(nowMinute / spec.minutes) * spec.minutes;

  while (buckets.length < spec.limit) {
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
      open * Math.exp(drift + seededNormal(`crypto:${asset.symbol}:${bucket}`) * sigma)
    );

    const wickSize = Math.abs(seededNormal(`crypto-wick:${asset.symbol}:${bucket}`)) * sigma * open * 0.55;
    const volume =
      asset.baseVolumePerGameMinute
      * elapsedMinutes
      * (0.55 + seededUnit(`crypto-volume:${asset.symbol}:${bucket}`) * 0.90);

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
    const currentDisplayPrice = Math.max(
      0.00000001,
      displayedPriceForAsset(asset)
    );
    const actualDayOpen = Math.max(
      0.00000001,
      Number(asset.dayOpenPrice) || currentDisplayPrice
    );
    const currentDayIndex = Math.floor(nowMinute / MINUTES_PER_DAY);
    const currentDayStartMinute = currentDayIndex * MINUTES_PER_DAY;

    let currentDayStartIndex = -1;

    for (let i = 0; i < series.length; i += 1) {
      if (Number(series[i].bucketMinute) >= currentDayStartMinute) {
        currentDayStartIndex = i;
        break;
      }
    }

    if (currentDayStartIndex >= 0) {
      // First, scale all older candles so the final pre-midnight close connects
      // continuously to the ACTUAL fictional day-open price.
      if (currentDayStartIndex > 0) {
        const previousClose =
          Number(series[currentDayStartIndex - 1].c)
          || actualDayOpen;

        const priorRatio =
          previousClose > 0
            ? actualDayOpen / previousClose
            : 1;

        for (let i = 0; i < currentDayStartIndex; i += 1) {
          const candle = series[i];

          candle.o = round(candle.o * priorRatio, 8);
          candle.h = round(candle.h * priorRatio, 8);
          candle.l = round(
            Math.max(0.00000001, candle.l * priorRatio),
            8
          );
          candle.c = round(candle.c * priorRatio, 8);
        }
      }

      // Preserve the deterministic shape/volatility of today's generated
      // candles, but adjust their aggregate log return so:
      //
      //   first open = persisted fictional day open
      //   last close = current displayed quote
      //
      // This makes the chart and the crypto daily-% badge mathematically
      // consistent without keeping hundreds of thousands of candle objects in
      // Railway memory.
      const todayCount = series.length - currentDayStartIndex;
      let rawReturnSum = 0;

      for (let i = currentDayStartIndex; i < series.length; i += 1) {
        const candle = series[i];
        const rawOpen = Math.max(
          0.00000001,
          Number(candle.o) || 0.00000001
        );
        const rawClose = Math.max(
          0.00000001,
          Number(candle.c) || rawOpen
        );

        rawReturnSum += Math.log(rawClose / rawOpen);
      }

      const desiredReturn =
        Math.log(currentDisplayPrice / actualDayOpen);

      const perCandleCorrection =
        todayCount > 0
          ? (desiredReturn - rawReturnSum) / todayCount
          : 0;

      let rebuiltOpen = actualDayOpen;

      for (let i = currentDayStartIndex; i < series.length; i += 1) {
        const candle = series[i];

        const rawOpen = Math.max(
          0.00000001,
          Number(candle.o) || rebuiltOpen
        );
        const rawClose = Math.max(
          0.00000001,
          Number(candle.c) || rawOpen
        );
        const rawHigh = Math.max(
          rawOpen,
          rawClose,
          Number(candle.h) || rawOpen
        );
        const rawLow = Math.max(
          0.00000001,
          Math.min(
            rawOpen,
            rawClose,
            Number(candle.l) || rawOpen
          )
        );

        const rawBodyReturn =
          Math.log(rawClose / rawOpen);

        let rebuiltClose =
          rebuiltOpen
          * Math.exp(
            rawBodyReturn + perCandleCorrection
          );

        if (i === series.length - 1) {
          rebuiltClose = currentDisplayPrice;
        }

        const rawUpperBody = Math.max(rawOpen, rawClose);
        const rawLowerBody = Math.min(rawOpen, rawClose);

        const upperWickFactor =
          rawUpperBody > 0
            ? Math.max(1, rawHigh / rawUpperBody)
            : 1;

        const lowerWickFactor =
          rawLow > 0
            ? Math.max(1, rawLowerBody / rawLow)
            : 1;

        candle.o = round(rebuiltOpen, 8);
        candle.c = round(
          Math.max(0.00000001, rebuiltClose),
          8
        );
        candle.h = round(
          Math.max(candle.o, candle.c)
            * upperWickFactor,
          8
        );
        candle.l = round(
          Math.max(
            0.00000001,
            Math.min(candle.o, candle.c)
              / lowerWickFactor
          ),
          8
        );

        rebuiltOpen = candle.c;
      }
    } else {
      // The loaded timeframe does not reach fictional midnight (for example a
      // 1-minute chart viewed many hours into the day). It cannot display the
      // entire daily move, so simply anchor its newest candle to the live quote.
      const lastClose =
        Number(series[series.length - 1].c)
        || currentDisplayPrice;

      const ratio =
        lastClose > 0
          ? currentDisplayPrice / lastClose
          : 1;

      for (const candle of series) {
        candle.o = round(candle.o * ratio, 8);
        candle.h = round(candle.h * ratio, 8);
        candle.l = round(
          Math.max(0.00000001, candle.l * ratio),
          8
        );
        candle.c = round(candle.c * ratio, 8);
      }
    }
  }

  asset.candles[intervalKey] = series.slice(-spec.limit);
  touchCandleSeries("crypto", asset.symbol, intervalKey);
  return asset.candles[intervalKey];
}

function updateCryptoCandles(asset, priorPrice, price, clock, elapsedGameMinutes = 0, playerVolume = 0) {
  const candleEntries = Object.entries(asset.candles || {});
  for (const [intervalKey, series] of candleEntries) {
    const spec = FICTIONAL_INTERVALS[intervalKey];
    if (!spec || !Array.isArray(series) || series.length === 0) continue;
    const bucket = Math.floor(clock.totalMinutes / spec.minutes) * spec.minutes;
    const current = series[series.length - 1];
    const currentBucket = current ? Number(current.bucketMinute) : null;

    const volume =
      asset.baseVolumePerGameMinute
      * Math.max(0, Number(elapsedGameMinutes) || 0)
      * (0.60 + Math.random() * 0.80)
      + Math.max(0, Number(playerVolume) || 0);

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
      current.h = round(Math.max(Number(current.h) || price, price), 8);
      current.l = round(
        Math.max(0.00000001, Math.min(Number(current.l) || price, price)),
        8
      );
      current.c = round(price, 8);
      current.v = Math.round((Number(current.v) || 0) + volume);
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

  const priorDisplayedPrice = displayedPriceForAsset(asset);
  decayPlayerImpact(asset, elapsedGameMinutes);

  if (Number(asset.lastDayIndex) !== clock.dayIndex) {
    asset.lastDayIndex = clock.dayIndex;

    // Daily change and regenerated charts must use the quote players actually
    // saw at fictional midnight, including any bounded player-order pressure.
    asset.dayOpenPrice = Math.max(
      0.00000001,
      Number(priorDisplayedPrice)
        || Number(asset.price)
        || asset.initialPrice
    );

    asset.volume24h = 0;
  }

  const prior = Math.max(
    0.00000001,
    Number(asset.price) || asset.initialPrice
  );

  const drift =
    asset.annualGrowth * elapsedGameMinutes / (365 * MINUTES_PER_DAY);

  const volatility =
    asset.annualVolatility
    * randomNormal()
    * Math.sqrt(elapsedGameMinutes / (365 * MINUTES_PER_DAY));

  const reference = Math.max(
    0.00000001,
    Number(asset.initialPrice) || prior
  );

  const referencePull =
    Math.log(reference / prior)
    * clamp(elapsedGameMinutes / (14 * MINUTES_PER_DAY), 0, 0.0015);

  asset.price = Math.max(
    0.00000001,
    prior * Math.exp(drift + volatility + referencePull)
  );

  updateCryptoCandles(
    asset,
    priorDisplayedPrice,
    displayedPriceForAsset(asset),
    clock,
    elapsedGameMinutes
  );
}

function fictionalCryptoRow(asset) {
  const executionReferencePrice = Math.max(
    0.00000001,
    Number(asset.price) || asset.initialPrice
  );
  const price = displayedPriceForAsset(asset);
  const dayOpen = Math.max(
    0.00000001,
    Number(asset.dayOpenPrice) || executionReferencePrice
  );

  return {
    symbol: asset.symbol,
    ticker: asset.symbol,
    name: asset.name,
    assetType: "crypto",
    fictional: true,
    simulated: true,
    price: round(price, 8),
    executionPrice: round(executionReferencePrice, 8),
    playerImpactPct: round(currentPlayerImpact(asset) * 100, 4),
    dayOpenPrice: round(dayOpen, 8),
    change24h: round(((price - dayOpen) / dayOpen) * 100, 4),
    volume24h: round(Math.max(0, Number(asset.volume24h) || 0) * price, 2),
    marketCap: round(price * Math.max(1, Number(asset.totalSupply) || 1), 2),
    source: "Godly Capital fictional crypto simulation",
    cryptoChartModelVersion: 2,
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
// Fully fictional commodities
// ============================
// GOLD, SILVER, and OIL are simulated entirely inside this backend.
// No Yahoo/Twelve Data/other real commodity price or candle data is used.
//
// Gold and silver intentionally share a strong metals factor. Stock-category
// factors can also feed into commodity movement. In particular, positive
// Electronics & Semiconductors movement lifts both metals, with SILVER receiving
// the larger sensitivity because industrial/electronics demand matters more to it.
const COMMODITY_SYMBOLS = ["GOLD", "SILVER", "OIL"];

const FICTIONAL_COMMODITY_SEEDS = [
  {
    ticker: "GOLD",
    name: "Gold",
    unit: "per troy oz",
    initialPrice: 1875.40,
    annualGrowth: 0.040,
    annualVolatility: 0.18,
    baseVolumePerGameMinute: 18500
  },
  {
    ticker: "SILVER",
    name: "Silver",
    unit: "per troy oz",
    initialPrice: 28.65,
    annualGrowth: 0.055,
    annualVolatility: 0.34,
    baseVolumePerGameMinute: 42000
  },
  {
    ticker: "OIL",
    name: "Crude Oil",
    unit: "per barrel",
    initialPrice: 83.25,
    annualGrowth: 0.025,
    annualVolatility: 0.42,
    baseVolumePerGameMinute: 65000
  }
];

function normalizeCommodityTicker(value) {
  const ticker = String(value || "").toUpperCase().replace(/[^A-Z]/g, "");
  return COMMODITY_SYMBOLS.includes(ticker) ? ticker : "";
}

function makeFictionalCommodityFromSeed(seed) {
  const price = Math.max(0.0001, Number(seed.initialPrice) || 1);
  return {
    ticker: seed.ticker,
    name: seed.name,
    unit: seed.unit,
    initialPrice: price,
    price,
    prevClose: price,
    annualGrowth: Number(seed.annualGrowth) || 0,
    annualVolatility: Math.max(0.01, Number(seed.annualVolatility) || 0.25),
    baseVolumePerGameMinute: Math.max(1, Number(seed.baseVolumePerGameMinute) || 10000),
    lastDayIndex: null,
    candles: {}
  };
}

function buildInitialSimulatedCommodityMap() {
  const output = {};
  for (const seed of FICTIONAL_COMMODITY_SEEDS) {
    output[seed.ticker] = makeFictionalCommodityFromSeed(seed);
  }
  return output;
}

function ensureSimulatedCommodityState(state) {
  if (!state || typeof state !== "object") return;

  if (!state.commodities || typeof state.commodities !== "object" || Array.isArray(state.commodities)) {
    state.commodities = {};
  }

  for (const seed of FICTIONAL_COMMODITY_SEEDS) {
    let asset = state.commodities[seed.ticker];
    if (!asset || typeof asset !== "object") {
      asset = makeFictionalCommodityFromSeed(seed);
      state.commodities[seed.ticker] = asset;
    }

    asset.ticker = seed.ticker;
    asset.name = seed.name;
    asset.unit = seed.unit;

    if (!(asNumber(asset.initialPrice) > 0)) asset.initialPrice = seed.initialPrice;
    if (!(asNumber(asset.price) > 0)) asset.price = seed.initialPrice;
    if (!(asNumber(asset.prevClose) > 0)) asset.prevClose = asset.price;

    asset.annualGrowth = Number(seed.annualGrowth) || 0;
    asset.annualVolatility = Math.max(0.01, Number(seed.annualVolatility) || 0.25);
    asset.baseVolumePerGameMinute = Math.max(1, Number(seed.baseVolumePerGameMinute) || 10000);
    asset.lastDayIndex = Number.isFinite(Number(asset.lastDayIndex))
      ? Number(asset.lastDayIndex)
      : null;
    asset.candles = asset.candles && typeof asset.candles === "object"
      ? asset.candles
      : {};
  }

  for (const ticker of Object.keys(state.commodities)) {
    if (!COMMODITY_SYMBOLS.includes(ticker)) {
      delete state.commodities[ticker];
    }
  }
}

// Fictional commodity schedule modeled after a realistic futures schedule:
// Sunday 6 PM through Friday 5 PM, with a 5-6 PM maintenance break Mon-Thu.
// dayOfWeekIndex: Monday=0 ... Sunday=6.
function commoditySessionForMinute(totalMinute) {
  const safeMinute = Math.max(0, Math.floor(Number(totalMinute) || 0));
  const dayIndex = Math.floor(safeMinute / MINUTES_PER_DAY);
  const dayOfWeekIndex = ((dayIndex % 7) + 7) % 7;
  const minuteOfDay = ((safeMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  if (dayOfWeekIndex === 5) return "closed"; // Saturday
  if (dayOfWeekIndex === 6) return minuteOfDay >= 1080 ? "open" : "closed"; // Sunday after 6 PM
  if (dayOfWeekIndex === 4) return minuteOfDay < 1020 ? "open" : "closed"; // Friday before 5 PM

  // Monday-Thursday: open until 5 PM, maintenance 5-6 PM, then reopen.
  return (minuteOfDay < 1020 || minuteOfDay >= 1080) ? "open" : "closed";
}

function makeFictionalCommodityCandle(bucketMinute, open, high, low, close, volume) {
  const safeBucket = Math.max(0, Math.floor(Number(bucketMinute) || 0));
  const dayIndex = Math.floor(safeBucket / MINUTES_PER_DAY);
  const dayOfWeekIndex = ((dayIndex % 7) + 7) % 7;
  const minuteOfDay = ((safeBucket % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;

  const o = round(Math.max(0.0001, Number(open) || 0), 6);
  const c = round(Math.max(0.0001, Number(close) || o), 6);
  const h = round(Math.max(o, c, Number(high) || o), 6);
  const l = round(Math.max(0.0001, Math.min(o, c, Number(low) || o)), 6);
  const v = Math.max(0, Math.round(Number(volume) || 0));

  return {
    t: safeBucket * 60,
    bucketMinute: safeBucket,
    o, h, l, c, v,
    session: "commodity",
    gameDayIndex: dayIndex,
    gameMinuteOfDay: minuteOfDay
  };
}

function ensureCommodityCandleSeries(asset, intervalKey) {
  asset.candles = asset.candles || {};

  if (Array.isArray(asset.candles[intervalKey]) && asset.candles[intervalKey].length) {
    touchCandleSeries("commodity", asset.ticker, intervalKey);
    return asset.candles[intervalKey];
  }

  const spec = FICTIONAL_INTERVALS[intervalKey];
  if (!spec) return [];

  const nowMinute = marketClock().totalMinutes;
  const buckets = [];
  let cursor = Math.floor(nowMinute / spec.minutes) * spec.minutes;
  let safety = 0;

  while (buckets.length < spec.limit && safety < 60000) {
    const dayIndex = Math.floor(cursor / MINUTES_PER_DAY);
    const dayOfWeekIndex = ((dayIndex % 7) + 7) % 7;

    if (intervalKey === "1d") {
      if (dayOfWeekIndex < 5) buckets.push(cursor);
    } else if (commoditySessionForMinute(cursor) === "open") {
      buckets.push(cursor);
    }

    cursor -= spec.minutes;
    safety += 1;
  }

  buckets.reverse();

  const series = [];
  let price = Math.max(0.0001, Number(asset.initialPrice || asset.price) || 1);

  for (const bucket of buckets) {
    const open = price;
    const elapsedMinutes = spec.minutes;
    const drift =
      asset.annualGrowth * elapsedMinutes / (365 * MINUTES_PER_DAY);

    const factor = historicalCommodityFactor(asset.ticker, bucket);
    const sigma =
      asset.annualVolatility * Math.sqrt(elapsedMinutes / (365 * MINUTES_PER_DAY));

    price = Math.max(
      0.0001,
      open * Math.exp(drift + sigma * factor)
    );

    const wick =
      Math.abs(seededNormal(`commodity-wick:${asset.ticker}:${bucket}`))
      * sigma * open * 0.55;

    const volume =
      asset.baseVolumePerGameMinute
      * elapsedMinutes
      * (0.55 + seededUnit(`commodity-volume:${asset.ticker}:${bucket}`) * 0.90);

    series.push(
      makeFictionalCommodityCandle(
        bucket,
        open,
        Math.max(open, price) + wick,
        Math.max(0.0001, Math.min(open, price) - wick),
        price,
        volume
      )
    );
  }

  if (series.length) {
    const latest = Number(series[series.length - 1].c) || asset.price;
    const ratio = latest > 0 ? asset.price / latest : 1;

    for (const candle of series) {
      candle.o = round(candle.o * ratio, 6);
      candle.h = round(candle.h * ratio, 6);
      candle.l = round(Math.max(0.0001, candle.l * ratio), 6);
      candle.c = round(candle.c * ratio, 6);
    }
  }

  asset.candles[intervalKey] = series.slice(-spec.limit);
  touchCandleSeries("commodity", asset.ticker, intervalKey);
  return asset.candles[intervalKey];
}

function updateCommodityCandles(asset, priorPrice, price, clock, elapsedGameMinutes, playerVolume = 0) {
  const candleEntries = Object.entries(asset.candles || {});
  for (const [intervalKey, series] of candleEntries) {
    const spec = FICTIONAL_INTERVALS[intervalKey];
    if (!spec || !Array.isArray(series) || series.length === 0) continue;
    const bucket = Math.floor(clock.totalMinutes / spec.minutes) * spec.minutes;
    const current = series[series.length - 1];
    const currentBucket = current ? Number(current.bucketMinute) : null;

    const volume = Math.max(
      1,
      Math.round(
        asset.baseVolumePerGameMinute
        * Math.max(0, Number(elapsedGameMinutes) || 0)
        * (0.65 + Math.random() * 0.70)
        + Math.max(0, Number(playerVolume) || 0)
      )
    );

    if (!current || currentBucket !== bucket) {
      series.push(
        makeFictionalCommodityCandle(
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
      current.h = round(Math.max(Number(current.h) || price, price), 6);
      current.l = round(
        Math.max(0.0001, Math.min(Number(current.l) || price, price)),
        6
      );
      current.c = round(price, 6);
      current.v = Math.round((Number(current.v) || 0) + volume);
      current.session = "commodity";
      current.fictional = true;
      current.simulated = true;
    }
  }
}

function updateSimulatedCommodity(asset, elapsedGameMinutes, clock, factors) {
  if (!(elapsedGameMinutes > 0)) return;

  const priorDisplayedPrice = displayedPriceForAsset(asset);
  decayPlayerImpact(asset, elapsedGameMinutes);

  if (commoditySessionForMinute(clock.totalMinutes) !== "open") return;

  if (Number(asset.lastDayIndex) !== clock.dayIndex) {
    asset.lastDayIndex = clock.dayIndex;
    asset.prevClose = Math.max(
      0.0001,
      Number(asset.price) || asset.initialPrice
    );
  }

  const prior = Math.max(
    0.0001,
    Number(asset.price) || asset.initialPrice
  );
  const factor = commodityFactorFromRuntime(asset.ticker, factors);

  const drift =
    asset.annualGrowth * elapsedGameMinutes / (365 * MINUTES_PER_DAY);

  const stochastic =
    asset.annualVolatility
    * factor
    * Math.sqrt(elapsedGameMinutes / (365 * MINUTES_PER_DAY));

  asset.price = Math.max(
    0.0001,
    prior * Math.exp(drift + stochastic)
  );

  updateCommodityCandles(
    asset,
    priorDisplayedPrice,
    displayedPriceForAsset(asset),
    clock,
    elapsedGameMinutes
  );
}

function fictionalCommodityRow(asset, clock = marketClock()) {
  const executionReferencePrice = Math.max(
    0.0001,
    Number(asset.price) || asset.initialPrice
  );
  const price = displayedPriceForAsset(asset);
  const prevClose = Math.max(
    0.0001,
    Number(asset.prevClose) || executionReferencePrice
  );

  return {
    ticker: asset.ticker,
    symbol: asset.ticker,
    name: asset.name,
    unit: asset.unit,
    assetType: "commodity",
    fictional: true,
    simulated: true,
    price: round(price, 6),
    executionPrice: round(executionReferencePrice, 6),
    playerImpactPct: round(currentPlayerImpact(asset) * 100, 4),
    prevClose: round(prevClose, 6),
    changePct: round(((price - prevClose) / prevClose) * 100, 3),
    marketState: commoditySessionForMinute(clock.totalMinutes) === "open"
      ? "OPEN"
      : "CLOSED",
    session: "commodity",
    source: "Godly Capital fictional commodity simulation",
    lastUpdated: Math.floor(Date.now() / 1000)
  };
}

async function getCommodityPrices() {
  engineStep();
  ensureSimulatedCommodityState(marketState);

  const prices = {};
  const clock = marketClock();

  for (const ticker of COMMODITY_SYMBOLS) {
    const asset = marketState.commodities[ticker];
    if (asset) prices[ticker] = fictionalCommodityRow(asset, clock);
  }

  return {
    success: true,
    fictional: true,
    simulated: true,
    externalCommodityDataUsed: false,
    prices,
    source: "Godly Capital fictional commodity simulation",
    updatedAt: Math.floor(Date.now() / 1000)
  };
}

async function getCommodityCandles(ticker, interval) {
  engineStep();
  ensureSimulatedCommodityState(marketState);

  const asset = marketState.commodities[ticker];
  if (!asset) {
    return {
      ticker,
      interval,
      fictional: true,
      error: "Unknown fictional commodity."
    };
  }

  if (!FICTIONAL_INTERVALS[interval]) {
    return {
      ticker,
      interval,
      fictional: true,
      error: "Unsupported commodity interval."
    };
  }

  return {
    success: true,
    ticker,
    name: asset.name,
    interval,
    commodity: true,
    fictional: true,
    simulated: true,
    assetType: "commodity",
    source: "Godly Capital fictional commodity simulation",
    livePriceCompatible: true,
    candles: withRsi(ensureCommodityCandleSeries(asset, interval)),
    indicators: {
      rsiPeriod: 14,
      rsiSource: "candle-close"
    }
  };
}

// ============================
// Fictional stock exchange - MAIN GAME CATALOG
// ============================
// Stock prices/candles/news are fully simulated after the one-time handoff.
// Crypto and commodities are also fully simulated and use no real-world
// crypto/commodity market feeds.
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


// ============================
// Stock classifications / hierarchical shared-factor model
// ============================
// Hierarchy:
//   Sector -> Category -> Subcategory
//
// "Industry" is a parallel business/production factor. It exists because a stock
// can belong to a thematic category such as Artificial Intelligence while still
// being physically exposed to semiconductors/electronics. Commodity coupling uses
// INDUSTRY factors, so AI semiconductor strength can still push SILVER/GOLD.
//
// Example:
//   MVDO (NVDA counterpart)
//   Sector      = Information Technology
//   Category    = Artificial Intelligence
//   Subcategory = AI Semiconductors
//   Industry    = Electronics & Semiconductors
//
// This prevents the AI category from erasing the economically important
// semiconductor/electronics relationship.
const STOCK_CLASSIFICATION = {
  ORNG: { sector: "Information Technology", category: "Consumer Technology", subcategory: "Consumer Electronics", industry: "Electronics & Semiconductors" },
  MHRD: { sector: "Information Technology", category: "Artificial Intelligence", subcategory: "AI Platforms & Cloud", industry: "Software & Cloud" },
  MVDO: { sector: "Information Technology", category: "Artificial Intelligence", subcategory: "AI Semiconductors", industry: "Electronics & Semiconductors" },
  AMZG: { sector: "Consumer Discretionary", category: "E-Commerce & Retail", subcategory: "E-Commerce Platforms", industry: "Consumer Discretionary" },
  ELPHT: { sector: "Communication Services", category: "Artificial Intelligence", subcategory: "AI Platforms & Cloud", industry: "Internet & Digital Media" },
  DATA: { sector: "Communication Services", category: "Artificial Intelligence", subcategory: "AI Platforms & Models", industry: "Internet & Digital Media" },
  NKLA: { sector: "Consumer Discretionary", category: "Automotive", subcategory: "Electric Vehicles", industry: "Automotive" },
  SKYX: { sector: "Industrials", category: "Aerospace & Defense", subcategory: "Space & Launch", industry: "Aerospace & Defense" },
  BKSG: { sector: "Financials", category: "Financial Services", subcategory: "Diversified Holdings", industry: "Financial Services" },
  HCC: { sector: "Information Technology", category: "Artificial Intelligence", subcategory: "AI Semiconductors", industry: "Electronics & Semiconductors" },
  ELLY: { sector: "Health Care", category: "Healthcare & Biotech", subcategory: "Pharmaceuticals", industry: "Healthcare & Biotech" },
  PMK: { sector: "Financials", category: "Financial Services", subcategory: "Banking", industry: "Financial Services" },
  M: { sector: "Financials", category: "Financial Services", subcategory: "Payments", industry: "Financial Services" },
  FMT: { sector: "Consumer Staples", category: "Consumer Staples", subcategory: "Discount Retail", industry: "Consumer Staples" },
  DVS: { sector: "Health Care", category: "Healthcare & Biotech", subcategory: "Health Insurance", industry: "Healthcare & Biotech" },
  WXM: { sector: "Energy", category: "Energy", subcategory: "Integrated Oil & Gas", industry: "Energy" },
  ABMD: { sector: "Information Technology", category: "Artificial Intelligence", subcategory: "AI Semiconductors", industry: "Electronics & Semiconductors" },
  NFKS: { sector: "Communication Services", category: "Entertainment & Media", subcategory: "Streaming", industry: "Internet & Digital Media" },
  BUM: { sector: "Information Technology", category: "Artificial Intelligence", subcategory: "AI Enterprise Software", industry: "Software & Cloud" },
  DGBE: { sector: "Information Technology", category: "Artificial Intelligence", subcategory: "AI Creative Software", industry: "Software & Cloud" },
  REVL: { sector: "Information Technology", category: "Artificial Intelligence", subcategory: "AI Platforms & Cloud", industry: "Software & Cloud" },
  MNEY: { sector: "Consumer Staples", category: "Consumer Staples", subcategory: "Warehouse Retail", industry: "Consumer Staples" },
  VKNEE: { sector: "Communication Services", category: "Entertainment & Media", subcategory: "Diversified Entertainment", industry: "Internet & Digital Media" },
  BEAR: { sector: "Industrials", category: "Aerospace & Defense", subcategory: "Commercial Aerospace", industry: "Aerospace & Defense" },
  NICY: { sector: "Consumer Discretionary", category: "Consumer Discretionary", subcategory: "Apparel & Footwear", industry: "Consumer Discretionary" },
  PPL: { sector: "Financials", category: "Financial Services", subcategory: "Digital Payments", industry: "Financial Services" },
  INFO: { sector: "Information Technology", category: "Electronics & Semiconductors", subcategory: "Semiconductors", industry: "Electronics & Semiconductors" },
  OVER: { sector: "Industrials", category: "Transportation & Travel", subcategory: "Mobility Platforms", industry: "Transportation & Travel" },
  WBAB: { sector: "Consumer Discretionary", category: "Transportation & Travel", subcategory: "Lodging Platforms", industry: "Transportation & Travel" },
  SMNY: { sector: "Consumer Discretionary", category: "Consumer Discretionary", subcategory: "Restaurants & Coffee", industry: "Consumer Discretionary" },
  BC: { sector: "Consumer Staples", category: "Consumer Staples", subcategory: "Beverages", industry: "Consumer Staples" },
  RBLX: { sector: "Communication Services", category: "Digital Platforms & Media", subcategory: "Gaming Platforms", industry: "Internet & Digital Media" },
  CHHD: { sector: "ETF", category: "Defensive Dividend ETF", subcategory: "Dividend Equity ETF", industry: "Diversified ETF" },
  VSS: { sector: "ETF", category: "Broad Market ETF", subcategory: "Large-Cap Market ETF", industry: "Diversified ETF" },

  MASK: { sector: "Information Technology", category: "Software & Cloud", subcategory: "Application Software", industry: "Software & Cloud" },
  MNTS: { sector: "Industrials", category: "Aerospace & Defense", subcategory: "Space Infrastructure", industry: "Aerospace & Defense" },
  DSY: { sector: "Information Technology", category: "Software & Cloud", subcategory: "Application Software", industry: "Software & Cloud" },
  ERNA: { sector: "Health Care", category: "Healthcare & Biotech", subcategory: "Biotechnology", industry: "Healthcare & Biotech" },
  CLDI: { sector: "Health Care", category: "Healthcare & Biotech", subcategory: "Biotechnology", industry: "Healthcare & Biotech" },
  AZI: { sector: "Consumer Discretionary", category: "Automotive", subcategory: "Automotive Technology", industry: "Automotive" },
  DXST: { sector: "Information Technology", category: "Software & Cloud", subcategory: "Technology Services", industry: "Software & Cloud" },
  WCT: { sector: "Communication Services", category: "Communications", subcategory: "Telecommunications", industry: "Communications & Networking" },
  AIXI: { sector: "Information Technology", category: "Artificial Intelligence", subcategory: "AI Software & Applications", industry: "Software & Cloud" },
  CODX: { sector: "Health Care", category: "Healthcare & Biotech", subcategory: "Diagnostics", industry: "Healthcare & Biotech" },
  GOVX: { sector: "Health Care", category: "Healthcare & Biotech", subcategory: "Vaccines & Biotechnology", industry: "Healthcare & Biotech" },
  CHAI: { sector: "Consumer Staples", category: "Consumer Staples", subcategory: "Beverages", industry: "Consumer Staples" },
  CDLX: { sector: "Communication Services", category: "Digital Platforms & Media", subcategory: "Advertising Technology", industry: "Internet & Digital Media" },
  DCX: { sector: "Industrials", category: "Industrials & Manufacturing", subcategory: "Industrial Services", industry: "Industrials & Manufacturing" },
  CLPR: { sector: "Real Estate", category: "Real Estate", subcategory: "Commercial Real Estate", industry: "Real Estate" }
};

const CATEGORY_CONFIG = {
  "Artificial Intelligence": { marketBeta: 1.18 },
  "Consumer Technology": { marketBeta: 1.02 },
  "Electronics & Semiconductors": { marketBeta: 1.10 },
  "Software & Cloud": { marketBeta: 1.05 },
  "Digital Platforms & Media": { marketBeta: 1.08 },
  "Entertainment & Media": { marketBeta: 0.98 },
  "E-Commerce & Retail": { marketBeta: 1.00 },
  "Financial Services": { marketBeta: 0.90 },
  "Consumer Discretionary": { marketBeta: 1.00 },
  "Consumer Staples": { marketBeta: 0.58 },
  "Healthcare & Biotech": { marketBeta: 0.78 },
  "Aerospace & Defense": { marketBeta: 0.82 },
  "Energy": { marketBeta: 0.88 },
  "Transportation & Travel": { marketBeta: 1.00 },
  "Industrials & Manufacturing": { marketBeta: 0.88 },
  "Communications": { marketBeta: 0.92 },
  "Automotive": { marketBeta: 1.15 },
  "Real Estate": { marketBeta: 0.72 },

  // Empty/future top-level categories:
  "Materials & Mining": { marketBeta: 0.82 },
  "Utilities": { marketBeta: 0.45 },
  "Agriculture": { marketBeta: 0.62 },

  "Broad Market ETF": { marketBeta: 1.00 },
  "Defensive Dividend ETF": { marketBeta: 0.62 }
};

const SUBCATEGORY_CONFIG = {
  "AI Semiconductors": {},
  "AI Platforms & Cloud": {},
  "AI Platforms & Models": {},
  "AI Enterprise Software": {},
  "AI Creative Software": {},
  "AI Software & Applications": {},

  // Future AI subcategories can exist before any listing uses them.
  "AI Robotics": {},
  "AI Cybersecurity": {},
  "AI Healthcare": {},
  "AI Infrastructure": {}
};

const INDUSTRY_CONFIG = {
  "Electronics & Semiconductors": {},
  "Software & Cloud": {},
  "Internet & Digital Media": {},
  "Financial Services": {},
  "Consumer Discretionary": {},
  "Consumer Staples": {},
  "Healthcare & Biotech": {},
  "Aerospace & Defense": {},
  "Energy": {},
  "Transportation & Travel": {},
  "Industrials & Manufacturing": {},
  "Communications & Networking": {},
  "Automotive": {},
  "Real Estate": {},
  "Materials & Mining": {},
  "Utilities": {},
  "Agriculture": {},
  "Diversified ETF": {}
};

const DEFAULT_CATEGORY_BY_SECTOR = {
  "Information Technology": "Software & Cloud",
  "Technology": "Software & Cloud",
  "Communication Services": "Digital Platforms & Media",
  "Financials": "Financial Services",
  "Consumer Discretionary": "Consumer Discretionary",
  "Consumer Cyclical": "Consumer Discretionary",
  "Consumer Staples": "Consumer Staples",
  "Consumer Defensive": "Consumer Staples",
  "Health Care": "Healthcare & Biotech",
  "Healthcare": "Healthcare & Biotech",
  "Industrials": "Industrials & Manufacturing",
  "Energy": "Energy",
  "Real Estate": "Real Estate",
  "Utilities": "Utilities",
  "Materials": "Materials & Mining",
  "ETF": "Broad Market ETF"
};

function classifyStock(ticker, fallbackSector = "Industrials") {
  const exact = STOCK_CLASSIFICATION[String(ticker || "").toUpperCase()];
  if (exact) return exact;

  const sector = String(fallbackSector || "Industrials");
  const category = DEFAULT_CATEGORY_BY_SECTOR[sector] || "Industrials & Manufacturing";

  return {
    sector,
    category,
    subcategory: category,
    industry: category
  };
}

function ensureStockClassifications(state) {
  if (!state || !state.companies) return;

  for (const company of Object.values(state.companies)) {
    const classification = classifyStock(company.ticker, company.sector);
    company.sector = classification.sector;
    company.category = classification.category;
    company.subcategory = classification.subcategory;
    company.industry = classification.industry;
  }
}

function weightedFactor(components) {
  let total = 0;
  let weightSq = 0;

  for (const [value, weight] of components) {
    if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(weight)) || weight === 0) continue;
    total += Number(value) * Number(weight);
    weightSq += Number(weight) * Number(weight);
  }

  return weightSq > 0 ? total / Math.sqrt(weightSq) : 0;
}

function averageCategoryShock(factors, names) {
  if (!factors || !factors.categories || !Array.isArray(names) || !names.length) return 0;

  let total = 0;
  let count = 0;

  for (const name of names) {
    const value = Number(factors.categories[name]);
    if (Number.isFinite(value)) {
      total += value;
      count += 1;
    }
  }

  return count > 0 ? total / count : 0;
}

function buildMarketFactorStep() {
  const categories = {};
  const subcategories = {};
  const industries = {};

  for (const category of Object.keys(CATEGORY_CONFIG)) {
    categories[category] = randomNormal();
  }

  // Include subcategories currently assigned to companies, plus explicitly
  // supported future subcategories.
  for (const classification of Object.values(STOCK_CLASSIFICATION)) {
    if (classification.subcategory && subcategories[classification.subcategory] == null) {
      subcategories[classification.subcategory] = randomNormal();
    }
  }
  for (const subcategory of Object.keys(SUBCATEGORY_CONFIG)) {
    if (subcategories[subcategory] == null) {
      subcategories[subcategory] = randomNormal();
    }
  }

  for (const industry of Object.keys(INDUSTRY_CONFIG)) {
    industries[industry] = randomNormal();
  }

  return {
    market: randomNormal(),
    metals: randomNormal(),
    oil: randomNormal(),
    inflation: randomNormal(),
    categories,
    subcategories,
    industries
  };
}

function stockFactorFromRuntime(company, factors) {
  const classification = classifyStock(company.ticker, company.sector);
  const category = company.category || classification.category;
  const subcategory = company.subcategory || classification.subcategory;
  const industry = company.industry || classification.industry;
  const config = CATEGORY_CONFIG[category] || { marketBeta: 1 };

  if (category === "Broad Market ETF") {
    return weightedFactor([
      [factors.market, 0.80],
      [averageCategoryShock(factors, [
        "Artificial Intelligence",
        "Consumer Technology",
        "Software & Cloud",
        "Digital Platforms & Media",
        "Financial Services",
        "Consumer Discretionary",
        "Consumer Staples",
        "Healthcare & Biotech",
        "Industrials & Manufacturing",
        "Energy"
      ]), 0.40],
      [randomNormal(), 0.16]
    ]);
  }

  if (category === "Defensive Dividend ETF") {
    return weightedFactor([
      [factors.market, 0.34],
      [averageCategoryShock(factors, [
        "Consumer Staples",
        "Healthcare & Biotech",
        "Financial Services",
        "Utilities"
      ]), 0.64],
      [randomNormal(), 0.18]
    ]);
  }

  const components = [
    [factors.market, 0.22 * (Number(config.marketBeta) || 1)],
    [factors.categories[category] || 0, 0.38],
    [factors.subcategories[subcategory] || 0, 0.26],
    [factors.industries[industry] || 0, 0.28],
    [randomNormal(), 0.58]
  ];

  // Commodity-sensitive INDUSTRIES. This is intentionally separate from the
  // thematic category hierarchy.
  if (industry === "Energy") components.push([factors.oil, 0.34]);
  if (industry === "Transportation & Travel") components.push([factors.oil, -0.14]);
  if (industry === "Consumer Discretionary") components.push([factors.oil, -0.05]);
  if (industry === "Automotive") components.push([factors.oil, -0.06]);
  if (industry === "Materials & Mining") components.push([factors.metals, 0.34]);
  if (industry === "Industrials & Manufacturing") components.push([factors.oil, 0.07]);

  return weightedFactor(components);
}

// Deterministic pseudo-random helpers are used only when a chart series must be
// generated from scratch. Same-category stocks therefore receive the same
// historical category component instead of completely unrelated fake histories.
function seededHash(text) {
  let hash = 2166136261 >>> 0;
  const input = String(text);
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function seededUnit(key) {
  return (seededHash(key) + 1) / 4294967297;
}

function seededNormal(key) {
  const u = Math.max(seededUnit(`${key}:u`), Number.EPSILON);
  const v = Math.max(seededUnit(`${key}:v`), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function historicalStockFactor(company, bucket) {
  const classification = classifyStock(company.ticker, company.sector);
  const category = company.category || classification.category;
  const subcategory = company.subcategory || classification.subcategory;
  const industry = company.industry || classification.industry;
  const config = CATEGORY_CONFIG[category] || { marketBeta: 1 };

  const market = seededNormal(`market:${bucket}`);
  const categoryShock = seededNormal(`category:${category}:${bucket}`);
  const subcategoryShock = seededNormal(`subcategory:${subcategory}:${bucket}`);
  const industryShock = seededNormal(`industry:${industry}:${bucket}`);
  const idiosyncratic = seededNormal(`stock:${company.ticker}:${bucket}`);
  const oil = seededNormal(`oil:${bucket}`);
  const metals = seededNormal(`metals:${bucket}`);

  if (category === "Broad Market ETF") {
    return weightedFactor([
      [market, 0.82],
      [seededNormal(`category-broad:${bucket}`), 0.38],
      [idiosyncratic, 0.14]
    ]);
  }

  if (category === "Defensive Dividend ETF") {
    return weightedFactor([
      [market, 0.34],
      [seededNormal(`category-defensive:${bucket}`), 0.64],
      [idiosyncratic, 0.18]
    ]);
  }

  const components = [
    [market, 0.22 * (Number(config.marketBeta) || 1)],
    [categoryShock, 0.38],
    [subcategoryShock, 0.26],
    [industryShock, 0.28],
    [idiosyncratic, 0.58]
  ];

  if (industry === "Energy") components.push([oil, 0.34]);
  if (industry === "Transportation & Travel") components.push([oil, -0.14]);
  if (industry === "Consumer Discretionary") components.push([oil, -0.05]);
  if (industry === "Automotive") components.push([oil, -0.06]);
  if (industry === "Materials & Mining") components.push([metals, 0.34]);

  return weightedFactor(components);
}

// Commodity factor coupling.
// Electronics has a positive effect on BOTH precious metals, but silver's
// coefficient is intentionally much larger.
function commodityFactorFromRuntime(ticker, factors) {
  const electronics = Number(factors.industries["Electronics & Semiconductors"]) || 0;
  const industrials = Number(factors.industries["Industrials & Manufacturing"]) || 0;
  const materials = Number(factors.industries["Materials & Mining"]) || 0;
  const energy = Number(factors.industries["Energy"]) || 0;
  const transport = Number(factors.industries["Transportation & Travel"]) || 0;
  const consumer = Number(factors.industries["Consumer Discretionary"]) || 0;

  if (ticker === "GOLD") {
    return weightedFactor([
      [factors.metals, 0.72],
      [factors.inflation, 0.14],
      [factors.market, -0.13],
      [electronics, 0.11],
      [materials, 0.24],
      [randomNormal(), 0.34]
    ]);
  }

  if (ticker === "SILVER") {
    return weightedFactor([
      [factors.metals, 0.68],
      [factors.inflation, 0.12],
      [factors.market, 0.05],
      [electronics, 0.40],
      [industrials, 0.20],
      [materials, 0.28],
      [randomNormal(), 0.34]
    ]);
  }

  return weightedFactor([
    [factors.oil, 0.68],
    [factors.market, 0.08],
    [energy, 0.46],
    [transport, 0.13],
    [industrials, 0.14],
    [consumer, 0.08],
    [randomNormal(), 0.38]
  ]);
}

function historicalCommodityFactor(ticker, bucket) {
  const metals = seededNormal(`metals:${bucket}`);
  const oil = seededNormal(`oil:${bucket}`);
  const inflation = seededNormal(`inflation:${bucket}`);
  const market = seededNormal(`market:${bucket}`);
  const electronics = seededNormal(`industry:Electronics & Semiconductors:${bucket}`);
  const industrials = seededNormal(`industry:Industrials & Manufacturing:${bucket}`);
  const materials = seededNormal(`industry:Materials & Mining:${bucket}`);
  const energy = seededNormal(`industry:Energy:${bucket}`);
  const transport = seededNormal(`industry:Transportation & Travel:${bucket}`);
  const consumer = seededNormal(`industry:Consumer Discretionary:${bucket}`);
  const idio = seededNormal(`commodity:${ticker}:${bucket}`);

  if (ticker === "GOLD") {
    return weightedFactor([
      [metals, 0.72],
      [inflation, 0.14],
      [market, -0.13],
      [electronics, 0.11],
      [materials, 0.24],
      [idio, 0.34]
    ]);
  }

  if (ticker === "SILVER") {
    return weightedFactor([
      [metals, 0.68],
      [inflation, 0.12],
      [market, 0.05],
      [electronics, 0.40],
      [industrials, 0.20],
      [materials, 0.28],
      [idio, 0.34]
    ]);
  }

  return weightedFactor([
    [oil, 0.68],
    [market, 0.08],
    [energy, 0.46],
    [transport, 0.13],
    [industrials, 0.14],
    [consumer, 0.08],
    [idio, 0.38]
  ]);
}

const YAHOO_HANDOFF_CONCURRENCY = clamp(
  Number(process.env.YAHOO_HANDOFF_CONCURRENCY) || 6,
  1,
  10
);

const FICTIONAL_INTERVALS = {
  // The Roblox chart shows 45 candles at once. These limits still allow several
  // screens of history while preventing dormant series from growing forever.
  "1m": { minutes: 1, limit: 180 },
  "5m": { minutes: 5, limit: 180 },
  "15m": { minutes: 15, limit: 180 },
  "30m": { minutes: 30, limit: 180 },
  "1h": { minutes: 60, limit: 200 },
  "1d": { minutes: 1440, limit: 220 }
};

const CANDLE_CACHE_IDLE_MS = clamp(
  Number(process.env.CANDLE_CACHE_IDLE_MS) || (5 * 60 * 1000),
  60 * 1000,
  60 * 60 * 1000
);

const CANDLE_CACHE_SWEEP_MS = 60 * 1000;
const candleSeriesLastAccess = new Map();

function candleCacheKey(kind, symbol, interval) {
  return `${kind}:${String(symbol || "").toUpperCase()}:${String(interval || "")}`;
}

function touchCandleSeries(kind, symbol, interval) {
  candleSeriesLastAccess.set(
    candleCacheKey(kind, symbol, interval),
    Date.now()
  );
}

function clearAllCandleCaches(state) {
  if (!state) return;

  for (const company of Object.values(state.companies || {})) {
    company.candles = {};
  }

  for (const asset of Object.values(state.cryptos || {})) {
    asset.candles = {};
  }

  for (const asset of Object.values(state.commodities || {})) {
    asset.candles = {};
  }

  candleSeriesLastAccess.clear();
}

function evictIdleCandleSeries() {
  if (!marketState) return;

  const now = Date.now();

  function sweep(kind, collection, symbolField) {
    for (const asset of Object.values(collection || {})) {
      if (!asset || !asset.candles) continue;

      const symbol = asset[symbolField];
      for (const interval of Object.keys(asset.candles)) {
        const key = candleCacheKey(kind, symbol, interval);
        const lastAccess = candleSeriesLastAccess.get(key) || 0;

        if (now - lastAccess >= CANDLE_CACHE_IDLE_MS) {
          delete asset.candles[interval];
          candleSeriesLastAccess.delete(key);
        }
      }
    }
  }

  sweep("stock", marketState.companies, "ticker");
  sweep("crypto", marketState.cryptos, "symbol");
  sweep("commodity", marketState.commodities, "ticker");
}

function residentCandleStats() {
  let series = 0;
  let candles = 0;

  function count(collection) {
    for (const asset of Object.values(collection || {})) {
      for (const value of Object.values(asset?.candles || {})) {
        if (Array.isArray(value)) {
          series += 1;
          candles += value.length;
        }
      }
    }
  }

  count(marketState?.companies);
  count(marketState?.cryptos);
  count(marketState?.commodities);

  return { series, candles };
}

// ============================
// Player trade market impact
// ============================
// Player flow moves the displayed quote/chart, but that pressure is temporary.
// The execution reference remains the underlying simulated price. Therefore a
// player cannot buy, create their own spike, then immediately dump into that
// same self-created spike.
//
// Impact follows a square-root participation curve. Tiny orders are effectively
// invisible, large orders are visible, and hard caps prevent memecoin-style
// vertical pumps even if several players coordinate.
const PLAYER_IMPACT_FAST_HALF_LIFE_GAME_MINUTES = 4;
const PLAYER_IMPACT_SLOW_HALF_LIFE_GAME_MINUTES = 30;
const PLAYER_IMPACT_FAST_WEIGHT = 0.72;
const PLAYER_IMPACT_SLOW_WEIGHT = 0.28;
const PLAYER_IMPACT_MIN_VISIBLE = 0.000005; // 0.0005%

function ensurePlayerImpactState(asset) {
  if (!asset || typeof asset !== "object") return;
  if (!Number.isFinite(Number(asset.playerImpactFast))) asset.playerImpactFast = 0;
  if (!Number.isFinite(Number(asset.playerImpactSlow))) asset.playerImpactSlow = 0;
}

function currentPlayerImpact(asset) {
  ensurePlayerImpactState(asset);
  return Number(asset.playerImpactFast || 0) + Number(asset.playerImpactSlow || 0);
}

function decayPlayerImpact(asset, elapsedGameMinutes) {
  ensurePlayerImpactState(asset);
  const elapsed = Math.max(0, Number(elapsedGameMinutes) || 0);
  if (!(elapsed > 0)) return;

  asset.playerImpactFast *= Math.exp(
    -Math.LN2 * elapsed / PLAYER_IMPACT_FAST_HALF_LIFE_GAME_MINUTES
  );
  asset.playerImpactSlow *= Math.exp(
    -Math.LN2 * elapsed / PLAYER_IMPACT_SLOW_HALF_LIFE_GAME_MINUTES
  );

  if (Math.abs(asset.playerImpactFast) < 1e-10) asset.playerImpactFast = 0;
  if (Math.abs(asset.playerImpactSlow) < 1e-10) asset.playerImpactSlow = 0;
}

function displayedPriceForAsset(asset) {
  const base = Math.max(
    0.00000001,
    Number(asset?.price ?? asset?.initialPrice) || 0.00000001
  );
  return base * Math.exp(currentPlayerImpact(asset));
}

function playerImpactModel(assetType, asset, clock = marketClock()) {
  const kind = String(assetType || "").toLowerCase();

  if (kind === "stock") {
    const marketCap = Math.max(
      1,
      Number(asset.price) * Math.max(1, Number(asset.sharesOutstanding) || 1)
    );
    const liquidity = clamp(Number(asset.liquidity) || 0.7, 0.05, 1);
    const volatility = Math.max(0.05, Number(asset.annualVolatility) || 0.30);

    return {
      liquidityNotional: clamp(
        Math.sqrt(marketCap) * 1450 * (0.75 + liquidity),
        3000000,
        120000000
      ),
      coefficient: 0.0046 + volatility * 0.0018 + (1 - liquidity) * 0.0012,
      maxTradeImpact: clock.session === "open" ? 0.0065 : 0.0085,
      maxOverlay: 0.0125
    };
  }

  if (kind === "crypto") {
    const marketCap = Math.max(
      1,
      Number(asset.price) * Math.max(1, Number(asset.totalSupply) || 1)
    );
    const liquidity = clamp(Number(asset.liquidity) || 0.7, 0.05, 1);

    return {
      liquidityNotional: clamp(
        Math.sqrt(marketCap) * 1050 * (0.75 + liquidity),
        2000000,
        80000000
      ),
      coefficient: 0.0062 + (1 - liquidity) * 0.0024,
      maxTradeImpact: 0.0085,
      maxOverlay: 0.015
    };
  }

  const referencePrice = Math.max(
    0.0001,
    Number(asset.price ?? asset.initialPrice) || 1
  );
  const baseVolume = Math.max(
    1,
    Number(asset.baseVolumePerGameMinute) || 10000
  );

  return {
    liquidityNotional: clamp(
      baseVolume * referencePrice * 2.5,
      5000000,
      100000000
    ),
    coefficient: 0.0045,
    maxTradeImpact: 0.0065,
    maxOverlay: 0.010
  };
}

function calculatePlayerTradeImpact(assetType, asset, side, quantity, clock = marketClock()) {
  const executionReferencePrice = Math.max(
    0.00000001,
    Number(asset.price) || Number(asset.initialPrice) || 0.00000001
  );
  const qty = Math.max(0, Number(quantity) || 0);
  const notional = executionReferencePrice * qty;
  const model = playerImpactModel(assetType, asset, clock);

  if (!(notional > 0) || !(model.liquidityNotional > 0)) {
    return {
      executionReferencePrice,
      notional,
      requestedImpact: 0,
      appliedImpact: 0,
      model
    };
  }

  const participation = notional / model.liquidityNotional;
  let requestedImpact =
    model.coefficient * Math.sqrt(Math.max(0, participation));

  requestedImpact = clamp(
    requestedImpact,
    0,
    model.maxTradeImpact
  );

  if (requestedImpact < PLAYER_IMPACT_MIN_VISIBLE) {
    requestedImpact = 0;
  }

  const direction = side === "sell" ? -1 : 1;
  const current = currentPlayerImpact(asset);
  const target = clamp(
    current + direction * requestedImpact,
    -model.maxOverlay,
    model.maxOverlay
  );

  return {
    executionReferencePrice,
    notional,
    requestedImpact,
    appliedImpact: target - current,
    model
  };
}

function applyPlayerTradeImpact(asset, impactInfo) {
  ensurePlayerImpactState(asset);
  const applied = Number(impactInfo?.appliedImpact) || 0;
  if (applied === 0) return;
  asset.playerImpactFast += applied * PLAYER_IMPACT_FAST_WEIGHT;
  asset.playerImpactSlow += applied * PLAYER_IMPACT_SLOW_WEIGHT;
}


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
let marketFastForwardInProgress = false;
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
  const [ticker, name, seedSector, capGroup, valueBillions, ipoPrice, annualGrowth, annualVolatility, dividendYield, liquidity] = seed;
  const classification = classifyStock(ticker, seedSector);
  const sector = classification.sector;
  const category = classification.category;
  const subcategory = classification.subcategory;
  const industry = classification.industry;
  const companyValue = valueBillions * 1e9;
  const sharesOutstanding = companyValue / ipoPrice;
  return {
    ticker, name, sector, category, subcategory, industry, capGroup, companyValue, sharesOutstanding,
    price: ipoPrice,
    prevClose: ipoPrice,
    lastRegularClosePrice: ipoPrice,
    lastRegularCloseDayIndex: null,
    dailyReferencePrice: ipoPrice,
    dailyReferenceDayIndex: 0,
    dailyChangeModelVersion: DAILY_CHANGE_MODEL_VERSION,
    initialPrice: ipoPrice,
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

  ensureStockClassifications({ companies });

  const state = {
    version: 5,
    catalogVersion: FICTIONAL_CATALOG_VERSION,
    clockMode: "accelerated-fictional-week",
    clockAnchorRealMs: Date.now(),
    clockAnchorGameSeconds: CLOCK_START_MINUTE * 60,
    realSecondsPerGameMinute: REAL_SECONDS_PER_GAME_MINUTE,
    lastUpdatedGameMinute: CLOCK_START_MINUTE,
    lastUpdatedGameSecond: CLOCK_START_MINUTE * 60,
    dailyChangeModelVersion: DAILY_CHANGE_MODEL_VERSION,
    lastIpoWeek: 0,
    nextNewsGameMinute: CLOCK_START_MINUTE + 120,
    companies,
    cryptos: buildInitialSimulatedCryptoMap(),
    commodities: buildInitialSimulatedCommodityMap(),
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

    // Retain the old real-world close only as diagnostics. Fictional daily %
    // begins from the fictional handoff quote.
    company.realPrevCloseAtHandoff = item.prevClose;
    company.prevClose = livePrice;
    company.lastRegularClosePrice = livePrice;
    company.lastRegularCloseDayIndex = null;
    company.dailyReferencePrice = livePrice;
    company.dailyReferenceDayIndex = 0;
    company.dailyChangeModelVersion = DAILY_CHANGE_MODEL_VERSION;

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
  marketState.dailyChangeModelVersion = DAILY_CHANGE_MODEL_VERSION;

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

    // Candle histories are regenerable caches, not authoritative market state.
    // Skipping them keeps the state file tiny and prevents JSON.stringify from
    // allocating a second giant copy of every chart in RAM during each save.
    const serialized = JSON.stringify(marketState, (key, value) => {
      if (key === "candles") return undefined;
      return value;
    });

    fs.writeFileSync(temporary, serialized);
    fs.renameSync(temporary, STATE_FILE);
  } catch (error) {
    console.error(`[FICTIONAL] State save failed: ${error.message}`);
  }
}

function queueSave(delayMs = 1000) {
  if (marketFastForwardInProgress) return;
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
    ensureStockClassifications(marketState);
    ensureSimulatedCryptoState(marketState);
    ensureSimulatedCommodityState(marketState);

    // v11 and older state files may contain tens of thousands of candle objects.
    // Drop them immediately; they are rebuilt lazily when a chart is requested.
    clearAllCandleCaches(marketState);
    marketState.news = Array.isArray(marketState.news)
      ? marketState.news.slice(0, 120)
      : [];

    marketState.tradeReceipts = marketState.tradeReceipts || {};
    const loadedReceiptIds = Object.keys(marketState.tradeReceipts);
    if (loadedReceiptIds.length > 500) {
      for (const id of loadedReceiptIds.slice(0, loadedReceiptIds.length - 500)) {
        delete marketState.tradeReceipts[id];
      }
    }
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

    if (Number(marketState.dailyChangeModelVersion) !== DAILY_CHANGE_MODEL_VERSION) {
      let rebasedCount = 0;

      for (const company of Object.values(marketState.companies || {})) {
        if (migrateCompanyDailyReference(company, clock)) {
          rebasedCount += 1;
        }
      }

      marketState.dailyChangeModelVersion = DAILY_CHANGE_MODEL_VERSION;

      console.log(
        `[FICTIONAL DAILY CHANGE] Upgraded existing market state. ` +
        `${rebasedCount} implausible legacy baseline(s) were rebased.`
      );

      saveStateNow();
    } else {
      for (const company of Object.values(marketState.companies || {})) {
        ensureDailyReferenceForTradingDay(company, clock);
      }
    }

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


// ============================
// Fictional daily-change baseline
// ============================
// Daily % compares against the PREVIOUS regular-session close.
//
// Keep two values:
//   lastRegularClosePrice = latest fictional 4:00 PM close
//   dailyReferencePrice   = baseline used for the CURRENT trading day's %
//
// A 4:00 PM close is saved without resetting today's % to zero. It becomes the
// new baseline on the next weekday. Friday's close therefore carries to Monday.
const DAILY_CHANGE_MODEL_VERSION = 2;

function stockDailySanityLimitPct(company) {
  const annualVolatility = Math.max(
    0.01,
    Number(company?.annualVolatility) || 0.30
  );

  const dailySigmaPct =
    annualVolatility * 100 / Math.sqrt(252);

  return Math.max(
    4.0,
    dailySigmaPct * 4 + 1.75
  );
}

function migrateCompanyDailyReference(company, clock) {
  if (!company || typeof company !== "object") return false;

  const currentDisplay = displayedPriceForAsset(company);
  const existingLastClose = Number(company.lastRegularClosePrice);
  const existingPrevClose = Number(company.prevClose);

  let candidate =
    existingLastClose > 0
      ? existingLastClose
      : existingPrevClose > 0
        ? existingPrevClose
        : currentDisplay;

  const changeFromCandidate =
    candidate > 0
      ? Math.abs((currentDisplay - candidate) / candidate) * 100
      : Infinity;

  const sanityLimit = stockDailySanityLimitPct(company);
  let rebased = false;

  if (
    !(candidate > 0)
    || !Number.isFinite(changeFromCandidate)
    || changeFromCandidate > sanityLimit
  ) {
    // Older builds did not persist enough information to reconstruct a true
    // fictional previous close once the saved baseline is obviously corrupted.
    // Rebase only the bad asset instead of displaying a fabricated move.
    candidate = currentDisplay;
    rebased = true;
    company.dailyReferenceRebasedAt = Math.floor(Date.now() / 1000);
    company.dailyReferenceRebaseReason = "implausible_legacy_baseline";
  }

  company.lastRegularClosePrice = candidate;
  company.lastRegularCloseDayIndex =
    Number.isFinite(Number(marketState?.lastCloseDayIndex))
      ? Number(marketState.lastCloseDayIndex)
      : null;

  company.dailyReferencePrice = candidate;
  company.dailyReferenceDayIndex = clock.dayIndex;
  company.prevClose = candidate; // compatibility field for Roblox
  company.dailyChangeModelVersion = DAILY_CHANGE_MODEL_VERSION;

  return rebased;
}

function ensureDailyReferenceForTradingDay(company, clock) {
  if (!company || !clock) return;

  if (
    Number(company.dailyChangeModelVersion) !== DAILY_CHANGE_MODEL_VERSION
    || !(Number(company.dailyReferencePrice) > 0)
  ) {
    migrateCompanyDailyReference(company, clock);
    return;
  }

  if (
    clock.dayOfWeekIndex < 5
    && Number(company.dailyReferenceDayIndex) !== Number(clock.dayIndex)
  ) {
    const lastClose = Number(company.lastRegularClosePrice);

    if (lastClose > 0) {
      company.dailyReferencePrice = lastClose;
      company.prevClose = lastClose;
    } else {
      const currentDisplay = displayedPriceForAsset(company);
      company.dailyReferencePrice = currentDisplay;
      company.prevClose = currentDisplay;
    }

    company.dailyReferenceDayIndex = clock.dayIndex;
  }
}

function companyRow(company, clock = marketClock()) {
  ensureDailyReferenceForTradingDay(company, clock);

  const fairPrice = company.companyValue / company.sharesOutstanding;
  const executionReferencePrice = Math.max(
    0.05,
    Number(company.price) || 0.05
  );
  const displayPrice = displayedPriceForAsset(company);
  const dailyReference = Math.max(
    0.00000001,
    Number(company.dailyReferencePrice)
      || Number(company.prevClose)
      || displayPrice
  );
  const changePct =
    ((displayPrice - dailyReference) / dailyReference) * 100;
  const ipoActive = clock.totalMinutes < Number(company.ipoActiveUntil || 0);

  return {
    ticker: company.ticker,
    companyName: company.name,
    name: company.name,
    sector: company.sector,
    category: company.category,
    subcategory: company.subcategory,
    industry: company.industry,
    capGroup: company.capGroup,
    assetType: "fictional-stock",
    fictional: true,
    price: round(displayPrice, 4),
    executionPrice: round(executionReferencePrice, 4),
    playerImpactPct: round(currentPlayerImpact(company) * 100, 4),
    fairValue: round(fairPrice, 4),
    companyValue: round(company.companyValue, 2),
    marketCap: round(displayPrice * company.sharesOutstanding, 2),
    sharesOutstanding: round(company.sharesOutstanding, 0),
    floatShares: round(company.sharesOutstanding * 0.76, 0),
    publicFloat: round(company.sharesOutstanding * 0.76, 0),
    prevClose: round(dailyReference, 4),
    dailyReferencePrice: round(dailyReference, 4),
    lastRegularClosePrice: Number(company.lastRegularClosePrice) > 0
      ? round(company.lastRegularClosePrice, 4)
      : null,
    changePct: round(changePct, 2),
    annualGrowth: round(company.annualGrowth * 100, 2),
    volatility: round(company.annualVolatility * 100, 2),
    volatilityBand: company.annualVolatility >= 0.48
      ? "High"
      : company.annualVolatility <= 0.22
        ? "Low"
        : "Medium",
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
    bucketMinute: safeBucket,
    o, h, l, c, v,
    session,
    gameDayIndex: dayIndex,
    gameMinuteOfDay: minuteOfDay
  };
}

function ensureCandleSeries(company, intervalKey) {
  company.candles = company.candles || {};

  if (Array.isArray(company.candles[intervalKey]) && company.candles[intervalKey].length) {
    touchCandleSeries("stock", company.ticker, intervalKey);
    return company.candles[intervalKey];
  }

  const spec = FICTIONAL_INTERVALS[intervalKey];
  if (!spec) return [];
  const nowMinute = marketClock().totalMinutes;
  const buckets = [];
  let cursor = Math.floor(nowMinute / spec.minutes) * spec.minutes;
  let safety = 0;
  while (buckets.length < spec.limit && safety < 50000) {
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
    const factor = historicalStockFactor(company, bucket);
    price = Math.max(
      0.05,
      open * Math.exp(
        company.annualGrowth * spec.minutes / (252 * 960)
        + factor * scale
      )
    );
    const wick =
      Math.abs(seededNormal(`stock-wick:${company.ticker}:${bucket}`))
      * scale * open * 0.45;
    series.push(candleRecord(bucket, open, Math.max(open, price) + wick, Math.min(open, price) - wick, price, 1000 + Math.random() * 80000, session === "closed" ? "regular" : session));
  }
  if (series.length) {
    const ratio = company.price / series[series.length - 1].c;
    for (const candle of series) {
      candle.o = round(candle.o * ratio, 4);
      candle.h = round(candle.h * ratio, 4);
      candle.l = round(candle.l * ratio, 4);
      candle.c = round(candle.c * ratio, 4);
    }
  }
  company.candles[intervalKey] = series.slice(-spec.limit);
  touchCandleSeries("stock", company.ticker, intervalKey);
  return company.candles[intervalKey];
}

function updateCandles(company, priorPrice, price, clock, playerVolume = 0, elapsedGameMinutes = 0) {
  const candleEntries = Object.entries(company.candles || {});
  for (const [intervalKey, series] of candleEntries) {
    const spec = FICTIONAL_INTERVALS[intervalKey];
    if (!spec || !Array.isArray(series) || series.length === 0) continue;
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
      current.h = round(Math.max(current.h, price), 4);
      current.l = round(Math.min(current.l, price), 4);
      current.c = round(price, 4);
      current.v = Math.round((current.v || 0) + volume);
      current.session = clock.session;
    }
  }
}

function updateCompany(company, elapsedGameMinutes, clock, factors) {
  if (!(elapsedGameMinutes > 0)) return;

  const priorDisplayedPrice = displayedPriceForAsset(company);
  decayPlayerImpact(company, elapsedGameMinutes);

  const classification = classifyStock(company.ticker, company.sector);
  company.sector = classification.sector;
  company.category = classification.category;
  company.subcategory = classification.subcategory;
  company.industry = classification.industry;

  const effectiveGrowth =
    company.annualGrowth
    + (
      clock.totalMinutes < Number(company.temporaryGrowthUntil || 0)
        ? Number(company.temporaryGrowth || 0)
        : 0
    );

  const sharedFactor = stockFactorFromRuntime(company, factors);

  const valueMove =
    effectiveGrowth * elapsedGameMinutes / (365 * MINUTES_PER_DAY)
    + company.annualVolatility
      * 0.28
      * sharedFactor
      * Math.sqrt(elapsedGameMinutes / (365 * MINUTES_PER_DAY));

  company.companyValue = Math.max(
    2e6,
    company.companyValue * Math.exp(valueMove)
  );

  if (!clock.isTradingAllowed) return;

  const fairPrice = company.companyValue / company.sharesOutstanding;

  const randomMove =
    company.annualVolatility
    * (clock.session === "open" ? 1 : 0.52)
    * sharedFactor
    * Math.sqrt(elapsedGameMinutes / (252 * 960));

  const fairPull =
    ((fairPrice - company.price) / Math.max(company.price, 0.01))
    * clamp(elapsedGameMinutes / 240, 0, 0.22);

  company.price = Math.max(
    0.05,
    company.price * Math.exp(randomMove + fairPull)
  );

  updateCandles(
    company,
    priorDisplayedPrice,
    displayedPriceForAsset(company),
    clock,
    0,
    elapsedGameMinutes
  );
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
  marketState.news = marketState.news.slice(0, 120);
  marketState.nextNewsGameMinute = clock.totalMinutes + 8 + Math.floor(Math.random() * 18);
  if (!marketFastForwardInProgress) {
    console.log(`[FICTIONAL NEWS] ${article.headline} (${article.impactPct}%)`);
  }
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
  marketState.news = marketState.news.slice(0, 120);
  marketState.lastIpoWeek = week;
  console.log(`[FICTIONAL IPO] Week ${week}: ${ticker} ${name} at $${ipoPrice.toFixed(2)}`);
  queueSave(0);
}

function engineStep() {
  if (!marketState) return;
  if (marketState.handoffReady !== true) return;

  // The one-time alignment simulator owns marketState while it is running.
  // HTTP requests may still be served, but they must not cause a second clock
  // advancement through engineStep at the same time.
  if (marketFastForwardInProgress) return;

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
    const factors = buildMarketFactorStep();

    ensureStockClassifications(marketState);
    for (const company of Object.values(marketState.companies)) {
      ensureDailyReferenceForTradingDay(company, clock);
      updateCompany(company, elapsedGameMinutes, clock, factors);
    }

    ensureSimulatedCommodityState(marketState);
    for (const asset of Object.values(marketState.commodities)) {
      updateSimulatedCommodity(asset, elapsedGameMinutes, clock, factors);
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

  // Snapshot the fictional 4 PM regular-session close.
  // Do NOT reset today's dailyReferencePrice here. The new close becomes the
  // reference only when the next weekday begins.
  if (
    clock.minuteOfDay >= 960
    && clock.dayOfWeekIndex < 5
    && Number(marketState.lastCloseDayIndex) !== clock.dayIndex
  ) {
    for (const company of Object.values(marketState.companies)) {
      company.lastRegularClosePrice = displayedPriceForAsset(company);
      company.lastRegularCloseDayIndex = clock.dayIndex;
    }

    marketState.lastCloseDayIndex = clock.dayIndex;
    queueSave();
  }

  if (Date.now() - lastPeriodicSaveAt >= 60000) {
    lastPeriodicSaveAt = Date.now();
    queueSave();
  }
}


// ============================
// One-time real 9:30 AM ET clock alignment
// ============================
// This migration runs ONCE. It advances the fictional clock to a forward-only
// phase where the NEXT regular 9:30 AM fictional open occurs at the next real
// 9:30 AM Eastern Time.
//
// It deliberately does NOT keep re-aligning afterward. Once applied, the normal
// 2x fictional clock continues freely and future real-world open times drift
// according to the fictional weekday/weekend schedule.
const MARKET_CLOCK_ALIGNMENT_VERSION = 1;
const EASTERN_TIME_ZONE = "America/New_York";

const easternClockFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function easternClockParts(unixMs) {
  const parts = {};
  for (const part of easternClockFormatter.formatToParts(new Date(unixMs))) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function easternLocalToUtcMs(year, month, day, hour, minute, second = 0) {
  const desiredAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second
  );

  let guess = desiredAsUtc;

  // Iteratively correct the UTC guess until formatting that timestamp in
  // America/New_York produces the requested local wall-clock time.
  for (let i = 0; i < 4; i += 1) {
    const observed = easternClockParts(guess);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second
    );

    const delta = desiredAsUtc - observedAsUtc;
    guess += delta;

    if (Math.abs(delta) < 1000) break;
  }

  return guess;
}

function nextRealEastern930Ms(nowMs = Date.now()) {
  const nowEastern = easternClockParts(nowMs);

  let targetYear = nowEastern.year;
  let targetMonth = nowEastern.month;
  let targetDay = nowEastern.day;

  let targetMs = easternLocalToUtcMs(
    targetYear,
    targetMonth,
    targetDay,
    9,
    30,
    0
  );

  if (targetMs <= nowMs) {
    // Advance the EASTERN calendar date by one day. Date.UTC is only used as a
    // convenient civil-date increment; easternLocalToUtcMs resolves the actual
    // ET offset afterward.
    const nextCivil = new Date(Date.UTC(
      targetYear,
      targetMonth - 1,
      targetDay + 1,
      12,
      0,
      0
    ));

    targetYear = nextCivil.getUTCFullYear();
    targetMonth = nextCivil.getUTCMonth() + 1;
    targetDay = nextCivil.getUTCDate();

    targetMs = easternLocalToUtcMs(
      targetYear,
      targetMonth,
      targetDay,
      9,
      30,
      0
    );
  }

  return targetMs;
}

function virtualClockFromGameSecond(totalGameSeconds) {
  const safeGameSeconds = Math.max(
    0,
    Math.floor(Number(totalGameSeconds) || 0)
  );

  const totalMinutes = Math.floor(safeGameSeconds / 60);
  const gameSecond = safeGameSeconds % 60;
  const dayIndex = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const dayOfWeekIndex = ((dayIndex % 7) + 7) % 7;
  const minuteOfDay =
    ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY)
    % MINUTES_PER_DAY;

  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const session = sessionForMinute(totalMinutes);
  const displayHour = ((hour + 11) % 12) + 1;
  const exactTime =
    `${displayHour}:${String(minute).padStart(2, "0")}:` +
    `${String(gameSecond).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;

  return {
    totalGameSeconds: safeGameSeconds,
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
    nextEventText: nextSessionText(
      dayOfWeekIndex,
      minuteOfDay,
      session
    )
  };
}

function nextRegularOpenGameSecondAfter(gameSecond) {
  const safe = Math.max(0, Math.floor(Number(gameSecond) || 0));
  const currentMinute = Math.floor(safe / 60);
  const currentDayIndex = Math.floor(currentMinute / MINUTES_PER_DAY);

  for (let offset = 0; offset < 21; offset += 1) {
    const dayIndex = currentDayIndex + offset;
    const dayOfWeekIndex = ((dayIndex % 7) + 7) % 7;

    if (dayOfWeekIndex >= 5) continue;

    const openSecond =
      dayIndex * MINUTES_PER_DAY * 60
      + 570 * 60;

    if (openSecond > safe) {
      return openSecond;
    }
  }

  return null;
}

function findForwardClosedAlignmentTarget(
  currentGameSecond,
  desiredGameSecondsUntilOpen
) {
  const current = Math.max(
    0,
    Math.floor(Number(currentGameSecond) || 0)
  );

  const desired = Math.max(
    1,
    Math.round(Number(desiredGameSecondsUntilOpen) || 1)
  );

  const currentDay = Math.floor(
    current / (MINUTES_PER_DAY * 60)
  );

  for (let offset = 0; offset < 28; offset += 1) {
    const openDay = currentDay + offset;
    const openWeekday = ((openDay % 7) + 7) % 7;

    if (openWeekday >= 5) continue;

    const openSecond =
      openDay * MINUTES_PER_DAY * 60
      + 570 * 60;

    const candidate = openSecond - desired;

    if (candidate <= current) continue;

    const candidateClock = virtualClockFromGameSecond(candidate);

    // Keep the market closed immediately after the jump. Otherwise a minimal
    // forward phase shift could land in the middle of a regular session, which
    // would make "next open at 9:30 real" misleading to players.
    if (candidateClock.session !== "closed") continue;

    const verifiedNextOpen =
      nextRegularOpenGameSecondAfter(candidate);

    if (verifiedNextOpen === openSecond) {
      return {
        targetGameSecond: candidate,
        nextOpenGameSecond: openSecond,
        targetClock: candidateClock
      };
    }
  }

  throw new Error(
    "Could not find a forward closed-market clock phase for the requested real 9:30 alignment."
  );
}

function applyVirtualFastForwardStep(clock, elapsedGameMinutes) {
  const factors = buildMarketFactorStep();

  ensureStockClassifications(marketState);
  for (const company of Object.values(marketState.companies)) {
    ensureDailyReferenceForTradingDay(company, clock);
    updateCompany(
      company,
      elapsedGameMinutes,
      clock,
      factors
    );
  }

  ensureSimulatedCommodityState(marketState);
  for (const asset of Object.values(marketState.commodities)) {
    updateSimulatedCommodity(
      asset,
      elapsedGameMinutes,
      clock,
      factors
    );
  }

  ensureSimulatedCryptoState(marketState);
  for (const asset of Object.values(marketState.cryptos)) {
    updateSimulatedCrypto(
      asset,
      elapsedGameMinutes,
      clock
    );
  }

  // Generate every fictional news event whose scheduled game minute was crossed.
  // nextNewsGameMinute always moves forward by at least 8 game minutes.
  while (
    clock.totalMinutes
    >= Number(marketState.nextNewsGameMinute || Infinity)
  ) {
    generateCompanyNews(clock);
  }

  marketState.lastIpoWeek = 0;

  // Preserve the exact same fictional 4 PM close behavior as the live engine.
  if (
    clock.minuteOfDay >= 960
    && clock.dayOfWeekIndex < 5
    && Number(marketState.lastCloseDayIndex) !== clock.dayIndex
  ) {
    for (const company of Object.values(marketState.companies)) {
      company.lastRegularClosePrice =
        displayedPriceForAsset(company);
      company.lastRegularCloseDayIndex = clock.dayIndex;
    }

    marketState.lastCloseDayIndex = clock.dayIndex;
  }

  marketState.lastUpdatedGameSecond = clock.totalGameSeconds;
  marketState.lastUpdatedGameMinute = clock.totalMinutes;
}

function nextFastForwardBoundarySecond(cursor, target) {
  const current = Math.max(0, Math.floor(Number(cursor) || 0));
  const maximumTarget = Math.max(current + 1, Math.floor(Number(target) || current + 1));

  // Default to five fictional minutes. The price equations already scale drift
  // linearly and volatility by sqrt(time), so this preserves the same stochastic
  // model without requiring thousands of consecutive one-minute JS loops.
  let next = Math.min(maximumTarget, current + 5 * 60);

  const currentMinute = Math.floor(current / 60);
  const currentDay = Math.floor(currentMinute / MINUTES_PER_DAY);

  // Never jump across the market/session boundaries that materially change the
  // simulation rules or the daily-close baseline.
  const importantMinutes = [
    currentDay * MINUTES_PER_DAY + 240,   // stock pre-market 4:00 AM
    currentDay * MINUTES_PER_DAY + 570,   // regular open 9:30 AM
    currentDay * MINUTES_PER_DAY + 960,   // regular close 4:00 PM
    currentDay * MINUTES_PER_DAY + 1020,  // commodity maintenance 5:00 PM
    currentDay * MINUTES_PER_DAY + 1080,  // commodity reopen 6:00 PM
    currentDay * MINUTES_PER_DAY + 1200,  // stock after-hours close 8:00 PM
    (currentDay + 1) * MINUTES_PER_DAY    // midnight/day rollover
  ];

  for (const minute of importantMinutes) {
    const second = minute * 60;
    if (second > current && second < next) {
      next = second;
    }
  }

  // Also stop exactly at the next scheduled fictional news event when it falls
  // inside this chunk, so its market effect starts at the correct point.
  const nextNewsMinute = Number(marketState.nextNewsGameMinute);
  if (Number.isFinite(nextNewsMinute)) {
    const newsSecond = Math.floor(nextNewsMinute * 60);
    if (newsSecond > current && newsSecond < next) {
      next = newsSecond;
    }
  }

  return Math.max(current + 1, Math.min(next, maximumTarget));
}

async function simulateMarketForwardTo(targetGameSecond) {
  const target = Math.max(
    0,
    Math.floor(Number(targetGameSecond) || 0)
  );

  const originalCursor = Math.max(
    0,
    Math.floor(Number(marketState.lastUpdatedGameSecond) || 0)
  );

  let cursor = originalCursor;

  if (target <= cursor) {
    return {
      simulatedGameSeconds: 0,
      simulatedSteps: 0,
      simulatedNewsEvents: 0
    };
  }

  const startingNewsCount =
    Number(marketState.news?.length) || 0;

  let steps = 0;
  let stepsSinceYield = 0;

  while (cursor < target) {
    const nextCursor =
      nextFastForwardBoundarySecond(cursor, target);

    const stepSeconds = nextCursor - cursor;
    cursor = nextCursor;

    const clock = virtualClockFromGameSecond(cursor);

    applyVirtualFastForwardStep(
      clock,
      stepSeconds / 60
    );

    steps += 1;
    stepsSinceYield += 1;

    // Yield frequently so Railway's HTTP server, health checks, and Roblox
    // requests remain responsive throughout the one-time migration.
    if (stepsSinceYield >= 20) {
      stepsSinceYield = 0;
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  return {
    simulatedGameSeconds: target - originalCursor,
    simulatedSteps: steps,
    retainedNewsCountDelta:
      (Number(marketState.news?.length) || 0)
      - startingNewsCount
  };
}

function formatAlignmentClock(clock) {
  return `${clock.dayName} ${clock.exactTime}`;
}

async function performOneTimeReal930Alignment() {
  if (!marketState || marketState.handoffReady !== true) {
    return false;
  }

  if (
    Number(marketState.marketClockAlignmentVersion)
    === MARKET_CLOCK_ALIGNMENT_VERSION
  ) {
    return false;
  }

  // Catch persisted state up to the deployment moment before the special
  // simulator takes exclusive ownership.
  engineStep();

  marketFastForwardInProgress = true;

  try {
    const alignmentNowMs = Date.now();
    const currentClock = marketClock(alignmentNowMs);
    const nextReal930Ms =
      nextRealEastern930Ms(alignmentNowMs);

    const realMsUntil930 =
      Math.max(1, nextReal930Ms - alignmentNowMs);

    const desiredGameSecondsUntilOpen =
      Math.max(
        1,
        Math.round(
          realMsUntil930
          * 60
          / GAME_MS_PER_MINUTE
        )
      );

    const alignment =
      findForwardClosedAlignmentTarget(
        currentClock.totalGameSeconds,
        desiredGameSecondsUntilOpen
      );

    const targetGameSecond =
      alignment.targetGameSecond;

    marketState.clockAlignmentStartGameSecond =
      currentClock.totalGameSeconds;

    console.log(
      `[CLOCK ALIGNMENT] One-time forward alignment starting. ` +
      `Current fictional time: ${formatAlignmentClock(currentClock)}.`
    );

    console.log(
      `[CLOCK ALIGNMENT] Fast-forward target: ` +
      `${formatAlignmentClock(alignment.targetClock)}. ` +
      `The next fictional regular open will occur at the next real ` +
      `9:30 AM ET.`
    );

    const result =
      await simulateMarketForwardTo(targetGameSecond);

    // Switch the live phase only after all skipped market movement has been
    // simulated.
    marketState.clockAnchorRealMs = alignmentNowMs;
    marketState.clockAnchorGameSeconds = targetGameSecond;
    marketState.lastUpdatedGameSecond = targetGameSecond;
    marketState.lastUpdatedGameMinute =
      Math.floor(targetGameSecond / 60);

    marketState.marketClockAlignmentVersion =
      MARKET_CLOCK_ALIGNMENT_VERSION;
    marketState.marketClockAlignedAtUnix =
      Math.floor(alignmentNowMs / 1000);
    marketState.marketClockAlignedReal930Unix =
      Math.floor(nextReal930Ms / 1000);
    marketState.marketClockAlignedTargetGameSecond =
      targetGameSecond;

    clearAllCandleCaches(marketState);

    console.log(
      `[CLOCK ALIGNMENT] Simulated ${result.simulatedSteps} ` +
      `bounded market steps before moving the anchor.`
    );

    console.log(
      `[CLOCK ALIGNMENT] COMPLETE. This alignment will NOT run again. ` +
      `The 2x fictional clock now continues normally.`
    );

    return true;
  } finally {
    marketFastForwardInProgress = false;
    delete marketState.clockAlignmentStartGameSecond;
    lastPeriodicSaveAt = Date.now();
    saveStateNow();
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
  const memory = process.memoryUsage();
  const candleStats = residentCandleStats();

  res.json({
    status: "ok",
    backend: "main-game-fictional-exchange",
    alignmentInProgress: marketFastForwardInProgress,
    marketClockAlignmentVersion:
      Number(marketState.marketClockAlignmentVersion) || 0,
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
    commodityCached: marketState?.commodities ? Object.keys(marketState.commodities).length : 0,
    residentCandleSeries: candleStats.series,
    residentCandles: candleStats.candles,
    playerImpactModel: {
      fastHalfLifeGameMinutes: PLAYER_IMPACT_FAST_HALF_LIFE_GAME_MINUTES,
      slowHalfLifeGameMinutes: PLAYER_IMPACT_SLOW_HALF_LIFE_GAME_MINUTES,
      minVisiblePct: PLAYER_IMPACT_MIN_VISIBLE * 100
    },
    candleCacheIdleSeconds: Math.round(CANDLE_CACHE_IDLE_MS / 1000),
    memoryMb: {
      rss: round(memory.rss / 1024 / 1024, 2),
      heapUsed: round(memory.heapUsed / 1024 / 1024, 2),
      heapTotal: round(memory.heapTotal / 1024 / 1024, 2),
      external: round(memory.external / 1024 / 1024, 2)
    }
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

app.get("/commodity/prices", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await getCommodityPrices());
});

app.get("/commodity/price", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const ticker = normalizeCommodityTicker(req.query.ticker);
  if (!ticker) return res.status(400).json({ error: "Unknown fictional commodity." });

  const result = await getCommodityPrices();
  const row = result.prices && result.prices[ticker];
  if (!row) return res.status(404).json({ ticker, error: "Commodity unavailable." });
  res.json(row);
});

app.get("/commodity/candles", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const ticker = normalizeCommodityTicker(req.query.ticker);
  if (!ticker) return res.status(400).json({ error: "Unknown fictional commodity." });
  res.json(await getCommodityCandles(ticker, String(req.query.interval || "1m").toLowerCase()));
});

app.get("/fictional/categories", (_req, res) => {
  res.set("Cache-Control", "no-store");

  const categoryMembers = {};
  const subcategoryMembers = {};
  const industryMembers = {};

  for (const company of Object.values(marketState?.companies || {})) {
    const classification = classifyStock(company.ticker, company.sector);
    const category = company.category || classification.category;
    const subcategory = company.subcategory || classification.subcategory;
    const industry = company.industry || classification.industry;

    categoryMembers[category] = categoryMembers[category] || [];
    categoryMembers[category].push(company.ticker);

    subcategoryMembers[subcategory] = subcategoryMembers[subcategory] || [];
    subcategoryMembers[subcategory].push(company.ticker);

    industryMembers[industry] = industryMembers[industry] || [];
    industryMembers[industry].push(company.ticker);
  }

  const categoryNames = Array.from(new Set([
    ...Object.keys(CATEGORY_CONFIG),
    ...Object.keys(categoryMembers)
  ]));

  const subcategoryNames = Array.from(new Set([
    ...Object.keys(SUBCATEGORY_CONFIG),
    ...Object.keys(subcategoryMembers)
  ]));

  const industryNames = Array.from(new Set([
    ...Object.keys(INDUSTRY_CONFIG),
    ...Object.keys(industryMembers)
  ]));

  res.json({
    success: true,
    hierarchy: "Sector -> Category -> Subcategory",
    categories: categoryNames.map(name => ({
      name,
      members: categoryMembers[name] || [],
      memberCount: (categoryMembers[name] || []).length
    })),
    subcategories: subcategoryNames.map(name => ({
      name,
      members: subcategoryMembers[name] || [],
      memberCount: (subcategoryMembers[name] || []).length
    })),
    industries: industryNames.map(name => ({
      name,
      members: industryMembers[name] || [],
      memberCount: (industryMembers[name] || []).length
    })),
    commodityLinks: {
      GOLD: {
        sharedMetalFactor: true,
        electronicsIndustryEffect: "positive",
        note: "Gold responds positively to electronics demand, but less than silver."
      },
      SILVER: {
        sharedMetalFactor: true,
        electronicsIndustryEffect: "strong positive",
        note: "AI semiconductor stocks still carry the Electronics & Semiconductors industry factor."
      },
      OIL: {
        strongestIndustries: [
          "Energy",
          "Industrials & Manufacturing",
          "Transportation & Travel"
        ]
      }
    }
  });
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

  if (marketFastForwardInProgress) {
    return res.status(503).json({
      success: false,
      alignmentInProgress: true,
      error: "One-time fictional market clock alignment is finishing. Please retry in a moment."
    });
  }

  if (marketState.handoffReady !== true) {
    return res.status(503).json({
      success: false,
      handoffReady: false,
      error: "Fictional market is not ready."
    });
  }

  engineStep();
  ensureStockClassifications(marketState);
  ensureSimulatedCryptoState(marketState);
  ensureSimulatedCommodityState(marketState);

  const ticker = String(req.body?.ticker || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const side = String(req.body?.side || "").toLowerCase();
  const quantity = Number(req.body?.quantity);
  const requestId = String(req.body?.requestId || "").slice(0, 160);
  const clock = marketClock();

  if (side !== "buy" && side !== "sell") {
    return res.status(400).json({ success: false, error: "Side must be buy or sell." });
  }

  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e9) {
    return res.status(400).json({ success: false, error: "Invalid quantity." });
  }

  if (requestId && marketState.tradeReceipts[requestId]) {
    return res.json(marketState.tradeReceipts[requestId]);
  }

  let assetType = "";
  let asset = null;

  if (marketState.companies[ticker]) {
    assetType = "stock";
    asset = marketState.companies[ticker];

    if (!clock.isTradingAllowed) {
      return res.status(409).json({
        success: false,
        marketClosed: true,
        session: clock.session,
        error: "The fictional stock market is closed."
      });
    }
  } else if (marketState.cryptos[ticker]) {
    assetType = "crypto";
    asset = marketState.cryptos[ticker];
  } else if (marketState.commodities[ticker]) {
    assetType = "commodity";
    asset = marketState.commodities[ticker];

    if (commoditySessionForMinute(clock.totalMinutes) !== "open") {
      return res.status(409).json({
        success: false,
        marketClosed: true,
        session: "commodity-closed",
        error: "The fictional commodity market is closed."
      });
    }
  } else {
    return res.status(404).json({ success: false, error: "Unknown fictional asset." });
  }

  const priorDisplayPrice = displayedPriceForAsset(asset);
  const impactInfo = calculatePlayerTradeImpact(
    assetType,
    asset,
    side,
    quantity,
    clock
  );

  applyPlayerTradeImpact(asset, impactInfo);

  const newDisplayPrice = displayedPriceForAsset(asset);

  if (assetType === "stock") {
    if (side === "buy") asset.buyVolume += quantity;
    else asset.sellVolume += quantity;

    updateCandles(
      asset,
      priorDisplayPrice,
      newDisplayPrice,
      clock,
      quantity,
      0
    );
  } else if (assetType === "crypto") {
    updateCryptoCandles(
      asset,
      priorDisplayPrice,
      newDisplayPrice,
      clock,
      0,
      quantity
    );
  } else {
    updateCommodityCandles(
      asset,
      priorDisplayPrice,
      newDisplayPrice,
      clock,
      0,
      quantity
    );
  }

  const market =
    assetType === "stock"
      ? companyRow(asset, clock)
      : assetType === "crypto"
        ? fictionalCryptoRow(asset)
        : fictionalCommodityRow(asset, clock);

  const decimals = assetType === "stock" ? 4 : 8;

  const result = {
    success: true,
    requestId,
    ticker,
    assetType,
    side,
    quantity,
    notional: round(impactInfo.notional, 2),
    executionPrice: round(impactInfo.executionReferencePrice, decimals),
    priorPrice: round(priorDisplayPrice, decimals),
    newPrice: round(newDisplayPrice, decimals),
    impactPct: round(impactInfo.appliedImpact * 100, 4),
    requestedImpactPct: round(impactInfo.requestedImpact * 100, 4),
    totalPlayerImpactPct: round(currentPlayerImpact(asset) * 100, 4),
    simulatedLiquidityNotional: round(impactInfo.model.liquidityNotional, 2),
    maxOverlayPct: round(impactInfo.model.maxOverlay * 100, 3),
    temporaryImpact: true,
    antiPumpAndDump: true,
    market
  };

  if (requestId) {
    marketState.tradeReceipts[requestId] = result;
    const ids = Object.keys(marketState.tradeReceipts);
    if (ids.length > 600) {
      for (const id of ids.slice(0, ids.length - 500)) {
        delete marketState.tradeReceipts[id];
      }
    }
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

  // IMPORTANT: bind Railway's port BEFORE running any potentially expensive
  // one-time market migration. v16 did this in the opposite order, which caused
  // Railway's proxy to return HTTP 502 until the entire fast-forward completed.
  app.listen(PORT, () => {
    const clock = marketClock();
    console.log(`[SERVER] Main-game fictional exchange listening on port ${PORT}.`);
    console.log(`[SERVER] ${Object.keys(marketState.companies).length} simulated main-game stocks; 5 fictional cryptocurrencies and 3 fictional commodities enabled.`);
    console.log(`[SERVER] Fictional stock prices evolve at game-second resolution; candles retain normal timeframe buckets.`);
    console.log(`[SERVER] Fictional clock currently ${clock.dayName} ${clock.exactTime}; 1 game minute = ${REAL_SECONDS_PER_GAME_MINUTE} real seconds.`);

    if (marketState.handoffReady === true) {
      console.log(`[SERVER] Exact price handoff is READY for ${marketState.handoffPriceCount || 0} tickers.`);
    } else {
      console.warn(`[SERVER] WAITING FOR EXACT YAHOO PRICE HANDOFF. Fictional seed prices remain blocked while Railway retries.`);
    }
  });

  // Give Node one event-loop turn so Railway can accept connections immediately.
  await new Promise(resolve => setImmediate(resolve));

  if (marketState.handoffReady === true) {
    try {
      await performOneTimeReal930Alignment();
    } catch (error) {
      // A failed alignment must never take the whole market API offline.
      console.error(
        `[CLOCK ALIGNMENT] Failed; keeping the existing clock phase instead: ` +
        `${error && error.stack || error}`
      );
      marketFastForwardInProgress = false;
    }
  }

  setInterval(engineStep, 1000);

  const candleSweepTimer = setInterval(
    evictIdleCandleSeries,
    CANDLE_CACHE_SWEEP_MS
  );
  if (typeof candleSweepTimer.unref === "function") {
    candleSweepTimer.unref();
  }

  if (marketState.handoffReady !== true) {
    startAutomaticHandoffLoop();
  }

  const finalClock = marketClock();
  console.log(
    `[SERVER] Market engine active at ${finalClock.dayName} ` +
    `${finalClock.exactTime}.`
  );
}

startServer().catch(error => {
  console.error(`[SERVER] Startup failed: ${error && error.stack || error}`);
  process.exit(1);
});
