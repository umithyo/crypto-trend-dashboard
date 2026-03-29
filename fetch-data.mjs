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
const BATCH_SIZE = 5;     // concurrent requests per batch
const BATCH_DELAY = 1500; // ms between batches

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

function computeTrend(bars) {
  if (!bars || bars.length < 2) return null;
  const closes = bars.map(b => b.close);
  // Filter out zero-price entries (unlisted coins)
  if (closes.every(c => c === 0)) return null;
  const current = closes[closes.length - 1];
  const prior = closes.length > 50 ? closes.slice(-51, -1) : closes.slice(0, -1);
  return current >= sma(prior);
}

async function processBatch(coins, tsym, label) {
  const results = {};
  for (let i = 0; i < coins.length; i += BATCH_SIZE) {
    const batch = coins.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (coin) => {
      try {
        const bars = await fetchDaily(coin, tsym);
        results[coin] = bars;
      } catch (e) {
        console.error(`  ERROR ${coin}/${tsym}: ${e.message}`);
        results[coin] = null;
      }
    });
    await Promise.all(promises);

    const done = Math.min(i + BATCH_SIZE, coins.length);
    process.stdout.write(`\r  ${label}: ${done}/${coins.length}`);

    if (i + BATCH_SIZE < coins.length) await sleep(BATCH_DELAY);
  }
  console.log();
  return results;
}

async function main() {
  // Filter out BTC from the altcoin list (BTC vs BTC makes no sense)
  const altcoins = COINS.filter(c => c !== 'BTC');

  console.log(`Fetching USD data for ${altcoins.length} coins...`);
  const usdData = await processBatch(altcoins, 'USD', 'USD pairs');

  await sleep(2000);

  console.log(`Fetching BTC data for ${altcoins.length} coins...`);
  const btcData = await processBatch(altcoins, 'BTC', 'BTC pairs');

  // Also fetch BTC/USD for BTC's own row
  console.log('Fetching BTC/USD...');
  let btcBars = null;
  try { btcBars = await fetchDaily('BTC', 'USD'); } catch (e) { console.error(`  ERROR BTC/USD: ${e.message}`); }

  const results = [];

  // BTC row (only USD trend, no BTC trend for BTC itself)
  if (btcBars) {
    const closes = btcBars.map(b => b.close);
    const current = closes[closes.length - 1];
    const prior = closes.length > 50 ? closes.slice(-51, -1) : closes.slice(0, -1);
    results.push({
      symbol: 'BTC',
      price: current,
      usdTrend: current >= sma(prior),
      btcTrend: null,
    });
    console.log(`  BTC: $${current.toFixed(2)} | USD: ${current >= sma(prior) ? 'GREEN' : 'RED'} | BTC: N/A`);
  }

  // Altcoin rows
  for (const coin of altcoins) {
    const usd = usdData[coin];
    const btc = btcData[coin];

    let price = null;
    const usdTrend = computeTrend(usd);
    const btcTrend = computeTrend(btc);

    if (usd && usd.length >= 1) {
      const closes = usd.map(b => b.close);
      price = closes[closes.length - 1];
      if (price === 0) price = null;
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
