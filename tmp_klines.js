const https = require('https');
// Fetch candles around 12:30 AM Bolivia (UTC-4) = 04:30 UTC on Feb 13, 2026
// Need candles from ~04:20 to 04:40 UTC
const startTime = new Date('2026-02-13T04:20:00Z').getTime();
const endTime = new Date('2026-02-13T04:45:00Z').getTime();
const url = `https://fapi.binance.com/fapi/v1/klines?symbol=STOUSDT&interval=5m&startTime=${startTime}&endTime=${endTime}`;

https.get(url, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const k = JSON.parse(d);
        console.log('Time (UTC)           | Open     | High     | Low      | Close');
        console.log('---------------------|----------|----------|----------|--------');
        k.forEach(c => {
            const t = new Date(c[0]).toISOString().slice(11, 16);
            console.log(`${t} UTC                | ${c[1]}  | ${c[2]}  | ${c[3]}  | ${c[4]}`);
        });
    });
});
