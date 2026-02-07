/**
 * Debug Backtest: SPIRIT_TRAILING con Trailing Stop 0.2%
 * Params: ALCHUSDT, 5m, 2 USDT, 20x, Feb 6 2025
 */
const { run: runBacktest } = require('./lib/backtest');

async function run() {
    const config = {
        symbol: 'ALCHUSDT',
        timeframe: '5m',
        strategy: 'SPIRIT_TRAILING',
        slMode: 'TRAILING',
        stopLossPct: 1.0,
        trailingPct: 0.2,
        orderSize: 2,
        leverage: 20,
        direction: 'BOTH',
        startDate: '2025-02-06',
        endDate: '2025-02-06',
        feeRate: 0.0005  // 0.05% taker
    };

    console.log('=== SPIRIT_TRAILING Debug Backtest ===');
    console.log(`Symbol: ${config.symbol} | TF: ${config.timeframe}`);
    console.log(`Strategy: ${config.strategy} | SL Mode: ${config.slMode}`);
    console.log(`Trailing: ${config.trailingPct}% | Order: ${config.orderSize} USDT | Leverage: ${config.leverage}x`);
    console.log('');

    const result = await runBacktest(config);

    if (!result || !result.trades) {
        console.log('ERROR: No result returned');
        return;
    }

    const trades = result.trades;
    console.log(`Total Trades: ${trades.length}`);
    console.log(`Balance: ${result.finalBalance?.toFixed(4) || 'N/A'}`);
    console.log(`ROI: ${result.roi?.toFixed(2) || 'N/A'}%`);
    console.log('');

    // Detailed trade table
    console.log('=== TRADE TABLE ===');
    console.log('#  | Type  | Entry Price | Exit Price  | Reason                | PnL      | ROI%    | Entry Time           | Exit Time');
    console.log('---|-------|-------------|-------------|----------------------|----------|---------|---------------------|--------------------');

    let wins = 0, losses = 0;
    let totalPnL = 0;
    let trailingStops = 0, signalReversals = 0, otherExits = 0;

    trades.forEach((t, idx) => {
        const num = String(idx + 1).padStart(2);
        const type = t.type.padEnd(5);
        const entry = t.entryPrice.toFixed(6).padStart(11);
        const exit = t.exitPrice.toFixed(6).padStart(11);
        const reason = (t.reason || 'Unknown').padEnd(20);
        const pnl = t.pnl.toFixed(4).padStart(8);
        const roi = t.roi.toFixed(2).padStart(7);
        const entryTime = new Date(t.entryTime).toISOString().substring(5, 19);
        const exitTime = new Date(t.exitTime).toISOString().substring(5, 19);

        console.log(`${num} | ${type} | ${entry} | ${exit} | ${reason} | ${pnl} | ${roi}% | ${entryTime} | ${exitTime}`);

        if (t.pnl > 0) wins++;
        else losses++;
        totalPnL += t.pnl;

        if (t.reason.includes('Trailing')) trailingStops++;
        else if (t.reason.includes('Signal')) signalReversals++;
        else otherExits++;
    });

    console.log('');
    console.log('=== SUMMARY ===');
    console.log(`Wins: ${wins} | Losses: ${losses} | Win Rate: ${((wins / trades.length) * 100).toFixed(1)}%`);
    console.log(`Total PnL: ${totalPnL.toFixed(4)}`);
    console.log(`Avg PnL: ${(totalPnL / trades.length).toFixed(4)}`);
    console.log(`Trailing Stops: ${trailingStops} | Signal Reversals: ${signalReversals} | Other: ${otherExits}`);

    // Check for same-candle entry+exit (potential bug indicator)
    console.log('');
    console.log('=== VALIDATION ===');
    let sameCandle = 0;
    let priceErrors = 0;
    trades.forEach((t, idx) => {
        if (t.entryTime === t.exitTime) {
            sameCandle++;
            console.log(`  WARN: Trade #${idx + 1} entry==exit time (${new Date(t.entryTime).toISOString()})`);
        }
    });

    // Check re-entries (trades where entry immediately follows previous exit)
    let reEntries = 0;
    for (let i = 1; i < trades.length; i++) {
        const prev = trades[i - 1];
        const curr = trades[i];
        // If current entry is at or before previous exit time + 1 candle (5min = 300000ms)
        if (curr.entryTime <= prev.exitTime + 300000 && curr.entryTime >= prev.exitTime - 300000) {
            if (prev.reason.includes('Trailing') || prev.reason.includes('Stop Loss')) {
                reEntries++;
                const reEntryDiff = ((curr.entryPrice - prev.exitPrice) / prev.exitPrice * 100).toFixed(4);
                console.log(`  RE-ENTRY: Trade #${i + 1} after #${i} (${prev.reason}). Entry=${curr.entryPrice.toFixed(6)}, PrevExit=${prev.exitPrice.toFixed(6)}, Diff=${reEntryDiff}%`);
            }
        }
    }

    console.log(`\nSame-candle trades: ${sameCandle}`);
    console.log(`Re-entries detected: ${reEntries}`);
    console.log(`Price errors: ${priceErrors}`);
}

run().catch(console.error);
