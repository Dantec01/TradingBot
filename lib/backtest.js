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


    // Fee logic: Use config.takerFee if available, default to 0.06%
    let feePct = 0.06;
    if (config.takerFee !== undefined && config.takerFee !== '') {
        feePct = parseFloat(config.takerFee);
    } else if (config.feePct !== undefined && config.feePct !== '') {
        // Fallback for older configs
        feePct = parseFloat(config.feePct);
    }
    const direction = config.direction || 'BOTH';
    const strategy = config.strategy || 'CLOSE_ENTRY'; // CLOSE_ENTRY, OPEN_ENTRY, CUSTOM
    const slMode = config.slMode || 'FIXED'; // FIXED, BREAKEVEN, TRAILING
    // const stopAtEntry = config.stopAtEntry === true || config.stopAtEntry === 'true'; // Removed in favor of slMode
    const trailingPct = (config.trailingPct !== undefined && config.trailingPct !== '') ? parseFloat(config.trailingPct) : 1.0;
    const eliteTrailingDefer = parseFloat(config.eliteTrailingDefer) || 5;
    // eliteTickOffset: Fixed POINTS offset for Breakeven+Tick SL (e.g., 0.001 = 0.001 price units)
    // IMPORTANT: This is in POINTS (same as Paper/Real bots)
    const eliteTickOffset = parseFloat(config.eliteTickOffset) || 0.0001;
    const trailingRate = trailingPct / 100;
    // Client sends timezoneOffset in minutes (e.g. 240 for UTC-4 Bolivia, 180 for UTC-3 Brazil)
    // This lets us interpret dates as "local midnight" in the USER's timezone, not the server's
    const clientOffsetMs = (config.timezoneOffset || 0) * 60 * 1000;

    const parseLocalDateStart = (dateStr) => {
        if (!dateStr) return null;
        const parts = String(dateStr).split('-').map(Number);
        if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
        const [y, m, d] = parts;
        return Date.UTC(y, m - 1, d, 0, 0, 0, 0) + clientOffsetMs;
    };
    const parseLocalDateEnd = (dateStr) => {
        if (!dateStr) return null;
        const parts = String(dateStr).split('-').map(Number);
        if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
        const [y, m, d] = parts;
        return Date.UTC(y, m - 1, d, 23, 59, 59, 999) + clientOffsetMs;
    };

    const startDate = config.startDate ? parseLocalDateStart(config.startDate) : null;
    const endDateRaw = config.endDate ? parseLocalDateEnd(config.endDate) : null;
    const endDate = endDateRaw !== null ? Math.min(endDateRaw, Date.now()) : null;

    // Safety buffer. 500 is the minimum for Range Filter 100 (which uses an internal 200-period EMA).
    const WARMUP_CANDLES = 500;

    console.log(`[Backtest] Starting Run. Symbol: ${symbol}, Fee: ${feePct}%, Leverage: ${leverage}x`);

    // 2. Fetch Data
    let fetchStartTime = null;
    if (startDate) {
        const tfMap = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
        const msPerCandle = tfMap[timeframe] || 900000;
        fetchStartTime = startDate - (WARMUP_CANDLES * msPerCandle);
    }

    // Increase fetching limit to allow for decent pagination
    // Fetch up to 10,000 candles if needed to cover range
    // Increase fetching limit to allow for decent pagination
    // Fetch up to 10,000 candles if needed to cover range
    const candles = await fetchKlines(symbol, timeframe, 10000, fetchStartTime, endDate);

    // VANGUARD: Fetch Auxiliary 1m Data
    let klines1m = [];
    let indicators1m = [];
    if (strategy === 'VANGUARD') {
        const candlesLimit = Math.min(10000 * 5, 200000); // 1m candles are 5x more frequent
        console.log(`[Backtest] Fetching 1m auxiliary data for VANGUARD strategy...`);
        klines1m = await fetchKlines(symbol, '1m', candlesLimit, fetchStartTime, endDate);

        // Calculate 1m Indicators
        const inds1mRaw = calculateRangeFilter(klines1m, { period: 100, multiplier: 3.0 });

        // Map to efficient lookup structure (Map by time)
        indicators1m = new Map();
        klines1m.forEach((k, idx) => {
            indicators1m.set(k.time, { ...k, ...inds1mRaw[idx] });
        });
        console.log(`[Backtest] Loaded ${klines1m.length} 1m candles for VANGUARD logic.`);
    }

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

    let pendingLimit = null; // { type, price, quantity, time, initialSL }

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

        // VANGUARD: Inner Loop Logic (1m Checks)
        // We simulate the time passing from candle.time (close) to nextCandle.time (close).
        // Actually the loop moves from 'i' to 'i+1'.
        // 'i' is the just closed candle. 'i+1' is the NEXT candle.
        // We need to check 1m candles that happen DURING 'i+1'.
        // Start Time: nextCandle.time (The 5m open time).
        // End Time: nextCandle.closeTime.
        // Wait, fetchKlines returns 'time' as Open Time.
        // So nextCandle.time IS the Open Time of the next candle.
        // We look for 1m candles with time >= nextCandle.time AND time < nextCandle.time + 5m.

        let vanguardExit = null;
        if (strategy === 'VANGUARD' && position && indicators1m.size > 0) {
            const fiveMinMs = 5 * 60 * 1000;
            const startTime = nextCandle.time;
            const endTime = startTime + fiveMinMs;

            // Iterate minutes 0, 1, 2, 3, 4
            for (let m = 0; m < 5; m++) {
                const checkTime = startTime + (m * 60 * 1000);
                const c1m = indicators1m.get(checkTime);
                const prevC1m = indicators1m.get(checkTime - 60000);

                if (c1m) {
                    // Check VANGUARD Exit Conditions
                    const positionType = position.type;
                    const prev5mCandle = candles[i - 1]; // Previous 5m candle defines the Reference Level

                    // Cond 1: Immediate 5m Reversal (Priority Absolute)
                    // Check if 1m Low/High breaches the Previous 5m RangeFilter level
                    if (prev5mCandle) {
                        const refLevel = prev5mCandle.rngfilt;
                        let reversalHit = false;

                        if (positionType === 'LONG') {
                            if (c1m.low < refLevel) reversalHit = true;
                        } else {
                            if (c1m.high > refLevel) reversalHit = true;
                        }

                        if (reversalHit) {
                            vanguardExit = { price: refLevel, reason: 'Vanguard 5m Reversal (Immediate)', time: c1m.closeTime };
                            break; // Stop checking other 1m candles
                        }
                    }

                    // Cond 2: Dual 1M Reversal (Count Signal Flips)
                    // Logic: Count occurrences of Opposite Signal since Entry.
                    // Exit on the 2nd occurrence.
                    const neededReversal = positionType === 'LONG' ? -1 : 1; // -1 for Sell, 1 for Buy

                    // Detect FLIP to neededReversal from a different state
                    // If prevC1m was NOT in needed state, and current IS, that's a new occurrence.
                    if (prevC1m) {
                        const isFlipToOpposite = (c1m.state === neededReversal && prevC1m.state !== neededReversal);

                        // NOTE: If we enter and the immediate next 1m candle is already opposite?
                        // We should count it if it's a flip or if it's the first check? 
                        // For robustness in backtest loop (simulating minutes):
                        // If it's the VERY first minute of the trade, and it's opposite, maybe count it?
                        // But let's stick to "Flips" as that's safer for "Signals".

                        if (isFlipToOpposite) {
                            if (!position.vanguardOppositeCount) position.vanguardOppositeCount = 0;
                            position.vanguardOppositeCount++;
                        }
                    }

                    if (position.vanguardOppositeCount >= 2) {
                        vanguardExit = { price: c1m.close, reason: 'Vanguard Dual-1m Reversal', time: c1m.closeTime };
                        break;
                    }

                    // Cond 3: Wick Exit
                    const isOpposite = (neededReversal === 'Sell' && c1m.state === -1) ||
                        (neededReversal === 'Buy' && c1m.state === 1);
                    if (isOpposite) {
                        const rfValue = c1m.rngfilt;
                        let wickBreach = false;
                        if (positionType === 'LONG' && c1m.high > rfValue) wickBreach = true;
                        if (positionType === 'SHORT' && c1m.low < rfValue) wickBreach = true;

                        if (wickBreach) {
                            vanguardExit = { price: c1m.close, reason: 'Vanguard Wick Exit', time: c1m.closeTime };
                            break;
                        }
                    }
                }
            }
        }

        if (position) {
            let closeReason = null;
            let exitPrice = 0;

            // Priority 1: 5m Reversal (Standard)
            const oppositeSignal = position.type === 'LONG' ? 'Sell' : 'Buy';
            if (candle.isTrigger && signal === oppositeSignal) {
                closeReason = 'Signal Reversal';
                exitPrice = nextCandle.open;
            }
            // Priority 2/3: VANGUARD Exits (Intra-candle)
            else if (vanguardExit) {
                closeReason = vanguardExit.reason;
                exitPrice = vanguardExit.price;
                // Note: This exit happens intra-candle, so it pre-empts SL/TP checks usually.
            }

            // ... (Rest of logic continues, checking SL/TP if no exit yet)

            if (closeReason) {
                // ... (Execution logic) ...
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

                // --- IMMEDIATE RE-ENTRY ON REVERSAL ---
                // If closed due to Signal Reversal, we should immediately check for Entry in the SAME direction as the signal (Opposite of old pos)
                if (closeReason === 'Signal Reversal') {
                    // Logic continues to 3.2 Manage ENTRY which checks (!position)
                    // But we must ensure the loop doesn't skip it or pendingLimit interferes.
                    // The main loop continues sequentially, so 3.2 WILL be hit.
                    // However, we need to ensure pendingLimit is null.
                    pendingLimit = null;
                    // Proceed naturally to 3.2
                } else if (strategy === 'SPIRIT_ELITE') {
                    // For Spirit Elite Stop Loss exits, DO NOT re-enter immediately in this loop.
                    // The Bot waits for the NEXT signal processing cycle.
                    // In backtest, we force a "wait" by ensuring we don't fall through to ENTRY logic 
                    // in this same iteration for a different signal unless it's a specific Reversal.
                    // Since ENTRY logic (3.2) is below, and we just closed (position=null), 
                    // it WOULD try to enter if signal is still active and valid.
                    // We need to flag "skip entry this turn" or similar.
                    // Simplest way: do nothing special here, BUT in 3.2 Add a check:
                    // "If we just closed a position in this candle 'i', don't enter unless it's a Signal Reversal"
                }
            }
        }

        // --- 3.1.5 Manage PENDING LIMIT (BACKGUARD) ---
        if (!position && pendingLimit) {
            const { type, price, initialSL, margin } = pendingLimit;
            let filled = false;

            // Check if nextCandle range touches the limit price
            if (type === 'LONG') {
                if (nextCandle.low <= price) filled = true;
            } else {
                if (nextCandle.high >= price) filled = true;
            }

            if (filled) {
                // Determine Entry Price (Limit Price)
                // Note: In real life, might get better price if gap, but Limit is usually strict on price or better.
                // If gap down passed limit (for long), we fill at Open? No, Limit is "Buy at 100 or better".
                // If Open is 90, we fill at 90.
                // Simplified: Fill at Limit Price or Open if better.
                let fillPrice = price;
                if (type === 'LONG' && nextCandle.open < price) fillPrice = nextCandle.open;
                if (type === 'SHORT' && nextCandle.open > price) fillPrice = nextCandle.open;

                const size = (margin * leverage) / fillPrice;
                const entryFee = margin * feeRate;

                if (balance >= (margin + entryFee)) {
                    balance -= (margin + entryFee);
                    position = {
                        type,
                        entryPrice: fillPrice,
                        margin,
                        entryTime: nextCandle.time,
                        size,
                        stopActiveFromIndex: i + 1, // Active immediately in this candle (technically) or next? Safer next.
                        initialSL: initialSL,
                        candlesSinceEntry: 0,
                        highestPrice: fillPrice,
                        lowestPrice: fillPrice,
                        isElite: false,
                        isTest: false
                    };
                    // console.log(`[BACKGUARD] Limit Filled at ${fillPrice}`);
                    pendingLimit = null;
                }
            } else {
                // Check Cancellation (Opposite Signal)
                const oppositeSignal = type === 'LONG' ? 'Sell' : 'Buy';
                if (candle.isTrigger && signal === oppositeSignal) {
                    // console.log(`[BACKGUARD] Limit Cancelled due to reversal`);
                    pendingLimit = null;
                }
            }
        }

        // --- 3.2 Manage ENTRY ---
        // Enter if no position (or just closed)
        if (!position && !pendingLimit) {
            // console.log(`[${i}] Checking Entry. Strat: ${strategy}, Signal: ${candle.signalStr}, Trigger: ${candle.isTrigger}`);
            const canLong = (direction === 'BOTH' || direction === 'LONG');
            const canShort = (direction === 'BOTH' || direction === 'SHORT');
            const tradeAmount = Math.min(orderSize, balance);

            // Only process if we have a trigger signal
            if (candle.isTrigger && ((candle.signalStr === 'Buy' && canLong) || (candle.signalStr === 'Sell' && canShort))) {

                if (strategy === 'BACKGUARD') {
                    // BACKGUARD: Place Limit Order logic
                    // Limit Price = Candle Close
                    // Initial SL = Min/Max of last 10 candles (from i-9 to i)
                    const lookback = 10;
                    const startIdx = Math.max(0, i - lookback + 1);
                    const relevantCandles = backtestCandles.slice(startIdx, i + 1); // Up to current signal candle

                    let initialSL = 0;

                    if (strategy === 'BACKGUARD') {
                        // BACKGUARD: Calculate SL based on 10 candle Min/Max
                        if (candle.signalStr === 'Buy') {
                            initialSL = Math.min(...relevantCandles.map(c => c.low));
                        } else {
                            initialSL = Math.max(...relevantCandles.map(c => c.high));
                        }
                    }
                    // VANGUARD: initialSL remains 0 (No fixed SL by default)

                    pendingLimit = {
                        type: (candle.signalStr === 'Buy' ? 'LONG' : 'SHORT'),
                        price: candle.close,
                        entryTime: candle.time, // Signal time
                        margin: tradeAmount,
                        initialSL: initialSL
                    };
                } else if (strategy === 'SPIRIT_ELITE') {
                    // SPIRIT_ELITE: Entrada Limit Agresiva (Simulada como Market al Cierre)
                    // Según docs/estrategia_limit.md: Se pone limit +/- 0.5% para asegurar entrada.
                    // En backtest esto equivale a entrar SIEMPRE al precio de cierre actual.

                    const tradeAmount = Math.min(orderSize, balance);
                    // Fee based on Notional
                    const notionalEntry = tradeAmount * leverage;
                    const entryFee = notionalEntry * feeRate;

                    if (balance >= (tradeAmount + entryFee)) {
                        balance -= (tradeAmount + entryFee);
                        const entryPrice = reversalEntry ? nextCandle.open : candle.close;
                        const size = notionalEntry / entryPrice;

                        position = {
                            type: (candle.signalStr === 'Buy' ? 'LONG' : 'SHORT'),
                            entryPrice: entryPrice,
                            margin: tradeAmount,
                            entryTime: reversalEntry ? nextCandle.time : candle.time,
                            size: size,
                            stopActiveFromIndex: reversalEntry ? i + 2 : i + 1,
                            isElite: true, // Flag for special Elite SL logic
                            candlesSinceEntry: 0,
                            highestPrice: entryPrice,
                            lowestPrice: entryPrice
                        };
                    }
                } else {
                    // Standard Entry Logic (CLOSE_ENTRY, OPEN_ENTRY, SPIRIT variants)

                    let entryPrice;
                    let entryTime;
                    let stopActiveFromIndex;

                    if (strategy === 'CLOSE_ENTRY' || strategy === 'SPIRIT' || strategy === 'SPIRIT_IMPROVED' || strategy === 'SPIRIT_TRAILING' || strategy === 'SPIRIT_TEST' || strategy === 'SPIRIT_EXPERIMENTAL' || strategy === 'SPIRIT_EXPERIMENTAL_FIXED') {
                        entryPrice = candle.close;
                        entryTime = candle.time;
                        stopActiveFromIndex = i + 1;
                    } else {
                        // OPEN_ENTRY
                        entryPrice = nextCandle.open;
                        entryTime = nextCandle.time;
                        stopActiveFromIndex = i + 2;
                    }

                    // Fee is based on Notional Value (Margin * Leverage)
                    const notionalEntry = tradeAmount * leverage;
                    const entryFee = notionalEntry * feeRate;

                    if (balance >= (tradeAmount + entryFee)) {
                        balance -= (tradeAmount + entryFee);
                        const size = notionalEntry / entryPrice;

                        // SPIRIT_ELITE Re-entry Check:
                        // If we just closed a trade in this SAME candle (i), meaning we are re-entering instantly...
                        // If it was a Stop Loss, we should WAIT for a future signal, not re-use the current one.
                        // We can track lastExitTime or similar.
                        // NOTE: 'trades' array has the last trade.
                        const lastTrade = trades.length > 0 ? trades[trades.length - 1] : null;
                        let skipEntry = false;
                        if (strategy === 'SPIRIT_ELITE' && lastTrade && lastTrade.exitTime === nextCandle.time) {
                            // Match exit reason
                            if (lastTrade.reason.includes('Stop Loss') || lastTrade.reason.includes('Trailing')) {
                                // It was an SL exit in this very timeframe.
                                // Logic dictates we wait for a FRESH signal (next candle or later).
                                skipEntry = true;
                            }
                        }

                        if (!skipEntry) {
                            position = {
                                type: (candle.signalStr === 'Buy' ? 'LONG' : 'SHORT'),
                                entryPrice: entryPrice,
                                margin: tradeAmount,
                                entryTime: entryTime,
                                size: size,
                                stopActiveFromIndex: stopActiveFromIndex
                            };
                        }
                    }
                }
            }
        }

        // Stop Loss active starting from the candle after the entry candle.
        // It is evaluated using the range (high/low) of the currently executing candle.
        if (position && position.stopActiveFromIndex !== undefined && position.stopActiveFromIndex <= (i + 1)) {
            let closeReason = null;
            let exitPrice = 0;

            // Track extremes for Trailing Stop
            // SPIRIT_TEST: Skip entry candle — position opened at candle.close,
            // so intra-candle low/high before close are irrelevant (position didn't exist yet).
            if (strategy === 'SPIRIT_TEST' && candle.time <= position.entryTime) {
                // Keep extremes at entryPrice (set in position creation)
            } else if (position.type === 'LONG') {
                position.highestPrice = Math.max(position.highestPrice || position.entryPrice, candle.high);
            } else {
                position.lowestPrice = Math.min(position.lowestPrice || position.entryPrice, candle.low);
            }

            // For BACKGUARD & SPIRIT_ELITE: Update candlesSinceEntry
            if (strategy === 'BACKGUARD' || strategy === 'SPIRIT_ELITE') {
                // Check if we are past entry time
                if (nextCandle.time > position.entryTime) {
                    position.candlesSinceEntry = (position.candlesSinceEntry || 0) + 1;
                }
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

            if (strategy === 'BACKGUARD') {
                // BACKGUARD Logic
                let currentSL = position.initialSL || 0;

                // VANGUARD: Bypass Trailing Logic entirely
                if (strategy === 'VANGUARD') {
                    currentSL = 0;
                } else if (position.candlesSinceEntry >= 3) {
                    // BACKGUARD Trailing after 3 candles
                    const trailingDist = 0.01; // 1%
                    if (position.type === 'LONG') {
                        const trailingVal = position.highestPrice * (1 - trailingDist);
                        if (trailingVal > currentSL) currentSL = trailingVal;
                    } else {
                        const trailingVal = position.lowestPrice * (1 + trailingDist);
                        if (trailingVal < currentSL || currentSL === 0) currentSL = trailingVal;
                    }
                }
                effectiveSL = currentSL;

            } else if (strategy === 'VANGUARD') {
                // VANGUARD: No Standard/Fixed/Trailing SL
                effectiveSL = 0;
            } else if (strategy === 'SPIRIT_SHIELD') {
                // SPIRIT_SHIELD: Internal Smart Breakeven
                // 1. Initial SL = 1%
                const shieldSLPct = 0.01;
                let calculatedSL = position.type === 'LONG' ?
                    position.entryPrice * (1 - shieldSLPct) :
                    position.entryPrice * (1 + shieldSLPct);

                // 2. Activation Trigger: 0.2% Profit
                const triggerPct = 0.002;

                if (position.type === 'LONG') {
                    // Check if high reached trigger
                    const profitHigh = (position.highestPrice - position.entryPrice) / position.entryPrice;
                    if (profitHigh >= triggerPct) {
                        calculatedSL = position.entryPrice; // Breakeven
                    }
                } else {
                    // Check if low reached trigger
                    const profitLow = (position.entryPrice - position.lowestPrice) / position.entryPrice;
                    if (profitLow >= triggerPct) {
                        calculatedSL = position.entryPrice; // Breakeven
                    }
                }
                effectiveSL = calculatedSL;


            } else if (strategy === 'SPIRIT_ELITE') {
                // SPIRIT_ELITE v3: Experimental SL + Delayed Breakeven (+1 tick)
                // 1. Experimental SL (Dynamic) - Copied from Experimental
                if (!position.experimentalSLSet && nextCandle.time > position.entryTime) {
                    position.experimentalSL = nextCandle.close; // Set after first candle closes
                    position.experimentalSLSet = true;
                }

                // 2. Elite Breakeven (Entry +/- fixed points offset) - Activates next candle
                // eliteTickOffset is in POINTS (e.g., 0.001 = 0.001 price units)
                let eliteBESL = 0;

                // Activate immediately after entry candle (next candle start) == candlesSinceEntry >= 1
                if (position.candlesSinceEntry >= 1) {
                    const offsetVal = eliteTickOffset;
                    if (position.type === 'LONG') {
                        eliteBESL = position.entryPrice + offsetVal; // Lock profit
                    } else {
                        eliteBESL = position.entryPrice - offsetVal; // Lock profit
                    }
                }

                // 3. Determine Effective SL (The one closest to price / most protective)
                let finalSL = 0;
                let usedSLType = 'None';

                if (position.type === 'LONG') {
                    // LONG: Max (Highest) SL is most protective
                    const expSL = position.experimentalSLSet ? position.experimentalSL : 0;

                    if (eliteBESL > expSL) {
                        finalSL = eliteBESL;
                        usedSLType = 'Breakeven+Tick';
                    } else {
                        finalSL = expSL;
                        usedSLType = 'Experimental';
                    }
                } else {
                    // SHORT: Min (Lowest) SL is most protective
                    const expSL = position.experimentalSLSet ? position.experimentalSL : Infinity;
                    const checkBE = eliteBESL !== 0 ? eliteBESL : Infinity;

                    if (checkBE < expSL) {
                        finalSL = checkBE;
                        usedSLType = 'Breakeven+Tick';
                    } else {
                        finalSL = expSL;
                        usedSLType = 'Experimental';
                    }
                    if (finalSL === Infinity) finalSL = 0;
                }

                effectiveSL = finalSL;
                position.eliteSLType = usedSLType;

                // 4. Delayed Trailing Stop (after X candles)
                if (position.candlesSinceEntry >= eliteTrailingDefer) {
                    const trailPct = parseFloat(config.trailingPct) || 1.0;
                    const trailDist = trailPct / 100;

                    if (position.type === 'LONG') {
                        const trailLevel = position.highestPrice * (1 - trailDist);
                        if (trailLevel > effectiveSL) {
                            effectiveSL = trailLevel;
                            position.eliteSLType = 'Delayed Trailing';
                        }
                    } else {
                        const trailLevel = position.lowestPrice * (1 + trailDist);
                        if (trailLevel < effectiveSL || effectiveSL === 0) {
                            effectiveSL = trailLevel;
                            position.eliteSLType = 'Delayed Trailing';
                        }
                    }
                }

            } else if (slMode === 'NONE') {
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
                if (strategy === 'SPIRIT_TEST') {
                    // SPIRIT_TEST: Real-time trailing (tick-by-tick simulation)
                    // Update extremes with BOTH current candle AND next candle for intra-bar simulation
                    // The extreme is already updated with candle[i] above.
                    // Now simulate tick-by-tick: if trend continues in nextCandle, the trailing
                    // moves further before checking for a hit.
                    // For LONG: price goes up first (to high), then could drop to low
                    // For SHORT: price goes down first (to low), then could rise to high
                    if (position.type === 'LONG') {
                        // Simulate: price reaches nextCandle.high first, moving trailing up
                        const simHigh = Math.max(position.highestPrice, nextCandle.high);
                        effectiveSL = simHigh * (1 - trailingRate);
                        // Update position extreme for next iteration
                        position.highestPrice = simHigh;
                    } else {
                        // Simulate: price reaches nextCandle.low first, moving trailing down
                        const simLow = Math.min(position.lowestPrice, nextCandle.low);
                        effectiveSL = simLow * (1 + trailingRate);
                        // Update position extreme for next iteration
                        position.lowestPrice = simLow;
                    }
                } else {
                    if (position.type === 'LONG') {
                        // SL is distance from highest high
                        effectiveSL = position.highestPrice * (1 - trailingRate);
                    } else {
                        // SL is distance from lowest low
                        effectiveSL = position.lowestPrice * (1 + trailingRate);
                    }
                }
            }

            // --- VISUALIZATION: Save SL to nextCandle for Chart ---
            nextCandle.stopLoss = effectiveSL;

            // Check Collision
            if (position.type === 'LONG') {
                if (effectiveSL > 0) { // Safety check
                    if (slMode === 'FIXED' && slRate > 0 && nextCandle.low <= effectiveSL) {
                        closeReason = 'Stop Loss';
                        exitPrice = effectiveSL;
                    } else if (slMode === 'BREAKEVEN' && nextCandle.low <= effectiveSL) {
                        closeReason = 'Stop Loss (Breakeven)';
                        exitPrice = effectiveSL;
                    } else if (slMode === 'TRAILING' && nextCandle.low <= effectiveSL) {
                        closeReason = 'Trailing Stop';
                        exitPrice = effectiveSL;
                    }
                }
                if (strategy === 'SPIRIT_EXPERIMENTAL' && position.experimentalSLSet && nextCandle.low <= position.experimentalSL) {
                    closeReason = 'Stop Loss (Experimental)';
                    exitPrice = position.experimentalSL;
                }
                if (strategy === 'SPIRIT_SHIELD' && effectiveSL > 0 && nextCandle.low <= effectiveSL) {
                    closeReason = 'Stop Loss (Shield)';
                    exitPrice = effectiveSL;
                }
                if (strategy === 'SPIRIT_ELITE' && effectiveSL > 0 && nextCandle.low <= effectiveSL) {
                    // Hybrid check: SL only triggers if the candle actually reached the SL level
                    // - SL below entry (loss protection): low <= SL triggers (+ handles gap down)
                    // - SL above entry (profit lock): only if high >= SL (candle crossed through SL)
                    if (nextCandle.high >= effectiveSL || effectiveSL <= position.entryPrice) {
                        closeReason = `Stop Loss (Elite: ${position.eliteSLType})`;
                        exitPrice = effectiveSL;
                    }
                }
            } else if (position.type === 'SHORT') {
                if (effectiveSL > 0) { // Safety check (prevents 0 from triggering Shorts)
                    if (slMode === 'FIXED' && slRate > 0 && nextCandle.high >= effectiveSL) {
                        closeReason = 'Stop Loss';
                        exitPrice = effectiveSL;
                    } else if (slMode === 'BREAKEVEN' && nextCandle.high >= effectiveSL) {
                        closeReason = 'Stop Loss (Breakeven)';
                        exitPrice = effectiveSL;
                    } else if (slMode === 'TRAILING' && nextCandle.high >= effectiveSL) {
                        closeReason = 'Trailing Stop';
                        exitPrice = effectiveSL;
                    }
                }
                if (strategy === 'SPIRIT_EXPERIMENTAL' && position.experimentalSLSet && nextCandle.high >= position.experimentalSL) {
                    closeReason = 'Stop Loss (Experimental)';
                    exitPrice = position.experimentalSL;
                }
                if (strategy === 'SPIRIT_SHIELD' && effectiveSL > 0 && nextCandle.high >= effectiveSL) {
                    closeReason = 'Stop Loss (Shield)';
                    exitPrice = effectiveSL;
                }
                if (strategy === 'SPIRIT_ELITE' && effectiveSL > 0 && nextCandle.high >= effectiveSL) {
                    // Hybrid check: SL only triggers if the candle actually reached the SL level
                    // - SL above entry (loss protection): high >= SL triggers (+ handles gap up)
                    // - SL below entry (profit lock): only if low <= SL (candle crossed through SL)
                    if (nextCandle.low <= effectiveSL || effectiveSL >= position.entryPrice) {
                        closeReason = `Stop Loss (Elite: ${position.eliteSLType})`;
                        exitPrice = effectiveSL;
                    }
                }
            }

            if (closeReason) {
                let pnlRaw = 0;
                if (position.type === 'LONG') {
                    pnlRaw = (exitPrice - position.entryPrice) * position.size;
                } else {
                    pnlRaw = (position.entryPrice - exitPrice) * position.size;
                }

                // Calculate fees based on Notional Value
                const entryFee = position.margin * leverage * feeRate;
                const exitNotional = position.size * exitPrice;
                const exitFee = exitNotional * feeRate;
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
                const isStopLoss = closeReason && (closeReason.startsWith('Stop Loss') || closeReason.startsWith('Breakeven SL'));
                const isTrailing = closeReason && closeReason.startsWith('Trailing Stop');
                const isSpirit = strategy.startsWith('SPIRIT'); // Covers SPIRIT, SPIRIT_EXPERIMENTAL, SPIRIT_SHIELD, etc
                const canReEnter = isSpirit && (isStopLoss || (isTrailing && (strategy === 'SPIRIT_TRAILING' || strategy === 'SPIRIT_TEST')));

                if (canReEnter) {
                    const neededSignal = (lastType === 'LONG') ? 'Buy' : 'Sell';

                    // All SPIRIT variants (Standard, Trailing, Experimental, Improved)
                    // Rule: Re-enter at the START of the candle AFTER the stop, using the STOP PRICE.
                    if (i + 2 < backtestCandles.length) {
                        const checkCandle = backtestCandles[i + 1]; // Candle where signal must still exist
                        if (checkCandle.signalStr === neededSignal) {
                            const entryCandle = backtestCandles[i + 2]; // Candle where entry happens
                            const tradeAmount = Math.min(orderSize, balance);

                            // Check strategy specific re-entry
                            if (strategy === 'SPIRIT_ELITE') {
                                // SPIRIT_ELITE: Immediate Re-entry at STOP PRICE
                                // In real trading, bot detects SL hit and immediately re-enters
                                // so the fill price ≈ SL exit price (not candle close which may drift)
                                const lastTrade = trades[trades.length - 1];
                                const reEntryPrice = lastTrade ? lastTrade.exitPrice : checkCandle.close;
                                const notionalEntry = tradeAmount * leverage;
                                const entryFee = notionalEntry * feeRate;

                                if (balance >= (tradeAmount + entryFee)) {
                                    balance -= (tradeAmount + entryFee);
                                    const size = notionalEntry / reEntryPrice;

                                    position = {
                                        type: (neededSignal === 'Buy' ? 'LONG' : 'SHORT'),
                                        entryPrice: reEntryPrice,
                                        margin: tradeAmount,
                                        entryTime: checkCandle.time,
                                        size: size,
                                        stopActiveFromIndex: i + 2, // Active next candle after signal
                                        isElite: true,
                                        candlesSinceEntry: 0,
                                        highestPrice: reEntryPrice,
                                        lowestPrice: reEntryPrice
                                    };
                                    // Advance loop index to skip the signal candle we just used
                                    i = i + 1;
                                }
                            } else {
                                // Standard SPIRIT (Market/Close Entry)
                                const reEntryPrice = checkCandle.close;
                                const notionalEntry = tradeAmount * leverage;
                                const entryFee = notionalEntry * feeRate;

                                if (balance >= (tradeAmount + entryFee)) {
                                    balance -= (tradeAmount + entryFee);
                                    const size = notionalEntry / reEntryPrice;

                                    position = {
                                        type: (neededSignal === 'Buy' ? 'LONG' : 'SHORT'),
                                        entryPrice: reEntryPrice,
                                        margin: tradeAmount,
                                        entryTime: checkCandle.time,
                                        size: size,
                                        stopActiveFromIndex: i + 2
                                    };
                                    // Advance loop
                                    i = i + 1;
                                }
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
