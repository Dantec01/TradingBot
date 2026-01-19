const express = require('express');
const path = require('path');
const cors = require('cors');
const backtestEngine = require('./lib/backtest');

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

// Fallback removed to avoid Express 5/path-to-regexp matching errors
// Static middleware handles index.html naturally


app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
