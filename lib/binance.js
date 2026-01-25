const axios = require('axios');

// Configurar headers por defecto para simular un navegador y evitar bloqueos simples
axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';


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
        console.error(`Error fetching klines for ${symbol}: ${error.message}`);
        // Re-throw for critical errors (network issues, invalid symbol, etc.)
        if (error.response) {
            const status = error.response.status;
            if (status === 400 || status === 404) {
                throw new Error(`Símbolo inválido o no disponible: ${symbol}`);
            } else if (status >= 500) {
                throw new Error(`Error del servidor de Binance. Intenta más tarde.`);
            }
        }
        throw new Error(`Error de conexión: ${error.message}`);
    }
}

/**
 * Fetch current funding rate info for a symbol
 * Uses /fapi/v1/premiumIndex - NO API KEY REQUIRED
 * Returns: { rate, nextFundingTime, markPrice }
 */
async function fetchFundingRate(symbol) {
    if (!symbol.toUpperCase().endsWith('USDT')) {
        symbol = symbol.toUpperCase() + 'USDT';
    } else {
        symbol = symbol.toUpperCase();
    }

    const url = 'https://fapi.binance.com/fapi/v1/premiumIndex';
    try {
        const response = await axios.get(url, { params: { symbol } });
        const data = response.data;
        return {
            rate: parseFloat(data.lastFundingRate),
            nextFundingTime: data.nextFundingTime,
            markPrice: parseFloat(data.markPrice),
            symbol: data.symbol
        };
    } catch (error) {
        console.error(`Error fetching funding rate for ${symbol}: ${error.message}`);
        return { rate: 0, nextFundingTime: null, markPrice: 0, symbol };
    }
}

/**
 * Fetch funding rate history for a symbol
 * Uses /fapi/v1/fundingRate - NO API KEY REQUIRED
 * @param {string} symbol - Trading pair (e.g., 'BTC' or 'BTCUSDT')
 * @param {number} limit - Number of records (max 1000, default 100)
 * @param {number} startTime - Optional start timestamp in ms
 * @param {number} endTime - Optional end timestamp in ms
 * Returns array of: { fundingRate, fundingTime, markPrice }
 */
async function fetchFundingRateHistory(symbol, limit = 100, startTime = null, endTime = null) {
    if (!symbol.toUpperCase().endsWith('USDT')) {
        symbol = symbol.toUpperCase() + 'USDT';
    } else {
        symbol = symbol.toUpperCase();
    }

    const url = 'https://fapi.binance.com/fapi/v1/fundingRate';
    const params = { symbol, limit: Math.min(limit, 1000) };
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;

    try {
        const response = await axios.get(url, { params });
        return response.data.map(item => ({
            rate: parseFloat(item.fundingRate),
            fundingTime: item.fundingTime,
            markPrice: item.markPrice ? parseFloat(item.markPrice) : null,
            symbol: item.symbol
        }));
    } catch (error) {
        console.error(`Error fetching funding rate history for ${symbol}: ${error.message}`);
        return [];
    }
}

/**
 * Fetch funding interval info for a symbol
 * Uses /fapi/v1/fundingInfo - NO API KEY REQUIRED
 * Some coins have 4h funding, others 8h, etc.
 * Returns: { fundingIntervalHours, adjustedFundingRateCap, adjustedFundingRateFloor }
 */
async function fetchFundingInfo(symbol) {
    if (!symbol.toUpperCase().endsWith('USDT')) {
        symbol = symbol.toUpperCase() + 'USDT';
    } else {
        symbol = symbol.toUpperCase();
    }

    const url = 'https://fapi.binance.com/fapi/v1/fundingInfo';
    try {
        const response = await axios.get(url);
        // This endpoint returns all symbols, filter for our symbol
        const info = response.data.find(item => item.symbol === symbol);

        if (info) {
            return {
                symbol: info.symbol,
                fundingIntervalHours: info.fundingIntervalHours || 8, // Default 8h if not specified
                adjustedFundingRateCap: info.adjustedFundingRateCap ? parseFloat(info.adjustedFundingRateCap) : null,
                adjustedFundingRateFloor: info.adjustedFundingRateFloor ? parseFloat(info.adjustedFundingRateFloor) : null
            };
        }

        // Symbol not found in adjustments list = uses default 8h interval
        return {
            symbol,
            fundingIntervalHours: 8,
            adjustedFundingRateCap: null,
            adjustedFundingRateFloor: null
        };
    } catch (error) {
        console.error(`Error fetching funding info: ${error.message}`);
        return { symbol, fundingIntervalHours: 8, adjustedFundingRateCap: null, adjustedFundingRateFloor: null };
    }
}

