// Crypto Trend Dashboard Data Fetcher
// - CoinDesk API for top coins list + ranks (authoritative, no symbol collisions)
// - CryptoCompare API for historical daily data (50-day SMA calculation)

const TARGET_COINS = 500;
const COINDESK_API = 'https://data-api.coindesk.com';
const HISTODAY_API = 'https://min-api.cryptocompare.com/data/v2/histoday';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sma(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

// Fetch top coins from CoinDesk's asset top list (sorted by circulating market cap)
async function fetchTopCoins() {
  const coins = []; // { symbol, rank, name }
  const pageSize = 100; // min 10, max 100
  const pages = Math.ceil(TARGET_COINS / pageSize);
  console.log(`Fetching top ${TARGET_COINS} coins from CoinDesk...`);

  for (let page = 1; page <= pages; page++) {
    const url = `${COINDESK_API}/asset/v1/top/list?page=${page}&page_size=${pageSize}`;
    const r = await fetch(url);
    if (!r.ok) { console.warn(`  Page ${page} failed: HTTP ${r.status}`); break; }
    const json = await r.json();
    if (json.Err?.message) { console.warn(`  Page ${page} error: ${json.Err.message}`); break; }
    const list = json.Data?.LIST;
    if (!list || list.length === 0) break;

    for (const asset of list) {
      const rank = asset.TOPLIST_BASE_RANK?.CIRCULATING_MKT_CAP_USD;
      if (asset.SYMBOL && rank) {
        coins.push({ symbol: asset.SYMBOL, rank, name: asset.NAME });
      }
    }
    console.log(`  Page ${page}/${pages}: ${coins.length} coins`);
    if (page < pages) await sleep(1500);
  }

  // Sort by rank to ensure correct order
  coins.sort((a, b) => a.rank - b.rank);
  console.log(`  Total: ${coins.length} coins\n`);
  return coins;
}

// Fetch historical daily OHLCV from CryptoCompare
async function fetchDaily(fsym, tsym, limit = 55) {
  const url = `${HISTODAY_API}?fsym=${fsym}&tsym=${tsym}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  if (json.Response !== 'Success') throw new Error(json.Message || 'API error');
  const bars = json.Data.Data;
  if (bars.every(b => b.close === 0)) return null;
  return bars;
}

async function fetchWithFallback(fsym, tsym) {
  try {
    const bars = await fetchDaily(fsym, tsym);
    if (bars) return bars;
  } catch {}
  if (tsym === 'USD') {
    try {
      const bars = await fetchDaily(fsym, 'USDT');
      if (bars) return bars;
    } catch {}
  }
  return null;
}

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
  // Step 1: Get authoritative coin list + ranks from CoinDesk
  const topCoins = await fetchTopCoins();

  await sleep(2000);

  // Step 2: Fetch BTC/USD historical data
  console.log('Fetching BTC/USD...');
  const btcUsdBars = await fetchWithFallback('BTC', 'USD');
  if (!btcUsdBars) { console.error('FATAL: Could not fetch BTC/USD'); process.exit(1); }

  const btcCloses = btcUsdBars.map(b => b.close);
  const btcPrice = btcCloses[btcCloses.length - 1];
  const btcUsd = computeTrendAndGap(btcUsdBars);

  const btcEntry = topCoins.find(c => c.symbol === 'BTC');
  const results = [];
  results.push({
    symbol: 'BTC', rank: btcEntry?.rank || 1, price: btcPrice,
    usdTrend: btcUsd.trend, usdGapPct: btcUsd.gapPct,
    btcTrend: null, btcGapPct: null,
  });
  console.log(`  BTC: $${btcPrice.toFixed(2)} | USD: ${btcUsd.trend ? 'GREEN' : 'RED'} (${btcUsd.gapPct > 0 ? '+' : ''}${btcUsd.gapPct}%)\n`);

  // Step 3: Fetch each altcoin sequentially
  const altcoins = topCoins.filter(c => c.symbol !== 'BTC');
  let skipped = 0;

  for (let i = 0; i < altcoins.length; i++) {
    const { symbol: coin, rank } = altcoins[i];
    process.stdout.write(`\r[${i + 1}/${altcoins.length}] #${rank} ${coin}...          `);

    await sleep(2000);
    const usdBars = await fetchWithFallback(coin, 'USD');
    await sleep(2000);

    const usdResult = computeTrendAndGap(usdBars);
    let price = null;
    if (usdBars && usdBars.length >= 1) {
      price = usdBars[usdBars.length - 1].close;
      if (price === 0) price = null;
    }

    // Synthetic BTC ratio
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
      skipped++;
      continue;
    }

    results.push({ symbol: coin, rank, price, usdTrend: usdResult.trend, usdGapPct: usdResult.gapPct, btcTrend, btcGapPct });
  }

  console.log(`\n\nDone. ${results.length} coins with data, ${skipped} skipped.`);

  const output = { updated: new Date().toISOString(), coins: results };
  const { writeFileSync } = await import('fs');
  writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Wrote data.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
