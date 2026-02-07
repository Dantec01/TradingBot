const { fetchKlines, fetchFundingRate, fetchFundingInfo, fetchCommissionRate } = require('./binance');
const { calculateRangeFilter } = require('./indicators');

/**
 * Single Symbol Trading Engine Instance
 * Handles indicators, signals, and virtual/real execution for one pair.
 */
class TradingEngine {
    constructor(config) {
        this.symbol = config.symbol;
        this.timeframe = config.timeframe;
        this.initialCapital = parseFloat(config.initialCapital) || 100;
        this.orderSize = parseFloat(config.orderSize) || 10;
        this.leverage = parseFloat(config.leverage) || 20;
        this.strategy = config.strategy || 'CLOSE_ENTRY';
        this.slMode = config.slMode || 'FIXED';
        this.stopLossPct = parseFloat(config.stopLossPct) || 1.0;
        this.trailingPct = parseFloat(config.trailingPct) || 1.0;
        this.direction = config.direction || 'BOTH';
        this.mode = config.mode || 'PAPER'; // 'PAPER' or 'REAL'

        // =====================================================
        // SPIRIT_ELITE CONFIGURATION PARAMETERS
        // =====================================================
        // These control the SPIRIT_ELITE v4 strategy behavior:
        //
        // eliteTrailingDefer: Number of candles to wait before activating Trailing Stop
        //   - Default: 5 candles
        //   - Lower = more aggressive (trailing starts sooner)
        //   - Higher = more patient (gives trade room to breathe)
        this.eliteTrailingDefer = parseFloat(config.eliteTrailingDefer) || 5;

        // eliteTickOffset: Fixed points offset for Breakeven+Tick SL (e.g., 0.0001 for 1 tick)
        this.eliteTickOffset = parseFloat(config.eliteTickOffset) || 0.0001;

        // eliteActivationPct: [RESERVED - NOT CURRENTLY IMPLEMENTED]
        // --------------------------------------------------------
        // UI Field: "% Activación" in Spirit Elite config
        // Intended purpose: Control when Breakeven+Tick activates based on PROFIT %
        // instead of candle count.
        //
        // CURRENT BEHAVIOR: Breakeven activates after 1 candle (candlesSinceEntry >= 1)
        // POTENTIAL FUTURE BEHAVIOR: Breakeven activates when price reaches X% profit
        //
        // Example implementation (not active):
        //   if (p.type === 'LONG') {
        //       const profitPct = (currentPrice - p.entryPrice) / p.entryPrice;
        //       if (profitPct >= this.eliteActivationPct) {
        //           eliteBESL = p.entryPrice + eliteTickOffset;
        //       }
        //   }
        //
        // RECOMMENDATION: Keep candle-based activation (simpler, more predictable)
        // unless backtesting shows %-based is significantly better.
        // this.eliteActivationPct = parseFloat(config.eliteActivationPct) || 0.002; // 0.2%


        // Internal State
        this.balance = this.initialCapital;
        this.position = null;
        this.trades = [];
        this.candles = []; // Warmup + Live
        this.lastProcessedTime = 0;
        this.pendingReEntry = null; // { neededSignal }
        this.pendingLimitOrder = null; // { type, price, candleTime } for BACKGUARD
        this.lastFundingUpdate = 0;
        this.startTime = Date.now(); // Track session start
        this.onStateChange = config.onStateChange || (() => { });
    }

    async init() {
        // Fetch 500 candles for warmup
        console.log(`[Bot Engine] Initializing ${this.symbol} warmup...`);
        const warmupCount = 500;
        const initialCandles = await fetchKlines(this.symbol, this.timeframe, warmupCount);
        this.candles = initialCandles;
        this.recalculateIndicators();

        // Fetch current funding rate and interval info from Binance (NO API KEY REQUIRED)
        await this.refreshRates();
        this.lastFundingUpdate = Date.now();

        const ratePercent = (this.currentFundingRate * 100).toFixed(4);
        console.log(`[Bot Engine] ${this.symbol} ready. Funding: ${ratePercent}% every ${this.fundingIntervalHours}h | Taker: ${this.takerFee}`);
    }

