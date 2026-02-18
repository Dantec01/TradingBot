const WebSocket = require('ws');
const TradingEngine = require('./realBot');
const fs = require('fs');
const path = require('path');
const Binance = require('binance-api-node').default;

const STATE_FILE = path.join(__dirname, '../data/real_bot_state.json');
const HISTORY_FILE = path.join(__dirname, '../data/real_bot_history.json');

class BotManager {
    constructor() {
        this.instances = new Map(); // symbol -> TradingEngine
        this.subscribedStreams = new Set(); // Track active subscriptions
        this.ws = null;
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.maxBackoff = 60000; // 1 minute max
        this.logs = []; // { time, level, message }
        this.maxLogs = 50;

        // User Data Stream (Private WebSocket for order fills)
        this.userDataWs = null;
        this.listenKey = null;
        this.keepAliveInterval = null;
        this.userDataReconnectAttempts = 0;
        this.binanceClient = null; // Initialized when first bot is added

        // Heartbeat tracking for connection health
        this.lastMessageTime = 0;
        this.heartbeatInterval = null;
        this.heartbeatTimeout = 60000; // 60 seconds - if no message, consider dead
        this.userDataLastMessageTime = 0;
        this.userDataHeartbeatInterval = null;

        // Sequential tick queue per engine (prevents race conditions with async update)
        this.tickQueues = new Map(); // symbol -> { queue: [], processing: false }
    }

    /**
     * Enqueue a tick for sequential processing.
     * Ensures each engine.update() completes before the next one starts,
     * preventing race conditions during async operations (MARKET orders, etc.)
     */
    enqueueUpdate(engine, candle) {
        const symbol = engine.symbol;
        if (!this.tickQueues.has(symbol)) {
            this.tickQueues.set(symbol, { queue: [], processing: false });
        }
        const q = this.tickQueues.get(symbol);
        q.queue.push(candle);

        if (!q.processing) {
            this.processTickQueue(engine, q);
        }
    }

    async processTickQueue(engine, q) {
        q.processing = true;
        while (q.queue.length > 0) {
            const candle = q.queue.shift();
            try {
                await engine.update(candle);
            } catch (err) {
                console.error(`[RealBot Manager] Error processing tick for ${engine.symbol}:`, err.message);
            }
        }
        q.processing = false;
    }

