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

        // Internal State
        this.balance = this.initialCapital;
        this.position = null;
        this.trades = [];
        this.candles = []; // Warmup + Live
        this.lastProcessedTime = 0;
        this.pendingReEntry = null; // { neededSignal }
        this.lastFundingUpdate = 0;
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
                return; // Don't enter immediately in same block for safety
            }
        }

        if (!this.position) {
            const isSpiritReEntry = this.pendingReEntry && signal === this.pendingReEntry.neededSignal;

            if (isTrigger || isSpiritReEntry) {
                const type = (signal === 'Buy') ? 'LONG' : 'SHORT';
                const canEnter = (type === 'LONG' && (this.direction === 'BOTH' || this.direction === 'LONG')) ||
                    (type === 'SHORT' && (this.direction === 'BOTH' || this.direction === 'SHORT'));

                if (canEnter) {
                    // Use forced entryPrice (e.g. from Stop Loss) if available, otherwise candle close
                    const targetPrice = (this.pendingReEntry && this.pendingReEntry.entryPrice) || candle.close;
                    this.openPosition(type, targetPrice, candle.time);
                }
                this.pendingReEntry = null; // Clear after use
            }
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

        // Check Collision
        let hit = false;
        if (p.type === 'LONG') {
            if (effectiveSL > 0 && tick.low <= effectiveSL) hit = true;
            if (this.strategy === 'SPIRIT_EXPERIMENTAL' && p.experimentalSLSet && tick.low <= p.experimentalSL) {
                hit = true;
                effectiveSL = p.experimentalSL; // Use experimental SL for exit
            }
        } else if (p.type === 'SHORT') {
            if (effectiveSL > 0 && tick.high >= effectiveSL) hit = true;
            if (this.strategy === 'SPIRIT_EXPERIMENTAL' && p.experimentalSLSet && tick.high >= p.experimentalSL) {
                hit = true;
                effectiveSL = p.experimentalSL; // Use experimental SL for exit
            }
        }

        if (hit) {
            let reason = this.slMode === 'TRAILING' ? 'Trailing Stop' : (this.slMode === 'BREAKEVEN' ? 'Breakeven SL' : 'Stop Loss');
            if (this.strategy === 'SPIRIT_EXPERIMENTAL' && p.experimentalSLSet && effectiveSL === p.experimentalSL) {
                reason = 'Stop Loss (Experimental)';
            }
            this.closePosition(effectiveSL, reason);
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

        this.position = {
            type,
            entryPrice: price,
            margin: tradeAmount,
            size: size,
            entryTime: Date.now(),
            entryCandleTime: candleTime,
            highestPrice: price,
            lowestPrice: price,
            entryCommission: entryFee, // Track entry fee
            accumulatedFunding: 0,     // Real-time funding accumulator
            lastFundingCheck: Date.now() // Track for funding intervals
        };

        console.log(`[${this.symbol}] ${this.mode} - OPEN ${type} at ${price}`);

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
            exitTime: Date.now(),
            pnl: netPnL,
            commission: p.entryCommission + exitFee,
            funding: fundingFee,
            reason: reason,
            roi: (netPnL / p.margin) * 100
        };

        this.trades.push(trade);
        this.position = null;

        console.log(`[${this.symbol}] ${this.mode} - CLOSE at ${price} (${reason}). PnL: ${netPnL.toFixed(2)}`);

        // If REAL, call Binance API here (TBD)

        // --- Spirit Re-entry Logic ---
        this.handleSpiritReEntry(reason, p.type, price);
        this.onStateChange();
    }

    handleSpiritReEntry(reason, lastType, exitPrice) {
        const isStopLoss = reason && (reason.startsWith('Stop Loss') || reason.startsWith('Breakeven SL'));
        const isTrailing = reason && reason.startsWith('Trailing Stop');
        const canReEnter = isStopLoss || (isTrailing && this.strategy === 'SPIRIT_TRAILING');

        if (!canReEnter) return;

        const neededSignal = (lastType === 'LONG') ? 'Buy' : 'Sell';

        // All SPIRIT variants now wait for the NEXT candle confirmed signal
        // Rules: Standard, Trailing, Experimental use the same exitPrice.
        // Improved uses the next candle close (default behavior in processSignal).
        let targetEntryPrice = null;
        if (this.strategy !== 'SPIRIT_IMPROVED') {
            targetEntryPrice = exitPrice;
        }

        this.pendingReEntry = {
            neededSignal,
            entryPrice: targetEntryPrice
        };

        console.log(`[${this.symbol}] ${this.strategy} - Re-entry queued for next candle at ${targetEntryPrice || 'Market'} price.`);
        this.onStateChange();
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
            lastPrice: this.candles[this.candles.length - 1].close
        };
    }
}

module.exports = TradingEngine;