    async refreshRates() {
        try {
            // Fetch funding rate (returns object with rate, nextFundingTime, etc)
            const fundingData = await fetchFundingRate(this.symbol);
            this.currentFundingRate = fundingData.rate; // Extract the rate number
            this.nextFundingTime = fundingData.nextFundingTime;

            // Fetch funding interval (some coins have 4h, others 8h, etc)
            const fundingInfo = await fetchFundingInfo(this.symbol);
            this.fundingIntervalHours = fundingInfo.fundingIntervalHours || 8;

            // Fetch commission rates
            const fees = await fetchCommissionRate(this.symbol);
            this.makerFee = fees.maker;
            this.takerFee = fees.taker;
            // console.log(`[${this.symbol}] Rates refreshed. Funding: ${(this.currentFundingRate*100).toFixed(4)}% every ${this.fundingIntervalHours}h`);
        } catch (err) {
            console.error(`[${this.symbol}] Error refreshing rates:`, err);
            // Fallback defaults
            this.currentFundingRate = this.currentFundingRate || 0;
            this.fundingIntervalHours = this.fundingIntervalHours || 8;
        }
    }

    countFundingWindows(startTime, endTime) {
        // Use dynamic funding interval from Binance (4h, 8h, etc. depending on the coin)
        const intervalHours = this.fundingIntervalHours || 8;
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
        // For 8h: 00:00, 08:00, 16:00 UTC
        // For 4h: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC
        let nextHour = Math.floor(current.getUTCHours() / intervalHours) * intervalHours + intervalHours;
        current.setUTCHours(nextHour);

        while (current.getTime() <= endTime) {
            count++;
            current.setUTCHours(current.getUTCHours() + intervalHours);
        }
        return count;
    }

    recalculateIndicators() {
        const indicators = calculateRangeFilter(this.candles, { period: 100, multiplier: 3.0 });
        this.candles = this.candles.map((c, i) => ({ ...c, ...indicators[i] }));
    }

    /**
     * Process a new candle update (from WebSocket)
     * @param {Object} newCandle { time, open, high, low, close, isFinal }
     */
    update(newCandle) {
        // Track last tick time from Binance for accurate timestamping
        this.lastTickTime = newCandle.time;

        // Ensure we only process the final candle (or update current partial)
        // For Range Filter, we usually check signals at the CLOSE of the candle.
        if (newCandle.time === this.candles[this.candles.length - 1].time) {
            // Update current candle
            this.candles[this.candles.length - 1] = { ...this.candles[this.candles.length - 1], ...newCandle };
        } else if (newCandle.time > this.candles[this.candles.length - 1].time) {
            // New candle started
            this.candles.push(newCandle);
            if (this.candles.length > 600) this.candles.shift(); // Maintain buffer
        }

        this.recalculateIndicators();

        // Refresh funding and commission rates every 30 minutes
        const now = Date.now();
        if (now - this.lastFundingUpdate > 30 * 60 * 1000) {
            this.refreshRates().catch(err => console.error(`[${this.symbol}] Error refreshing rates:`, err));
            this.lastFundingUpdate = now;
        }

        // Signal logic only on "isFinal" or "lastProcessedTime"
        if (newCandle.isFinal && newCandle.time > this.lastProcessedTime) {
            this.processSignal();
            this.lastProcessedTime = newCandle.time;
        }

        // Manage SL/TP in real-time (not just on close)
        this.manageOpenPosition(newCandle);

        // Check if we have a pending limit order to fill (BACKGUARD)
        this.checkPendingLimitOrder(newCandle);

        // --- Real-Time Funding Logic ---
        this.processRealTimeFunding(newCandle.time);
    }

