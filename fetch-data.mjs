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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sma(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

async function fetchDaily(fsym, tsym, limit = 55) {
  const url = `${API}?fsym=${fsym}&tsym=${tsym}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  if (json.Response !== 'Success') throw new Error(json.Message || 'API error');
  const bars = json.Data.Data;
  // Check if data is real (not all zeros)
  if (bars.every(b => b.close === 0)) return null;
  return bars;
}

async function fetchWithFallback(fsym, tsym) {
  try {
    const bars = await fetchDaily(fsym, tsym);
    if (bars) return bars;
  } catch {}
  // Try USDT as fallback for USD pairs
  if (tsym === 'USD') {
    try {
      const bars = await fetchDaily(fsym, 'USDT');
      if (bars) return bars;
    } catch {}
  }
  return null;
}

// Returns { trend, gapPct } where gapPct = (current - sma) / sma * 100
function computeTrendAndGap(bars) {
  if (!bars || bars.length < 2) return { trend: null, gapPct: null };
  const closes = bars.map(b => b.close);
  const current = closes[closes.length - 1];
  if (current === 0) return { trend: null, gapPct: null };
  const prior = closes.length > 50 ? closes.slice(-51, -1) : closes.slice(0, -1);
  const avg = sma(prior);
  if (avg === 0) return { trend: null, gapPct: null };
  const gapPct = ((current - avg) / avg) * 100;
  return { trend: current >= avg, gapPct: Math.round(gapPct * 100) / 100 };
}

async function main() {
  const altcoins = COINS.filter(c => c !== 'BTC');

  // Step 1: Fetch BTC/USD
  console.log('Fetching BTC/USD...');
  const btcUsdBars = await fetchWithFallback('BTC', 'USD');
  if (!btcUsdBars) { console.error('FATAL: Could not fetch BTC/USD'); process.exit(1); }

  const results = [];

  // BTC row
  const btcCloses = btcUsdBars.map(b => b.close);
  const btcPrice = btcCloses[btcCloses.length - 1];
  const btcUsd = computeTrendAndGap(btcUsdBars);
  results.push({ symbol: 'BTC', price: btcPrice, usdTrend: btcUsd.trend, usdGapPct: btcUsd.gapPct, btcTrend: null, btcGapPct: null });
  console.log(`  BTC: $${btcPrice.toFixed(2)} | USD: ${btcUsd.trend ? 'GREEN' : 'RED'} (${btcUsd.gapPct > 0 ? '+' : ''}${btcUsd.gapPct}%)`);

  // Step 2: Fetch each altcoin sequentially (one at a time, 2s gap)
  // This avoids rate limits: ~200 calls over ~7 minutes
  for (let i = 0; i < altcoins.length; i++) {
    const coin = altcoins[i];
    process.stdout.write(`\r[${i + 1}/${altcoins.length}] ${coin}...          `);

    await sleep(2000);

    // Fetch USD data
    const usdBars = await fetchWithFallback(coin, 'USD');

    await sleep(2000);

    // Compute USD trend, gap, and price
    const usdResult = computeTrendAndGap(usdBars);
    let price = null;
    if (usdBars && usdBars.length >= 1) {
      price = usdBars[usdBars.length - 1].close;
      if (price === 0) price = null;
    }

    // Compute BTC trend from synthetic ratio (coin_usd / btc_usd)
    let btcTrend = null;
    let btcGapPct = null;
    if (usdBars && usdBars.length >= 2) {
      const coinCloses = usdBars.map(b => b.close);
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
          const avg = sma(prior);
          btcTrend = current >= avg;
          btcGapPct = avg > 0 ? Math.round(((current - avg) / avg) * 10000) / 100 : null;
        }
      }
    }

    if (price === null && usdResult.trend === null && btcTrend === null) {
      console.log(`\r[${i + 1}/${altcoins.length}] ${coin}: SKIPPED (no data)`);
      continue;
    }

    results.push({ symbol: coin, price, usdTrend: usdResult.trend, usdGapPct: usdResult.gapPct, btcTrend, btcGapPct });
    const fmt = (v) => v === null ? 'N/A' : v ? 'GREEN' : 'RED';
    const fmtGap = (v) => v === null ? '' : ` (${v > 0 ? '+' : ''}${v}%)`;
    console.log(`\r[${i + 1}/${altcoins.length}] ${coin}: ${price !== null ? '$' + price.toFixed(4) : 'N/A'} | USD: ${fmt(usdResult.trend)}${fmtGap(usdResult.gapPct)} | BTC: ${fmt(btcTrend)}${fmtGap(btcGapPct)}`);
  }

  // Fetch market cap ranks from CoinGecko (free, one call, up to 250 coins)
  console.log('\nFetching market cap ranks from CoinGecko...');
  const rankMap = {};
  try {
    // Fetch top 250 coins by market cap
    const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1';
    const r = await fetch(url);
    if (r.ok) {
      const list = await r.json();
      for (const c of list) {
        rankMap[c.symbol.toUpperCase()] = c.market_cap_rank;
      }
      console.log(`  Got ranks for ${Object.keys(rankMap).length} coins`);
    } else {
      console.warn(`  CoinGecko returned ${r.status}, skipping ranks`);
    }
  } catch (e) {
    console.warn(`  Failed to fetch ranks: ${e.message}`);
  }

  // Attach rank to results
  for (const coin of results) {
    coin.rank = rankMap[coin.symbol] || null;
  }

  const output = { updated: new Date().toISOString(), coins: results };
  const { writeFileSync } = await import('fs');
  writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Done. Wrote data.json with ${results.length} coins.`);
}

main().catch(e => { console.error(e); process.exit(1); });
