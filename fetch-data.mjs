// CryptoCompare (CoinDesk) Data Fetcher
// Runs daily via GitHub Actions, writes data.json for the static frontend
// No API key required for basic endpoints

const COINS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
  'LTC', 'SUI', 'NEAR', 'ATOM', 'UNI', 'AAVE', 'APT', 'ARB', 'OP', 'RENDER',
  'INJ', 'TRX', 'MATIC', 'SHIB', 'TON', 'BCH', 'XLM', 'HBAR', 'FIL', 'ICP',
  'ETC', 'VET', 'ALGO', 'FTM', 'SAND', 'MANA', 'THETA', 'AXS', 'EOS', 'FLOW',
  'XTZ', 'CHZ', 'CRV', 'GALA', 'LDO', 'RNDR', 'SNX', 'ENS', 'COMP', 'MKR',
  'IMX', 'GRT', 'STX', 'RPL', 'PENDLE', 'FET', 'WLD', 'TIA', 'SEI', 'BONK',
  'JUP', 'STRK', 'PYTH', 'WIF', 'PEPE', 'FLOKI', 'ORDI', 'RUNE', 'KAS',
  'TAO', 'ONDO', 'JTO', 'BEAM', 'AR', 'JASMY', 'ROSE', 'ZIL', 'ENJ', 'BAT',
  'ONE', 'CELO', 'SKL', 'ANKR', 'LRC', 'CKB', 'ZEC', 'DASH', 'NEO', 'WAVES',
  'KAVA', 'IOTA', '1INCH', 'SUSHI', 'YFI', 'DYDX', 'UMA', 'CELR', 'AUDIO', 'RAY',
];

const API = 'https://min-api.cryptocompare.com/data/v2/histoday';
const BATCH_SIZE = 5;
const BATCH_DELAY = 1500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sma(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

async function fetchDaily(fsym, tsym, limit = 55) {
  const url = `${API}?fsym=${fsym}&tsym=${tsym}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  if (json.Response !== 'Success') throw new Error(json.Message || 'API error');
  return json.Data.Data;
}

// Returns bars with non-zero closes, or null
function validBars(bars) {
  if (!bars || bars.length < 2) return null;
  const closes = bars.map(b => b.close);
  if (closes.every(c => c === 0)) return null;
  return bars;
}

function computeTrend(bars) {
  const valid = validBars(bars);
  if (!valid) return null;
  const closes = valid.map(b => b.close);
  const current = closes[closes.length - 1];
  if (current === 0) return null;
  const prior = closes.length > 50 ? closes.slice(-51, -1) : closes.slice(0, -1);
  return current >= sma(prior);
}

function getPrice(bars) {
  const valid = validBars(bars);
  if (!valid) return null;
  const price = valid[valid.length - 1].close;
  return price === 0 ? null : price;
}

async function fetchWithFallback(coin, primaryTsym, fallbackTsym) {
  try {
    const bars = await fetchDaily(coin, primaryTsym);
    if (validBars(bars)) return bars;
  } catch {}
  // Fallback
  try {
    const bars = await fetchDaily(coin, fallbackTsym);
    if (validBars(bars)) return bars;
  } catch {}
  return null;
}

async function processBatchWithFallback(coins, primaryTsym, fallbackTsym, label) {
  const results = {};
  for (let i = 0; i < coins.length; i += BATCH_SIZE) {
    const batch = coins.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (coin) => {
      results[coin] = await fetchWithFallback(coin, primaryTsym, fallbackTsym);
    }));

    const done = Math.min(i + BATCH_SIZE, coins.length);
    process.stdout.write(`\r  ${label}: ${done}/${coins.length}`);
    if (i + BATCH_SIZE < coins.length) await sleep(BATCH_DELAY);
  }
  console.log();
  return results;
}

async function main() {
  const altcoins = COINS.filter(c => c !== 'BTC');

  // Fetch BTC/USD first (needed for synthetic BTC ratios)
  console.log('Fetching BTC/USD...');
  let btcUsdBars = null;
  try { btcUsdBars = await fetchDaily('BTC', 'USD'); } catch (e) {
    try { btcUsdBars = await fetchDaily('BTC', 'USDT'); } catch {}
  }

  await sleep(BATCH_DELAY);

  // Fetch altcoin/USD data (fallback to USDT)
  console.log(`Fetching USD data for ${altcoins.length} coins...`);
  const usdData = await processBatchWithFallback(altcoins, 'USD', 'USDT', 'USD pairs');

  await sleep(2000);

  // Fetch altcoin/BTC data (fallback: compute synthetic from USD prices)
  console.log(`Fetching BTC data for ${altcoins.length} coins...`);
  const btcData = await processBatchWithFallback(altcoins, 'BTC', 'BTC', 'BTC pairs');

  const results = [];

  // BTC row
  if (btcUsdBars && validBars(btcUsdBars)) {
    const closes = btcUsdBars.map(b => b.close);
    const current = closes[closes.length - 1];
    const prior = closes.length > 50 ? closes.slice(-51, -1) : closes.slice(0, -1);
    results.push({
      symbol: 'BTC',
      price: current,
      usdTrend: current >= sma(prior),
      btcTrend: null,
    });
    console.log(`  BTC: $${current.toFixed(2)} | USD: ${current >= sma(prior) ? 'GREEN' : 'RED'}`);
  }

  // Altcoin rows
  for (const coin of altcoins) {
    const usd = usdData[coin];
    const btc = btcData[coin];

    const price = getPrice(usd);
    const usdTrend = computeTrend(usd);
    let btcTrend = computeTrend(btc);

    // If no direct BTC pair, compute synthetic BTC ratio from USD prices
    if (btcTrend === null && validBars(usd) && validBars(btcUsdBars)) {
      const coinCloses = usd.map(b => b.close);
      const btcCloses = btcUsdBars.map(b => b.close);
      const minLen = Math.min(coinCloses.length, btcCloses.length);
      if (minLen >= 2) {
        const ratios = [];
        for (let j = 0; j < minLen; j++) {
          const ci = coinCloses.length - minLen + j;
          const bi = btcCloses.length - minLen + j;
          if (btcCloses[bi] > 0 && coinCloses[ci] > 0) {
            ratios.push(coinCloses[ci] / btcCloses[bi]);
          }
        }
        if (ratios.length >= 2) {
          const current = ratios[ratios.length - 1];
          const prior = ratios.length > 50 ? ratios.slice(-51, -1) : ratios.slice(0, -1);
          btcTrend = current >= sma(prior);
        }
      }
    }

    // Skip coins with no data at all
    if (price === null && usdTrend === null && btcTrend === null) {
      console.log(`  ${coin}: SKIPPED (no data)`);
      continue;
    }

    results.push({ symbol: coin, price, usdTrend, btcTrend });
    const fmt = (v) => v === null ? 'N/A' : v ? 'GREEN' : 'RED';
    console.log(`  ${coin}: ${price !== null ? '$' + price.toFixed(4) : 'N/A'} | USD: ${fmt(usdTrend)} | BTC: ${fmt(btcTrend)}`);
  }

  const output = { updated: new Date().toISOString(), coins: results };
  const { writeFileSync } = await import('fs');
  writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`\nDone. Wrote data.json with ${results.length} coins.`);
}

main().catch(e => { console.error(e); process.exit(1); });
