const { fetchKlines, fetchFundingRate, fetchFundingInfo, fetchCommissionRate } = require('./binance');
const { calculateRangeFilter } = require('./indicators');

/**
 * Single Symbol Trading Engine Instance (REAL TRADING ENV)
 * Handles indicators, signals, and execution for one pair.
 * Currently simulates execution, will be updated to use Binance Authenticated API.
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
        this.mode = 'REAL_BOT_01'; // Distinct mode identifier

        // Internal State
        this.balance = this.initialCapital;
        this.position = null;
        this.trades = [];
        this.candles = []; // Warmup + Live
        this.lastProcessedTime = 0;
        this.pendingReEntry = null; // { neededSignal }
        this.lastFundingUpdate = 0;
        this.startTime = Date.now(); // Track session start
        this.onStateChange = config.onStateChange || (() => { });
    }

    async init() {
        // Fetch 500 candles for warmup
        console.log(`[RealBot Engine] Initializing ${this.symbol} warmup...`);
        const warmupCount = 500;
        const initialCandles = await fetchKlines(this.symbol, this.timeframe, warmupCount);
        this.candles = initialCandles;
        this.recalculateIndicators();

        // Fetch current funding rate and interval info from Binance
        await this.refreshRates();
        this.lastFundingUpdate = Date.now();

        const ratePercent = (this.currentFundingRate * 100).toFixed(4);
        console.log(`[RealBot Engine] ${this.symbol} ready. Funding: ${ratePercent}% every ${this.fundingIntervalHours}h | Taker: ${this.takerFee}`);
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
        if (newCandle.time === this.candles[this.candles.length - 1].time) {
            this.candles[this.candles.length - 1] = { ...this.candles[this.candles.length - 1], ...newCandle };
        } else if (newCandle.time > this.candles[this.candles.length - 1].time) {
            this.candles.push(newCandle);
            if (this.candles.length > 600) this.candles.shift(); // Maintain buffer
        }

        this.recalculateIndicators();

        const now = Date.now();
        if (now - this.lastFundingUpdate > 30 * 60 * 1000) {
            this.refreshRates().catch(err => console.error(`[${this.symbol}] Error refreshing rates:`, err));
            this.lastFundingUpdate = now;
        }

        if (newCandle.isFinal && newCandle.time > this.lastProcessedTime) {
            this.processSignal();
            this.lastProcessedTime = newCandle.time;
        }

        this.manageOpenPosition(newCandle);
        this.processRealTimeFunding(newCandle.time);
    }

    processRealTimeFunding(currentTime) {
        if (!this.position) return;

        const intervalMs = (this.fundingIntervalHours || 8) * 60 * 60 * 1000;

        if (!this.position.lastFundingCheck) {
            this.position.lastFundingCheck = this.position.entryTime;
        }

        const getNextBoundary = (time) => {
            const date = new Date(time);
            date.setUTCHours(Math.floor(date.getUTCHours() / this.fundingIntervalHours) * this.fundingIntervalHours + this.fundingIntervalHours, 0, 0, 0);
            return date.getTime();
        };

        let nextBoundary = getNextBoundary(this.position.lastFundingCheck);

        // Catch up loop
        while (currentTime >= nextBoundary) {
            const historicCandle = this.candles.find(c => Math.abs(c.time - nextBoundary) < 60000);
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

            this.balance -= amountPaid;
            this.position.accumulatedFunding = (this.position.accumulatedFunding || 0) + amountPaid;

            const dateStr = new Date(nextBoundary).toISOString().substring(11, 16);
            console.log(`[${this.symbol}] REAL CATCH-UP FUNDING (${dateStr}): Rate ${rate.toFixed(6)}, Price ${executionPrice}, Paid: ${amountPaid.toFixed(4)} USDT.`);

            this.position.lastFundingCheck = nextBoundary;
            nextBoundary = getNextBoundary(this.position.lastFundingCheck);
            this.onStateChange();
        }
    }

    processSignal() {
        const candle = this.candles[this.candles.length - 1];
        const signal = candle.signalStr;
        const isTrigger = candle.isTrigger;

        if (this.position) {
            const oppositeSignal = this.position.type === 'LONG' ? 'Sell' : 'Buy';
            if (isTrigger && signal === oppositeSignal) {
                this.closePosition(candle.close, 'Signal Reversal');
                return;
            }
        }

        if (!this.position) {
            const isSpiritReEntry = this.pendingReEntry && signal === this.pendingReEntry.neededSignal;

            if (isTrigger || isSpiritReEntry) {
                const type = (signal === 'Buy') ? 'LONG' : 'SHORT';
                const canEnter = (type === 'LONG' && (this.direction === 'BOTH' || this.direction === 'LONG')) ||
                    (type === 'SHORT' && (this.direction === 'BOTH' || this.direction === 'SHORT'));

                if (canEnter) {
                    const targetPrice = (this.pendingReEntry && this.pendingReEntry.entryPrice) || candle.close;
                    this.openPosition(type, targetPrice, candle.time);
                }
                this.pendingReEntry = null;
            }
        }
    }

    manageOpenPosition(tick) {
        if (!this.position) return;

        const p = this.position;
        const slRate = this.stopLossPct / 100;
        const trailingRate = this.trailingPct / 100;

        if (p.type === 'LONG') p.highestPrice = Math.max(p.highestPrice || p.entryPrice, tick.high);
        else p.lowestPrice = Math.min(p.lowestPrice || p.entryPrice, tick.low);

        let effectiveSL = 0;
        if (this.slMode === 'NONE') {
            effectiveSL = 0;
        } else if (this.slMode === 'FIXED') {
            effectiveSL = p.type === 'LONG' ? p.entryPrice * (1 - slRate) : p.entryPrice * (1 + slRate);
        } else if (this.slMode === 'BREAKEVEN') {
            effectiveSL = p.entryPrice;
        } else if (this.slMode === 'TRAILING') {
            effectiveSL = p.type === 'LONG' ? p.highestPrice * (1 - trailingRate) : p.lowestPrice * (1 + trailingRate);
        }

        if (this.strategy === 'SPIRIT_EXPERIMENTAL' && !p.experimentalSLSet) {
            const currentCandle = this.candles[this.candles.length - 1];
            if (currentCandle.time > p.entryCandleTime) {
                p.experimentalSL = currentCandle.close;
                p.experimentalSLSet = true;
                console.log(`[${this.symbol}] SPIRIT_EXPERIMENTAL SL set at ${p.experimentalSL}`);
            }
        }

        let hit = false;
        if (p.type === 'LONG') {
            if (effectiveSL > 0 && tick.low <= effectiveSL) hit = true;
            if (this.strategy === 'SPIRIT_EXPERIMENTAL' && p.experimentalSLSet && tick.low <= p.experimentalSL) {
                hit = true;
                effectiveSL = p.experimentalSL;
            }
        } else if (p.type === 'SHORT') {
            if (effectiveSL > 0 && tick.high >= effectiveSL) hit = true;
            if (this.strategy === 'SPIRIT_EXPERIMENTAL' && p.experimentalSLSet && tick.high >= p.experimentalSL) {
                hit = true;
                effectiveSL = p.experimentalSL;
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
        const feeRate = this.takerFee || 0.0004;
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
            entryCommission: entryFee,
            accumulatedFunding: 0,
            lastFundingCheck: Date.now()
        };

        console.log(`[${this.symbol}] REAL_BOT - OPEN ${type} at ${price}`);
        this.onStateChange();
    }

    closePosition(price, reason) {
        if (!this.position) return;

        const p = this.position;
        const feeRate = this.takerFee || 0.0004;
        const exitFee = p.margin * feeRate;

        let pnlRaw = p.type === 'LONG' ? (price - p.entryPrice) * p.size : (p.entryPrice - price) * p.size;
        const fundingFee = p.accumulatedFunding || 0;

        const netPnL = pnlRaw - exitFee - p.entryCommission - fundingFee;

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

        console.log(`[${this.symbol}] REAL_BOT - CLOSE at ${price} (${reason}). PnL: ${netPnL.toFixed(2)}`);

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
            lastPrice: this.candles.length > 0 ? this.candles[this.candles.length - 1].close : 0,
            startTime: this.startTime
        };
    }
}

module.exports = TradingEngine;