/**
 * Get complete funding data for a symbol (combines all funding endpoints)
 * Returns comprehensive funding info for backtesting or live trading
 */
async function getCompleteFundingData(symbol) {
    try {
        const [currentRate, fundingInfo, history] = await Promise.all([
            fetchFundingRate(symbol),
            fetchFundingInfo(symbol),
            fetchFundingRateHistory(symbol, 100) // Last 100 funding events
        ]);

        // Calculate average funding rate from history
        let avgRate = 0;
        if (history.length > 0) {
            avgRate = history.reduce((sum, h) => sum + h.rate, 0) / history.length;
        }

        // Calculate funding events per day based on interval
        const fundingsPerDay = 24 / fundingInfo.fundingIntervalHours;

        return {
            symbol: currentRate.symbol,
            currentRate: currentRate.rate,
            currentRatePercent: (currentRate.rate * 100).toFixed(4) + '%',
            nextFundingTime: currentRate.nextFundingTime,
            nextFundingTimeFormatted: new Date(currentRate.nextFundingTime).toLocaleString(),
            markPrice: currentRate.markPrice,
            fundingIntervalHours: fundingInfo.fundingIntervalHours,
            fundingsPerDay: fundingsPerDay,
            avgHistoricalRate: avgRate,
            avgHistoricalRatePercent: (avgRate * 100).toFixed(4) + '%',
            estimatedDailyRate: avgRate * fundingsPerDay,
            estimatedDailyRatePercent: (avgRate * fundingsPerDay * 100).toFixed(4) + '%',
            history: history.slice(0, 10) // Last 10 for quick reference
        };
    } catch (error) {
        console.error(`Error getting complete funding data: ${error.message}`);
        return null;
    }
}

/**
 * Fetch Commission Rate for a symbol. 
 * Requires API credentials for account-specific rates.
 * Returns default if not available.
 */
async function fetchCommissionRate(symbol, apiKey = null, apiSecret = null) {
    // For now, if no API keys, return standard Binance Futures Maker/Taker fees (estimated)
    // Most accounts start at 0.02% Maker / 0.05% Taker. 
    // We'll use 0.06% as a fair estimate for Taker (including slippage).
    if (!apiKey) {
        return { maker: 0.0002, taker: 0.0006 };
    }

    // TODO: Implement authenticated request to /fapi/v1/commissionRate
    // when API keys are integrated into the session.
    return { maker: 0.0002, taker: 0.0004 };
}

/**
 * Fetch Exchange Info for a symbol.
 * Returns precision info: stepSize (quantity), tickSize (price), minNotional.
 * NO API KEY REQUIRED.
 */
async function fetchExchangeInfo(symbol) {
    if (!symbol.toUpperCase().endsWith('USDT')) {
        symbol = symbol.toUpperCase() + 'USDT';
    } else {
        symbol = symbol.toUpperCase();
    }

    const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
    try {
        const response = await axios.get(url);
        const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);

        if (!symbolInfo) {
            console.warn(`[ExchangeInfo] Symbol ${symbol} not found, using defaults`);
            return {
                symbol,
                quantityPrecision: 3,
                pricePrecision: 2,
                stepSize: 0.001,
                tickSize: 0.01,
                minNotional: 5
            };
        }

        // Extract filters
        const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
        const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

        return {
            symbol: symbolInfo.symbol,
            quantityPrecision: symbolInfo.quantityPrecision,
            pricePrecision: symbolInfo.pricePrecision,
            stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.001,
            tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.01,
            minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 5,
            minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0.001
        };
    } catch (error) {
        console.error(`Error fetching exchange info for ${symbol}: ${error.message}`);
        // Return safe defaults
        return {
            symbol,
            quantityPrecision: 3,
            pricePrecision: 2,
            stepSize: 0.001,
            tickSize: 0.01,
            minNotional: 5,
            minQty: 0.001
        };
    }
}

/**
 * Helper function to round quantity to valid step size
 */
function roundToStepSize(quantity, stepSize) {
    const precision = Math.round(-Math.log10(stepSize));
    const factor = Math.pow(10, precision);
    return Math.floor(quantity * factor) / factor;
}

module.exports = {
    fetchKlines,
    fetchFundingRate,
    fetchFundingRateHistory,
    fetchFundingInfo,
    getCompleteFundingData,
    fetchCommissionRate,
    fetchExchangeInfo,
    roundToStepSize
};
