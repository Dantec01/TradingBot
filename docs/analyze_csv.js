const fs = require('fs');
const readline = require('readline');

async function processCSV() {
    const fileStream = fs.createReadStream('docs/real bot 20 feb.csv');
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let isHeader = true;
    let trailes = [];
    let reversals = [];

    const leverage = 20;

    for await (const line of rl) {
        if (isHeader) { isHeader = false; continue; }
        if (!line.trim()) continue;

        // "Symbol,Type,Entry Time,Exit Time,Entry Price,Exit Price,Offset,Size,PnL,Commission,Funding,Reason"
        // Regex to split by comma, ignoring commas inside quotes
        const match = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g);
        if (!match) continue;
        const row = line.split(','); // Simplified because dates have quotes but we won't parse dates. We will use proper matching:

        let cols = [];
        let inQuotes = false;
        let p = "";
        for (let i = 0; i < line.length; i++) {
            if (line[i] === '"') { inQuotes = !inQuotes; }
            else if (line[i] === ',' && !inQuotes) { cols.push(p); p = ""; }
            else { p += line[i]; }
        }
        cols.push(p);

        if (cols.length < 12) continue;

        const type = cols[1];
        const entryPrice = parseFloat(cols[4]);
        const exitPrice = parseFloat(cols[5]);
        const pnl = parseFloat(cols[8]);
        const commission = parseFloat(cols[9]);
        const reason = cols[11].replace(/"/g, '');

        const sign = type === 'LONG' ? 1 : -1;

        // Exact percentage change at exit
        const exitMovePct = type === 'LONG'
            ? ((exitPrice - entryPrice) / entryPrice) * 100
            : ((entryPrice - exitPrice) / entryPrice) * 100;

        // If trailing stop hits, and trailing is 0.1%, it means the peak was 0.1% better than the exit.
        const estPeakPct = exitMovePct + 0.1;

        if (reason.includes('Trailing Stop')) {
            trailes.push({ type, entryPrice, exitPrice, exitMovePct, estPeakPct, pnl, commission });
        } else if (reason.includes('Signal Reversal')) {
            reversals.push({ type, entryPrice, exitPrice, exitMovePct, pnl, commission });
        }
    }

    console.log(`\n=== ANALISIS DE TRAILING STOPS (0.3% Activacion / 0.1% Trailing) ===`);
    let anomalousCount = 0;

    trailes.forEach((t, i) => {
        // Did it actually respect the 0.3% activation? 
        // If the estimated peak is less than 0.3%, something is off (either slippage, or bug in virtual trailing).
        const isValidActivation = t.estPeakPct >= 0.3;

        console.log(`TS #${i + 1} [${t.type}] | Cambio Exit: ${t.exitMovePct.toFixed(3)}% | Pico Est: ${t.estPeakPct.toFixed(3)}% | Activation OK?: ${isValidActivation ? 'SI' : 'NO'} | PnL: ${t.pnl.toFixed(4)}`);

        if (!isValidActivation) anomalousCount++;
    });

    console.log(`\nResumen Trailing: ${trailes.length} trades, ${anomalousCount} sospechosos de activar antes del 0.3% o mucho slippage.`);

    console.log(`\n=== ANALISIS DE SIGNAL REVERSALS ===`);
    let revPnl = 0;
    reversals.forEach((r, i) => {
        revPnl += r.pnl;
        console.log(`SR #${i + 1} [${r.type}] | Caida al cierre: ${r.exitMovePct.toFixed(3)}% | PnL: ${r.pnl.toFixed(4)}`);
    });
    console.log(`Reversals PnL Total: ${revPnl.toFixed(4)}`);
}

processCSV();