    processRealTimeFunding(currentTime) {
        if (!this.position) return;

        // Use dynamic funding interval (default 8h)
        const intervalMs = (this.fundingIntervalHours || 8) * 60 * 60 * 1000;

        // Ensure we track the last check time. If newly opened, use entryTime.
        if (!this.position.lastFundingCheck) {
            this.position.lastFundingCheck = this.position.entryTime;
        }

        // Helper to align to next boundary
        const getNextBoundary = (time) => {
            const date = new Date(time);
            date.setUTCHours(Math.floor(date.getUTCHours() / this.fundingIntervalHours) * this.fundingIntervalHours + this.fundingIntervalHours, 0, 0, 0);
            return date.getTime();
        };

        let nextBoundary = getNextBoundary(this.position.lastFundingCheck);

        // Catch up loop: Process ALL missed funding windows
        while (currentTime >= nextBoundary) {
            // Try to find the specific candle at the boundary time for accurate pricing
            // Since init() fetches history, we should have it.
            const historicCandle = this.candles.find(c => Math.abs(c.time - nextBoundary) < 60000); // Allow 1m tolerance
            const executionPrice = historicCandle ? historicCandle.close : this.candles[this.candles.length - 1].close;

            const rate = this.currentFundingRate || 0;
            const positionSize = this.position.size;

            const notional = positionSize * executionPrice;
            let fundingPayment = notional * rate;

            let amountPaid = 0;
            if (this.position.type === 'LONG') {
                amountPaid = fundingPayment;
            } else {
                amountPaid = -fundingPayment;
            }

            // Update Balance
            this.balance -= amountPaid;

            // Update Position Stats
            this.position.accumulatedFunding = (this.position.accumulatedFunding || 0) + amountPaid;

            // Advance detailed logs
            const dateStr = new Date(nextBoundary).toISOString().substring(11, 16);
            console.log(`[${this.symbol}] CATCH-UP FUNDING (${dateStr}): Rate ${rate.toFixed(6)}, Price ${executionPrice}, Paid: ${amountPaid.toFixed(4)} USDT.`);

            // Advance check time to the boundary we just processed
            this.position.lastFundingCheck = nextBoundary;
            nextBoundary = getNextBoundary(this.position.lastFundingCheck);

            this.onStateChange();
        }
    }

    processSignal() {
        const candle = this.candles[this.candles.length - 1]; // Current confirmed candle
        const signal = candle.signalStr;
        const isTrigger = candle.isTrigger;

        if (this.position) {
            const oppositeSignal = this.position.type === 'LONG' ? 'Sell' : 'Buy';
            if (isTrigger && signal === oppositeSignal) {
                this.closePosition(candle.close, 'Signal Reversal');
                // Allow fall-through to immediate entry logic below
            }
        }

        if (!this.position) {
            const isSpiritReEntry = this.pendingReEntry && signal === this.pendingReEntry.neededSignal;

            if (isTrigger || isSpiritReEntry) {
                const type = (signal === 'Buy') ? 'LONG' : 'SHORT';
                const canEnter = (type === 'LONG' && (this.direction === 'BOTH' || this.direction === 'LONG')) ||
                    (type === 'SHORT' && (this.direction === 'BOTH' || this.direction === 'SHORT'));

                if (canEnter) {

                    if (this.strategy === 'BACKGUARD') {
                        // Place Virtual Limit Order at Close Price for BACKGUARD
                        this.pendingLimitOrder = {
                            type,
                            price: candle.close,
                            time: candle.time,
                            strategy: this.strategy
                        };
                        console.log(`[${this.symbol}] ${this.strategy} - Limit Order Placed at ${candle.close} (${type})`);
                    } else {
                        // SPIRIT_ELITE and all others: Immediate entry at candle.close
                        // Same behavior as Backtest
                        const targetPrice = (this.pendingReEntry && this.pendingReEntry.entryPrice) || candle.close;
                        this.openPosition(type, targetPrice, candle.time);
                    }
                }
            }
            this.pendingReEntry = null; // Clear after use
        }
    }

