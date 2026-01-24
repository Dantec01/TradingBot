const { fetchKlines, fetchFundingRate, fetchFundingInfo, fetchCommissionRate } = require('./binance');
const { calculateRangeFilter } = require('./indicators');
const Binance = require('binance-api-node').default;

/**
 * Single Symbol Trading Engine Instance (REAL TRADING ENV)
 * Handles indicators, signals, and REAL execution for one pair using API Keys.
 */
class TradingEngine {
    constructor(config) {
        this.symbol = config.symbol.toUpperCase();
        if (!this.symbol.endsWith('USDT')) {
            this.symbol += 'USDT';
        }

        this.timeframe = config.timeframe;
        this.initialCapital = parseFloat(config.initialCapital) || 100;
        this.orderSize = parseFloat(config.orderSize) || 10;
        this.leverage = parseFloat(config.leverage) || 20;
        this.strategy = config.strategy || 'CLOSE_ENTRY';
        this.slMode = config.slMode || 'FIXED';
        this.stopLossPct = parseFloat(config.stopLossPct) || 1.0;
        this.trailingPct = parseFloat(config.trailingPct) || 1.0;
        this.direction = config.direction || 'BOTH';
        this.mode = 'REAL_BOT_01_LIVE'; // Distinct mode identifier for Real Money

        // Initialize Binance Client
        if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
            throw new Error('Faltan claves API en el archivo .env');
        }

        this.client = Binance({
            apiKey: process.env.BINANCE_API_KEY,
            apiSecret: process.env.BINANCE_API_SECRET,
        });

