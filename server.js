require('dotenv').config();
const express = require('express');
const { execSync } = require('child_process');
const path = require('path');
const cors = require('cors');
const backtestEngine = require('./lib/backtest');
const botManager = require('./lib/botManager');
const realBotManager = require('./lib/realBotManager');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.post('/api/backtest', async (req, res) => {
    try {
        const config = req.body;
        console.log('Starting backtest with config:', config);
        const results = await backtestEngine.run(config);
        res.json(results);
    } catch (error) {
        console.error('Backtest error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Live Bot Management (Paper)
app.post('/api/bot/pair/add', async (req, res) => {
    try {
        const config = req.body;
        const status = await botManager.addPair(config);
        res.json({ success: true, status });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/bot/pair/remove', (req, res) => {
    const { symbol } = req.body;
    const success = botManager.removePair(symbol);
    res.json({ success });
});

app.get('/api/bot/status', (req, res) => {
    const status = botManager.getStatus();
    res.json(status);
});

app.get('/api/bot/history', (req, res) => {
    const history = botManager.getHistory();
    res.json(history);
});

app.post('/api/bot/stop-all', (req, res) => {
    botManager.stopAll();
    res.json({ success: true });
});

app.post('/api/bot/history/clear', (req, res) => {
    botManager.clearHistory();
    res.json({ success: true });
});

app.get('/api/bot/history/export', (req, res) => {
    try {
        const history = botManager.getHistory();
        const activeBots = botManager.getStatus().bots || [];

        // Collect ALL trades from History sessions AND Active Bots
        let allTrades = [];

        // 1. From History Sessions
        history.forEach(session => {
            // Check if 'trades' exists in session object (not explicitly shown in saveToHistory but likely needed)
            // Wait, saveToHistory saves: initialCapital, finalBalance, etc. 
            // BUT it does NOT seem to save the list of trades inside historyEntry in botManager.js!
            // Looking at botManager.js:172... It saves totalTrades count, but NOT the trades array itself.
            // THIS IS A FINDING. I need to fix botManager.js to save the trades array first if I want to export past sessions.
            // However, the user might just want the current/recent ones.
            // Let's assume for now I will fix botManager.js too.
            if (Array.isArray(session.trades)) {
                allTrades = allTrades.concat(session.trades.map(t => ({ ...t, sessionParam: session.symbol })));
            }
        });

        // 2. From Active Bots
        activeBots.forEach(bot => {
            if (Array.isArray(bot.trades)) {
                allTrades = allTrades.concat(bot.trades.map(t => ({ ...t, sessionParam: bot.symbol })));
            }
        });

        // Sort by entry time
        allTrades.sort((a, b) => b.entryTime - a.entryTime);

        // Generate CSV
        const headers = ['Symbol', 'Type', 'Entry Time', 'Exit Time', 'Entry Price', 'Exit Price', 'Size', 'PnL', 'Reason'];
        const csvRows = [headers.join(',')];

        allTrades.forEach(trade => {
            const entryTime = new Date(trade.entryTime).toLocaleString();
            const exitTime = trade.exitTime ? new Date(trade.exitTime).toLocaleString() : 'Open';
            const symbol = trade.symbol || trade.sessionParam || 'Unknown';
            // Use full precision, simple string start
            const row = [
                symbol,
                trade.type,
                `"${entryTime}"`,
                `"${exitTime}"`,
                trade.entryPrice,
                trade.exitPrice || '',
                trade.size,
                trade.pnl || 0,
                `"${trade.reason || ''}"`
            ];
            csvRows.push(row.join(','));
        });

        const csvString = csvRows.join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="bot_trades_history.csv"');
        res.send(csvString);

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).send('Error generating CSV');
    }
});

// Real Bot Management (Exact Mirror for BOT 01)
app.post('/api/real-bot/pair/add', async (req, res) => {
    try {
        const config = req.body;
        const status = await realBotManager.addPair(config);
        res.json({ success: true, status });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/real-bot/pair/remove', (req, res) => {
    const { symbol } = req.body;
    const success = realBotManager.removePair(symbol);
    res.json({ success });
});

app.get('/api/real-bot/status', (req, res) => {
    const status = realBotManager.getStatus();
    res.json(status);
});

app.get('/api/real-bot/history', (req, res) => {
    const history = realBotManager.getHistory();
    res.json(history);
});

app.post('/api/real-bot/stop-all', (req, res) => {
    realBotManager.stopAll();
    res.json({ success: true });
});

app.get('/api/real-bot/balance', async (req, res) => {
    try {
        const balance = await realBotManager.fetchBalance();
        res.json({ balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/real-bot/history/clear', (req, res) => {
    realBotManager.clearHistory();
    res.json({ success: true });
});

// Version endpoint - returns git commit hash
app.get('/api/version', (req, res) => {
    try {
        const commitHash = execSync('git rev-parse --short HEAD').toString().trim();
        const commitDate = execSync('git log -1 --format=%cd --date=short').toString().trim();
        const commitMsg = execSync('git log -1 --format=%s').toString().trim();
        res.json({ commit: commitHash, date: commitDate, message: commitMsg });
    } catch (err) {
        res.json({ commit: 'unknown', date: '', message: '' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    botManager.loadState();
    realBotManager.loadState();
});