    manageOpenPosition(tick) {
        if (!this.position) return;

        const p = this.position;
        const slRate = this.stopLossPct / 100;
        const trailingRate = this.trailingPct / 100;

        // Update Extremes
        if (p.type === 'LONG') p.highestPrice = Math.max(p.highestPrice || p.entryPrice, tick.high);
        else p.lowestPrice = Math.min(p.lowestPrice || p.entryPrice, tick.low);

        let effectiveSL = 0;
        if (this.slMode === 'NONE') {
            // No stop loss active
            effectiveSL = 0;
        } else if (this.slMode === 'FIXED') {
            effectiveSL = p.type === 'LONG' ? p.entryPrice * (1 - slRate) : p.entryPrice * (1 + slRate);
        } else if (this.slMode === 'BREAKEVEN') {
            effectiveSL = p.entryPrice;
        } else if (this.slMode === 'TRAILING') {
            effectiveSL = p.type === 'LONG' ? p.highestPrice * (1 - trailingRate) : p.lowestPrice * (1 + trailingRate);
        }

        // SPIRIT_EXPERIMENTAL: Set SL at the close of the candle AFTER entry
        if (this.strategy === 'SPIRIT_EXPERIMENTAL' && !p.experimentalSLSet) {
            const currentCandle = this.candles[this.candles.length - 1];
            // If the current candle is already AFTER the entry candle time
            if (currentCandle.time > p.entryCandleTime) {
                p.experimentalSL = currentCandle.close;
                p.experimentalSLSet = true;
                console.log(`[${this.symbol}] SPIRIT_EXPERIMENTAL SL set at ${p.experimentalSL}`);
            }
        }

        // SPIRIT_EXPERIMENTAL_FIXED: Same as above BUT waits for NEXT tick before activating
        if (this.strategy === 'SPIRIT_EXPERIMENTAL_FIXED' && !p.experimentalSLSet) {
            const currentCandle = this.candles[this.candles.length - 1];
            if (currentCandle.time > p.entryCandleTime) {
                p.experimentalSL = currentCandle.close;
                p.experimentalSLSet = true;
                p.experimentalSLActivatedTime = Date.now(); // Mark when SL was set
                console.log(`[${this.symbol}] SPIRIT_EXPERIMENTAL_FIXED SL set at ${p.experimentalSL} (activation delayed)`);
            }
        }

        // BACKGUARD & ELITE Logic: Update candle counter
        if (this.strategy === 'BACKGUARD' || this.strategy === 'SPIRIT_ELITE') {
            if (tick.time > p.lastCandleTime) {
                p.candlesSinceEntry++;
                p.lastCandleTime = tick.time;
                // console.log(`[${this.symbol}] Candle +1. Total: ${p.candlesSinceEntry}`);
            }

            // 1. Initial 10-candle SL
            if (p.backguardSL) {
                effectiveSL = p.backguardSL;
            }

            // 2. Delayed Trailing Stop (1%) starts after 3 candles
            if (p.candlesSinceEntry >= 3) {
                const trailRate = 0.01; // 1% Fixed for BACKGUARD
                const trailSL = p.type === 'LONG'
                    ? p.highestPrice * (1 - trailRate)
                    : p.lowestPrice * (1 + trailRate);

                // If Trailing SL is better (closer to price/profit) than current effectiveSL, use it
                if (p.type === 'LONG') {
                    if (effectiveSL === 0 || trailSL > effectiveSL) effectiveSL = trailSL;
                } else {
                    if (effectiveSL === 0 || trailSL < effectiveSL) effectiveSL = trailSL;
                }
            }
        }

        // Check Collision
        // SPIRIT_SHIELD (Smart Breakeven) Logic
        if (this.strategy === 'SPIRIT_SHIELD') {
            const shieldSLPct = 0.01; // 1% Initial Risk
            let finalSL = p.type === 'LONG'
                ? p.entryPrice * (1 - shieldSLPct)
                : p.entryPrice * (1 + shieldSLPct);

            const triggerPct = 0.002; // 0.2% Profit Trigger

            if (p.type === 'LONG') {
                if ((p.highestPrice - p.entryPrice) / p.entryPrice >= triggerPct) {
                    finalSL = p.entryPrice;
                }
            } else {
                if ((p.entryPrice - p.lowestPrice) / p.entryPrice >= triggerPct) {
                    finalSL = p.entryPrice;
                }
            }
            effectiveSL = finalSL;
        }

        // SPIRIT_ELITE v4 (Paper): Experimental + Delayed Breakeven + Delayed Trailing
        if (this.strategy === 'SPIRIT_ELITE') {
            const eliteTickOffset = this.eliteTickOffset;

            // 1. Experimental SL (Dynamic)
            // Sets SL based on the candle that JUST closed after entry
            if (!p.experimentalSLSet) {
                // We need to find the first CLOSED candle that started AFTER our entry
                // Entry Time: p.entryTime (or p.entryCandleTime)
                // We look for a candle in history where candle.time > p.entryCandleTime
                const closedCandle = this.candles.find(c => c.time > p.entryCandleTime);

                if (closedCandle) {
                    p.experimentalSL = closedCandle.close;
                    p.experimentalSLSet = true;
                    console.log(`[SPIRIT_ELITE] Experimental SL set at ${p.experimentalSL}`);
                }
            }

            // 2. Elite Breakeven (Entry +/- points offset) - Activates next candle
            let eliteBESL = 0;
            if (p.candlesSinceEntry >= 1) { // 1 candle closed means we are in the "next" candle
                // eliteTickOffset is now in POINTS (fixed price offset)
                const offsetVal = this.eliteTickOffset;

                if (p.type === 'LONG') {
                    eliteBESL = p.entryPrice + offsetVal;
                } else {
                    eliteBESL = p.entryPrice - offsetVal;
                }
            }

            // 3. Delayed Trailing (after 5 candles)
            let trailingSL = 0;
            const deferCandles = this.eliteTrailingDefer || 5;
            if (p.candlesSinceEntry >= deferCandles) {
                const trailPct = this.trailingPct || 1.0;
                const trailDist = trailPct / 100;
                if (p.type === 'LONG') {
                    trailingSL = p.highestPrice * (1 - trailDist);
                } else {
                    trailingSL = p.lowestPrice * (1 + trailDist);
                }
            }

            // 4. Determine Effective SL (Most Protective)
            let finalSL = 0;
            let usedSLType = 'None';

            if (p.type === 'LONG') {
                const expSL = p.experimentalSLSet ? p.experimentalSL : 0;
                // Max is most protective for LONG
                finalSL = Math.max(eliteBESL, expSL, trailingSL);

                if (finalSL === eliteBESL && eliteBESL > 0) usedSLType = 'Breakeven+Tick';
                else if (finalSL === trailingSL && trailingSL > 0) usedSLType = 'Delayed Trailing';
                else if (finalSL === expSL && expSL > 0) usedSLType = 'Experimental';

            } else {
                // Min is most protective for SHORT (ignoring 0)
                const expSL = p.experimentalSLSet ? p.experimentalSL : Infinity;
                const beSL = eliteBESL !== 0 ? eliteBESL : Infinity;
                const trSL = trailingSL !== 0 ? trailingSL : Infinity;

                finalSL = Math.min(expSL, beSL, trSL);
                if (finalSL === Infinity) finalSL = 0;

                if (finalSL === beSL && beSL !== Infinity) usedSLType = 'Breakeven+Tick';
                else if (finalSL === trSL && trSL !== Infinity) usedSLType = 'Delayed Trailing';
                else if (finalSL === expSL && expSL !== Infinity) usedSLType = 'Experimental';
            }

            effectiveSL = finalSL;
            p.eliteSLType = usedSLType; // Store for logs
        }

        let hit = false;
        if (p.type === 'LONG') {
            if (effectiveSL > 0 && tick.low <= effectiveSL) hit = true;
            if (this.strategy === 'SPIRIT_EXPERIMENTAL' && p.experimentalSLSet && tick.low <= p.experimentalSL) {
                hit = true;
                effectiveSL = p.experimentalSL; // Use experimental SL for exit
            }
            // FIXED version: wait 500ms after SL is set before activating
            if (this.strategy === 'SPIRIT_EXPERIMENTAL_FIXED' && p.experimentalSLSet && tick.low <= p.experimentalSL) {
                const timeSinceSLSet = Date.now() - (p.experimentalSLActivatedTime || 0);
                if (timeSinceSLSet > 500) { // Wait at least 500ms
                    hit = true;
                    effectiveSL = p.experimentalSL;
                }
            }
            if (this.strategy === 'SPIRIT_SHIELD' && effectiveSL > 0 && tick.low <= effectiveSL) {
                hit = true;
                // effectiveSL is already set by above logic
            }
            if (this.strategy === 'SPIRIT_ELITE' && effectiveSL > 0 && tick.low <= effectiveSL) {
                // Hybrid check: SL only triggers if the candle actually reached the SL level
                // - SL below entry (loss protection): low <= SL triggers (+ handles gap down)
                // - SL above entry (profit lock): only if high >= SL (candle crossed through SL)
                if (tick.high >= effectiveSL || effectiveSL <= p.entryPrice) {
                    hit = true;
                }
            }
        } else if (p.type === 'SHORT') {
            if (effectiveSL > 0 && tick.high >= effectiveSL) hit = true;
            if (this.strategy === 'SPIRIT_EXPERIMENTAL' && p.experimentalSLSet && tick.high >= p.experimentalSL) {
                hit = true;
                effectiveSL = p.experimentalSL; // Use experimental SL for exit
            }
            // FIXED version: wait 500ms after SL is set before activating
            if (this.strategy === 'SPIRIT_EXPERIMENTAL_FIXED' && p.experimentalSLSet && tick.high >= p.experimentalSL) {
                const timeSinceSLSet = Date.now() - (p.experimentalSLActivatedTime || 0);
                if (timeSinceSLSet > 500) { // Wait at least 500ms
                    hit = true;
                    effectiveSL = p.experimentalSL;
                }
            }
            if (this.strategy === 'SPIRIT_SHIELD' && effectiveSL > 0 && tick.high >= effectiveSL) {
                hit = true;
                // effectiveSL is already set by above logic
            }
            if (this.strategy === 'SPIRIT_ELITE' && effectiveSL > 0 && tick.high >= effectiveSL) {
                // Hybrid check: SL only triggers if the candle actually reached the SL level
                // - SL above entry (loss protection): high >= SL triggers (+ handles gap up)
                // - SL below entry (profit lock): only if low <= SL (candle crossed through SL)
                if (tick.low <= effectiveSL || effectiveSL >= p.entryPrice) {
                    hit = true;
                }
            }
        }

        if (hit) {
            let reason = this.slMode === 'TRAILING' ? 'Trailing Stop' : (this.slMode === 'BREAKEVEN' ? 'Breakeven SL' : 'Stop Loss');
            if ((this.strategy === 'SPIRIT_EXPERIMENTAL' || this.strategy === 'SPIRIT_EXPERIMENTAL_FIXED') && p.experimentalSLSet && effectiveSL === p.experimentalSL) {
                reason = 'Stop Loss (Experimental)';
            }
            if (this.strategy === 'SPIRIT_SHIELD') {
                reason = 'Stop Loss (Shield)';
            }
            if (this.strategy === 'SPIRIT_ELITE' && p.eliteSLType) {
                reason = `Stop Loss (Elite: ${p.eliteSLType})`;
            }
            this.closePosition(effectiveSL, reason);
        }
    }

