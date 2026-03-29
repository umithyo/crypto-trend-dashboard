// Crypto Trend Dashboard — 100% CoinDesk API
// - Top list + ranks from /asset/v1/top/list
// - Historical daily data from /index/cc/v1/historical/days

const TARGET_COINS = 500;
const API = 'https://data-api.coindesk.com';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sma(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

async function fetchTopCoins() {
  const coins = [];
  const pageSize = 100;
  const pages = Math.ceil(TARGET_COINS / pageSize);
  console.log(`Fetching top ${TARGET_COINS} coins from CoinDesk...`);

  for (let page = 1; page <= pages; page++) {
    const url = `${API}/asset/v1/top/list?page=${page}&page_size=${pageSize}`;
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

  coins.sort((a, b) => a.rank - b.rank);
  console.log(`  Total: ${coins.length} coins\n`);
  return coins;
}

async function fetchDaily(symbol, limit = 55) {
  const instrument = `${symbol}-USD`;
  const url = `${API}/index/cc/v1/historical/days?market=cadli&instrument=${instrument}&limit=${limit}&apply_mapping=true`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  if (json.Err?.message) throw new Error(json.Err.message);
  if (!json.Data || json.Data.length === 0) return null;
  // Filter out entries with zero close
  const bars = json.Data.filter(b => b.CLOSE > 0);
  return bars.length >= 2 ? bars : null;
}

function computeTrendAndGap(bars) {
  if (!bars || bars.length < 2) return { trend: null, gapPct: null };
  const closes = bars.map(b => b.CLOSE);
  const current = closes[closes.length - 1];
  if (current === 0) return { trend: null, gapPct: null };
  const prior = closes.length > 50 ? closes.slice(-51, -1) : closes.slice(0, -1);
  const avg = sma(prior);
  if (avg === 0) return { trend: null, gapPct: null };
  const gapPct = ((current - avg) / avg) * 100;
  return { trend: current >= avg, gapPct: Math.round(gapPct * 100) / 100 };
}

async function main() {
  const topCoins = await fetchTopCoins();
  await sleep(2000);

  // Fetch BTC/USD first
  console.log('Fetching BTC/USD...');
  let btcBars;
  try { btcBars = await fetchDaily('BTC'); } catch (e) {
    console.error('FATAL: Could not fetch BTC/USD:', e.message);
    process.exit(1);
  }

  const btcCloses = btcBars.map(b => b.CLOSE);
  const btcPrice = btcCloses[btcCloses.length - 1];
  const btcUsd = computeTrendAndGap(btcBars);

  const btcEntry = topCoins.find(c => c.symbol === 'BTC');
  const results = [];
  results.push({
    symbol: 'BTC', rank: btcEntry?.rank || 1, price: btcPrice,
    usdTrend: btcUsd.trend, usdGapPct: btcUsd.gapPct,
    btcTrend: null, btcGapPct: null,
  });
  console.log(`  BTC: $${btcPrice.toFixed(2)} | USD gap: ${btcUsd.gapPct > 0 ? '+' : ''}${btcUsd.gapPct}%\n`);

  // Fetch altcoins
  const altcoins = topCoins.filter(c => c.symbol !== 'BTC');
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < altcoins.length; i++) {
    const { symbol: coin, rank } = altcoins[i];
    process.stdout.write(`\r[${i + 1}/${altcoins.length}] #${rank} ${coin}...          `);

    await sleep(2000);

    let usdBars = null;
    try {
      usdBars = await fetchDaily(coin);
    } catch {
      errors++;
    }

    const usdResult = computeTrendAndGap(usdBars);
    let price = null;
    if (usdBars && usdBars.length >= 1) {
      price = usdBars[usdBars.length - 1].CLOSE;
    }

    // Synthetic BTC ratio from USD prices
    let btcTrend = null;
    let btcGapPct = null;
    if (usdBars && usdBars.length >= 2) {
      const coinCloses = usdBars.map(b => b.CLOSE);
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

  console.log(`\n\nDone. ${results.length} coins with data, ${skipped} skipped, ${errors} errors.`);

  const output = { updated: new Date().toISOString(), coins: results };
  const { writeFileSync } = await import('fs');
  writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Wrote data.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
