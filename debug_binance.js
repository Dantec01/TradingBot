require('dotenv').config();
const Binance = require('binance-api-node').default;
const client = Binance({ apiKey: 'test', apiSecret: 'test' });
// Log all properties that might be functions
const methods = [];
for (const prop in client) {
    if (typeof client[prop] === 'function') {
        methods.push(prop);
    }
}
console.log("Methods found:", methods.filter(m => m.toLowerCase().includes('future') || m.toLowerCase().includes('listen') || m.toLowerCase().includes('stream')));