    checkPendingLimitOrder(tick) {
        if (!this.pendingLimitOrder) return;

        const { type, price } = this.pendingLimitOrder;
        let filled = false;

        // Limit Order Logic:
        // LONG: Fill if Low <= limitPrice (we buy at limit or lower)
        // SHORT: Fill if High >= limitPrice (we sell at limit or higher)

        if (type === 'LONG') {
            if (tick.low <= price) {
                filled = true;
                // In Paper, we assume perfect fill at limit price
                // (In reality, could be better, but limit price is the guarantee)
            }
        } else {
            if (tick.high >= price) {
                filled = true;
            }
        }

        if (filled) {
            const stratName = this.pendingLimitOrder.strategy || 'Limit Order';

            // Fill at Limit Price (Conservative Paper Trading)
            let fillPrice = price;

            console.log(`[${this.symbol}] ${stratName} - Limit Order FILLED at ${fillPrice} (Limit: ${price})`);
            this.openPosition(type, fillPrice, tick.time);
            this.pendingLimitOrder = null;
        }
    }

    openPosition(type, price, candleTime) {
        const tradeAmount = Math.min(this.orderSize, this.balance);
        const feeRate = this.takerFee || 0.0004; // Use dynamic rate
        const entryFee = tradeAmount * feeRate;

        if (this.balance < (tradeAmount + entryFee)) {
            console.log(`[${this.symbol}] Insufficient balance for trade.`);
            return;
        }

        this.balance -= (tradeAmount + entryFee);
        const size = (tradeAmount * this.leverage) / price;

        let backguardSL = null;
        if (this.strategy === 'BACKGUARD') {
            // Calculate 10-candle swing SL
            // Lookback: last 10 completed candles from the list
            const lookback = 10;
            const history = this.candles.slice(-lookback);
            if (history.length > 0) {
                if (type === 'LONG') {
                    // Lowest Low of last 10
                    backguardSL = Math.min(...history.map(c => c.low));
                } else {
                    // Highest High of last 10
                    backguardSL = Math.max(...history.map(c => c.high));
                }
                console.log(`[${this.symbol}] BACKGUARD - Initial SL set at ${backguardSL}`);
            }
        }

        this.position = {
            type,
            entryPrice: price,
            margin: tradeAmount,
            size: size,
            entryTime: candleTime,           // Use Binance candle time, not Date.now()
            entryCandleTime: candleTime,
            highestPrice: price,
            lowestPrice: price,
            entryCommission: entryFee, // Track entry fee
            accumulatedFunding: 0,     // Real-time funding accumulator
            lastFundingCheck: candleTime,    // Use Binance candle time for funding tracking
            // BACKGUARD Specifics
            backguardSL: backguardSL,
            candlesSinceEntry: 0,
            lastCandleTime: candleTime,
            // SPIRIT_ELITE / SPIRIT_EXPERIMENTAL fields - reset on new entry
            experimentalSL: null,
            experimentalSLSet: false,
            lastReportedSLType: null
        };

        console.log(`[${this.symbol}] ${this.mode} - OPEN ${type} at ${price}`);

        // VANGUARD State Reset
        if (this.strategy === 'VANGUARD') {
            this.vanguardState = {
                oppositeCount: 0,
                lastProcessedTime: 0,
                positionAmt: 1 // Dummy value to indicate active
            };
        }

        // If REAL, call Binance API here (TBD)
        this.onStateChange();
    }

