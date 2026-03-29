// CryptoCompare (CoinDesk) Data Fetcher
// Runs daily via GitHub Actions, writes data.json for the static frontend
// Dynamically fetches top 500 coins by market cap — no hardcoded list

const TARGET_COINS = 500;
const API = 'https://min-api.cryptocompare.com/data/v2/histoday';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sma(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

async function fetchTopCoins() {
  const coins = []; // { symbol, rank }
  const pages = Math.ceil(TARGET_COINS / 100);
  console.log(`Fetching top ${TARGET_COINS} coins by market cap...`);

  for (let page = 0; page < pages; page++) {
    const url = `https://min-api.cryptocompare.com/data/top/mktcapfull?limit=100&tsym=USD&page=${page}`;
    const r = await fetch(url);
    if (!r.ok) { console.warn(`  Page ${page} failed: HTTP ${r.status}`); break; }
    const json = await r.json();
    if (!json.Data || json.Data.length === 0) break;

    for (let j = 0; j < json.Data.length; j++) {
      const sym = json.Data[j].CoinInfo?.Name;
      if (sym) coins.push({ symbol: sym, rank: page * 100 + j + 1 });
    }
    console.log(`  Page ${page + 1}/${pages}: ${coins.length} coins so far`);
    if (page < pages - 1) await sleep(1500);
  }

  console.log(`  Total: ${coins.length} coins\n`);
  return coins;
}

async function fetchDaily(fsym, tsym, limit = 55) {
  const url = `${API}?fsym=${fsym}&tsym=${tsym}&limit=${limit}`;
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
  // Step 1: Get the coin list dynamically from market cap rankings
  const topCoins = await fetchTopCoins();
  const rankMap = {};
  for (const c of topCoins) rankMap[c.symbol] = c.rank;

  await sleep(2000);

  // Step 2: Fetch BTC/USD first (needed for synthetic BTC ratios)
  console.log('Fetching BTC/USD...');
  const btcUsdBars = await fetchWithFallback('BTC', 'USD');
  if (!btcUsdBars) { console.error('FATAL: Could not fetch BTC/USD'); process.exit(1); }

  const btcCloses = btcUsdBars.map(b => b.close);
  const btcPrice = btcCloses[btcCloses.length - 1];
  const btcUsd = computeTrendAndGap(btcUsdBars);

  const results = [];
  results.push({
    symbol: 'BTC', rank: 1, price: btcPrice,
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
