const backtest = require('./lib/backtest');
const fs = require('fs');

async function runTest() {
    console.log('=== BACKTEST DEBUG SPIRIT_ELITE - 06 FEB 2026 ===\n');
    
    const config = {
        symbol: 'ALCHUSDT',
        timeframe: '5m',
        strategy: 'SPIRIT_ELITE',
        initialCapital: 100,
        orderSize: 2,
        leverage: 20,
        eliteTickOffset: 0.0010,
        eliteTrailingDefer: 5,
        trailingPct: 1.0,
        direction: 'BOTH',
        slMode: 'NONE',
        startDate: '2026-02-06',
        endDate: '2026-02-06',
        takerFee: 0.05
    };
    
    console.log('Config:', JSON.stringify(config, null, 2));
    console.log('\nEjecutando backtest...\n');
    
    try {
        const result = await backtest.run(config);
        
        const trades = result.trades;
        const candles = result.candles;
        
        // ===========================
        // TABLA COMPLETA DE TRADES  
        // ===========================
        console.log('\n' + '='.repeat(180));
        console.log('  #  | TIPO  | ENTRADA          | HORA ENTRADA        | SALIDA           | HORA SALIDA         | RAZÓN                              | PnL USDT  | REENTRY | VÁLIDO');
        console.log('='.repeat(180));
        
        let slExits = 0;
        let reEntries = 0;
        let slWithoutReEntry = 0;
        let missedReEntries = [];
        let totalPnlSL = 0;
        let totalPnlSignal = 0;
        let priceErrors = 0;
        
        for (let i = 0; i < trades.length; i++) {
            const trade = trades[i];
            const entryDate = new Date(trade.entryTime).toLocaleString('es-ES', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
            const exitDate = new Date(trade.exitTime).toLocaleString('es-ES', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
            
            const isSLExit = trade.reason.includes('Stop Loss') || trade.reason.includes('Trailing');
            const isReEntry = i > 0 && trades[i-1].reason.includes('Stop Loss') && 
                              trades[i-1].type === trade.type && 
                              Math.abs(trades[i-1].exitTime - trade.entryTime) < 600001; // within 10min
            
            // Check if next trade is re-entry after this SL
            let hasReEntry = false;
            if (isSLExit && i + 1 < trades.length) {
                const next = trades[i+1];
                hasReEntry = next.type === trade.type && Math.abs(trade.exitTime - next.entryTime) < 600001;
            }
            
            if (isSLExit) {
                slExits++;
                totalPnlSL += trade.pnl;
                if (!hasReEntry) {
                    slWithoutReEntry++;
                    missedReEntries.push({index: i+1, trade});
                }
            } else {
                totalPnlSignal += trade.pnl;
            }
            if (isReEntry) reEntries++;
            
            // Validate price
            const exitCandle = candles.find(c => c.time === trade.exitTime);
            let valid = '✅';
            if (exitCandle) {
                if (trade.exitPrice < exitCandle.low || trade.exitPrice > exitCandle.high) {
                    valid = '❌';
                    priceErrors++;
                }
            }
            
            const reTag = isReEntry ? '  ↩️  ' : '      ';
            const num = String(i+1).padStart(4);
            const tipo = trade.type.padEnd(5);
            const ep = String(trade.entryPrice).padEnd(16);
            const xp = String(trade.exitPrice).padEnd(16);
            const reason = trade.reason.padEnd(35);
            const pnl = (trade.pnl >= 0 ? '+' : '') + trade.pnl.toFixed(4);
            
            console.log(`${num} | ${tipo} | ${ep} | ${entryDate.padEnd(19)} | ${xp} | ${exitDate.padEnd(19)} | ${reason} | ${pnl.padStart(9)} | ${reTag} | ${valid}`);
        }
        
        // ===========================
        // ANÁLISIS DE RE-ENTRADAS
        // ===========================
        console.log('\n' + '='.repeat(80));
        console.log('ANÁLISIS DE RE-ENTRADAS TRAS STOP LOSS');
        console.log('='.repeat(80));
        console.log(`Total salidas por SL:          ${slExits}`);
        console.log(`Re-entradas ejecutadas:        ${reEntries}`);
        console.log(`SL SIN re-entrada:             ${slWithoutReEntry}`);
        
        if (missedReEntries.length > 0) {
            console.log('\n--- SL SIN RE-ENTRADA (detalle) ---');
            for (const m of missedReEntries) {
                const t = m.trade;
                const exitDate = new Date(t.exitTime).toLocaleString('es-ES');
                console.log(`  Trade #${m.index}: ${t.type} salió @ ${t.exitPrice} (${exitDate}) - ${t.reason}`);
                
                // Check what signal existed at exit time
                const exitCandle = candles.find(c => c.time === t.exitTime);
                if (exitCandle) {
                    console.log(`    Vela de salida: signal=${exitCandle.signalStr || 'N/A'}, isTrigger=${exitCandle.isTrigger || 'N/A'}`);
                }
                // Check next candle signal
                const exitIdx = candles.findIndex(c => c.time === t.exitTime);
                if (exitIdx >= 0 && exitIdx + 1 < candles.length) {
                    const nextC = candles[exitIdx + 1];
                    console.log(`    Vela siguiente: signal=${nextC.signalStr || 'N/A'}, isTrigger=${nextC.isTrigger || 'N/A'}`);
                }
                // Check what the next trade is
                const nextTrade = m.index < trades.length ? trades[m.index] : null;
                if (nextTrade) {
                    console.log(`    Siguiente trade: ${nextTrade.type} @ ${nextTrade.entryPrice} (${new Date(nextTrade.entryTime).toLocaleString('es-ES')}) → ${nextTrade.reason}`);
                } else {
                    console.log(`    ⚠️ No hay trade posterior`);
                }
            }
        }
        
        // ===========================
        // ESTADÍSTICAS FINALES
        // ===========================
        console.log('\n' + '='.repeat(80));
        console.log('ESTADÍSTICAS');
        console.log('='.repeat(80));
        console.log(`Total trades:            ${trades.length}`);
        console.log(`Errores de precio:       ${priceErrors}`);
        console.log(`Win Rate:                ${(result.stats.winRate * 100).toFixed(2)}%`);
        console.log(`ROI:                     ${result.stats.roi.toFixed(4)}%`);
        console.log(`PnL total (SL exits):    ${totalPnlSL.toFixed(4)} USDT (${slExits} trades)`);
        console.log(`PnL total (Signal Rev):  ${totalPnlSignal.toFixed(4)} USDT (${trades.length - slExits} trades)`);
        console.log(`PnL promedio SL:         ${slExits > 0 ? (totalPnlSL/slExits).toFixed(4) : 'N/A'} USDT`);
        console.log(`PnL promedio Signal:     ${(trades.length - slExits) > 0 ? (totalPnlSignal/(trades.length - slExits)).toFixed(4) : 'N/A'} USDT`);
        
        // ===========================
        // EXPORT CSV
        // ===========================
        let csv = 'No,Tipo,Entrada Precio,Entrada Hora,Salida Precio,Salida Hora,Razon,PnL USDT,Reentry\n';
        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            const entryDate = new Date(t.entryTime).toLocaleString('es-ES');
            const exitDate = new Date(t.exitTime).toLocaleString('es-ES');
            const isSL = t.reason.includes('Stop Loss') || t.reason.includes('Trailing');
            const isRE = i > 0 && trades[i-1].reason.includes('Stop Loss') && 
                         trades[i-1].type === t.type && 
                         Math.abs(trades[i-1].exitTime - t.entryTime) < 600001;
            csv += `${i+1},${t.type},${t.entryPrice},${entryDate},${t.exitPrice},${exitDate},"${t.reason}",${t.pnl.toFixed(4)},${isRE ? 'SI' : 'NO'}\n`;
        }
        fs.writeFileSync('debug_backtest_trades.csv', csv, 'utf-8');
        console.log(`\n✅ CSV exportado: debug_backtest_trades.csv`);
        
    } catch (error) {
        console.error('Error en backtest:', error);
    }
}

runTest();