    closePosition(price, reason) {
        if (!this.position) return;

        const p = this.position;
        const feeRate = this.takerFee || 0.0004; // Use dynamic rate
        const exitFee = p.margin * feeRate;

        let pnlRaw = p.type === 'LONG' ? (price - p.entryPrice) * p.size : (p.entryPrice - price) * p.size;

        // Funding is already deducted from balance in real-time via accumulatedFunding
        // We just need it for reporting statistics
        const fundingFee = p.accumulatedFunding || 0;

        const netPnL = pnlRaw - exitFee - p.entryCommission - fundingFee;

        // Balance update:
        // Balance already has entryFee deducted (on Open).
        // Balance already has fundingFee deducted (Real-time).
        // We need to ADD back the Margin (returned) + PnL from price movement - Exit Fee.

        // Wait, careful math:
        // Balance = Initial - EntryFee - FundingPaid...
        // On Close: Balance += Margin + RawPnL - ExitFee
        // Net Result = Initial - EntryFee - FundingPaid + RawPnL - ExitFee
        // This is mathematically equivalent to: Balance += Margin + NetPnL (where NetPnL includes all deductions)
        // BUT NetPnL defined above INCLUDES fundingFee.
        // If we add NetPnL, we are subtracting FundingFee AGAIN!

        // Correct approach:
        // fundingFee is ALREADY reflected in `this.balance` because we subtracted it in real-time.
        // So we only apply the Trade Outcome (RawPnL) and Exit Fees.

        this.balance += (p.margin + pnlRaw - exitFee);

        const trade = {
            ...p,
            exitPrice: price,
            exitTime: this.lastTickTime || Date.now(),  // Use last tick time from Binance
            pnl: netPnL,
            commission: p.entryCommission + exitFee,
            funding: fundingFee,
            reason: reason,
            roi: (netPnL / p.margin) * 100,
            eliteTickOffset: this.eliteTickOffset // Save offset used for this trade
        };

        this.trades.push(trade);
        this.position = null;

        console.log(`[${this.symbol}] ${this.mode} - CLOSE at ${price} (${reason}). PnL: ${netPnL.toFixed(2)}`);

        // If REAL, call Binance API here (TBD)

        // --- Spirit Re-entry Logic ---
        this.handleSpiritReEntry(reason, p.type, price);
        this.onStateChange();
    }

