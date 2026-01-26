require('dotenv').config();
const { run } = require('./lib/backtest');

async function debugVanguard() {
    try {
        console.log("Starting VANGUARD Debug for ROSEUSDT (Jan 24-25 2026)...");

        const config = {
            symbol: 'ROSEUSDT',
            timeframe: '5m',
            strategy: 'VANGUARD',
            initialCapital: 100,
            orderSize: 10,
            leverage: 20,
            feePct: 0.06,
            slMode: 'FIXED',
            stopLossPct: 1.0,
            trailingPct: 1.0,
            direction: 'BOTH',
            startDate: '2026-01-24',
            endDate: '2026-01-25'
        };

        const result = await run(config);

        console.log("# VANGUARD Debug Log - ROSEUSDT (Jan 24-25 2026)");
        console.log(`**Total Trades:** ${result.stats.totalTrades}`);
        const netPnL = result.stats.finalBalance - result.stats.initialCapital;
        console.log(`**Net PnL:** ${netPnL.toFixed(4)} USDT`);
        console.log(`**Win Rate:** ${(result.stats.winRate * 100).toFixed(2)}%`);
        console.log("\n## Trade List\n");
        console.log("| # | Type | Entry Time | Entry Price | Exit Time | Exit Price | Reason | PnL |");
        console.log("|---|---|---|---|---|---|---|---|");

        result.trades.forEach((t, index) => {
            const entryStr = new Date(t.entryTime).toISOString().replace('T', ' ').slice(0, 19);
            const exitStr = new Date(t.exitTime).toISOString().replace('T', ' ').slice(0, 19);
            console.log(`| ${index + 1} | ${t.type} | ${entryStr} | ${t.entryPrice} | ${exitStr} | ${t.exitPrice} | ${t.reason} | ${t.pnl.toFixed(4)} |`);
        });

    } catch (err) {
        console.error("Error debugging:", err);
    }
}

debugVanguard();
