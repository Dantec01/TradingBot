const axios = require('axios');

const BASE_URL = 'https://fapi.binance.com/fapi/v1/klines';

async function fetchKlines(symbol, interval, limit = 1500, startTime = null, endTime = null) {
    // Normalize symbol
    if (!symbol.toUpperCase().endsWith('USDT')) {
        symbol = symbol.toUpperCase() + 'USDT';
    } else {
        symbol = symbol.toUpperCase();
    }

    const allCandles = [];
    // Max API limit per request is 1000; safely use 1000.
    const API_LIMIT = 1000;

    // If we only need a small amount, just do one request
    if (limit <= API_LIMIT && !startTime) {
        return fetchSinglePage(symbol, interval, limit, null, endTime);
    }

    // Pagination Logic
    // Strategy: Fetch backwards or forwards? 
    // Binance API `startTime` param fetches *from* that time *forward*.
    // If we have a `startTime`, we can fetch forward in chunks of 1000.

    if (startTime) {
        let currentStartTime = startTime;
        // We fetch until we reach endTime or "now"
        const targetEndTime = endTime || Date.now();

        while (true) {
            // We can't exceed 'limit' total candles requested (safety cap)
            if (allCandles.length >= limit) break;

            // Fetch chunk
            const chunk = await fetchSinglePage(symbol, interval, API_LIMIT, currentStartTime, null);

            if (!chunk || chunk.length === 0) break;

            // Filter chunk to not exceed targetEndTime (though usually handled by logic)
            const validChunk = chunk.filter(c => c.time <= targetEndTime);

            // Avoid duplicates (shouldn't happen with correct startTime, but be safe)
            const newCandles = validChunk.filter(c =>
                allCandles.length === 0 || c.time > allCandles[allCandles.length - 1].time
            );

            if (newCandles.length === 0) break;

            // Add to list
            allCandles.push(...newCandles);

            // Setup next loop
            const lastCandle = newCandles[newCandles.length - 1];
            currentStartTime = lastCandle.time + 1; // +1ms to avoid overlap

            // If the last candle is significantly past target, stop.
            if (lastCandle.time >= targetEndTime) break;

            // If we got fewer than requested, we likely hit end of data
            if (chunk.length < API_LIMIT) break;

            // Rate limit safety
            await new Promise(r => setTimeout(r, 100));
        }

        return allCandles;

    } else {
        // No startTime provided? Just fetch the most recent 'limit' candles (up to 1500)
        // Since Binance only supports fetching *from* a time or *decreasing* from now?
        // Actually, if we just pass `limit=1500`, axios wont work because API max is 1000.
        // We must fetch recent 1000, then fetch previous if needed?
        // Simpler: Just fetch one page of 1000 for now if no start date is specific.
        // Or strict to 1000.
        return fetchSinglePage(symbol, interval, Math.min(limit, 1000), null, endTime);
    }
}

async function fetchSinglePage(symbol, interval, limit, startTime, endTime) {
    const params = {
        symbol: symbol,
        interval: interval,
        limit: limit
    };
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;

    try {
        console.log(`Fetching klines for ${symbol} params:`, params);
        const response = await axios.get(BASE_URL, { params });
        return response.data.map(k => ({
            time: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            closeTime: k[6]
        }));
    } catch (error) {
        console.error(`Error fetching klines: ${error.message}`);
        return [];
    }
}

module.exports = { fetchKlines };