    // --- VANGUARD AUXILIARY PROCESSING (PAPER) ---
    processAuxiliaryCandle(candle1m) {
        if (this.strategy !== 'VANGUARD' || !this.position) return;

        // Ensure 1m candles are sequential
        if (this.lastProcessed1mTime && candle1m.time <= this.lastProcessed1mTime) return;
        this.lastProcessed1mTime = candle1m.time;

        // --- VANGUARD 5m IMMEDIATE REVERSAL (Priority 1) ---
        // Validate against the LAST CLOSED 5m Candle's Range Filter (Simulating Real Time Breach)
        const last5m = this.candles.length > 0 ? this.candles[this.candles.length - 1] : null;
        if (last5m) {
            const refLevel = last5m.rngfilt;
            let reversalHit = false;

            if (this.position.type === 'LONG') { // LONG
                // If Price drops below Support (RF)
                if (candle1m.low < refLevel) reversalHit = true;
            } else { // SHORT
                // If Price rises above Resistance (RF)
                if (candle1m.high > refLevel) reversalHit = true;
            }

            if (reversalHit) {
                console.log(`[${this.symbol}] [VANGUARD] 5m Reversal Detected (Immediate).`);
                this.closePosition(refLevel, 'Vanguard 5m Reversal (Immediate)');
                return;
            }
        }

        const candidates1m = this.candidates1m || [];
        candidates1m.push(candle1m);
        if (candidates1m.length > 200) candidates1m.shift();
        this.candidates1m = candidates1m;

        // Calculate 1m Indicators (Range Filter)
        const sigs1m = calculateRangeFilter(this.candidates1m, { period: 100, multiplier: 3.0 });
        if (sigs1m.length === 0) return;

        const lastSig = sigs1m[sigs1m.length - 1];
        const prevSig = sigs1m.length > 1 ? sigs1m[sigs1m.length - 2] : null;

        if (!candle1m.isFinal) return; // Wait for close

        const positionType = this.position.type;
        const neededReversal = positionType === 'LONG' ? -1 : 1; //-1 Sell, 1 Buy

        // Handle State Initialization if missing (should be in openPosition but safety check)
        if (!this.vanguardState) {
            this.vanguardState = { oppositeCount: 0, lastProcessedTime: 0 };
        }

        const currentState = lastSig.state;
        const previousState = prevSig ? prevSig.state : null;

        // Detect Flip to Needed Reversal
        if (prevSig) {
            if (currentState === neededReversal && previousState !== neededReversal) {
                this.vanguardState.oppositeCount++;
                console.log(`[${this.symbol}] [VANGUARD] Opposite Signal Count: ${this.vanguardState.oppositeCount}`);
            }
        }

        // Condition 2: 2nd Opposite Signal
        if (this.vanguardState.oppositeCount >= 2) {
            console.log(`[${this.symbol}] [VANGUARD] QC2: Dual 1m Reversal (Count 2). Closing.`);
            this.closePosition(candle1m.close, 'Vanguad Dual-1m Exit');
            return;
        }

        // Condition 3: Wick Exit
        // Must be in opposite state
        if (currentState === neededReversal) {
            const rfValue = lastSig.rngfilt;
            let wickBreach = false;
            if (positionType === 'LONG') {
                if (candle1m.high > rfValue) wickBreach = true;
            } else {
                if (candle1m.low < rfValue) wickBreach = true;
            }

            if (wickBreach) {
                console.log(`[${this.symbol}] [VANGUARD] QC3: Wick Exit.`);
                this.closePosition(candle1m.close, 'Vanguad 1m Wick Exit');
                return;
            }
        }
    }

