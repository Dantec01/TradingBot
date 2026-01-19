const WebSocket = require('ws');
const TradingEngine = require('./bot');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../data/bot_state.json');

class BotManager {
    constructor() {
        this.instances = new Map(); // symbol -> TradingEngine
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
                        pendingReEntry: b.pendingReEntry
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
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            console.log(`[Bot Manager] Restoring ${data.bots.length} pairs from state file: ${STATE_FILE}`);

            for (const botData of data.bots) {
                const config = {
                    ...botData.config,
                    onStateChange: () => this.saveState()
                };
                const engine = new TradingEngine(config);

                // Initialize engine (fetch warmup candles)
                await engine.init();

                // Restore state
                engine.balance = botData.state.balance;
                engine.trades = botData.state.trades;
                engine.position = botData.state.position;
                engine.pendingReEntry = botData.state.pendingReEntry;

                this.instances.set(botData.config.symbol, engine);
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
            this.instances.delete(symbol);
            this.updateSubscription();
            this.saveState();
            return true;
        }
        return false;
    }

    stopAll() {
        this.instances.clear();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.reconnectAttempts = 0;
        this.saveState();
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

    updateSubscription() {
        if (this.instances.size === 0) {
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

        // Send subscribe message to Binance
        // Format: streams = ["btcusdt@kline_15m", ...]
        const streams = [];
        for (const [symbol, engine] of this.instances) {
            streams.push(`${symbol.toLowerCase()}usdt@kline_${engine.timeframe}`);
        }

        const msg = {
            method: "SUBSCRIBE",
            params: streams,
            id: Date.now()
        };

        // Note: For simplicity, we just resubscribe everything or we could diff.
        // Binance SUBSCRIBE is additive. UNSUBSCRIBE is subtractive.
        // To be safe and simple, we might just restart connection or clear/re-add.
        this.ws.send(JSON.stringify(msg));
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
