const { fetchKlines, fetchFundingRate, fetchFundingInfo, fetchCommissionRate, fetchExchangeInfo, roundToStepSize } = require('./binance');
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
        this.waitingForLimitFill = null; // { orderId, type, price, quantity, setupTime, initialSL }
        this.lastFundingUpdate = 0;
        this.startTime = Date.now(); // Track session start
        this.isClosing = false; // Lock to prevent concurrent close calls
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

        // Fetch exchange info for correct precision (stepSize, minNotional, etc.)
        try {
            this.exchangeInfo = await fetchExchangeInfo(this.symbol);
            this.log('INFO', `Exchange info loaded: stepSize=${this.exchangeInfo.stepSize}, minQty=${this.exchangeInfo.minQty}`);
        } catch (err) {
            this.log('WARN', `Could not fetch exchange info: ${err.message}. Using defaults.`);
            this.exchangeInfo = { stepSize: 0.001, minQty: 0.001, minNotional: 5 };
        }

        const ratePercent = (this.currentFundingRate * 100).toFixed(4);
        this.log('SUCCESS', `LIVE READY. Funding: ${ratePercent}%`);
    }

    async syncAccountState() {
        try {
            // Get balance using correct method
            const balances = await this.client.futuresAccountBalance();
            const usdtAsset = balances.find(a => a.asset === 'USDT');
            if (usdtAsset) {
                this.balance = parseFloat(usdtAsset.availableBalance);
            }

            // Get positions using correct method
            const positions = await this.client.futuresPositionRisk();
            const binancePosition = positions.find(p => p.symbol === this.symbol && parseFloat(p.positionAmt) !== 0);

            if (binancePosition) {
                const amt = parseFloat(binancePosition.positionAmt);
                const entryPrice = parseFloat(binancePosition.entryPrice);
                const type = amt > 0 ? 'LONG' : 'SHORT';
                const size = Math.abs(amt);

                // If we already have local tracking, preserve it (for trailing stop, funding, etc.)
                if (this.position && this.position.type === type && Math.abs(this.position.size - size) < 0.0001) {
                    // Same position - just update entry price from Binance (more accurate)
                    this.position.entryPrice = entryPrice;
                    // Keep existing: highestPrice, lowestPrice, accumulatedFunding, lastFundingCheck
                } else {
                    // New position detected or size changed - create fresh tracking
                    this.position = {
                        type,
                        entryPrice: entryPrice,
                        margin: Math.abs(amt * entryPrice) / this.leverage,
                        size: size,
                        entryTime: this.position?.entryTime || Date.now(),
                        entryCandleTime: this.position?.entryCandleTime || Date.now(),
                        highestPrice: this.position?.highestPrice || entryPrice,
                        lowestPrice: this.position?.lowestPrice || entryPrice,
                        entryCommission: this.position?.entryCommission || 0,
                        accumulatedFunding: this.position?.accumulatedFunding || 0,
                        lastFundingCheck: this.position?.lastFundingCheck || Date.now()
                    };
                    this.log('WARN', `Detected EXISTING position: ${type} ${size} @ ${entryPrice}`);
                }
            } else if (!binancePosition && this.position) {
                // Position closed on Binance but we still have local tracking
                this.log('WARN', `Local position cleared - no position found on Binance`);
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

    /**
     * Get real commission and PnL from a specific order's trades
     * @param {number} orderId - The order ID from Binance
     * @returns {Object} { commission, realizedPnl, avgPrice }
     */
    async getRealTradeData(orderId) {
        try {
            // Fetch trades for this symbol
            const trades = await this.client.futuresUserTrades({
                symbol: this.symbol,
                limit: 50 // Recent trades should include our order
            });

            // Filter trades for this specific order
            const orderTrades = trades.filter(t => t.orderId === orderId);

            if (orderTrades.length === 0) {
                this.log('WARN', `No trades found for order ${orderId}`);
                return null;
            }

            // Sum up commission and realized PnL from all fills
            let totalCommission = 0;
            let totalRealizedPnl = 0;
            let totalQty = 0;
            let totalQuoteQty = 0;

            orderTrades.forEach(t => {
                totalCommission += Math.abs(parseFloat(t.commission || 0));
                totalRealizedPnl += parseFloat(t.realizedPnl || 0);
                totalQty += parseFloat(t.qty || 0);
                totalQuoteQty += parseFloat(t.quoteQty || 0);
            });

            const avgPrice = totalQty > 0 ? totalQuoteQty / totalQty : 0;

            this.log('INFO', `Real Trade Data: Commission=${totalCommission.toFixed(4)}, PnL=${totalRealizedPnl.toFixed(4)}, AvgPrice=${avgPrice.toFixed(6)}`);

            return {
                commission: totalCommission,
                realizedPnl: totalRealizedPnl,
                avgPrice: avgPrice
            };
        } catch (err) {
            this.log('WARN', `Failed to get real trade data: ${err.message}`);
            return null;
        }
    }

    /**
     * Get real funding fees paid for this symbol since a given time
     * @param {number} startTime - Timestamp to start from
     * @returns {number} Total funding fee paid (negative = paid, positive = received)
     */
    async getRealFundingPaid(startTime) {
        try {
            const income = await this.client.futuresIncome({
                symbol: this.symbol,
                incomeType: 'FUNDING_FEE',
                startTime: startTime,
                limit: 100
            });

            const totalFunding = income.reduce((sum, i) => sum + parseFloat(i.income || 0), 0);
            this.log('INFO', `Real Funding Fee since ${new Date(startTime).toISOString()}: ${totalFunding.toFixed(4)} USDT`);
            return totalFunding;
        } catch (err) {
            this.log('WARN', `Failed to get real funding: ${err.message}`);
            return 0;
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

        // Check pending limit order status (throttle to avoid API bans, e.g., every 5s or on final candle)
        // Check more often for responsiveness, but respect limits. Every 2s roughly?
        // Simple heuristic: Check on every update if it's been > 2000ms since last check
        if (this.waitingForLimitFill) {
            const now = Date.now();
            if (!this.waitingForLimitFill.lastCheck || now - this.waitingForLimitFill.lastCheck > 2000) {
                this.checkPendingOrder();
                this.waitingForLimitFill.lastCheck = now;
            }
        }

        // Increment candlesSinceEntry for BACKGUARD logic
        if (newCandle.isFinal && this.position) {
            this.position.candlesSinceEntry = (this.position.candlesSinceEntry || 0) + 1;
        }

        // Track funding for statistics (Binance handles actual balance deductions)
        this.trackFundingForStats(newCandle.time);
    }

    /**
     * Track funding payments for statistics/history purposes.
     * NOTE: Does NOT modify balance - Binance handles that automatically.
     * This only tracks accumulatedFunding for the trade history.
     */
    trackFundingForStats(currentTime) {
        if (!this.position) return;

        const intervalHours = this.fundingIntervalHours || 8;

        // Ensure we track the last check time
        if (!this.position.lastFundingCheck) {
            this.position.lastFundingCheck = this.position.entryTime;
        }

        // Helper to align to next boundary
        const getNextBoundary = (time) => {
            const date = new Date(time);
            date.setUTCHours(Math.floor(date.getUTCHours() / intervalHours) * intervalHours + intervalHours, 0, 0, 0);
            return date.getTime();
        };

        let nextBoundary = getNextBoundary(this.position.lastFundingCheck);

        // Process funding windows that have passed
        while (currentTime >= nextBoundary) {
            const currentPrice = this.candles.length > 0 ? this.candles[this.candles.length - 1].close : this.position.entryPrice;
            const rate = this.currentFundingRate || 0;
            const notional = this.position.size * currentPrice;
            let fundingPayment = notional * rate;

            // LONG pays positive rate, SHORT receives
            let amountPaid = this.position.type === 'LONG' ? fundingPayment : -fundingPayment;

            // Track for statistics only (balance is managed by Binance)
            this.position.accumulatedFunding = (this.position.accumulatedFunding || 0) + amountPaid;

            const dateStr = new Date(nextBoundary).toISOString().substring(11, 16);
            this.log('INFO', `FUNDING TRACKED (${dateStr}): Rate ${(rate * 100).toFixed(4)}%, Amount: ${amountPaid.toFixed(4)} USDT`);

            // Advance to next boundary
            this.position.lastFundingCheck = nextBoundary;
            nextBoundary = getNextBoundary(this.position.lastFundingCheck);
        }
    }

    processSignal() {
        const candle = this.candles[this.candles.length - 1];
        const signal = candle.signalStr;
        const isTrigger = candle.isTrigger;

        // --- BACKGUARD REVERSAL LOGIC ---
        // If we have a position or pending order and get opposite signal -> Close/Cancel
        if (this.position || this.waitingForLimitFill) {
            const currentType = this.position ? this.position.type : (this.waitingForLimitFill ? this.waitingForLimitFill.type : null);
            const oppositeSignal = currentType === 'LONG' ? 'Sell' : 'Buy';

            if (isTrigger && signal === oppositeSignal) {
                if (this.position) {
                    this.closePosition(candle.close, 'Signal Reversal');
                }
                if (this.waitingForLimitFill) {
                    this.cancelPendingOrder('Signal Reversal');
                }
                return;
            }
        }

        if (!this.position && !this.waitingForLimitFill) {
            const isSpiritReEntry = this.pendingReEntry && signal === this.pendingReEntry.neededSignal;

            if (isTrigger || isSpiritReEntry) {
                const type = (signal === 'Buy') ? 'LONG' : 'SHORT';
                const canEnter = (type === 'LONG' && (this.direction === 'BOTH' || this.direction === 'LONG')) ||
                    (type === 'SHORT' && (this.direction === 'BOTH' || this.direction === 'SHORT'));

                if (canEnter) {
                    const targetPrice = (this.pendingReEntry && this.pendingReEntry.entryPrice) || candle.close;

                    if (this.strategy === 'BACKGUARD') {
                        // BACKGUARD: Place LIMIT order at candle close
                        // Verify we are not blindly placing limits far from price if delaying?
                        // No, strategy says "Limit at Closing Price of Signal Candle".
                        this.placeLimitOrder(type, targetPrice, candle.time);
                    } else {
                        // Market Entry for other strategies
                        this.openPosition(type, targetPrice, candle.time);
                    }
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

        // --- BACKGUARD SL LOGIC ---
        if (this.strategy === 'BACKGUARD') {
            const candlesStored = p.candlesSinceEntry || 0;

            // 1. Initial SL (Fixed from setup)
            let currentSL = p.initialSL;

            // 2. Trailing Stop (Active after 3 candles)
            if (candlesStored >= 3) {
                // Trailing 1% (0.01)
                const trailingDist = 0.01;
                if (p.type === 'LONG') {
                    const trailingVal = p.highestPrice * (1 - trailingDist);
                    if (trailingVal > currentSL) currentSL = trailingVal;
                } else {
                    const trailingVal = p.lowestPrice * (1 + trailingDist);
                    if (trailingVal < currentSL || currentSL === 0) currentSL = trailingVal;
                }
            }
            effectiveSL = currentSL;

        } else {
            // --- STANDARD MODES ---
            if (this.slMode === 'NONE') {
                effectiveSL = 0;
            } else if (this.slMode === 'FIXED') {
                effectiveSL = p.type === 'LONG' ? p.entryPrice * (1 - slRate) : p.entryPrice * (1 + slRate);
            } else if (this.slMode === 'BREAKEVEN') {
                effectiveSL = p.entryPrice;
            } else if (this.slMode === 'TRAILING') {
                effectiveSL = p.type === 'LONG' ? p.highestPrice * (1 - trailingRate) : p.lowestPrice * (1 + trailingRate);
            }
        }

        if (this.strategy === 'SPIRIT_EXPERIMENTAL' && !p.experimentalSLSet) {
            const currentCandle = this.candles[this.candles.length - 1];
            if (currentCandle.time > p.entryCandleTime) {
                p.experimentalSL = currentCandle.close;
                p.experimentalSLSet = true;
                this.log('INFO', `SPIRIT_EXPERIMENTAL SL set at ${p.experimentalSL}`);
            }
        }

        // SPIRIT_EXPERIMENTAL_FIXED: Same but with activation delay
        if (this.strategy === 'SPIRIT_EXPERIMENTAL_FIXED' && !p.experimentalSLSet) {
            const currentCandle = this.candles[this.candles.length - 1];
            if (currentCandle.time > p.entryCandleTime) {
                p.experimentalSL = currentCandle.close;
                p.experimentalSLSet = true;
                p.experimentalSLActivatedTime = Date.now();
                this.log('INFO', `SPIRIT_EXPERIMENTAL_FIXED SL set at ${p.experimentalSL} (activation delayed 500ms)`);
            }
        }

        let hit = false;
        if (p.type === 'LONG') {
            if (effectiveSL > 0 && tick.low <= effectiveSL) hit = true;
            if (this.strategy === 'SPIRIT_EXPERIMENTAL' && p.experimentalSLSet && tick.low <= p.experimentalSL) {
                hit = true;
                effectiveSL = p.experimentalSL;
            }
            // FIXED version: wait 500ms after SL is set
            if (this.strategy === 'SPIRIT_EXPERIMENTAL_FIXED' && p.experimentalSLSet && tick.low <= p.experimentalSL) {
                const timeSinceSLSet = Date.now() - (p.experimentalSLActivatedTime || 0);
                if (timeSinceSLSet > 500) {
                    hit = true;
                    effectiveSL = p.experimentalSL;
                }
            }
        } else if (p.type === 'SHORT') {
            if (effectiveSL > 0 && tick.high >= effectiveSL) hit = true;
            if (this.strategy === 'SPIRIT_EXPERIMENTAL' && p.experimentalSLSet && tick.high >= p.experimentalSL) {
                hit = true;
                effectiveSL = p.experimentalSL;
            }
            // FIXED version: wait 500ms after SL is set
            if (this.strategy === 'SPIRIT_EXPERIMENTAL_FIXED' && p.experimentalSLSet && tick.high >= p.experimentalSL) {
                const timeSinceSLSet = Date.now() - (p.experimentalSLActivatedTime || 0);
                if (timeSinceSLSet > 500) {
                    hit = true;
                    effectiveSL = p.experimentalSL;
                }
            }
        }

        if (hit) {
            let reason = this.slMode === 'TRAILING' ? 'Trailing Stop' : (this.slMode === 'BREAKEVEN' ? 'Breakeven SL' : 'Stop Loss');
            if ((this.strategy === 'SPIRIT_EXPERIMENTAL' || this.strategy === 'SPIRIT_EXPERIMENTAL_FIXED') && p.experimentalSLSet && effectiveSL === p.experimentalSL) {
                reason = 'Stop Loss (Experimental)';
            }
            this.closePosition(effectiveSL, reason);
        }
    }

    async openPosition(type, price, candleTime) {
        // Get exchange info for precision
        const stepSize = this.exchangeInfo?.stepSize || 0.001;
        const minQty = this.exchangeInfo?.minQty || 0.001;
        const minNotional = this.exchangeInfo?.minNotional || 5;

        // Calculate margin and check balance
        const margin = Math.min(this.orderSize, this.balance);
        const estimatedFee = margin * (this.takerFee || 0.0004);
        const requiredBalance = margin + estimatedFee;

        // Improved balance validation
        if (this.balance < requiredBalance) {
            this.log('WARN', `Insufficient balance: ${this.balance.toFixed(2)} < ${requiredBalance.toFixed(2)} USDT needed`);
            return;
        }

        // Calculate and round quantity using Binance stepSize
        const rawQuantity = (margin * this.leverage) / price;
        const quantity = roundToStepSize(rawQuantity, stepSize);

        // Validate minimum quantity
        if (quantity < minQty) {
            this.log('WARN', `Quantity ${quantity} below minimum ${minQty}, aborting.`);
            return;
        }

        // Validate minimum notional value
        const notional = quantity * price;
        if (notional < minNotional) {
            this.log('WARN', `Notional ${notional.toFixed(2)} below minimum ${minNotional}, aborting.`);
            return;
        }

        try {
            this.log('INFO', `EXECUTING REAL ${type} ORDER: Size ${quantity}, Price ~${price}, Leverage ${this.leverage}x`);

            const side = type === 'LONG' ? 'BUY' : 'SELL';

            const order = await this.client.futuresOrder({
                symbol: this.symbol,
                side: side,
                type: 'MARKET',
                quantity: quantity,
                newOrderRespType: 'RESULT' // Get avgPrice in response
            });

            // Log full response for debugging
            this.log('INFO', `Order Response: ${JSON.stringify({ orderId: order.orderId, status: order.status, avgPrice: order.avgPrice, executedQty: order.executedQty })}`);
            this.log('SUCCESS', `ORDER FILLED: ID ${order.orderId}, AvgPrice ${order.avgPrice || price}`);

            // Get real trade data from Binance
            const realData = await this.getRealTradeData(order.orderId);
            const fillPrice = realData?.avgPrice || parseFloat(order.avgPrice || price);
            const entryCommission = realData?.commission || (quantity * fillPrice * (this.takerFee || 0.0004));

            this.position = {
                type,
                entryPrice: fillPrice,
                margin: margin,
                size: quantity,
                entryTime: Date.now(),
                entryCandleTime: candleTime,
                highestPrice: fillPrice,
                lowestPrice: fillPrice,
                entryCommission: entryCommission, // Real commission from Binance
                entryOrderId: order.orderId, // Store order ID for reference
                accumulatedFunding: 0,
                lastFundingCheck: Date.now()
            };

            // Update balance after trade
            await this.syncAccountState();
            this.onStateChange();

        } catch (err) {
            this.log('ERROR', `ORDER FAILED: ${err.message}`);
        }
    }

    async closePosition(price, reason) {
        if (!this.position) return;
        if (this.isClosing) {
            this.log('WARN', 'Close already in progress, skipping...');
            return;
        }

        this.isClosing = true; // Set lock
        this.log('INFO', `EXECUTING REAL CLOSE (${reason})...`);

        try {
            const side = this.position.type === 'LONG' ? 'SELL' : 'BUY';
            const quantity = this.position.size;

            const order = await this.client.futuresOrder({
                symbol: this.symbol,
                side: side,
                type: 'MARKET',
                quantity: quantity,
                newOrderRespType: 'RESULT' // Get avgPrice in response
            });

            // Log full response for debugging
            this.log('INFO', `Close Response: ${JSON.stringify({ orderId: order.orderId, status: order.status, avgPrice: order.avgPrice, executedQty: order.executedQty })}`);
            this.log('SUCCESS', `CLOSE ORDER FILLED: ID ${order.orderId}, AvgPrice ${order.avgPrice || price}`);

            // Get real trade data from Binance for the exit
            const realExitData = await this.getRealTradeData(order.orderId);
            const exitPrice = realExitData?.avgPrice || parseFloat(order.avgPrice || price);
            const exitCommission = realExitData?.commission || (this.position.size * exitPrice * (this.takerFee || 0.0004));

            // Get real funding paid during the position
            const realFunding = await this.getRealFundingPaid(this.position.entryTime);

            // Calculate total commission (entry + exit)
            const totalCommission = (this.position.entryCommission || 0) + exitCommission;

            // Use Binance's realized PnL if available, otherwise calculate
            let netPnL;
            if (realExitData?.realizedPnl !== undefined && realExitData.realizedPnl !== 0) {
                // Binance gives us the exact PnL (already considers commissions on close side)
                netPnL = realExitData.realizedPnl;
                this.log('INFO', `Using Binance Realized PnL: ${netPnL.toFixed(4)} USDT`);
            } else {
                // Fallback calculation
                const pnlRaw = this.position.type === 'LONG' ?
                    (exitPrice - this.position.entryPrice) * this.position.size :
                    (this.position.entryPrice - exitPrice) * this.position.size;
                netPnL = pnlRaw - exitCommission;
            }

            const trade = {
                ...this.position,
                exitPrice: exitPrice,
                exitTime: Date.now(),
                pnl: netPnL,
                commission: totalCommission,
                funding: realFunding, // Real funding from Binance
                reason: reason,
                roi: (netPnL / this.position.margin) * 100
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
        } finally {
            this.isClosing = false; // Release lock
        }
    }



    async placeLimitOrder(type, price, candleTime) {
        // Calculate quantity similar to openPosition
        const stepSize = this.exchangeInfo?.stepSize || 0.001;
        const minQty = this.exchangeInfo?.minQty || 0.001;
        const minNotional = this.exchangeInfo?.minNotional || 5;

        const margin = Math.min(this.orderSize, this.balance);
        const estimatedFee = margin * (this.takerFee || 0.0004); // Estimate with worst case
        const requiredBalance = margin + estimatedFee;

        if (this.balance < requiredBalance) {
            this.log('WARN', `Insufficient balance for LIMIT: ${this.balance.toFixed(2)} < ${requiredBalance.toFixed(2)}`);
            return;
        }

        const rawQuantity = (margin * this.leverage) / price;
        const quantity = roundToStepSize(rawQuantity, stepSize);

        if (quantity < minQty) {
            this.log('WARN', `Limit Qty ${quantity} < min ${minQty}`);
            return;
        }
        if ((quantity * price) < minNotional) {
            this.log('WARN', `Limit Notional ${quantity * price} < min ${minNotional}`);
            return;
        }

        // Calculate Initial SL for Backguard (Min/Max of last 10 candles)
        // Note: Logic assumes slice(-10) are the 10 candles LEADING UP to this signal.
        const lookback = 10;
        const relevantCandles = this.candles.slice(-lookback);
        let initialSL = 0;
        if (relevantCandles.length > 0) {
            if (type === 'LONG') {
                initialSL = Math.min(...relevantCandles.map(c => c.low));
            } else {
                initialSL = Math.max(...relevantCandles.map(c => c.high));
            }
        }

        try {
            const side = type === 'LONG' ? 'BUY' : 'SELL';
            this.log('INFO', `PLACING LIMIT ${side} @ ${price}, Qty: ${quantity}. InitSL: ${initialSL}`);

            const order = await this.client.futuresOrder({
                symbol: this.symbol,
                side: side,
                type: 'LIMIT',
                timeInForce: 'GTC',
                quantity: quantity,
                price: price.toString(),
                newOrderRespType: 'RESULT'
            });

            this.waitingForLimitFill = {
                orderId: order.orderId,
                type: type,
                price: price, // Limit price
                initialSL: initialSL,
                quantity: quantity,
                setupTime: Date.now(),
                candleTime: candleTime,
                margin: margin
            };
            this.log('SUCCESS', `LIMIT ORDER PLACED. ID: ${order.orderId}`);

        } catch (err) {
            this.log('ERROR', `Failed to place LIMIT order: ${err.message}`);
        }
    }

    async checkPendingOrder() {
        if (!this.waitingForLimitFill) return;

        const { orderId, type, initialSL, margin, quantity, candleTime } = this.waitingForLimitFill;

        try {
            const order = await this.client.futuresOrder({
                symbol: this.symbol,
                orderId: orderId
            });

            if (order.status === 'FILLED') {
                this.log('SUCCESS', `LIMIT ORDER FILLED! ID: ${orderId}, AvgPrice: ${order.avgPrice}`);

                // Construct position
                const fillPrice = parseFloat(order.avgPrice);

                // Fetch real data for commission
                const realData = await this.getRealTradeData(orderId);
                const commission = realData?.commission || 0;

                this.position = {
                    type: type,
                    entryPrice: fillPrice,
                    margin: margin,
                    size: parseFloat(order.executedQty),
                    entryTime: Date.now(),
                    entryCandleTime: candleTime,
                    highestPrice: fillPrice,
                    lowestPrice: fillPrice,
                    initialSL: initialSL,
                    candlesSinceEntry: 0,
                    entryCommission: commission,
                    entryOrderId: orderId,
                    accumulatedFunding: 0,
                    lastFundingCheck: Date.now()
                };

                // Clear waiting state
                this.waitingForLimitFill = null;

                await this.syncAccountState(); // Sync real balance
                this.onStateChange();

            } else if (order.status === 'CANCELED' || order.status === 'EXPIRED' || order.status === 'REJECTED') {
                this.log('WARN', `Limit Order ${orderId} end state: ${order.status}`);
                this.waitingForLimitFill = null;
                this.onStateChange();
            } else {
                // Still NEW or PARTIALLY_FILLED
                // Optional: If timeout? For now GTC means we wait.
            }

        } catch (err) {
            this.log('WARN', `Error checking Pending Order ${orderId}: ${err.message}`);
        }
    }

    async cancelPendingOrder(reason) {
        if (!this.waitingForLimitFill) return;
        this.log('INFO', `Cancelling Pending Order ${this.waitingForLimitFill.orderId} due to: ${reason}`);

        try {
            await this.client.futuresCancelOrder({
                symbol: this.symbol,
                orderId: this.waitingForLimitFill.orderId
            });
            this.waitingForLimitFill = null;
            this.onStateChange();
        } catch (err) {
            this.log('WARN', `Failed to cancel order: ${err.message}`);
            // If error is "Unknown Order" it might be already closed/cancelled
            this.waitingForLimitFill = null; // Assume gone
            this.onStateChange();
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
            waitingForLimitFill: this.waitingForLimitFill,
            totalTrades: this.trades.length,
            trades: this.trades,
            roi: ((this.balance - this.initialCapital) / this.initialCapital) * 100, // ROI relative to initial capital set in config (visual only)
            lastPrice: this.candles.length > 0 ? this.candles[this.candles.length - 1].close : 0,
            startTime: this.startTime
        };
    }
}

module.exports = TradingEngine;
