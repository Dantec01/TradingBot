/**
 * Verify paper bot trade prices against real Binance kline data.
 * fetchKlines signature: fetchKlines(symbol, interval, limit, startTime, endTime)
 */
const { fetchKlines } = require('./lib/binance');

const trades = [
    { time: '5:55 PM', action: 'OPEN', type: 'LONG', price: 0.05320 },
    { time: '6:00 PM', action: 'CLOSE', type: 'LONG', price: 0.05317 },
    { time: '6:05 PM', action: 'OPEN', type: 'LONG', price: 0.05317 },
    { time: '6:10 PM', action: 'CLOSE', type: 'LONG', price: 0.05320 },
    { time: '6:15 PM', action: 'OPEN', type: 'LONG', price: 0.05317 },
    { time: '6:20 PM', action: 'CLOSE', type: 'LONG', price: 0.05325 },
    { time: '6:25 PM', action: 'OPEN', type: 'LONG', price: 0.05321 },
    { time: '6:30 PM', action: 'CLOSE', type: 'LONG', price: 0.05324 },
    { time: '6:35 PM', action: 'OPEN', type: 'LONG', price: 0.05316 },
    { time: '6:40 PM', action: 'CLOSE', type: 'LONG', price: 0.05314 },
    { time: '6:45 PM', action: 'OPEN', type: 'LONG', price: 0.05305 },
    { time: '6:50 PM', action: 'CLOSE', type: 'LONG', price: 0.05303 },
    { time: '6:55 PM', action: 'OPEN', type: 'SHORT', price: 0.05280 },
    { time: '7:00 PM', action: 'CLOSE', type: 'SHORT', price: 0.05284 },
    { time: '7:05 PM', action: 'OPEN', type: 'SHORT', price: 0.05249 },
    { time: '7:10 PM', action: 'CLOSE', type: 'SHORT', price: 0.05242 },
    { time: '7:15 PM', action: 'OPEN', type: 'SHORT', price: 0.05250 },
    { time: '7:20 PM', action: 'CLOSE', type: 'SHORT', price: 0.05250 },
    { time: '7:25 PM', action: 'OPEN', type: 'SHORT', price: 0.05221 },
    { time: '7:30 PM', action: 'CLOSE', type: 'SHORT', price: 0.05218 },
    { time: '7:35 PM', action: 'OPEN', type: 'SHORT', price: 0.05207 },
    { time: '7:40 PM', action: 'CLOSE', type: 'SHORT', price: 0.05204 },
    { time: '7:45 PM', action: 'OPEN', type: 'SHORT', price: 0.05230 },
    { time: '7:50 PM', action: 'CLOSE', type: 'SHORT', price: 0.05235 },
    { time: '7:55 PM', action: 'OPEN', type: 'SHORT', price: 0.05237 },
    { time: '8:00 PM', action: 'CLOSE', type: 'SHORT', price: 0.05240 },
    { time: '8:05 PM', action: 'OPEN', type: 'LONG', price: 0.05257 },
    { time: '8:10 PM', action: 'CLOSE', type: 'LONG', price: 0.05285 },
    { time: '8:15 PM', action: 'OPEN', type: 'LONG', price: 0.05290 },
    { time: '8:20 PM', action: 'CLOSE', type: 'LONG', price: 0.05294 },
    { time: '8:25 PM', action: 'OPEN', type: 'LONG', price: 0.05297 },
    { time: '8:30 PM', action: 'CLOSE', type: 'LONG', price: 0.05297 },
    { time: '8:35 PM', action: 'OPEN', type: 'LONG', price: 0.05296 },
    { time: '8:40 PM', action: 'CLOSE', type: 'LONG', price: 0.05320 },
    { time: '8:45 PM', action: 'OPEN', type: 'LONG', price: 0.05320 },
    { time: '8:50 PM', action: 'CLOSE', type: 'LONG', price: 0.05322 },
    { time: '8:55 PM', action: 'OPEN', type: 'LONG', price: 0.05308 },
    { time: '9:00 PM', action: 'CLOSE', type: 'LONG', price: 0.05306 },
    { time: '9:05 PM', action: 'OPEN', type: 'LONG', price: 0.05327 },
    { time: '9:10 PM', action: 'CLOSE', type: 'LONG', price: 0.05322 },
    { time: '9:15 PM', action: 'OPEN', type: 'LONG', price: 0.05327 },
    { time: '9:20 PM', action: 'CLOSE', type: 'LONG', price: 0.05325 },
    { time: '9:25 PM', action: 'OPEN', type: 'LONG', price: 0.05321 },
    { time: '9:30 PM', action: 'CLOSE', type: 'LONG', price: 0.05334 },
    { time: '9:35 PM', action: 'OPEN', type: 'LONG', price: 0.05341 },
    { time: '9:40 PM', action: 'CLOSE', type: 'LONG', price: 0.05357 },
    { time: '9:45 PM', action: 'OPEN', type: 'LONG', price: 0.05358 },
    { time: '9:50 PM', action: 'CLOSE', type: 'LONG', price: 0.05357 },
    { time: '9:55 PM', action: 'OPEN', type: 'LONG', price: 0.05352 },
    { time: '10:00 PM', action: 'CLOSE', type: 'LONG', price: 0.05357 },
];