    async fetchBalance() {
        // Optimization: If we have active running bots, use their cached balance (synced on every trade/init)
        if (this.instances.size > 0) {
            const firstBot = this.instances.values().next().value;
            // Force a sync on that bot to get fresh data
            await firstBot.syncAccountState();
            return firstBot.balance;
        }

        try {
            if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
                throw new Error('API Keys no configuradas en .env');
            }
            const Binance = require('binance-api-node').default;
            const client = Binance({
                apiKey: process.env.BINANCE_API_KEY,
                apiSecret: process.env.BINANCE_API_SECRET,
            });

            const balances = await client.futuresAccountBalance();
            const usdt = balances.find(b => b.asset === 'USDT');
            return usdt ? parseFloat(usdt.balance) : 0;

        } catch (err) {
            console.error("[RealBot Manager] Error fetching balance:", err.message);
            this.addLog('ERROR', `Error fetching balance: ${err.message}`);
            // Propagate error but ensure it's logged to UI
            throw err;
        }
    }

    addLog(level, message, symbol = 'SYSTEM') {
        const logEntry = {
            id: Date.now() + Math.random(),
            time: new Date().toISOString(),
            level, // 'INFO', 'WARN', 'ERROR', 'SUCCESS'
            message: `[${symbol}] ${message}`
        };
        this.logs.unshift(logEntry);
        if (this.logs.length > this.maxLogs) this.logs.pop();

        // Also log to console
        const color = level === 'ERROR' ? '\x1b[31m' : (level === 'WARN' ? '\x1b[33m' : '\x1b[32m');
        console.log(`${color}[${level}] ${logEntry.message}\x1b[0m`);
    }

    async saveState() {
        try {
            const status = this.getStatus();
            // We only need to save the configuration and current results
            // botManager.getStatus() returns { connection, bots, ... }
            const dataToSave = {
                bots: status.bots.map(b => ({
                    config: {
                        symbol: b.symbol,
                        timeframe: b.timeframe || '15m', // fallback
                        initialCapital: b.initialCapital,
                        orderSize: b.orderSize || 10,
                        leverage: b.leverage || 20,
                        strategy: b.strategy || 'CLOSE_ENTRY',
                        slMode: b.slMode || 'FIXED',
                        stopLossPct: b.stopLossPct || 1,
                        trailingPct: b.trailingPct || 1,
                        direction: b.direction || 'BOTH',
                        mode: b.mode || 'REAL_BOT_01',
                        // SPIRIT_ELITE parameters
                        eliteTickOffset: b.eliteTickOffset || 0.0001,
                        eliteTrailingDefer: b.eliteTrailingDefer || 5
                    },
                    state: {
                        balance: b.balance,
                        trades: b.trades,
                        position: b.position,
                        pendingReEntry: b.pendingReEntry,
                        pendingVirtualOrder: b.pendingVirtualOrder, // SPIRIT_ELITE virtual order
                        activeStopOrder: b.activeStopOrder, // STOP_MARKET or TAKE_PROFIT_MARKET order on Binance
                        startTime: b.startTime // Persist start time
                    }
                }))
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(dataToSave, null, 2));
            console.log(`[RealBot Manager] State saved to ${STATE_FILE} (${dataToSave.bots.length} bots)`);
        } catch (err) {
            console.error("[RealBot Manager] Error saving state:", err.message);
        }
    }

    async loadState() {
        if (!fs.existsSync(STATE_FILE)) return;
        try {
            const rawData = fs.readFileSync(STATE_FILE, 'utf8');

            // Validate JSON structure
            let data;
            try {
                data = JSON.parse(rawData);
            } catch (parseErr) {
                console.error("[RealBot Manager] State file is corrupted, skipping restore:", parseErr.message);
                return;
            }

            // Validate data structure
            if (!data || !Array.isArray(data.bots)) {
                console.warn("[RealBot Manager] Invalid state file structure, skipping restore");
                return;
            }

            console.log(`[RealBot Manager] Restoring ${data.bots.length} pairs from state file: ${STATE_FILE}`);

            for (const botData of data.bots) {
                // Validate required fields
                if (!botData.config || !botData.config.symbol || !botData.state) {
                    console.warn(`[RealBot Manager] Skipping invalid bot entry:`, botData);
                    continue;
                }

                try {
                    const config = {
                        ...botData.config,
                        onStateChange: () => this.saveState()
                    };
                    const engine = new TradingEngine(config);

                    // Initialize engine (fetch warmup candles)
                    await engine.init();

                    // Restore state with defaults for missing values
                    engine.balance = botData.state.balance ?? config.initialCapital ?? 100;
                    engine.trades = Array.isArray(botData.state.trades) ? botData.state.trades : [];
                    engine.position = botData.state.position || null;
                    engine.pendingReEntry = botData.state.pendingReEntry || null;
                    engine.pendingVirtualOrder = botData.state.pendingVirtualOrder || null; // SPIRIT_ELITE
                    engine.activeStopOrder = botData.state.activeStopOrder || null; // STOP_MARKET
                    engine.startTime = botData.state.startTime || Date.now(); // Restore start time

                    this.instances.set(botData.config.symbol, engine);
                } catch (botErr) {
                    console.error(`[RealBot Manager] Failed to restore ${botData.config.symbol}:`, botErr.message);
                }
            }

            if (this.instances.size > 0) {
                this.updateSubscription();
            }
        } catch (err) {
            console.error("[RealBot Manager] Error loading state:", err.message);
        }
    }

    async addPair(config) {
        const symbol = config.symbol.toUpperCase();
        if (this.instances.has(symbol)) {
            throw new Error(`El bot para ${symbol} ya está en ejecución.`);
        }

        const engine = new TradingEngine({
            ...config,
            onStateChange: () => this.saveState(),
            onLog: (level, msg) => this.addLog(level, msg, symbol)
        });
        await engine.init();
        this.instances.set(symbol, engine);
        this.saveState();

        this.updateSubscription();

        // Start User Data Stream if this is the first bot
        if (this.instances.size === 1) {
            this.connectUserDataStream();
        }

        return engine.getStatus();
    }

    removePair(symbol) {
        symbol = symbol.toUpperCase();
        if (this.instances.has(symbol)) {
            const engine = this.instances.get(symbol);
            this.saveToHistory(engine); // Save to history before removing
            this.instances.delete(symbol);
            this.updateSubscription();
            this.saveState();
            return true;
        }
        return false;
    }

    getEngine(symbol) {
        return this.instances.get(symbol.toUpperCase()) || null;
    }

    stopAll() {
        for (const [symbol, engine] of this.instances) {
            this.saveToHistory(engine);
        }
        this.instances.clear();
        this.subscribedStreams.clear(); // Clear tracked subscriptions
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.reconnectAttempts = 0;

        // Close User Data Stream
        this.closeUserDataStream();

        this.saveState();
    }

    saveToHistory(engine) {
        try {
            const status = engine.getStatus();
            const endTime = Date.now();
            const durationMs = endTime - status.startTime;

            // Format duration human readable
            const seconds = Math.floor((durationMs / 1000) % 60);
            const minutes = Math.floor((durationMs / (1000 * 60)) % 60);
            const hours = Math.floor((durationMs / (1000 * 60 * 60)));
            const durationStr = `${hours}h ${minutes}m`;

            const historyEntry = {
                id: Date.now() + Math.random().toString(36).substr(2, 5),
                symbol: status.symbol,
                timeframe: status.timeframe,
                strategy: status.strategy,
                slMode: status.slMode,
                stopLossPct: status.stopLossPct,
                mode: status.mode,
                initialCapital: status.initialCapital,
                finalBalance: status.balance,
                pnl: status.balance - status.initialCapital,
                startTime: status.startTime,
                endTime: endTime,
                duration: durationStr,
                totalTrades: status.totalTrades,
                trades: engine.trades // Include full trade list for CSV export
            };

            let history = [];
            if (fs.existsSync(HISTORY_FILE)) {
                try {
                    history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
                } catch (e) {
                    history = [];
                }
            }

            history.push(historyEntry);
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
            console.log(`[RealBot Manager] Saved session history for ${status.symbol}`);

        } catch (err) {
            console.error("[RealBot Manager] Error saving history:", err);
        }
    }

    getHistory() {
        if (!fs.existsSync(HISTORY_FILE)) return [];
        try {
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            return Array.isArray(data) ? data.reverse() : [];
        } catch (e) {
            return [];
        }
    }

    clearHistory() {
        try {
            fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
            console.log("[RealBot Manager] History cleared.");
            return true;
        } catch (err) {
            console.error("[RealBot Manager] Error clearing history:", err);
            return false;
        }
    }

    getStatus() {
        const status = [];
        for (const [symbol, engine] of this.instances) {
            status.push(engine.getStatus());
        }
        // Get account balance from first available bot instance (since they share the same account)
        let totalBalance = 0;
        if (this.instances.size > 0) {
            const firstBot = this.instances.values().next().value;
            totalBalance = firstBot.balance;
        }

        return {
            connection: this.getConnectionStatus(),
            reconnectAttempts: this.reconnectAttempts,
            totalBalance: totalBalance,
            bots: status,
            logs: this.logs
        };
    }

    getConnectionStatus() {
        if (!this.ws) {
            return this.reconnectAttempts > 0 ? 'RECONNECTING' : 'DISCONNECTED';
        }
        switch (this.ws.readyState) {
            case WebSocket.CONNECTING: return 'CONNECTING';
            case WebSocket.OPEN: return 'CONNECTED';
            case WebSocket.CLOSING: return 'DISCONNECTING';
            case WebSocket.CLOSED: return 'RECONNECTING';
            default: return 'DISCONNECTED';
        }
    }

    // Helper to generate stream name consistently
    getStreamName(symbol, timeframe) {
        // Symbol should already be normalized (e.g., 'BTC' or 'BTCUSDT')
        const base = symbol.toUpperCase().replace('USDT', '');
        return `${base.toLowerCase()}usdt@kline_${timeframe}`;
    }

    updateSubscription() {
        if (this.instances.size === 0) {
            // Unsubscribe from all and close connection
            if (this.ws && this.ws.readyState === WebSocket.OPEN && this.subscribedStreams.size > 0) {
                const unsubMsg = {
                    method: "UNSUBSCRIBE",
                    params: Array.from(this.subscribedStreams),
                    id: Date.now()
                };
                this.ws.send(JSON.stringify(unsubMsg));
                console.log(`[RealBot Manager] Unsubscribed from all streams`);
            }
            this.subscribedStreams.clear();
            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }
            return;
        }

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.connect();
            return;
        }

        // Calculate required streams
        const requiredStreams = new Set();
        for (const [symbol, engine] of this.instances) {
            // Primary Stream
            requiredStreams.add(this.getStreamName(symbol, engine.timeframe));

            // Auxiliary Stream for VANGUARD (1m)
            if (engine.strategy === 'VANGUARD') {
                requiredStreams.add(this.getStreamName(symbol, '1m'));
                console.log(`[RealBot Manager] Adding 1m auxiliary stream for VANGUARD on ${symbol}`);
            }
        }

        // Find streams to unsubscribe (in subscribed but not required)
        const toUnsubscribe = [];
        for (const stream of this.subscribedStreams) {
            if (!requiredStreams.has(stream)) {
                toUnsubscribe.push(stream);
            }
        }

        // Find streams to subscribe (in required but not subscribed)
        const toSubscribe = [];
        for (const stream of requiredStreams) {
            if (!this.subscribedStreams.has(stream)) {
                toSubscribe.push(stream);
            }
        }

        // Send UNSUBSCRIBE if needed
        if (toUnsubscribe.length > 0) {
            const unsubMsg = {
                method: "UNSUBSCRIBE",
                params: toUnsubscribe,
                id: Date.now()
            };
            this.ws.send(JSON.stringify(unsubMsg));
            toUnsubscribe.forEach(s => this.subscribedStreams.delete(s));
            console.log(`[RealBot Manager] Unsubscribed from: ${toUnsubscribe.join(', ')}`);
        }

        // Send SUBSCRIBE if needed
        if (toSubscribe.length > 0) {
            const subMsg = {
                method: "SUBSCRIBE",
                params: toSubscribe,
                id: Date.now() + 1
            };
            this.ws.send(JSON.stringify(subMsg));
            toSubscribe.forEach(s => this.subscribedStreams.add(s));
            console.log(`[RealBot Manager] Subscribed to: ${toSubscribe.join(', ')}`);
        }
    }

    connect() {
        if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;
        this.isConnecting = true;

        // Clear any existing heartbeat
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }

        console.log(`[RealBot Manager] Connecting for ${this.instances.size} pairs...`);
        const url = "wss://fstream.binance.com/ws";

        // Configure WebSocket with ping/pong handling
        this.ws = new WebSocket(url, {
            handshakeTimeout: 30000, // 30 seconds handshake timeout
            perMessageDeflate: false // Disable compression for lower latency
        });

        this.ws.on('open', () => {
            console.log("[RealBot Manager] WebSocket Open.");
            this.addLog('SUCCESS', 'WebSocket de mercado conectado');
            this.isConnecting = false;
            this.reconnectAttempts = 0; // Reset on success
            this.lastMessageTime = Date.now(); // Track connection health
            this.updateSubscription();

            // Setup heartbeat to detect dead connections
            // Binance streams should send data at least every few seconds (kline updates)
            this.heartbeatInterval = setInterval(() => {
                const timeSinceLastMessage = Date.now() - this.lastMessageTime;
                if (timeSinceLastMessage > this.heartbeatTimeout) {
                    console.log(`[RealBot Manager] Heartbeat timeout: ${timeSinceLastMessage}ms since last message`);
                    this.addLog('WARN', `WebSocket heartbeat timeout - forcing reconnect`);
                    this.ws.terminate(); // Force close to trigger reconnect
                }
            }, 30000); // Check every 30 seconds
        });

        this.ws.on('message', (data) => {
            this.lastMessageTime = Date.now(); // Update last message time

            try {
                const msg = JSON.parse(data);
                if (msg.e === 'kline') {
                    const symbol = msg.s.replace('USDT', '');
                    const engine = this.instances.get(symbol);
                    if (engine) {
                        const k = msg.k;
                        // Check if it's the primary timeframe or auxiliary
                        const candleTimeframe = k.i; // Interval (e.g., '5m', '1m')

                        if (candleTimeframe === engine.timeframe) {
                            // Primary Update — enqueue for sequential processing
                            const candle = {
                                time: k.t,
                                open: parseFloat(k.o),
                                high: parseFloat(k.h),
                                low: parseFloat(k.l),
                                close: parseFloat(k.c),
                                isFinal: k.x,
                                eventTime: msg.E, // Binance server time
                                closeTime: k.T   // Kline close time (Binance)
                            };
                            this.enqueueUpdate(engine, candle);
                        } else if (engine.strategy === 'VANGUARD' && candleTimeframe === '1m') {
                            // Auxiliary Update (1m)
                            // We assume engine has this method (we will add it next)
                            if (engine.processAuxiliaryCandle) {
                                engine.processAuxiliaryCandle({
                                    time: k.t,
                                    open: parseFloat(k.o),
                                    high: parseFloat(k.h),
                                    low: parseFloat(k.l),
                                    close: parseFloat(k.c),
                                    isFinal: k.x
                                });
                            }
                        }
                    }
                }
                // Other JSON messages (subscription confirmations, errors) are silently ignored
                else if (msg.e) {
                    console.log(`[RealBot Manager] WS Message ignored: ${msg.e}`);
                }
            } catch (err) {
                // Check if it's a ping frame (Buffer with specific format)
                if (Buffer.isBuffer(data)) {
                    // Binary/ping frame - auto-responded by ws library, just update timestamp
                    this.lastMessageTime = Date.now();
                    return;
                }
                // Only log if it's actually an error, not a ping/pong
                if (data.length > 0 && !data.toString().startsWith('{')) {
                    // Non-JSON message, likely ping/pong - silently ignore
                    this.lastMessageTime = Date.now();
                    return;
                }
                // JSON parse error - this is actually a problem
                this.addLog('WARN', `WebSocket mensaje no procesable: ${err.message}`);
            }
        });

        this.ws.on('ping', (data) => {
            // Auto-responded by ws library, just log for debugging
            this.lastMessageTime = Date.now();
            console.log(`[RealBot Manager] WebSocket ping received, pong auto-sent`);
        });

        this.ws.on('pong', (data) => {
            this.lastMessageTime = Date.now();
            console.log(`[RealBot Manager] WebSocket pong received`);
        });

        this.ws.on('close', (code, reason) => {
            // Clear heartbeat
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }

            if (this.instances.size === 0) return; // Clean stop

            this.isConnecting = false;
            this.reconnectAttempts++;
            const backoff = Math.min(this.reconnectAttempts * 2000, this.maxBackoff);

            console.log(`[RealBot Manager] WS Closed (code: ${code}, reason: ${reason}). Reconnecting in ${backoff / 1000}s (Attempt ${this.reconnectAttempts})`);
            this.addLog('WARN', `WebSocket cerrado. Reconectando en ${backoff / 1000}s...`);
            setTimeout(() => this.connect(), backoff);
        });

        this.ws.on('error', (err) => {
            console.error("[RealBot Manager] WebSocket Error:", err.message);
            this.addLog('ERROR', `WebSocket error: ${err.message}`);
            // close handler will handle reconnect if needed
        });
    }

    // =============================================
    // USER DATA STREAM (Private WebSocket)
    // =============================================
    // Receives ORDER_TRADE_UPDATE events for instant fill detection
    // This replaces polling in realBot.checkPendingOrder()

    async connectUserDataStream() {
        if (this.userDataWs && this.userDataWs.readyState === WebSocket.OPEN) {
            return; // Already connected
        }

        try {
            // Initialize Binance client if not already done
            if (!this.binanceClient) {
                if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
                    this.addLog('ERROR', 'Cannot connect User Data Stream: API Keys missing');
                    return;
                }
                this.binanceClient = Binance({
                    apiKey: process.env.BINANCE_API_KEY,
                    apiSecret: process.env.BINANCE_API_SECRET,
                });
            }

            // Clear any existing heartbeat
            if (this.userDataHeartbeatInterval) {
                clearInterval(this.userDataHeartbeatInterval);
                this.userDataHeartbeatInterval = null;
            }

            // Get listenKey from Binance Futures API
            const listenKeyResponse = await this.binanceClient.futuresGetDataStream();
            this.listenKey = listenKeyResponse.listenKey || listenKeyResponse;
            console.log(`[RealBot Manager] User Data Stream listenKey obtained`);
            this.addLog('INFO', 'Binance User Data Stream: listenKey obtenida');

            // Connect to private WebSocket with configuration
            const url = `wss://fstream.binance.com/ws/${this.listenKey}`;
            this.userDataWs = new WebSocket(url, {
                handshakeTimeout: 30000,
                perMessageDeflate: false
            });

            this.userDataWs.on('open', () => {
                console.log('[RealBot Manager] User Data Stream CONNECTED');
                this.addLog('SUCCESS', 'Binance User Data Stream conectado (detección de fills en tiempo real)');
                this.userDataReconnectAttempts = 0;
                this.userDataLastMessageTime = Date.now();

                // Set up keep-alive interval (every 30 minutes)
                // Binance listenKey expires after 60 minutes without keep-alive
                if (this.keepAliveInterval) {
                    clearInterval(this.keepAliveInterval);
                }
                this.keepAliveInterval = setInterval(async () => {
                    try {
                        await this.binanceClient.futuresKeepDataStream();
                        console.log('[RealBot Manager] User Data Stream keep-alive sent');
                    } catch (err) {
                        console.error('[RealBot Manager] Keep-alive failed:', err.message);
                        // Reconnect on next opportunity
                    }
                }, 30 * 60 * 1000); // 30 minutes

                // Setup heartbeat for User Data Stream
                // User Data Stream is less active, so we use longer timeout (3 minutes)
                this.userDataHeartbeatInterval = setInterval(() => {
                    const timeSinceLastMessage = Date.now() - this.userDataLastMessageTime;
                    if (timeSinceLastMessage > 180000) { // 3 minutes without message
                        console.log(`[RealBot Manager] User Data heartbeat timeout: ${timeSinceLastMessage}ms since last message`);
                        this.addLog('WARN', `User Data Stream heartbeat timeout - forcing reconnect`);
                        this.userDataWs.terminate(); // Force close to trigger reconnect
                    }
                }, 60000); // Check every 60 seconds
            });

            this.userDataWs.on('message', (data) => {
                this.userDataLastMessageTime = Date.now();

                try {
                    const msg = JSON.parse(data.toString());

                    // Handle ORDER_TRADE_UPDATE events
                    if (msg.e === 'ORDER_TRADE_UPDATE') {
                        this.handleOrderTradeUpdate(msg.o);
                    }
                    // ACCOUNT_UPDATE events could be used for balance sync but we already do that
                    else if (msg.e === 'ACCOUNT_UPDATE') {
                        console.log(`[RealBot Manager] ACCOUNT_UPDATE received`);
                        this.addLog('INFO', 'Account balance/position updated');
                    }
                    else if (msg.e) {
                        console.log(`[RealBot Manager] User Data Stream: ${msg.e}`);
                    }
                } catch (err) {
                    console.error('[RealBot Manager] User Data parse error:', err.message);
                }
            });

            this.userDataWs.on('ping', (data) => {
                this.userDataLastMessageTime = Date.now();
                console.log(`[RealBot Manager] User Data Stream ping received, pong auto-sent`);
            });

            this.userDataWs.on('pong', (data) => {
                this.userDataLastMessageTime = Date.now();
                console.log(`[RealBot Manager] User Data Stream pong received`);
            });

            this.userDataWs.on('close', (code, reason) => {
                // Clear heartbeat intervals
                if (this.userDataHeartbeatInterval) {
                    clearInterval(this.userDataHeartbeatInterval);
                    this.userDataHeartbeatInterval = null;
                }
                if (this.keepAliveInterval) {
                    clearInterval(this.keepAliveInterval);
                    this.keepAliveInterval = null;
                }

                console.log(`[RealBot Manager] User Data Stream closed (code: ${code}, reason: ${reason})`);
                this.addLog('WARN', `Binance User Data Stream desconectado (code: ${code})`);

                // Reconnect if we still have active bots
                if (this.instances.size > 0) {
                    this.userDataReconnectAttempts++;
                    const backoff = Math.min(this.userDataReconnectAttempts * 3000, this.maxBackoff);
                    console.log(`[RealBot Manager] User Data reconnecting in ${backoff / 1000}s...`);
                    this.addLog('INFO', `Reconectando User Data Stream en ${backoff / 1000}s...`);
                    setTimeout(() => this.connectUserDataStream(), backoff);
                }
            });

            this.userDataWs.on('error', (err) => {
                console.error('[RealBot Manager] User Data Stream Error:', err.message);
                this.addLog('ERROR', `Binance User Data Stream error: ${err.message}`);
            });

        } catch (err) {
            console.error('[RealBot Manager] Failed to connect User Data Stream:', err.message);
            this.addLog('ERROR', `Binance User Data Stream fallo de conexión: ${err.message}`);

            // Retry after delay
            if (this.instances.size > 0) {
                this.userDataReconnectAttempts++;
                const backoff = Math.min(this.userDataReconnectAttempts * 3000, this.maxBackoff);
                setTimeout(() => this.connectUserDataStream(), backoff);
            }
        }
    }

    closeUserDataStream() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        if (this.userDataHeartbeatInterval) {
            clearInterval(this.userDataHeartbeatInterval);
            this.userDataHeartbeatInterval = null;
        }
        if (this.userDataWs) {
            this.userDataWs.close();
            this.userDataWs = null;
        }
        this.listenKey = null;
        this.userDataReconnectAttempts = 0;
        console.log('[RealBot Manager] User Data Stream closed and cleaned up');
    }

    handleOrderTradeUpdate(order) {
        // order contains: s (symbol), X (status), i (orderId), S (side), o (type), q (qty), p (price), ap (avgPrice), etc.
        const symbol = order.s.replace('USDT', '');
        const engine = this.instances.get(symbol);

        if (!engine) {
            return; // Order for a symbol we're not tracking
        }

        const orderId = order.i;
        const status = order.X; // NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED, etc.
        const side = order.S; // BUY, SELL
        const avgPrice = parseFloat(order.ap) || parseFloat(order.p);
        const executedQty = parseFloat(order.z) || parseFloat(order.q);

        console.log(`[RealBot Manager] ORDER_TRADE_UPDATE: ${symbol} ${status} orderId=${orderId} side=${side}`);
        this.addLog('INFO', `Binance Order: ${symbol} ${side} ${status} @ ${avgPrice}`);

        // Check if this is a fill for a STOP_MARKET, TAKE_PROFIT_MARKET, or TRAILING_STOP_MARKET
        // Match by orderId, or by type if orderId is null (library didn't return it)
        // ALSO: Binance algo orders (TRAILING_STOP_MARKET) create a MARKET order when triggered,
        // so WebSocket reports order.o='MARKET' not 'TRAILING_STOP_MARKET'. We detect this by
        // checking if the MARKET fill is on the close side of an active trailing stop.
        const orderType = order.o; // Order type from WebSocket: STOP_MARKET, TRAILING_STOP_MARKET, MARKET, etc.
        const isStopTypeMatch = (orderType === 'TRAILING_STOP_MARKET' || orderType === 'STOP_MARKET' || orderType === 'TAKE_PROFIT_MARKET');
        const isTrailingMarketFill = engine.activeStopOrder &&
            engine.activeStopOrder.orderType === 'TRAILING_STOP_MARKET' &&
            orderType === 'MARKET' &&
            engine.position &&
            ((engine.position.type === 'LONG' && side === 'SELL') || (engine.position.type === 'SHORT' && side === 'BUY')) &&
            !engine.isClosing; // Not a manual close

        const isStopMatch = engine.activeStopOrder && (
            engine.activeStopOrder.orderId === orderId ||
            (engine.activeStopOrder.orderId === null && isStopTypeMatch) ||
            isTrailingMarketFill
        );

        if (isStopMatch) {
            const typeLabel = engine.activeStopOrder.orderType === 'TRAILING_STOP_MARKET' ? 'TRAILING_STOP' :
                (engine.activeStopOrder.orderType === 'TAKE_PROFIT_MARKET' ? 'TP_MARKET' : 'STOP_MARKET');
            if (status === 'FILLED') {
                this.addLog('SUCCESS', `✓ ${typeLabel} ejecutado: ${symbol} @ ${avgPrice}`);
                // Handle the stop order fill - this closes the position
                engine.handleStopMarketFilled({
                    orderId: orderId,
                    avgPrice: avgPrice,
                    executedQty: executedQty,
                    side: side,
                    status: status
                });
            } else if (status === 'CANCELED' || status === 'EXPIRED') {
                this.addLog('INFO', `${typeLabel} ${symbol} cancelado/expirado`);
                engine.activeStopOrder = null;
            } else if (status === 'NEW') {
                // Order placed — update orderId if we didn't have it from REST response
                if (engine.activeStopOrder && !engine.activeStopOrder.orderId) {
                    engine.activeStopOrder.orderId = orderId;
                    this.addLog('INFO', `${typeLabel} ${symbol} orderId actualizado: ${orderId}`);
                }
            }
        }

        // Check if this is a fill for a pending limit order
        // Allow match if orderId is null (race condition: fill arrived before API response set orderId)
        if (engine.waitingForLimitFill && (engine.waitingForLimitFill.orderId === null || engine.waitingForLimitFill.orderId === orderId)) {
            if (status === 'FILLED') {
                // Notify the engine of the fill
                engine.onOrderFilled({
                    orderId: orderId,
                    avgPrice: avgPrice,
                    executedQty: executedQty,
                    side: side,
                    status: status
                });
                this.addLog('SUCCESS', `✓ Orden LIMIT ejecutada: ${symbol} @ ${avgPrice}`);
            } else if (status === 'CANCELED' || status === 'EXPIRED' || status === 'REJECTED') {
                // Order was not filled
                engine.onOrderCanceled(status);
                this.addLog('WARN', `Orden ${symbol} terminada: ${status}`);
            }
            // Log other order statuses for visibility
            else if (status === 'NEW') {
                this.addLog('INFO', `Orden ${symbol} creada y activa`);
            }
            else if (status === 'PARTIALLY_FILLED') {
                this.addLog('INFO', `Orden ${symbol} parcialmente ejecutada: ${executedQty}`);
            }
        }
    }
}

// Singleton Instance
const manager = new BotManager();
module.exports = manager;
