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
        this.trailingPct = (config.trailingPct !== undefined && config.trailingPct !== '') ? parseFloat(config.trailingPct) : 1.0;
        this.direction = config.direction || 'BOTH';
        this.mode = 'REAL_BOT_01_LIVE'; // Distinct mode identifier for Real Money

        // =====================================================
        // SPIRIT_ELITE CONFIGURATION PARAMETERS
        // =====================================================
        // These control the SPIRIT_ELITE v4 strategy behavior.
        // See bot.js for full documentation of each parameter.
        //
        // eliteTrailingDefer: Candles before Trailing Stop activates (default: 5)
        this.eliteTrailingDefer = parseFloat(config.eliteTrailingDefer) || 5;
        // eliteTickOffset: Fixed points offset for Breakeven+Tick SL (e.g., 0.0001 for 1 tick)
        this.eliteTickOffset = parseFloat(config.eliteTickOffset) || 0.0001;
        // eliteActivationPct: [RESERVED - NOT IMPLEMENTED] See bot.js for details
        // this.eliteActivationPct = parseFloat(config.eliteActivationPct) || 0.002;

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
        this.candidates1m = []; // VANGUARD: Auxiliary 1m candles
        this.lastProcessedTime = 0;
        this.pendingReEntry = null; // { neededSignal }
        this.waitingForLimitFill = null; // { orderId, type, price, quantity, setupTime, initialSL }
        this.pendingVirtualOrder = null; // SPIRIT_ELITE: Virtual order simulated locally, executed as MARKET when conditions met
        this.activeStopOrder = null; // { orderId, stopPrice } - STOP_MARKET order on Binance
        this.lastFundingUpdate = 0;
        this.startTime = Date.now(); // Track session start
        this.isClosing = false; // Lock to prevent concurrent close calls
        this.onStateChange = config.onStateChange || (() => { });
        this.logger = config.onLog || ((l, m) => console.log(`[${l}] ${m}`));

        // SPIRIT_TEST Mirror Mode: real bot mirrors paper bot's decisions
        this.mirrorMode = this.strategy === 'SPIRIT_TEST';
        this.paperBotRef = null; // Set by server.js when linking paper↔real
        this.mirrorSL = null;    // Current SL level from paper bot
    }

    log(level, message) {
        this.logger(level, message);
    }

    // =============================================
    // SPIRIT_TEST MIRROR MODE
    // =============================================
    // Links this real bot to a paper bot instance.
    // Real bot places LIMIT orders at paper's exact prices.

    linkToPaperBot(paperEngine) {
        if (!this.mirrorMode) return;
        this.paperBotRef = paperEngine;

        const decimals = 5; // For logging low-price coins

        // When paper opens a position → place LIMIT at paper's price
        paperEngine.events.on('paper:open', async (data) => {
            if (data.symbol !== this.symbol.replace('USDT', '')) return;
            
            // If we already have a position or pending order, skip
            if (this.position || this.waitingForLimitFill) {
                this.log('WARN', `Mirror: Paper opened but real already has position/order, skipping`);
                return;
            }

            this.log('INFO', `🪞 Mirror: Paper opened ${data.type} @ ${data.price.toFixed(decimals)} → Placing LIMIT`);
            await this.placeLimitOrder(data.type, data.price, data.candleTime, 0, false);
        });

        // When paper updates SL → store it for our position
        paperEngine.events.on('paper:sl_update', async (data) => {
            if (data.symbol !== this.symbol.replace('USDT', '')) return;
            this.mirrorSL = data.trailingSLLevel;

            // If we have an open position, update the STOP_MARKET on Binance
            if (this.position) {
                const currentPrice = this.candles.length > 0 ? this.candles[this.candles.length - 1].close : this.position.entryPrice;
                await this.updateStopMarket(this.mirrorSL, currentPrice);
            }
        });

        // When paper closes → cancel our LIMIT if unfilled, or close our position
        paperEngine.events.on('paper:close', async (data) => {
            if (data.symbol !== this.symbol.replace('USDT', '')) return;

            if (this.waitingForLimitFill) {
                // Paper closed before our LIMIT filled → cancel, no loss
                this.log('INFO', `🪞 Mirror: Paper closed (${data.reason}) before LIMIT filled → Cancelling`);
                await this.cancelPendingOrder('Paper closed');
            } else if (this.position) {
                // Paper closed and we have an open position → close with MARKET
                this.log('INFO', `🪞 Mirror: Paper closed (${data.reason}) → Closing real position`);
                await this.closePosition(data.price, data.reason);
            }
            this.mirrorSL = null;
        });

        this.log('INFO', `🪞 Mirror mode ACTIVE: Linked to paper bot for ${this.symbol}`);
    }

    unlinkFromPaperBot() {
        if (this.paperBotRef) {
            this.paperBotRef.events.removeAllListeners('paper:open');
            this.paperBotRef.events.removeAllListeners('paper:sl_update');
            this.paperBotRef.events.removeAllListeners('paper:close');
            this.paperBotRef = null;
            this.log('INFO', `🪞 Mirror mode DEACTIVATED`);
        }
    }

    getPrecision(tickSize) {
        if (!isFinite(tickSize)) return 4;
        let e = 1;
        let p = 0;
        while (Math.round(tickSize * e) / e !== tickSize) {
            e *= 10;
            p++;
        }
        return p;
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
        this.log('SUCCESS', `✓ BOT LISTO. Funding Rate: ${ratePercent}%`);
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
                    const now = Date.now();
                    this.position = {
                        type,
                        entryPrice: entryPrice,
                        margin: Math.abs(amt * entryPrice) / this.leverage,
                        size: size,
                        entryTime: this.position?.entryTime || now,
                        entryCandleTime: this.position?.entryCandleTime || now,
                        highestPrice: this.position?.highestPrice || entryPrice,
                        lowestPrice: this.position?.lowestPrice || entryPrice,
                        entryCommission: this.position?.entryCommission || 0,
                        accumulatedFunding: this.position?.accumulatedFunding || 0,
                        lastFundingCheck: this.position?.lastFundingCheck || now,
                        // SPIRIT_ELITE / BACKGUARD fields - critical for SL logic
                        candlesSinceEntry: this.position?.candlesSinceEntry || 0,
                        lastCandleTime: this.position?.lastCandleTime || now,
                        // SPIRIT_EXPERIMENTAL fields
                        experimentalSL: this.position?.experimentalSL || null,
                        experimentalSLSet: this.position?.experimentalSLSet || false
                    };
                    this.log('WARN', `Detected EXISTING position: ${type} ${size} @ ${entryPrice}`);
                }
            } else if (!binancePosition && this.position) {
                // Position closed on Binance but we still have local tracking
                this.log('WARN', `Local position cleared - no position found on Binance`);
                this.position = null;
            }
        } catch (err) {
            const msg = err.message || '';
            if (msg.includes('API-key') || msg.includes('permissions') || msg.includes('code -2015') || msg.includes('code -2014') || msg.includes('code -1022')) {
                // Fetch public IP to show in error
                try {
                    // Try to fetch IP dynamically. If fetch fails (no net/old node), fallback to 'unknown'
                    // Using a dynamically imported fetch or node https if needed, but assuming fetch global in modern node
                    /* global fetch */
                    let ip = 'unknown';
                    try {
                        const response = await fetch('https://api.ipify.org?format=json');
                        const data = await response.json();
                        ip = data.ip;
                    } catch (e) {
                        ip = 'unknown (network fail)';
                    }
                    this.log('ERROR', `Error fetching balance: Invalid API-key, IP, or permissions for action, request ip: ${ip}`);
                } catch (e2) {
                    this.log('ERROR', `Error fetching balance: Invalid API-key... (IP lookup failed)`);
                }
            } else {
                this.log('ERROR', `Sync State Error: ${msg}`);
            }
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
    async update(newCandle) {
        // Track last tick time from Binance for accurate timestamping
        this.lastTickTime = newCandle.time;

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
            await this.processSignal();
            this.lastProcessedTime = newCandle.time;
        }

        await this.manageOpenPosition(newCandle);

        // SPIRIT_ELITE: Check virtual order fill (simulates paper bot logic, executes MARKET when triggered)
        await this.checkPendingVirtualOrder(newCandle);

        // NOTE: Pending limit order fills are now handled via User Data Stream (WebSocket)
        // See realBotManager.handleOrderTradeUpdate() -> this.onOrderFilled()
        // checkPendingOrder() is kept as fallback but not called in normal operation

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

        // CRITICAL: Save reference to prevent race conditions
        const p = this.position;
        
        const intervalHours = this.fundingIntervalHours || 8;

        // Ensure we track the last check time
        if (!p.lastFundingCheck) {
            p.lastFundingCheck = p.entryTime;
        }

        // Helper to align to next boundary
        const getNextBoundary = (time) => {
            const date = new Date(time);
            date.setUTCHours(Math.floor(date.getUTCHours() / intervalHours) * intervalHours + intervalHours, 0, 0, 0);
            return date.getTime();
        };

        let nextBoundary = getNextBoundary(p.lastFundingCheck);

        // Process funding windows that have passed
        while (currentTime >= nextBoundary) {
            // Check if position still exists (could be closed by another call)
            if (!this.position) return;
            
            const currentPrice = this.candles.length > 0 ? this.candles[this.candles.length - 1].close : p.entryPrice;
            const rate = this.currentFundingRate || 0;
            const notional = p.size * currentPrice;
            let fundingPayment = notional * rate;

            // LONG pays positive rate, SHORT receives
            let amountPaid = p.type === 'LONG' ? fundingPayment : -fundingPayment;

            // Track for statistics only (balance is managed by Binance)
            p.accumulatedFunding = (p.accumulatedFunding || 0) + amountPaid;

            const dateStr = new Date(nextBoundary).toISOString().substring(11, 16);
            this.log('INFO', `FUNDING TRACKED (${dateStr}): Rate ${(rate * 100).toFixed(4)}%, Amount: ${amountPaid.toFixed(4)} USDT`);

            // Advance to next boundary
            p.lastFundingCheck = nextBoundary;
            nextBoundary = getNextBoundary(p.lastFundingCheck);
        }
    }

    async processAuxiliaryCandle(candle1m) {
        if (!this.position) return;

        // --- VANGUARD 5m IMMEDIATE REVERSAL (Priority 1) ---
        // Validate against the LAST CLOSED 5m Candle's Range Filter
        // We assume this.candles contains the 5m history.
        const last5m = this.candles.length > 0 ? this.candles[this.candles.length - 1] : null;
        if (last5m) {
            const refLevel = last5m.rngfilt;
            let reversalHit = false;

            if (this.position.type === 'LONG') { // LONG
                // If Price drops below Support (RF)
                // Use Low of 1m candle to detect breach
                if (candle1m.low < refLevel) reversalHit = true;
            } else { // SHORT
                // If Price rises above Resistance (RF)
                if (candle1m.high > refLevel) reversalHit = true;
            }

            if (reversalHit) {
                this.log('INFO', `[VANGUARD] 5m Reversal Detected (Immediate). 1m Low/High breached RF ${refLevel}`);
                await this.closePosition(refLevel, 'Vanguard 5m Reversal (Immediate)');
                return;
            }
        }

        // --- VANGUARD 1m LOGIC (Priority 2 & 3) ---
        // 1. Maintain a buffer of 1m candles (e.g., last 200 for indicators)
        // Ensure strictly increasing time
        if (this.candidates1m.length > 0 && candle1m.time <= this.candidates1m[this.candidates1m.length - 1].time) {
            return; // Duplicate or out of order
        }

        this.candidates1m.push(candle1m);
        if (this.candidates1m.length > 200) this.candidates1m.shift();

        // 2. Only process logic if we HAVE A POSITION
        if (!this.position) return;

        // 3. Calculate 1m Indicators (Range Filter)
        // Use standard params for 1m: Period 100, Multiplier 3 (or maybe faster like 50/2?) 
        // Plan implies "same params" but applied to 1m.
        const sigs1m = calculateRangeFilter(this.candidates1m, { period: 100, multiplier: 3.0 });
        if (sigs1m.length === 0) return;

        const lastSig = sigs1m[sigs1m.length - 1]; // Current 1m candle (just closed or forming? "k.x" in stream means closed)
        const prevSig = sigs1m.length > 1 ? sigs1m[sigs1m.length - 2] : null;

        if (!candle1m.isFinal) return; // Wait for candle close for decisions

        const positionType = this.position.type;
        const neededReversal = positionType === 'LONG' ? 'Sell' : 'Buy';

        // --- VANGUARD EXIT LOGIC ---

        // Condition 2: Dual 1m Reversal (2 consecutive opposite signals)
        // e.g. previous was Sell, current is Sell (and persistent)
        // Initialize Vanguard State if new position or not exists
        if (!this.vanguardState) {
            this.vanguardState = {
                oppositeCount: 0,
                lastProcessedTime: 0,
                positionSize: this.position.size
            };
        }
        // Safety Reset if position changed
        if (this.vanguardState.positionSize !== this.position.size) {
            this.vanguardState = {
                oppositeCount: 0,
                lastProcessedTime: 0,
                positionSize: this.position.size
            };
        }

        // Prevent double processing of the same candle time
        if (this.vanguardState.lastProcessedTime === candle1m.time) return;
        this.vanguardState.lastProcessedTime = candle1m.time;

        const currentState = lastSig.state;
        const previousState = prevSig ? prevSig.state : null;

        // Detect Flip to Needed Reversal
        if (prevSig) {
            // If we moved from "Not Needed" to "Needed"
            if (currentState === neededReversal && previousState !== neededReversal) {
                this.vanguardState.oppositeCount++;
                this.log('INFO', `[VANGUARD] Opposite Signal Count: ${this.vanguardState.oppositeCount}`);
            }
        }

        // Condition 2: 2nd Opposite Signal
        if (this.vanguardState.oppositeCount >= 2) {
            this.log('INFO', `[VANGUARD] Exit Condition 2: Dual 1m Reversal (Count 2). Closing.`);
            await this.closePosition(candle1m.close, 'Vanguard Dual-1m Exit');
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
                this.log('INFO', `[VANGUARD] QC3: Wick Exit.`);
                await this.closePosition(candle1m.close, 'Vanguard 1m Wick Exit');
                return;
            }
        }
    }

    async processSignal() {
        // SPIRIT_TEST Mirror Mode: Skip signal processing, paper bot controls everything
        if (this.mirrorMode) return;

        const candle = this.candles[this.candles.length - 1];
        const signal = candle.signalStr;
        const isTrigger = candle.isTrigger;

        // --- REVERSAL LOGIC ---
        // If we have a position, pending LIMIT order, or pending VIRTUAL order and get opposite signal -> Close/Cancel
        if (this.position || this.waitingForLimitFill || this.pendingVirtualOrder) {
            const currentType = this.position ? this.position.type : 
                               (this.waitingForLimitFill ? this.waitingForLimitFill.type : 
                               (this.pendingVirtualOrder ? this.pendingVirtualOrder.type : null));
            const oppositeSignal = currentType === 'LONG' ? 'Sell' : 'Buy';

            if (isTrigger && signal === oppositeSignal) {
                if (this.position) {
                    await this.closePosition(candle.close, 'Signal Reversal');
                }
                if (this.waitingForLimitFill) {
                    await this.cancelPendingOrder('Signal Reversal');
                }
                if (this.pendingVirtualOrder) {
                    this.cancelPendingVirtualOrder('Signal Reversal');
                }
                // Allow fall-through to immediate entry logic below
            }
        }

        if (!this.position && !this.waitingForLimitFill && !this.pendingVirtualOrder) {
            const isSpiritReEntry = this.pendingReEntry && signal === this.pendingReEntry.neededSignal;

            if (isTrigger || isSpiritReEntry) {
                const type = (signal === 'Buy') ? 'LONG' : 'SHORT';
                const canEnter = (type === 'LONG' && (this.direction === 'BOTH' || this.direction === 'LONG')) ||
                    (type === 'SHORT' && (this.direction === 'BOTH' || this.direction === 'SHORT'));

                if (canEnter) {
                    const targetPrice = (this.pendingReEntry && this.pendingReEntry.entryPrice) || candle.close;

                    if (this.strategy === 'BACKGUARD') {
                        // BACKGUARD: Place LIMIT order at candle close
                        await this.placeLimitOrder(type, targetPrice, candle.time);
                    } else if (this.strategy === 'SPIRIT_ELITE') {
                        // SPIRIT_ELITE: Immediate MARKET entry at candle.close
                        // Same entry point as Backtest - no virtual order, no waiting
                        const decimals = targetPrice < 1 ? 5 : 4;
                        this.log('INFO', `🎯 SPIRIT_ELITE - Entrada MARKET: ${type} @ ${targetPrice.toFixed(decimals)}`);
                        await this.openPosition(type, targetPrice, candle.time);
                    } else {
                        // Market Entry for other strategies
                        await this.openPosition(type, targetPrice, candle.time);
                    }
                }
                this.pendingReEntry = null;
            }
        }
    }

    async manageOpenPosition(tick) {
        if (!this.position) return;

        const p = this.position;
        const slRate = this.stopLossPct / 100;
        const trailingRate = this.trailingPct / 100;

        // ============================================================
        // SPIRIT_TEST Mirror Mode: Paper bot controls trailing & close.
        // Real bot only keeps STOP_MARKET updated as safety net.
        // All open/close decisions come from paper:open / paper:close events.
        // ============================================================
        if (this.strategy === 'SPIRIT_TEST' && this.mirrorMode) {
            // mirrorSL is set by paper:sl_update event handler
            // STOP_MARKET is already updated in the event handler
            // Nothing to do here — paper controls everything
            return;
        }

        // ============================================================
        // TRAILING MODE: Match backtest behavior exactly
        // Backtest flow: update extremes with candle[i] → calc SL → check candle[i+1]
        // - Extremes & SL recalculated ONLY on candle close (isFinal)
        // - SL checked AFTER entry candle (skip entry candle)
        // - STOP_MARKET order placed on Binance for precise execution
        // ============================================================
        const hasCustomSL = ['SPIRIT_ELITE', 'BACKGUARD', 'SPIRIT_SHIELD'].includes(this.strategy);
        if (this.slMode === 'TRAILING' && !hasCustomSL) {
            // On candle close: update extremes, recalculate trailing SL, place on Binance
            if (tick.isFinal) {
                if (p.type === 'LONG') p.highestPrice = Math.max(p.highestPrice || p.entryPrice, tick.high);
                else p.lowestPrice = Math.min(p.lowestPrice || p.entryPrice, tick.low);

                p.trailingSLLevel = p.type === 'LONG'
                    ? p.highestPrice * (1 - trailingRate)
                    : p.lowestPrice * (1 + trailingRate);

                // Place/update STOP_MARKET on Binance for precise execution
                if (p.trailingSLLevel > 0 && tick.time > p.entryCandleTime) {
                    await this.updateStopMarket(p.trailingSLLevel, tick.close);
                }
            }

            // Check hit only AFTER entry candle (matches backtest stopActiveFromIndex)
            // Local check as fallback — Binance STOP_MARKET handles actual execution
            if (tick.time > p.entryCandleTime && p.trailingSLLevel > 0) {
                let hit = false;
                if (p.type === 'LONG' && tick.low <= p.trailingSLLevel) hit = true;
                else if (p.type === 'SHORT' && tick.high >= p.trailingSLLevel) hit = true;

                if (hit) {
                    // Trust Binance STOP_MARKET if it's already placed at the right price
                    if (this.activeStopOrder) {
                        const stopMatches = Math.abs(this.activeStopOrder.stopPrice - p.trailingSLLevel) < (this.exchangeInfo?.tickSize || 0.0001);
                        if (stopMatches) {
                            const decimals = p.trailingSLLevel < 1 ? 5 : 4;
                            this.log('INFO', `⏳ Trailing SL hit @ ${p.trailingSLLevel.toFixed(decimals)} - Esperando ejecución de Binance...`);
                            return;
                        }
                    }
                    // Fallback: no active stop or price mismatch
                    if (this.activeStopOrder) await this.cancelStopMarket();
                    await this.closePosition(p.trailingSLLevel, 'Trailing Stop');
                }
            }
            return; // TRAILING fully handled, skip rest
        }

        // Update Extremes (for non-TRAILING modes)
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
        }

        // SPIRIT_EXPERIMENTAL: Set SL at the close of the candle AFTER entry
        if (this.strategy === 'SPIRIT_EXPERIMENTAL' && !p.experimentalSLSet) {
            const currentCandle = this.candles[this.candles.length - 1];
            // If the current candle is already AFTER the entry candle time
            if (currentCandle.time > p.entryCandleTime) {
                p.experimentalSL = currentCandle.close;
                p.experimentalSLSet = true;
                this.log('INFO', `SPIRIT_EXPERIMENTAL SL set at ${p.experimentalSL}`);
            }
        }

        // SPIRIT_EXPERIMENTAL_FIXED: Same as above BUT waits for NEXT tick before activating
        if (this.strategy === 'SPIRIT_EXPERIMENTAL_FIXED' && !p.experimentalSLSet) {
            const currentCandle = this.candles[this.candles.length - 1];
            if (currentCandle.time > p.entryCandleTime) {
                p.experimentalSL = currentCandle.close;
                p.experimentalSLSet = true;
                p.experimentalSLActivatedTime = Date.now(); // Mark when SL was set
                this.log('INFO', `SPIRIT_EXPERIMENTAL_FIXED SL set at ${p.experimentalSL} (activation delayed)`);
            }
        }

        // BACKGUARD & ELITE Logic: Update candle counter
        if (this.strategy === 'BACKGUARD' || this.strategy === 'SPIRIT_ELITE') {
            if (tick.time > p.lastCandleTime) {
                p.candlesSinceEntry++;
                p.lastCandleTime = tick.time;
                // this.log('DEBUG', `Candle +1. Total: ${p.candlesSinceEntry}`);
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

        // SPIRIT_ELITE v4: Experimental + Delayed Breakeven + Delayed Trailing
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
                    this.log('INFO', `[SPIRIT_ELITE] Experimental SL set at ${p.experimentalSL}`);
                }
            }

            // 2. Elite Breakeven (Entry +/- points offset) - Activates next candle
            let eliteBESL = 0;
            if (p.candlesSinceEntry >= 1) { // 1 candle closed means we are in the "next" candle
                // eliteTickOffset is now in POINTS (fixed price offset)
                const offsetVal = eliteTickOffset;

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
            
            // Debug log when SL type changes - use 5 decimals for low-price coins
            if (p.lastReportedSLType !== usedSLType && usedSLType !== 'None') {
                const decimals = p.entryPrice < 1 ? 5 : 4;
                this.log('INFO', `[SPIRIT_ELITE] SL Active: ${usedSLType} @ ${finalSL.toFixed(decimals)} | Entry: ${p.entryPrice.toFixed(decimals)} | Offset: ${eliteTickOffset} | Candles: ${p.candlesSinceEntry}`);
                p.lastReportedSLType = usedSLType;
            }
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

        // Update STOP/TP order on Binance when SL changes
        // This ensures precise execution at the SL price instead of market price
        if (effectiveSL > 0 && !hit) {
            await this.updateStopMarket(effectiveSL, tick.close);
        }

        if (hit) {
            // If we have an active stop order on Binance, it should execute automatically
            // at the exact stop price. Trust Binance instead of closing manually with MARKET.
            // The WebSocket ORDER_TRADE_UPDATE will notify us when it fills.
            if (this.activeStopOrder) {
                // Check if stop price matches our target - if so, Binance will handle it
                const stopMatches = Math.abs(this.activeStopOrder.stopPrice - effectiveSL) < (this.exchangeInfo?.tickSize || 0.0001);
                if (stopMatches) {
                    const decimals = effectiveSL < 1 ? 5 : 4;
                    this.log('INFO', `⏳ SL hit detectado @ ${effectiveSL.toFixed(decimals)} - Esperando ejecución de Binance...`);
                    return; // Let Binance execute the stop order at the exact price
                }
            }
            
            // Fallback: No active stop order or price mismatch - close manually
            if (this.activeStopOrder) {
                await this.cancelStopMarket();
            }
            
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
            await this.closePosition(effectiveSL, reason);
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
            
            // Use 5 decimals for low-price coins
            const decimals = price < 1 ? 5 : 4;
            this.log('SUCCESS', `✓ ORDEN MARKET ejecutada: ID ${order.orderId}, Precio ${parseFloat(order.avgPrice || price).toFixed(decimals)}`);

            // Get real trade data from Binance
            const realData = await this.getRealTradeData(order.orderId);
            const fillPrice = realData?.avgPrice || parseFloat(order.avgPrice || price);
            const entryCommission = realData?.commission || (quantity * fillPrice * (this.takerFee || 0.0004));

            this.position = {
                type,
                entryPrice: fillPrice,
                margin: margin,
                size: quantity,
                entryTime: candleTime,           // Use Binance candle time, not Date.now()
                entryCandleTime: candleTime,
                highestPrice: fillPrice,
                lowestPrice: fillPrice,
                entryCommission: entryCommission, // Real commission from Binance
                entryOrderId: order.orderId, // Store order ID for reference
                accumulatedFunding: 0,
                lastFundingCheck: candleTime,    // Use Binance candle time for funding tracking
                candlesSinceEntry: 0,            // SPIRIT_ELITE tracking
                lastCandleTime: candleTime,      // For BACKGUARD/ELITE candle counter
                // SPIRIT_ELITE / SPIRIT_EXPERIMENTAL fields - reset on new entry
                experimentalSL: null,
                experimentalSLSet: false,
                lastReportedSLType: null
            };

            // Update balance after trade
            await this.syncAccountState();
            this.onStateChange();

        } catch (err) {
            this.log('ERROR', `✗ ORDEN FALLIDA: ${err.message}`);
        }

        // VANGUARD State Reset
        if (this.strategy === 'VANGUARD') {
            this.vanguardState = {
                oppositeCount: 0,
                lastProcessedTime: 0,
                positionSize: this.position?.size || 0 // Track position size for change detection
            };
        }
    }

    async updateTrailingStop() {
        if (!this.position) return;
        if (this.isClosing) return;

        // VANGUARD: No Trailing Stop (Uses 1m Exit Logic)
        if (this.strategy === 'VANGUARD') return;

        const p = this.position;
        const trailingRate = this.trailingPct / 100;
        let currentSL = p.initialSL || 0; // Start with initial SL if set

        // BACKGUARD specific trailing logic
        if (this.strategy === 'BACKGUARD') {
            const candlesStored = p.candlesSinceEntry || 0;
            if (candlesStored >= 3) {
                const trailingDist = 0.01;
                if (p.type === 'LONG') {
                    const trailingVal = p.highestPrice * (1 - trailingDist);
                    if (trailingVal > currentSL) currentSL = trailingVal;
                } else {
                    const trailingVal = p.lowestPrice * (1 + trailingDist);
                    if (trailingVal < currentSL || currentSL === 0) currentSL = trailingVal;
                }
            }
        } else if (this.slMode === 'TRAILING') {
            // Standard trailing logic
            currentSL = p.type === 'LONG' ? p.highestPrice * (1 - trailingRate) : p.lowestPrice * (1 + trailingRate);
        }

        // Update position's effective SL for manageOpenPosition to use
        p.effectiveSL = currentSL;
    }

    async closePosition(price, reason) {
        if (!this.position) return;
        if (this.isClosing) {
            this.log('WARN', 'Close already in progress, skipping...');
            return;
        }

        this.isClosing = true; // Set lock
        
        // CRITICAL: Save position reference before any await calls
        // This prevents race conditions where another call could null this.position
        const p = this.position;
        
        // Cancel any active STOP_MARKET order first
        await this.cancelStopMarket();
        
        this.log('INFO', `EXECUTING REAL CLOSE (${reason})...`);

        try {
            const side = p.type === 'LONG' ? 'SELL' : 'BUY';
            const quantity = p.size;

            const order = await this.client.futuresOrder({
                symbol: this.symbol,
                side: side,
                type: 'MARKET',
                quantity: quantity,
                reduceOnly: true, // CRITICAL: Allows closing positions < 5 USD notional
                newOrderRespType: 'RESULT' // Get avgPrice in response
            });

            // Log full response for debugging
            this.log('INFO', `Close Response: ${JSON.stringify({ orderId: order.orderId, status: order.status, avgPrice: order.avgPrice, executedQty: order.executedQty })}`);
            // Use 5 decimals for low-price coins
            const decimals = p.entryPrice < 1 ? 5 : 4;
            this.log('SUCCESS', `✓ POSICIÓN CERRADA: ID ${order.orderId}, Precio ${parseFloat(order.avgPrice || price).toFixed(decimals)}`);

            // Get real trade data from Binance for the exit
            const realExitData = await this.getRealTradeData(order.orderId);
            const exitPrice = realExitData?.avgPrice || parseFloat(order.avgPrice || price);
            const exitCommission = realExitData?.commission || (p.size * exitPrice * (this.takerFee || 0.0004));

            // Log detailed exit info
            this.log('INFO', `📊 Entry: ${p.entryPrice.toFixed(decimals)} | Exit: ${exitPrice.toFixed(decimals)} | Diff: ${((exitPrice - p.entryPrice) * (p.type === 'LONG' ? 1 : -1)).toFixed(decimals)}`);

            // Get real funding paid during the position
            const realFunding = await this.getRealFundingPaid(p.entryTime);

            // Calculate total commission (entry + exit)
            const totalCommission = (p.entryCommission || 0) + exitCommission;

            // Use Binance's realized PnL if available, otherwise calculate
            let netPnL;
            if (realExitData?.realizedPnl !== undefined && realExitData.realizedPnl !== 0) {
                // Binance gives us the exact PnL (already considers commissions on close side)
                netPnL = realExitData.realizedPnl;
                this.log('INFO', `Using Binance Realized PnL: ${netPnL.toFixed(4)} USDT`);
            } else {
                // Fallback calculation
                const pnlRaw = p.type === 'LONG' ?
                    (exitPrice - p.entryPrice) * p.size :
                    (p.entryPrice - exitPrice) * p.size;
                netPnL = pnlRaw - exitCommission;
            }

            const trade = {
                ...p,
                exitPrice: exitPrice,
                exitTime: this.lastTickTime || Date.now(),  // Use Binance tick time for accuracy
                pnl: netPnL,
                commission: totalCommission,
                funding: realFunding, // Real funding from Binance
                reason: reason,
                roi: (netPnL / p.margin) * 100,
                eliteTickOffset: this.eliteTickOffset // Save offset used for this trade
            };

            this.trades.push(trade);
            const prevType = p.type;
            this.position = null;

            // Update balance after trade
            await this.syncAccountState(); // Re-sync balance

            // --- Spirit Re-entry Logic ---
            this.handleSpiritReEntry(reason, prevType, exitPrice);
            this.onStateChange();

        } catch (err) {
            this.log('ERROR', `✗ ERROR CRÍTICO AL CERRAR: ${err.message}`);
        } finally {
            this.isClosing = false; // Release lock
        }
    }

    // =============================================
    // STOP_MARKET ORDER MANAGEMENT
    // =============================================
    // These methods manage a STOP_MARKET order on Binance for precise SL execution

    /**
     * Place a STOP_MARKET order on Binance
     * @param {number} stopPrice - The price at which to trigger the stop
     * @param {number} currentPrice - Current market price to determine order type
     */
    async placeStopMarket(stopPrice, currentPrice) {
        if (!this.position) return;
        
        // Cancel any existing stop order first
        await this.cancelStopMarket();
        
        try {
            const side = this.position.type === 'LONG' ? 'SELL' : 'BUY';
            const quantity = this.position.size;
            
            // Round stop price to tick size
            const tickSize = this.exchangeInfo?.tickSize || 0.0001;
            const pricePrecision = this.getPrecision(tickSize);
            const roundedStopPrice = parseFloat(stopPrice.toFixed(pricePrecision));
            
            // Determine order type based on position and SL location:
            // - STOP_MARKET: triggers on loss (price moves against us)
            // - TAKE_PROFIT_MARKET: triggers on profit (price moves in our favor)
            //
            // For LONG + SELL:
            //   - SL below current price = loss = STOP_MARKET
            //   - SL above current price = profit = TAKE_PROFIT_MARKET
            // For SHORT + BUY:
            //   - SL above current price = loss = STOP_MARKET
            //   - SL below current price = profit = TAKE_PROFIT_MARKET
            let orderType;
            if (this.position.type === 'LONG') {
                orderType = roundedStopPrice < currentPrice ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET';
            } else {
                // SHORT
                orderType = roundedStopPrice > currentPrice ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET';
            }
            
            const decimals = roundedStopPrice < 1 ? 5 : 4;
            const typeLabel = orderType === 'TAKE_PROFIT_MARKET' ? 'TP_MARKET' : 'STOP_MARKET';
            this.log('INFO', `📌 Colocando ${typeLabel} @ ${roundedStopPrice.toFixed(decimals)}...`);
            
            const order = await this.client.futuresOrder({
                symbol: this.symbol,
                side: side,
                type: orderType,
                stopPrice: roundedStopPrice,
                quantity: quantity,
                reduceOnly: true,
                workingType: 'MARK_PRICE' // Use mark price to avoid manipulation
            });
            
            this.activeStopOrder = {
                orderId: order.orderId,
                stopPrice: roundedStopPrice,
                orderType: orderType
            };
            
            this.log('SUCCESS', `✓ ${typeLabel} colocado: ID ${order.orderId} @ ${roundedStopPrice.toFixed(decimals)}`);
            
        } catch (err) {
            this.log('ERROR', `✗ Error colocando STOP_MARKET: ${err.message}`);
        }
    }

    /**
     * Update the STOP_MARKET/TAKE_PROFIT_MARKET order with a new stop price
     * Only updates if the new price is different from current
     * @param {number} newStopPrice - The new stop price
     * @param {number} currentPrice - Current market price to determine order type
     */
    async updateStopMarket(newStopPrice, currentPrice) {
        if (!this.position) return;
        if (!newStopPrice || newStopPrice <= 0) return;
        
        // Round to tick size for comparison
        const tickSize = this.exchangeInfo?.tickSize || 0.0001;
        const pricePrecision = this.getPrecision(tickSize);
        const roundedNewPrice = parseFloat(newStopPrice.toFixed(pricePrecision));
        
        // Check if we need to update (price changed)
        if (this.activeStopOrder && Math.abs(this.activeStopOrder.stopPrice - roundedNewPrice) < tickSize) {
            return; // No change needed
        }
        
        const decimals = roundedNewPrice < 1 ? 5 : 4;
        this.log('INFO', `🔄 Actualizando SL: ${this.activeStopOrder?.stopPrice?.toFixed(decimals) || 'N/A'} → ${roundedNewPrice.toFixed(decimals)}`);
        
        // Cancel and replace
        await this.placeStopMarket(roundedNewPrice, currentPrice);
    }

    /**
     * Cancel the active STOP_MARKET order
     */
    async cancelStopMarket() {
        if (!this.activeStopOrder) return;
        
        try {
            await this.client.futuresCancelOrder({
                symbol: this.symbol,
                orderId: this.activeStopOrder.orderId
            });
            
            this.log('INFO', `🚫 STOP_MARKET cancelado: ID ${this.activeStopOrder.orderId}`);
            this.activeStopOrder = null;
            
        } catch (err) {
            // Order might already be filled or canceled
            if (err.code === -2011) {
                // Unknown order - already filled or canceled
                this.log('INFO', `STOP_MARKET ya ejecutado o cancelado`);
            } else {
                this.log('WARN', `Error cancelando STOP_MARKET: ${err.message}`);
            }
            this.activeStopOrder = null;
        }
    }

    /**
     * Check if position was closed by STOP_MARKET or TAKE_PROFIT_MARKET (called on order update events)
     */
    async handleStopMarketFilled(orderData) {
        if (!this.position) return;
        if (!this.activeStopOrder) return;
        if (orderData.orderId !== this.activeStopOrder.orderId) return;
        
        const typeLabel = this.activeStopOrder.orderType === 'TAKE_PROFIT_MARKET' ? 'TP_MARKET' : 'STOP_MARKET';
        this.log('SUCCESS', `✓ ${typeLabel} ejecutado @ ${orderData.avgPrice}`);
        
        // The position was closed by the stop order
        // We need to record this trade
        const p = this.position;
        const exitPrice = parseFloat(orderData.avgPrice);
        const exitCommission = p.size * exitPrice * (this.takerFee || 0.0004);
        
        // Get real funding
        const realFunding = await this.getRealFundingPaid(p.entryTime);
        
        // Calculate PnL
        const pnlRaw = p.type === 'LONG' 
            ? (exitPrice - p.entryPrice) * p.size 
            : (p.entryPrice - exitPrice) * p.size;
        const netPnL = pnlRaw - exitCommission;
        
        // Determine reason based on strategy and SL type
        let reason = 'Stop Loss';
        if (this.strategy === 'SPIRIT_ELITE' && p.eliteSLType) {
            reason = `Stop Loss (Elite: ${p.eliteSLType})`;
        } else if (this.slMode === 'TRAILING') {
            reason = 'Trailing Stop';
        } else if (this.slMode === 'BREAKEVEN') {
            reason = 'Breakeven SL';
        }
        
        const trade = {
            ...p,
            exitPrice: exitPrice,
            exitTime: this.lastTickTime || Date.now(),
            pnl: netPnL,
            commission: (p.entryCommission || 0) + exitCommission,
            funding: realFunding,
            reason: reason,
            roi: (netPnL / p.margin) * 100,
            eliteTickOffset: this.eliteTickOffset
        };
        
        this.trades.push(trade);
        const prevType = p.type;
        this.position = null;
        this.activeStopOrder = null;
        
        // Sync balance
        await this.syncAccountState();
        
        // Re-entry logic
        this.handleSpiritReEntry(reason, prevType, exitPrice);
        this.onStateChange();
    }

    /**
     * SPIRIT_ELITE: Check if virtual order conditions are met
     * This simulates the EXACT same logic as paper bot's checkPendingLimitOrder()
     * When conditions are met, executes a MARKET order for guaranteed fill
     */
    async checkPendingVirtualOrder(tick) {
        if (!this.pendingVirtualOrder) return;
        if (this.position) {
            // Already have a position, clear virtual order
            this.pendingVirtualOrder = null;
            return;
        }

        const { type, price, basePrice, time, strategy } = this.pendingVirtualOrder;
        let filled = false;

        // EXACT same logic as paper bot (bot.js checkPendingLimitOrder):
        // LONG: Fill if Low <= limitPrice (price touched our buy level)
        // SHORT: Fill if High >= limitPrice (price touched our sell level)
        if (type === 'LONG') {
            if (tick.low <= price) {
                filled = true;
            }
        } else {
            if (tick.high >= price) {
                filled = true;
            }
        }

        if (filled) {
            const decimals = tick.close < 1 ? 5 : 4;
            this.log('SUCCESS', `✓ SPIRIT_ELITE - Orden VIRTUAL activada! ${type} | Limit: ${price.toFixed(decimals)} | Tick: L=${tick.low.toFixed(decimals)} H=${tick.high.toFixed(decimals)} C=${tick.close.toFixed(decimals)}`);
            this.log('INFO', `→ Ejecutando MARKET ORDER real en Binance...`);
            
            // Clear virtual order BEFORE executing to prevent double execution
            this.pendingVirtualOrder = null;
            
            // Execute MARKET order (same as paper uses tick.close for fill price)
            await this.openPosition(type, tick.close, tick.time);
        }
    }

    /**
     * Cancel pending virtual order (called on signal reversal)
     */
    cancelPendingVirtualOrder(reason) {
        if (!this.pendingVirtualOrder) return;
        this.log('INFO', `Orden VIRTUAL cancelada: ${reason}`);
        this.pendingVirtualOrder = null;
    }

    async placeLimitOrder(type, price, candleTime, initialSL = 0, isElite = false) { // Added isElite parameter
        // Calculate quantity similar to openPosition
        const stepSize = this.exchangeInfo?.stepSize || 0.001;
        const minQty = this.exchangeInfo?.minQty || 0.001;
        const minNotional = this.exchangeInfo?.minNotional || 5;

        const margin = Math.min(this.orderSize, this.balance);
        const estimatedFee = margin * (this.makerFee || 0.0002); // Use maker fee for limit orders
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

        // Round price to tick size for Binance
        const tickSize = this.exchangeInfo?.tickSize || 0.01;
        const pricePrecision = this.getPrecision(tickSize);
        const roundedPrice = parseFloat(price.toFixed(pricePrecision));

        try {
            const side = type === 'LONG' ? 'BUY' : 'SELL';
            const strategyLabel = isElite ? `${this.strategy} Aggressive` : 'BACKGUARD';
            this.log('INFO', `PLACING ${strategyLabel} LIMIT ${side} @ ${roundedPrice}, Qty: ${quantity}. InitSL: ${initialSL || 'NONE'}`);

            const order = await this.client.futuresOrder({
                symbol: this.symbol,
                side: side,
                type: 'LIMIT',
                timeInForce: 'GTC',
                quantity: quantity,
                price: roundedPrice.toString(),
                newOrderRespType: 'RESULT'
            });

            this.waitingForLimitFill = {
                orderId: order.orderId,
                type: type,
                price: roundedPrice, // Limit price (rounded)
                initialSL: initialSL,
                quantity: quantity,
                setupTime: candleTime, // Use Binance time instead of Date.now()
                candleTime: candleTime,
                margin: margin,
                isElite: isElite // Track if this is SPIRIT_ELITE order
            };
            this.log('SUCCESS', `→ Orden LIMIT colocada. ID: ${order.orderId}`);

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
                this.log('SUCCESS', `✓ Orden LIMIT ejecutada: ID ${orderId}, Precio ${order.avgPrice}`);

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
                    entryTime: candleTime,           // Use Binance candle time, not Date.now()
                    entryCandleTime: candleTime,
                    highestPrice: fillPrice,
                    lowestPrice: fillPrice,
                    initialSL: initialSL,
                    candlesSinceEntry: 0,
                    lastCandleTime: candleTime,      // For BACKGUARD/ELITE candle counter
                    entryCommission: commission,
                    entryOrderId: orderId,
                    accumulatedFunding: 0,
                    lastFundingCheck: candleTime,    // Use Binance candle time
                    isElite: this.waitingForLimitFill?.isElite || false, // Preserve Elite flag for SL logic
                    // SPIRIT_ELITE / SPIRIT_EXPERIMENTAL fields - reset on new entry
                    experimentalSL: null,
                    experimentalSLSet: false,
                    lastReportedSLType: null
                };

                // Clear waiting state
                this.waitingForLimitFill = null;

                await this.syncAccountState(); // Sync real balance
                this.onStateChange();

                // SPIRIT_TEST Mirror: If we have a pending SL from paper, place it now
                if (this.mirrorMode && this.mirrorSL) {
                    this.log('INFO', `🪞 Mirror: LIMIT filled → Placing SL from paper @ ${this.mirrorSL.toFixed(5)}`);
                    await this.updateStopMarket(this.mirrorSL, fillPrice);
                }

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

    // =============================================
    // USER DATA STREAM HANDLERS
    // =============================================
    // Called by realBotManager when ORDER_TRADE_UPDATE events arrive

    async onOrderFilled(orderData) {
        // orderData: { orderId, avgPrice, executedQty, side, status }
        if (!this.waitingForLimitFill) {
            this.log('WARN', 'onOrderFilled called but no pending order');
            return;
        }

        const { orderId, type, initialSL, margin, candleTime, isElite } = this.waitingForLimitFill;

        // Verify this is the order we're waiting for
        if (orderData.orderId !== orderId) {
            this.log('WARN', `onOrderFilled: OrderId mismatch. Expected ${orderId}, got ${orderData.orderId}`);
            return;
        }

        this.log('SUCCESS', `✓ Binance confirma orden ${orderId} ejecutada @ ${orderData.avgPrice}`);

        const fillPrice = orderData.avgPrice;
        const executedQty = orderData.executedQty;

        // Fetch real commission data
        const realData = await this.getRealTradeData(orderId);
        const commission = realData?.commission || 0;

        // Create position
        this.position = {
            type: type,
            entryPrice: fillPrice,
            margin: margin,
            size: executedQty,
            entryTime: candleTime,
            entryCandleTime: candleTime,
            highestPrice: fillPrice,
            lowestPrice: fillPrice,
            initialSL: initialSL,
            candlesSinceEntry: 0,
            lastCandleTime: candleTime, // FIXED: Was 0, now uses candleTime for proper candle counting
            entryCommission: commission,
            entryOrderId: orderId,
            accumulatedFunding: 0,
            lastFundingCheck: candleTime,
            isElite: isElite || false,
            // SPIRIT_ELITE / SPIRIT_EXPERIMENTAL fields - reset on new entry
            experimentalSL: null,
            experimentalSLSet: false,
            lastReportedSLType: null
        };

        // Clear waiting state
        this.waitingForLimitFill = null;

        // Sync balance and notify UI
        await this.syncAccountState();
        this.onStateChange();

        this.log('INFO', `Position created: ${type} ${executedQty} @ ${fillPrice}`);

        // SPIRIT_TEST Mirror: If we have a pending SL from paper, place it now
        if (this.mirrorMode && this.mirrorSL) {
            this.log('INFO', `🪞 Mirror: LIMIT filled → Placing SL from paper @ ${this.mirrorSL.toFixed(5)}`);
            await this.updateStopMarket(this.mirrorSL, fillPrice);
        }
    }

    onOrderCanceled(status) {
        if (!this.waitingForLimitFill) return;

        this.log('WARN', `Order ${this.waitingForLimitFill.orderId} ended: ${status}`);
        this.waitingForLimitFill = null;
        this.onStateChange();
    }

    handleSpiritReEntry(reason, lastType, exitPrice) { // SPIRIT RE-ENTRY Setup
        // SPIRIT_TEST Mirror Mode: Paper bot handles re-entry, not us
        if (this.mirrorMode) return;

        const isStopLoss = reason && (reason.startsWith('Stop Loss') || reason.startsWith('Breakeven SL'));
        const isTrailing = reason && reason.startsWith('Trailing Stop');
        // Check strategy type
        const isSpirit = this.strategy && this.strategy.startsWith('SPIRIT');

        // SPIRIT_TRAILING and SPIRIT_TEST allow re-entry on trailing stop
        const canReEnter = isSpirit && (isStopLoss || (isTrailing && (this.strategy === 'SPIRIT_TRAILING' || this.strategy === 'SPIRIT_TEST')));

        if (canReEnter) {
            const neededSignal = lastType === 'LONG' ? 'Buy' : 'Sell';

            if (this.strategy === 'SPIRIT_ELITE') {
                // SPIRIT_ELITE: Re-enter at exit price (SL price)
                this.pendingReEntry = {
                    neededSignal,
                    entryPrice: exitPrice
                };
                this.log('INFO', `SPIRIT_ELITE - Re-entry Wait. Waiting for ${neededSignal}.`);
            } else {
                // SPIRIT_TRAILING & Standard SPIRIT: Re-enter at candle.close (MARKET, matches backtest)
                this.pendingReEntry = {
                    neededSignal
                    // entryPrice omitted → processSignal uses candle.close
                };
                this.log('INFO', `${this.strategy} - Re-entry Pending (MARKET at candle.close). Waiting for ${neededSignal}.`);
            }
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
            waitingForLimitFill: this.waitingForLimitFill,
            pendingVirtualOrder: this.pendingVirtualOrder, // SPIRIT_ELITE virtual order waiting for fill
            totalTrades: this.trades.length,
            trades: this.trades,
            roi: ((this.balance - this.initialCapital) / this.initialCapital) * 100, // ROI relative to initial capital set in config (visual only)
            lastPrice: this.candles.length > 0 ? this.candles[this.candles.length - 1].close : 0,
            startTime: this.startTime,
            // SPIRIT_ELITE parameters
            eliteTickOffset: this.eliteTickOffset,
            eliteTrailingDefer: this.eliteTrailingDefer
        };
    }
}

module.exports = TradingEngine;

