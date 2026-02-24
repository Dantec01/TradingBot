const http = require('https');

http.get('https://fapi.binance.com/fapi/v1/klines?symbol=STOUSDT&interval=5m&limit=1500', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            const candles = parsed.map(d => ({
                open: parseFloat(d[1]), high: parseFloat(d[2]),
                low: parseFloat(d[3]), close: parseFloat(d[4])
            }));

            for (let i = 0; i < candles.length; i++) {
                let c = candles[i];
                if (i === 0) {
                    c.sma = c.close; c.atr = c.high - c.low; c.filter = c.close;
                    c.trend = 1; c.isTrigger = false; c.signalStr = 'Neutral';
                    continue;
                }

                let prev = candles[i - 1];
                let sum = 0, count = Math.min(i + 1, 100);
                for (let j = 0; j < count; j++) sum += candles[i - j].close;
                c.sma = sum / count;

                let tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
                c.atr = ((prev.atr * 99) + tr) / 100;
                let smrng = c.atr * 3.0;

                let filter = prev.filter || 0, upward = prev.upward || 0, downward = prev.downward || 0;

                if (c.sma > filter) {
                    upward = c.sma - filter > smrng ? c.sma - smrng : filter; downward = filter;
                } else if (c.sma < filter) {
                    downward = filter - c.sma > smrng ? c.sma + smrng : filter; upward = filter;
                }
                c.upward = upward; c.downward = downward; c.filter = c.sma > filter ? upward : downward;

                let trend = prev.trend || 1;
                if (c.close > c.filter) trend = 1;
                else if (c.close < c.filter) trend = -1;
                c.trend = trend; c.isTrigger = trend !== prev.trend;
                c.signalStr = trend === 1 ? 'Buy' : 'Sell';
            }

            let inPosition = false;
            let p = null;
            let moves = [];

            for (let i = 1; i < candles.length; i++) {
                const c = candles[i];
                if (!inPosition && c.isTrigger && c.signalStr !== 'Neutral') {
                    inPosition = true; p = { type: c.signalStr === 'Buy' ? 'LONG' : 'SHORT', entry: c.close, maxP: c.high, minP: c.low };
                } else if (inPosition) {
                    p.maxP = Math.max(p.maxP, c.high); p.minP = Math.min(p.minP, c.low);
                    if (c.isTrigger && c.signalStr !== (p.type === 'LONG' ? 'Buy' : 'Sell')) {
                        const mP = p.type === 'LONG' ? ((p.maxP - p.entry) / p.entry) * 100 : ((p.entry - p.minP) / p.entry) * 100;
                        const mD = p.type === 'LONG' ? ((p.minP - p.entry) / p.entry) * 100 : ((p.entry - p.maxP) / p.entry) * 100;
                        moves.push({ profit: mP, dd: mD });
                        inPosition = false; p = null;
                    }
                }
            }

            let pRuns1_5 = 0, pRuns2 = 0, pRuns3 = 0, maxPAvg = 0, medianDD = 0, avgDD = 0;
            let plist = moves.map(m => m.profit).sort((a, b) => a - b);
            let dlist = moves.map(m => m.dd).sort((a, b) => a - b);
            moves.forEach(m => {
                if (m.profit >= 1.5) pRuns1_5++;
                if (m.profit >= 2.0) pRuns2++;
                if (m.profit >= 3.0) pRuns3++;
                maxPAvg += m.profit;
                avgDD += m.dd;
            });
            maxPAvg /= moves.length;
            avgDD /= moves.length;
            medianDD = dlist[Math.floor(dlist.length / 2)];
            let medP = plist[Math.floor(plist.length / 2)];
            let p75 = plist[Math.floor(plist.length * 0.75)];

            const out = `
=== STOUSDT 5m (Last 5 Days / 1500 Candles) ===
Theoretical Maximum Excursions for Range Filter (100, 3.0) signals.

Total Trades: ${moves.length}

>> MAXIMUM PROFIT REACHED (Before the reversal signal triggered)
Average Max Profit Hit: ${maxPAvg.toFixed(2)}%
Median Max Profit Hit: ${medP.toFixed(2)}%
75th Percentile Max Profit: ${p75.toFixed(2)}%

Trades that successfully hit +1.5% profit: ${pRuns1_5}
Trades that successfully hit +2.0% profit: ${pRuns2}
Trades that successfully hit +3.0% profit: ${pRuns3}

>> MAXIMUM REVERSE DRAWDOWN (Before reaching peak profit or exit)
Average Drawdown Suffered: ${avgDD.toFixed(2)}%
Median Drawdown Suffered: ${medianDD.toFixed(2)}%
`;
            console.log(out);
        } catch (e) { console.error(e); }
    });
});