async function verify() {
    // Fetch the most recent 100 candles of STOUSDT 5m (no date params)
    const klines = await fetchKlines('STOUSDT', '5m', 100);

    console.log(`\nFetched ${klines.length} candles`);
    if (klines.length > 0) {
        console.log(`First: ${new Date(klines[0].time).toISOString()}`);
        console.log(`Last:  ${new Date(klines[klines.length - 1].time).toISOString()}`);
        console.log(`\nSample candle prices (last 10):\n`);
        klines.slice(-10).forEach(c => {
            console.log(`  ${new Date(c.time).toISOString()} | O=${c.open} H=${c.high} L=${c.low} C=${c.close}`);
        });
    }

    console.log('\n' + '='.repeat(110));
    console.log('TRADE VERIFICATION');
    console.log('='.repeat(110));

    let entryOk = 0, entryBad = 0;
    let exitOk = 0, exitBad = 0;

    for (const trade of trades) {
        if (trade.action === 'OPEN') {
            // Entry should match a candle's CLOSE price
            const match = klines.find(c => Math.abs(c.close - trade.price) < 0.00002);
            if (match) {
                const t = new Date(match.time).toISOString().slice(11, 16);
                console.log(`[${trade.time.padEnd(9)}] OPEN ${trade.type.padEnd(5)} @ ${trade.price} ✅ candle ${t} C=${match.close}`);
                entryOk++;
            } else {
                // Check if at least it's within some candle's range
                const inRange = klines.find(c => trade.price >= c.low && trade.price <= c.high);
                if (inRange) {
                    const t = new Date(inRange.time).toISOString().slice(11, 16);
                    console.log(`[${trade.time.padEnd(9)}] OPEN ${trade.type.padEnd(5)} @ ${trade.price} ⚠️  not exact close, but in range of ${t} (C=${inRange.close} L=${inRange.low} H=${inRange.high})`);
                    entryOk++;
                } else {
                    console.log(`[${trade.time.padEnd(9)}] OPEN ${trade.type.padEnd(5)} @ ${trade.price} ❌ NOT FOUND in any candle`);
                    entryBad++;
                }
            }
        } else {
            // Exit: trailing SL price should be within some candle's high/low range
            const inRange = klines.find(c => trade.price >= c.low && trade.price <= c.high);
            if (inRange) {
                const t = new Date(inRange.time).toISOString().slice(11, 16);
                console.log(`[${trade.time.padEnd(9)}] EXIT        @ ${trade.price} ✅ in range of ${t} (L=${inRange.low} H=${inRange.high})`);
                exitOk++;
            } else {
                // Check all candles to find closest
                let closest = null, minDist = Infinity;
                klines.forEach(c => {
                    const dist = Math.min(Math.abs(trade.price - c.low), Math.abs(trade.price - c.high));
                    if (dist < minDist) { minDist = dist; closest = c; }
                });
                const t = closest ? new Date(closest.time).toISOString().slice(11, 16) : '?';
                console.log(`[${trade.time.padEnd(9)}] EXIT        @ ${trade.price} ❌ PHANTOM (closest: ${t} L=${closest?.low} H=${closest?.high} dist=${minDist.toFixed(5)})`);
                exitBad++;
            }
        }
    }

    console.log('\n' + '='.repeat(110));
    console.log(`ENTRIES: ${entryOk} valid, ${entryBad} invalid`);
    console.log(`EXITS:   ${exitOk} valid, ${exitBad} phantom`);
}

verify().catch(console.error);
