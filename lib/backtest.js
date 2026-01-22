const { fetchKlines, fetchFundingRateHistory, fetchFundingInfo } = require('./binance');
const { calculateRangeFilter } = require('./indicators');

// Note: sleep helper removed as it was unused

async function run(config) {
    // 1. Parse Config
    const symbol = config.symbol || 'BTCUSDT';
    const timeframe = config.timeframe || '15m'; // Default 15m
    const initialCapital = parseFloat(config.initialCapital) || 1000;
    const orderSize = parseFloat(config.orderSize) || 100;
    const leverage = parseFloat(config.leverage) || 1;
    const stopLossPct = parseFloat(config.stopLossPct) || 0;
    // Fix: Allow 0 fee.
    let feePct = 0.04;
    if (config.feePct !== undefined && config.feePct !== '') {
        feePct = parseFloat(config.feePct);
    }
    const direction = config.direction || 'BOTH';
    const strategy = config.strategy || 'CLOSE_ENTRY'; // CLOSE_ENTRY, OPEN_ENTRY, CUSTOM
    const slMode = config.slMode || 'FIXED'; // FIXED, BREAKEVEN, TRAILING
    // const stopAtEntry = config.stopAtEntry === true || config.stopAtEntry === 'true'; // Removed in favor of slMode
    const trailingPct = parseFloat(config.trailingPct) || 1.0;
    const trailingRate = trailingPct / 100;
    const parseLocalDateStart = (dateStr) => {
        if (!dateStr) return null;
        const parts = String(dateStr).split('-').map(Number);
        if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
        const [y, m, d] = parts;
        return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    };
    const parseLocalDateEnd = (dateStr) => {
        if (!dateStr) return null;
        const parts = String(dateStr).split('-').map(Number);
        if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
        const [y, m, d] = parts;
        return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
    };

    const startDate = config.startDate ? parseLocalDateStart(config.startDate) : null;
    const endDateRaw = config.endDate ? parseLocalDateEnd(config.endDate) : null;
    const endDate = endDateRaw !== null ? Math.min(endDateRaw, Date.now()) : null;

    // Safety buffer. 500 is the minimum for Range Filter 100 (which uses an internal 200-period EMA).
    const WARMUP_CANDLES = 500;

    // 2. Fetch Data
    let fetchStartTime = null;
    if (startDate) {
        const tfMap = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
        const msPerCandle = tfMap[timeframe] || 900000;
        fetchStartTime = startDate - (WARMUP_CANDLES * msPerCandle);
    }

    // Increase fetching limit to allow for decent pagination
    // Fetch up to 10,000 candles if needed to cover range
    const candles = await fetchKlines(symbol, timeframe, 10000, fetchStartTime, endDate);

    if (candles.length === 0) {
        throw new Error('No candle data found for the specified period');
    }

    // Fetch funding rate data from Binance (NO API KEY REQUIRED)
    let fundingHistory = [];
    let fundingIntervalHours = 8; // Default
    try {
        const [history, info] = await Promise.all([
            fetchFundingRateHistory(symbol, 1000, fetchStartTime, endDate),
            fetchFundingInfo(symbol)
        ]);
        fundingHistory = history;
        fundingIntervalHours = info.fundingIntervalHours || 8;
        console.log(`[Backtest] Loaded ${fundingHistory.length} funding events for ${symbol} (Interval: ${fundingIntervalHours}h)`);
    } catch (err) {
        console.warn(`[Backtest] Could not fetch funding data: ${err.message}. Using defaults.`);
    }

    // Helper function to count funding windows and get average rate during a period
    const countFundingWindows = (startTime, endTime) => {
        const intervalMs = fundingIntervalHours * 60 * 60 * 1000;
        const start = new Date(startTime);
        const end = new Date(endTime);

        let count = 0;
        let current = new Date(Date.UTC(
            start.getUTCFullYear(),
            start.getUTCMonth(),
            start.getUTCDate(),
            start.getUTCHours(),
            0, 0, 0
        ));

        // Find next funding boundary based on dynamic interval
        let nextHour = Math.floor(current.getUTCHours() / fundingIntervalHours) * fundingIntervalHours + fundingIntervalHours;
        current.setUTCHours(nextHour);

        while (current.getTime() <= endTime) {
            count++;
            current.setUTCHours(current.getUTCHours() + fundingIntervalHours);
        }
        return count;
    };

    // Get average funding rate for a period (uses actual historical data if available)
    const getAvgFundingRate = (startTime, endTime) => {
        const relevantFunding = fundingHistory.filter(f => f.fundingTime >= startTime && f.fundingTime <= endTime);
        if (relevantFunding.length > 0) {
            return relevantFunding.reduce((sum, f) => sum + f.rate, 0) / relevantFunding.length;
        }
        // Fallback to overall average if no data in range
        if (fundingHistory.length > 0) {
            return fundingHistory.reduce((sum, f) => sum + f.rate, 0) / fundingHistory.length;
        }
        return 0.0001; // Default 0.01% if no data
    };

    // 3. Calculate Indicators
    const indicators = calculateRangeFilter(candles, {
        period: 100,
        multiplier: 3.0
    });

    // 4. Align
    let data = candles.map((c, i) => ({
        ...c,
        ...indicators[i]
    }));

    // Filter by date range for the actual simulation
    let backtestCandles = data;
    if (startDate) {
        backtestCandles = backtestCandles.filter(d => d.time >= startDate);
    }
    if (endDate) {
        backtestCandles = backtestCandles.filter(d => d.closeTime <= endDate);
    }

    if (backtestCandles.length < 2) {
        throw new Error('Insuficientes velas para el rango seleccionado.');
    }

    // 5. Simulation Loop (Reference Logic Implementation)
    let balance = initialCapital;
    let position = null;
    const trades = [];
    const slRate = stopLossPct / 100;
    const feeRate = feePct / 100;

    // Loop until length - 1 because we assert logic on "nextCandle" (i+1)
    for (let i = 0; i < backtestCandles.length - 1; i++) {
        const candle = backtestCandles[i];       // Signal Candle (Confirmed at Close)
        const nextCandle = backtestCandles[i + 1]; // Execution Candle (Open/Low/High)

        // Signal from the confirmed candle
        const signal = candle.signalStr;

        // Entry Price logic from Reference: "currentPrice = candle.close"
        // Executed effectively at Open of nextCandle which is virtually same as Close of i.
        const currentPrice = candle.close;

        // --- 3.1 Manage EXIT ---
        // Exit by signal reversal is executed at nextCandle.open (confirmed on candle close).
        if (position) {
            const oppositeSignal = position.type === 'LONG' ? 'Sell' : 'Buy';
            if (candle.isTrigger && signal === oppositeSignal) {
                const exitPrice = nextCandle.open;

                let pnlRaw = 0;
                if (position.type === 'LONG') {
                    pnlRaw = (exitPrice - position.entryPrice) * position.size;
                } else {
                    pnlRaw = (position.entryPrice - exitPrice) * position.size;
                }

                // Calculate fees
                const entryFee = position.margin * feeRate;
                const exitFee = position.margin * feeRate;
                const totalCommission = entryFee + exitFee;

                // Calculate funding (using real Binance data)
                const windowsCrossed = countFundingWindows(position.entryTime, nextCandle.time);
                let fundingFee = 0;
                if (windowsCrossed > 0) {
                    const avgRate = getAvgFundingRate(position.entryTime, nextCandle.time);
                    const notional = position.size * exitPrice;
                    fundingFee = notional * avgRate * windowsCrossed;
                    if (position.type === 'SHORT') fundingFee = -fundingFee; // Shorts receive if rate > 0
                }

                const netPnL = pnlRaw - exitFee - fundingFee;
                balance += (position.margin + netPnL); // Return margin + pnl (entryFee already deducted)

                trades.push({
                    type: position.type,
                    entryPrice: position.entryPrice,
                    exitPrice: exitPrice,
                    entryTime: position.entryTime,
                    exitTime: nextCandle.time,
                    margin: position.margin,
                    pnl: netPnL,
                    commission: totalCommission,
                    funding: fundingFee,
                    reason: 'Signal Reversal',
                    roi: (netPnL / position.margin) * 100
                });

                position = null;
            }
        }

        // --- 3.2 Manage ENTRY ---
        // Enter if no position (or just closed)
        if (!position) {
            // console.log(`[${i}] Checking Entry. Strat: ${strategy}, Signal: ${candle.signalStr}, Trigger: ${candle.isTrigger}`);
            const canLong = (direction === 'BOTH' || direction === 'LONG');
            const canShort = (direction === 'BOTH' || direction === 'SHORT');
            const tradeAmount = Math.min(orderSize, balance);

            // Determine entry price based on strategy
            // CLOSE_ENTRY: Entry at candle.close (signal candle), stops active on nextCandle
            // OPEN_ENTRY: Entry at nextCandle.open, stops active on i+2
            let entryPrice;
            let entryTime;
            let stopActiveFromIndex;

            if (strategy === 'CLOSE_ENTRY' || strategy === 'SPIRIT' || strategy === 'SPIRIT_IMPROVED' || strategy === 'SPIRIT_TRAILING' || strategy === 'SPIRIT_EXPERIMENTAL') {
                entryPrice = candle.close;
                entryTime = candle.time;
                stopActiveFromIndex = i + 1; // Stops active starting from nextCandle
            } else {
                // OPEN_ENTRY (default)
                entryPrice = nextCandle.open;
                entryTime = nextCandle.time;
                stopActiveFromIndex = i + 2; // Stops active starting from candle after entry
            }

            if (candle.isTrigger && candle.signalStr === 'Buy' && canLong) {
                const entryFee = tradeAmount * feeRate;
                if (balance >= (tradeAmount + entryFee)) {
                    balance -= (tradeAmount + entryFee);
                    const notional = tradeAmount * leverage;
                    const size = notional / entryPrice;

                    position = {
                        type: 'LONG',
                        entryPrice: entryPrice,
                        margin: tradeAmount,
                        entryTime: entryTime,
                        size: size,
                        stopActiveFromIndex: stopActiveFromIndex
                    };
                }
            } else if (candle.isTrigger && candle.signalStr === 'Sell' && canShort) {
                const entryFee = tradeAmount * feeRate;
                if (balance >= (tradeAmount + entryFee)) {
                    balance -= (tradeAmount + entryFee);
                    const notional = tradeAmount * leverage;
                    const size = notional / entryPrice;

                    position = {
                        type: 'SHORT',
                        entryPrice: entryPrice,
                        margin: tradeAmount,
                        entryTime: entryTime,
                        size: size,
                        stopActiveFromIndex: stopActiveFromIndex
                    };
                }
            }
        }

        // Stop Loss active starting from the candle after the entry candle.
        // It is evaluated using the range (high/low) of the currently executing candle.
        if (position && position.stopActiveFromIndex !== undefined && position.stopActiveFromIndex <= (i + 1)) {
            let closeReason = null;
            let exitPrice = 0;

            // Track extremes for Trailing Stop
            if (position.type === 'LONG') {
                position.highestPrice = Math.max(position.highestPrice || position.entryPrice, candle.high);
            } else {
                position.lowestPrice = Math.min(position.lowestPrice || position.entryPrice, candle.low);
            }

            // SPIRIT_EXPERIMENTAL: Set SL at the close of the candle AFTER entry
            if (strategy === 'SPIRIT_EXPERIMENTAL' && !position.experimentalSLSet) {
                if (candle.time > position.entryTime) {
                    position.experimentalSL = candle.close;
                    position.experimentalSLSet = true;
                    // console.log(`[SPIRIT_EXPERIMENTAL] SL set at ${position.experimentalSL} for ${position.type}`);
                }
            }

            // Determine SL Price based on Mode
            let effectiveSL = 0;
            if (slMode === 'NONE') {
                // No stop loss - effectiveSL stays 0, no collision will occur
                effectiveSL = 0;
            } else if (slMode === 'FIXED') {
                effectiveSL = position.type === 'LONG' ?
                    position.entryPrice * (1 - slRate) :
                    position.entryPrice * (1 + slRate);
            } else if (slMode === 'BREAKEVEN') {
                // Breakeven puts SL at Entry Price
                effectiveSL = position.entryPrice;
            } else if (slMode === 'TRAILING') {
                if (position.type === 'LONG') {
                    // SL is distance from highest high
                    effectiveSL = position.highestPrice * (1 - trailingRate);
                } else {
                    // SL is distance from lowest low
                    effectiveSL = position.lowestPrice * (1 + trailingRate);
                }
            }

            // Check Collision
            if (position.type === 'LONG') {
                if (slMode === 'FIXED' && slRate > 0 && nextCandle.low <= effectiveSL) {
                    closeReason = 'Stop Loss';
                    exitPrice = effectiveSL;
                } else if (slMode === 'BREAKEVEN' && nextCandle.low <= effectiveSL) {
                    closeReason = 'Stop Loss (Breakeven)';
                    exitPrice = effectiveSL;
                } else if (slMode === 'TRAILING' && nextCandle.low <= effectiveSL) {
                    closeReason = 'Trailing Stop';
                    exitPrice = effectiveSL;
                } else if (strategy === 'SPIRIT_EXPERIMENTAL' && position.experimentalSLSet && nextCandle.low <= position.experimentalSL) {
                    closeReason = 'Stop Loss (Experimental)';
                    exitPrice = position.experimentalSL;
                }
            } else if (position.type === 'SHORT') {
                if (slMode === 'FIXED' && slRate > 0 && nextCandle.high >= effectiveSL) {
                    closeReason = 'Stop Loss';
                    exitPrice = effectiveSL;
                } else if (slMode === 'BREAKEVEN' && nextCandle.high >= effectiveSL) {
                    closeReason = 'Stop Loss (Breakeven)';
                    exitPrice = effectiveSL;
                } else if (slMode === 'TRAILING' && nextCandle.high >= effectiveSL) {
                    closeReason = 'Trailing Stop';
                    exitPrice = effectiveSL;
                } else if (strategy === 'SPIRIT_EXPERIMENTAL' && position.experimentalSLSet && nextCandle.high >= position.experimentalSL) {
                    closeReason = 'Stop Loss (Experimental)';
                    exitPrice = position.experimentalSL;
                }
            }

            if (closeReason) {
                let pnlRaw = 0;
                if (position.type === 'LONG') {
                    pnlRaw = (exitPrice - position.entryPrice) * position.size;
                } else {
                    pnlRaw = (position.entryPrice - exitPrice) * position.size;
                }

                // Calculate fees
                const entryFee = position.margin * feeRate;
                const exitFee = position.margin * feeRate;
                const totalCommission = entryFee + exitFee;

                // Calculate funding (using real Binance data)
                const windowsCrossed = countFundingWindows(position.entryTime, nextCandle.time);
                let fundingFee = 0;
                if (windowsCrossed > 0) {
                    const avgRate = getAvgFundingRate(position.entryTime, nextCandle.time);
                    const notional = position.size * exitPrice;
                    fundingFee = notional * avgRate * windowsCrossed;
                    if (position.type === 'SHORT') fundingFee = -fundingFee;
                }

                const netPnL = pnlRaw - exitFee - fundingFee;
                balance += (position.margin + netPnL);

                trades.push({
                    type: position.type,
                    entryPrice: position.entryPrice,
                    exitPrice: exitPrice,
                    entryTime: position.entryTime,
                    exitTime: nextCandle.time,
                    margin: position.margin,
                    pnl: netPnL,
                    commission: totalCommission,
                    funding: fundingFee,
                    reason: closeReason,
                    roi: (netPnL / position.margin) * 100
                });
                // console.log(`[Trade Closed] ${closeReason} at ${exitPrice}. PnL: ${netPnL}`);

                const lastType = position.type;
                position = null;

                // SPIRIT Strategy: Re-entry Logic
                const isStopLoss = closeReason && closeReason.startsWith('Stop Loss');
                const isTrailing = closeReason && closeReason.startsWith('Trailing Stop');
                const canReEnter = isStopLoss || (isTrailing && strategy === 'SPIRIT_TRAILING');

                if (canReEnter) {
                    const neededSignal = (lastType === 'LONG') ? 'Buy' : 'Sell';

                    // All SPIRIT variants (Standard, Trailing, Experimental, Improved)
                    // Rule: Re-enter at the START of the candle AFTER the stop, using the STOP PRICE.
                    if (i + 2 < backtestCandles.length) {
                        const checkCandle = backtestCandles[i + 1]; // Candle where signal must still exist
                        if (checkCandle.signalStr === neededSignal) {
                            const entryCandle = backtestCandles[i + 2]; // Candle where entry happens
                            const tradeAmount = Math.min(orderSize, balance);
                            const entryFee = tradeAmount * feeRate;

                            if (balance >= (tradeAmount + entryFee)) {
                                balance -= (tradeAmount + entryFee);
                                const notional = tradeAmount * leverage;
                                const size = notional / exitPrice;

                                position = {
                                    type: lastType,
                                    entryPrice: exitPrice, // Re-enter at Exit Price
                                    margin: tradeAmount,
                                    entryTime: entryCandle.time,
                                    size: size,
                                    stopActiveFromIndex: i + 3 // Stop active from the candle AFTER entry
                                };
                            }
                        }
                    }
                }
            }
        }
    }

    // Force close at end
    if (position) {
        const lastCandle = backtestCandles[backtestCandles.length - 1];
        const exitPrice = lastCandle.close;
        const pnlRaw = position.type === 'LONG' ?
            (exitPrice - position.entryPrice) * position.size :
            (position.entryPrice - exitPrice) * position.size;

        // Calculate fees
        const entryFee = position.margin * feeRate;
        const exitFee = position.margin * feeRate;
        const totalCommission = entryFee + exitFee;

        // Calculate funding
        const windowsCrossed = countFundingWindows(position.entryTime, lastCandle.time);
        let fundingFee = 0;
        if (windowsCrossed > 0) {
            const avgRate = getAvgFundingRate(position.entryTime, lastCandle.time);
            const notional = position.size * exitPrice;
            fundingFee = notional * avgRate * windowsCrossed;
            if (position.type === 'SHORT') fundingFee = -fundingFee;
        }

        const netPnL = pnlRaw - exitFee - fundingFee;
        balance += (position.margin + netPnL);

        trades.push({
            type: position.type,
            entryPrice: position.entryPrice,
            exitPrice: exitPrice,
            entryTime: position.entryTime,
            exitTime: lastCandle.time,
            margin: position.margin,
            pnl: netPnL,
            commission: totalCommission,
            funding: fundingFee,
            reason: 'Force Close (End)',
            roi: (netPnL / position.margin) * 100
        });
    }

    const totalTrades = trades.length;
    const wins = trades.filter(t => t.pnl > 0).length;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const finalBalance = balance;
    const roiTotal = ((finalBalance - initialCapital) / initialCapital) * 100;

    return {
        stats: {
            initialCapital,
            finalBalance,
            roi: roiTotal,
            totalTrades,
            winRate
        },
        trades: trades,
        candles: backtestCandles.map(c => ({
            time: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            signal: c.signalStr // Optional: pass signal for potential viz later
        }))
    };
}

module.exports = { run };