        // Internal State
        this.balance = this.initialCapital; // Will update from real wallet
        this.position = null;               // Sync with exchange
        this.trades = [];
        this.candles = []; // Warmup + Live
        this.lastProcessedTime = 0;
        this.pendingReEntry = null; // { neededSignal }
        this.lastFundingUpdate = 0;
        this.startTime = Date.now(); // Track session start
        this.onStateChange = config.onStateChange || (() => { });
        this.logger = config.onLog || ((l, m) => console.log(`[${l}] ${m}`));
    }

    log(level, message) {
        this.logger(level, message);
    }

    async init() {
        // Fetch 500 candles for warmup
        this.log('INFO', `Initializing ${this.symbol} real trading...`);
        const warmupCount = 500;
        const initialCandles = await fetchKlines(this.symbol, this.timeframe, warmupCount);
        this.candles = initialCandles;
        this.recalculateIndicators();

        try {
            // 1. Set Margin Type (User manually controls this on exchange)
            /*
            try {
                await this.client.futuresMarginType({ symbol: this.symbol, marginType: 'ISOLATED' });
                console.log(`[${this.symbol}] Margin mode set to ISOLATED.`);
            } catch (e) {
                // Ignore if already isolated or error
                if (!e.message.includes('No need to change')) {
                    this.log('WARN', `Warning setting margin type: ${e.message}`);
                }
            }
            */

            // 2. Set Leverage
            try {
                await this.client.futuresLeverage({ symbol: this.symbol, leverage: this.leverage });
                this.log('INFO', `Leverage set to ${this.leverage}x.`);
            } catch (e) {
                this.log('WARN', `Warning setting leverage: ${e.message}`);
            }

            // 3. Sync Balance and Positions
            await this.syncAccountState();

        } catch (err) {
            this.log('ERROR', `CRITICAL INIT ERROR: ${err.message}`);
            throw err;
        }

        // Fetch current funding rate and interval info from Binance
        await this.refreshRates();
        this.lastFundingUpdate = Date.now();

        const ratePercent = (this.currentFundingRate * 100).toFixed(4);
        this.log('SUCCESS', `LIVE READY. Funding: ${ratePercent}%`);
    }

    async syncAccountState() {
        try {
            const account = await this.client.futuresAccount();

            // Sync Balance (USDT)
            const usdtAsset = account.assets.find(a => a.asset === 'USDT');
            if (usdtAsset) {
                this.balance = parseFloat(usdtAsset.availableBalance);
            }

            // Check if we already have a position
            const position = account.positions.find(p => p.symbol === this.symbol && parseFloat(p.positionAmt) !== 0);
            if (position) {
                const amt = parseFloat(position.positionAmt);
                const entryPrice = parseFloat(position.entryPrice);
                this.position = {
                    type: amt > 0 ? 'LONG' : 'SHORT',
                    entryPrice: entryPrice,
                    margin: Math.abs(amt * entryPrice) / this.leverage, // Approx margin
                    size: Math.abs(amt),
                    entryTime: Date.now(), // Unknown really
                    entryCandleTime: Date.now(),
                    highestPrice: entryPrice,
                    lowestPrice: entryPrice,
                    entryCommission: 0, // Unknown
                    accumulatedFunding: 0,
                    lastFundingCheck: Date.now()
                };
                this.log('WARN', `Detected EXISTING position: ${this.position.type} ${this.position.size} @ ${this.position.entryPrice}`);
            } else {
                this.position = null;
            }
        } catch (err) {
            this.log('ERROR', `Sync State Error: ${err.message}`);
        }
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
            this.log('WARN', `Error refreshing rates: ${err.message}`);
            // Fallback defaults
            this.currentFundingRate = this.currentFundingRate || 0;
            this.fundingIntervalHours = this.fundingIntervalHours || 8;
        }
    }

    recalculateIndicators() {
        const indicators = calculateRangeFilter(this.candles, { period: 100, multiplier: 3.0 });
        this.candles = this.candles.map((c, i) => ({ ...c, ...indicators[i] }));
    }

    /**
     * Process a new candle update (from WebSocket via Manager)
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
            this.refreshRates().catch(err => this.log('WARN', `Error refreshing rates: ${err.message}`));
            this.lastFundingUpdate = now;
        }

        if (newCandle.isFinal && newCandle.time > this.lastProcessedTime) {
            this.processSignal();
            this.lastProcessedTime = newCandle.time;
        }

        this.manageOpenPosition(newCandle);
        // Note: Real-time funding deduction logic is removed because Binance handles it automatically on the account balance.
        // We just track PnL via API updates ideally, or approximate it here.
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
                // console.log(`[${this.symbol}] SPIRIT_EXPERIMENTAL SL set at ${p.experimentalSL}`);
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

    async openPosition(type, price, candleTime) {
        // Double check balance before ordering
        if (this.balance < 5) { // Min balance check
            this.log('WARN', `Insufficient balance (${this.balance} USDT) for trade.`);
            return;
        }

        // Calculate quantity based on orderSize (USDT margin)
        // quantity = (margin * leverage) / price
        // BUT Binance precision is important.

        try {
            const margin = Math.min(this.orderSize, this.balance);
            const rawQuantity = (margin * this.leverage) / price;
            // Simplified precision fix: 3 decimals (should use exchangeInfo)
            const quantity = parseFloat(rawQuantity.toFixed(3));

            if (quantity <= 0) {
                this.log('WARN', `Calculated quantity 0, aborting.`);
                return;
            }

            this.log('INFO', `EXECUTING REAL ${type} ORDER: Size ${quantity}, Leverage ${this.leverage}x`);

            const side = type === 'LONG' ? 'BUY' : 'SELL';

            const order = await this.client.futuresOrder({
                symbol: this.symbol,
                side: side,
                type: 'MARKET',
                quantity: quantity
            });

            this.log('SUCCESS', `ORDER FILLED: ID ${order.orderId}, AvgPrice ${order.avgPrice || price}`);

            const fillPrice = parseFloat(order.avgPrice || price); // Use fill price if available

            this.position = {
                type,
                entryPrice: fillPrice,
                margin: margin,
                size: quantity,
                entryTime: Date.now(),
                entryCandleTime: candleTime,
                highestPrice: fillPrice,
                lowestPrice: fillPrice,
                entryCommission: 0, // Commission is deducted from asset usually
                accumulatedFunding: 0,
                lastFundingCheck: Date.now()
            };

            // Update balance after trade
            await this.syncAccountState(); // Re-sync balance
            this.onStateChange();

        } catch (err) {
            this.log('ERROR', `ORDER FAILED: ${err.message}`);
            // Optionally alarm here?
        }
    }

    async closePosition(price, reason) {
        if (!this.position) return;

        this.log('INFO', `EXECUTING REAL CLOSE (${reason})...`);

        try {
            const side = this.position.type === 'LONG' ? 'SELL' : 'BUY';
            const quantity = this.position.size;

            const order = await this.client.futuresOrder({
                symbol: this.symbol,
                side: side,
                type: 'MARKET',
                quantity: quantity
            });

            this.log('SUCCESS', `CLOSE ORDER FILLED: ID ${order.orderId}, AvgPrice ${order.avgPrice || price}`);

            const exitPrice = parseFloat(order.avgPrice || price);

            // Calculate PnL locally for history (Simulated for record keeping)
            let pnlRaw = this.position.type === 'LONG' ?
                (exitPrice - this.position.entryPrice) * this.position.size :
                (this.position.entryPrice - exitPrice) * this.position.size;

            const trade = {
                ...this.position,
                exitPrice: exitPrice,
                exitTime: Date.now(),
                pnl: pnlRaw, // Approx pnl
                commission: 0, // Hard to fetch exact comms immediately
                funding: 0,
                reason: reason,
                roi: (pnlRaw / this.position.margin) * 100
            };

            this.trades.push(trade);
            const prevType = this.position.type;
            this.position = null;

            // Update balance after trade
            await this.syncAccountState(); // Re-sync balance

            // --- Spirit Re-entry Logic ---
            this.handleSpiritReEntry(reason, prevType, exitPrice);
            this.onStateChange();

        } catch (err) {
            this.log('ERROR', `CLOSE ORDER FAILED (CRITICAL): ${err.message}`);
        }
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

        this.log('INFO', `${this.strategy} - Re-entry queued for next candle at ${targetEntryPrice || 'Market'} price.`);
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
            roi: ((this.balance - this.initialCapital) / this.initialCapital) * 100, // ROI relative to initial capital set in config (visual only)
            lastPrice: this.candles.length > 0 ? this.candles[this.candles.length - 1].close : 0,
            startTime: this.startTime
        };
    }
}

module.exports = TradingEngine;
