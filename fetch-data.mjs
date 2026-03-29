// Alpaca Crypto Data Fetcher
// Runs daily via GitHub Actions, writes data.json for the static frontend

const COINS = [
  'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK',
  'DOT', 'LTC', 'SUI', 'NEAR', 'ATOM', 'UNI', 'AAVE', 'APT',
  'ARB', 'OP', 'RENDER', 'INJ',
];

const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_API_SECRET;
const DATA_URL = 'https://data.alpaca.markets/v1beta3/crypto/us';

if (!ALPACA_KEY || !ALPACA_SECRET) {
  console.error('ERROR: ALPACA_API_KEY and ALPACA_API_SECRET env vars required.');
  process.exit(1);
}

const headers = {
  'Apca-Api-Key-Id': ALPACA_KEY,
  'Apca-Api-Secret-Key': ALPACA_SECRET,
};

function sma(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// Get date string N days ago in YYYY-MM-DD format
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split('T')[0];
}

async function fetchBars(symbols, timeframe, start, end) {
  const params = new URLSearchParams({
    symbols: symbols.join(','),
    timeframe,
    start,
    end,
    limit: '10000',
    sort: 'asc',
  });

  const allBars = {};
  let url = `${DATA_URL}/bars?${params}`;

  while (url) {
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Alpaca API ${r.status}: ${body}`);
    }
    const data = await r.json();

    for (const [sym, bars] of Object.entries(data.bars || {})) {
      if (!allBars[sym]) allBars[sym] = [];
      allBars[sym].push(...bars);
    }

    if (data.next_page_token) {
      const nextParams = new URLSearchParams(params);
      nextParams.set('page_token', data.next_page_token);
      url = `${DATA_URL}/bars?${nextParams}`;
    } else {
      url = null;
    }
  }

  return allBars;
}

async function main() {
  const start = daysAgo(60); // extra buffer for 50-day SMA
  const end = daysAgo(0);

  // Build symbol lists
  const usdSymbols = COINS.map(c => `${c}/USD`);
  const btcSymbols = COINS.map(c => `${c}/BTC`);

  console.log(`Fetching USD pairs (${usdSymbols.length} symbols)...`);
  const usdBars = await fetchBars(usdSymbols, '1Day', start, end);
  console.log(`  Got data for: ${Object.keys(usdBars).join(', ')}`);

  console.log(`Fetching BTC pairs (${btcSymbols.length} symbols)...`);
  const btcBars = await fetchBars(btcSymbols, '1Day', start, end);
  console.log(`  Got data for: ${Object.keys(btcBars).join(', ')}`);

  const results = [];

  for (const coin of COINS) {
    const usdKey = `${coin}/USD`;
    const btcKey = `${coin}/BTC`;

    const usdData = usdBars[usdKey];
    const btcData = btcBars[btcKey];

    let price = null, usdTrend = null, btcTrend = null;

    // USD trend
    if (usdData && usdData.length >= 2) {
      const closes = usdData.map(b => b.c);
      price = closes[closes.length - 1];
      if (closes.length > 50) {
        const smaValue = sma(closes.slice(-51, -1)); // 50-day SMA excluding today
        usdTrend = price >= smaValue;
      } else {
        const smaValue = sma(closes.slice(0, -1));
        usdTrend = price >= smaValue;
      }
    }

    // BTC trend
    if (btcData && btcData.length >= 2) {
      const closes = btcData.map(b => b.c);
      const current = closes[closes.length - 1];
      if (closes.length > 50) {
        const smaValue = sma(closes.slice(-51, -1));
        btcTrend = current >= smaValue;
      } else {
        const smaValue = sma(closes.slice(0, -1));
        btcTrend = current >= smaValue;
      }
    }

    results.push({ symbol: coin, price, usdTrend, btcTrend });

    const fmt = (v) => v === null ? 'N/A' : v ? 'GREEN' : 'RED';
    console.log(`  ${coin}: ${price !== null ? '$' + price.toFixed(2) : 'N/A'} | USD: ${fmt(usdTrend)} | BTC: ${fmt(btcTrend)}`);
  }

  const output = { updated: new Date().toISOString(), coins: results };
  const { writeFileSync } = await import('fs');
  writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`\nDone. Wrote data.json with ${results.length} coins.`);
}

main().catch(e => { console.error(e); process.exit(1); });