    handleSpiritReEntry(reason, lastType, exitPrice) {
        const isStopLoss = reason && (reason.startsWith('Stop Loss') || reason.startsWith('Breakeven SL'));
        const isTrailing = reason && reason.startsWith('Trailing Stop');
        // Check strategy type
        const isSpirit = this.strategy && this.strategy.startsWith('SPIRIT');

        // SPIRIT_TRAILING allows checks trailing too
        const canReEnter = isSpirit && (isStopLoss || (isTrailing && this.strategy === 'SPIRIT_TRAILING'));

        if (canReEnter) {
            const neededSignal = lastType === 'LONG' ? 'Buy' : 'Sell';

            if (this.strategy === 'SPIRIT_ELITE') {
                // SPIRIT_ELITE: Re-enter at exit price (SL price)
                this.pendingReEntry = {
                    neededSignal,
                    entryPrice: exitPrice
                };
            } else {
                // SPIRIT_TRAILING & Standard SPIRIT: Re-enter at candle.close (MARKET, matches backtest)
                this.pendingReEntry = {
                    neededSignal
                    // entryPrice omitted → processSignal uses candle.close
                };
            }
            console.log(`[${this.symbol}] ${this.strategy} - Re-entry Pending. Waiting for ${neededSignal} signal.`);
            this.onStateChange();
        }
    }

    getStatus() {
        return {
            symbol: this.symbol,
            timeframe: this.timeframe,
            initialCapital: this.initialCapital,
            orderSize: this.orderSize,
            leverage: this.leverage,
            strategy: this.strategy,
            slMode: this.slMode,
            stopLossPct: this.stopLossPct,
            trailingPct: this.trailingPct,
            direction: this.direction,
            mode: this.mode,
            balance: this.balance,
            position: this.position,
            pendingReEntry: this.pendingReEntry,
            totalTrades: this.trades.length,
            trades: this.trades,
            roi: ((this.balance - this.initialCapital) / this.initialCapital) * 100,
            lastPrice: this.candles.length > 0 ? this.candles[this.candles.length - 1].close : 0,
            startTime: this.startTime,
            // SPIRIT_ELITE parameters
            eliteTickOffset: this.eliteTickOffset,
            eliteTrailingDefer: this.eliteTrailingDefer
        };
    }
}

module.exports = TradingEngine;
