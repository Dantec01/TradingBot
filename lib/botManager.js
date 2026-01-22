const WebSocket = require('ws');
const TradingEngine = require('./bot');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../data/bot_state.json');
const HISTORY_FILE = path.join(__dirname, '../data/bot_history.json');

class BotManager {
    constructor() {
        this.instances = new Map(); // symbol -> TradingEngine
        this.subscribedStreams = new Set(); // Track active subscriptions
        this.ws = null;
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.maxBackoff = 60000; // 1 minute max
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
                        mode: b.mode || 'PAPER'
                    },
                    state: {
                        balance: b.balance,
                        trades: b.trades,
                        position: b.position,
                        pendingReEntry: b.pendingReEntry,
                        startTime: b.startTime // Persist start time
                    }
                }))
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(dataToSave, null, 2));
            console.log(`[Bot Manager] State saved to ${STATE_FILE} (${dataToSave.bots.length} bots)`);
        } catch (err) {
            console.error("[Bot Manager] Error saving state:", err.message);
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
                console.error("[Bot Manager] State file is corrupted, skipping restore:", parseErr.message);
                return;
            }

            // Validate data structure
            if (!data || !Array.isArray(data.bots)) {
                console.warn("[Bot Manager] Invalid state file structure, skipping restore");
                return;
            }

            console.log(`[Bot Manager] Restoring ${data.bots.length} pairs from state file: ${STATE_FILE}`);

            for (const botData of data.bots) {
                // Validate required fields
                if (!botData.config || !botData.config.symbol || !botData.state) {
                    console.warn(`[Bot Manager] Skipping invalid bot entry:`, botData);
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
                    engine.trades = Array.isArray(botData.state.trades) ? botData.state.trades : [];
                    engine.position = botData.state.position || null;
                    engine.pendingReEntry = botData.state.pendingReEntry || null;
                    engine.startTime = botData.state.startTime || Date.now(); // Restore start time

                    this.instances.set(botData.config.symbol, engine);
                } catch (botErr) {
                    console.error(`[Bot Manager] Failed to restore ${botData.config.symbol}:`, botErr.message);
                }
            }

            if (this.instances.size > 0) {
                this.updateSubscription();
            }
        } catch (err) {
            console.error("[Bot Manager] Error loading state:", err.message);
        }
    }

    async addPair(config) {
        const symbol = config.symbol.toUpperCase();
        if (this.instances.has(symbol)) {
            throw new Error(`El bot para ${symbol} ya está en ejecución.`);
        }

        const engine = new TradingEngine({
            ...config,
            onStateChange: () => this.saveState()
        });
        await engine.init();
        this.instances.set(symbol, engine);
        this.saveState();

        this.updateSubscription();
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
                totalTrades: status.totalTrades
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
            console.log(`[Bot Manager] Saved session history for ${status.symbol}`);

        } catch (err) {
            console.error("[Bot Manager] Error saving history:", err);
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

    getStatus() {
        const status = [];
        for (const [symbol, engine] of this.instances) {
            status.push(engine.getStatus());
        }
        return {
            connection: this.getConnectionStatus(),
            reconnectAttempts: this.reconnectAttempts,
            bots: status
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
                console.log(`[Bot Manager] Unsubscribed from all streams`);
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
            requiredStreams.add(this.getStreamName(symbol, engine.timeframe));
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
            console.log(`[Bot Manager] Unsubscribed from: ${toUnsubscribe.join(', ')}`);
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
            console.log(`[Bot Manager] Subscribed to: ${toSubscribe.join(', ')}`);
        }
    }

    connect() {
        if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;
        this.isConnecting = true;

        console.log(`[Bot Manager] Connecting for ${this.instances.size} pairs...`);
        const url = "wss://fstream.binance.com/ws";
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            console.log("[Bot Manager] WebSocket Open.");
            this.isConnecting = false;
            this.reconnectAttempts = 0; // Reset on success
            this.updateSubscription();
        });

        this.ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.e === 'kline') {
                const symbol = msg.s.replace('USDT', '');
                const engine = this.instances.get(symbol);
                if (engine) {
                    const k = msg.k;
                    engine.update({
                        time: k.t,
                        open: parseFloat(k.o),
                        high: parseFloat(k.h),
                        low: parseFloat(k.l),
                        close: parseFloat(k.c),
                        isFinal: k.x
                    });
                }
            }
        });

        this.ws.on('close', () => {
            if (this.instances.size === 0) return; // Clean stop

            this.isConnecting = false;
            this.reconnectAttempts++;
            const backoff = Math.min(this.reconnectAttempts * 2000, this.maxBackoff);

            console.log(`[Bot Manager] WS Closed. Reconnecting in ${backoff / 1000}s (Attempt ${this.reconnectAttempts})`);
            setTimeout(() => this.connect(), backoff);
        });

        this.ws.on('error', (err) => {
            console.error("[Bot Manager] WebSocket Error:", err.message);
            // close handler will handle reconnect if needed
        });
    }
}

// Singleton Instance
const manager = new BotManager();
module.exports = manager;
