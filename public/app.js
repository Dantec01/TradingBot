const { createChart } = LightweightCharts;

let chart = null;
let candleSeries = null;
let markers = [];
let allSymbols = []; // Cache for symbols
let recentSymbols = []; // Last 5 used symbols

const STORAGE_KEYS = {
    START_DATE: 'backtest_startDate',
    END_DATE: 'backtest_endDate',
    RECENT_SYMBOLS: 'backtest_recentSymbols'
};

// Init
document.addEventListener('DOMContentLoaded', () => {
    loadPersistedData();
    loadSymbols();
    setupAutocomplete();
    setupDatePersistence();
    setupClearButton();
});

// Setup clear button for symbol input
function setupClearButton() {
    const clearBtn = document.getElementById('clearSymbol');
    const input = document.getElementById('symbol');

    clearBtn.addEventListener('click', () => {
        input.value = '';
        input.focus();
        // Trigger input event to show recent symbols
        input.dispatchEvent(new Event('input'));
    });
}

// Load persisted data from localStorage
function loadPersistedData() {
    // Load dates
    const savedStartDate = localStorage.getItem(STORAGE_KEYS.START_DATE);
    const savedEndDate = localStorage.getItem(STORAGE_KEYS.END_DATE);

    if (savedStartDate) {
        document.getElementById('startDate').value = savedStartDate;
    }
    if (savedEndDate) {
        document.getElementById('endDate').value = savedEndDate;
    }

    // Load recent symbols
    const savedRecent = localStorage.getItem(STORAGE_KEYS.RECENT_SYMBOLS);
    if (savedRecent) {
        try {
            recentSymbols = JSON.parse(savedRecent);
        } catch (e) {
            recentSymbols = [];
        }
    }
}

// Setup date persistence on change
function setupDatePersistence() {
    document.getElementById('startDate').addEventListener('change', (e) => {
        localStorage.setItem(STORAGE_KEYS.START_DATE, e.target.value);
    });
    document.getElementById('endDate').addEventListener('change', (e) => {
        localStorage.setItem(STORAGE_KEYS.END_DATE, e.target.value);
    });
}

// Save a symbol to recent list
function saveRecentSymbol(symbol) {
    if (!symbol) return;
    const upper = symbol.toUpperCase();
    // Remove if already exists
    recentSymbols = recentSymbols.filter(s => s !== upper);
    // Add to front
    recentSymbols.unshift(upper);
    // Keep only last 5
    recentSymbols = recentSymbols.slice(0, 5);
    // Save
    localStorage.setItem(STORAGE_KEYS.RECENT_SYMBOLS, JSON.stringify(recentSymbols));
}

async function loadSymbols() {
    try {
        // Fetch from Binance Futures Exchange Info
        const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const data = await res.json();
        // Filter USDT pairs usually
        allSymbols = data.symbols
            .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
            .map(s => ({
                symbol: s.symbol,
                baseAsset: s.baseAsset
            }));
        console.log(`Loaded ${allSymbols.length} symbols.`);
    } catch (e) {
        console.error('Error loading symbols:', e);
    }
}

function setupAutocomplete() {
    const input = document.getElementById('symbol');
    const list = document.getElementById('symbolSuggestions');

    input.addEventListener('input', (e) => {
        const val = e.target.value.toUpperCase();
        if (!val) {
            // Show recent symbols when input is empty
            if (recentSymbols.length > 0) {
                const recentMatches = recentSymbols.map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }));
                renderSuggestions(recentMatches, true);
            } else {
                list.style.display = 'none';
            }
            return;
        }

        const matches = allSymbols.filter(s => s.symbol.startsWith(val) || s.baseAsset.startsWith(val));
        renderSuggestions(matches.slice(0, 50), false);
    });

    // Show recent when focused and empty
    input.addEventListener('focus', () => {
        const val = input.value.toUpperCase();
        if (!val && recentSymbols.length > 0) {
            const recentMatches = recentSymbols.map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }));
            renderSuggestions(recentMatches, true);
        }
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
        if (e.target !== input && e.target !== list && !list.contains(e.target)) {
            list.style.display = 'none';
        }
    });
}

function renderSuggestions(matches, showRecentHeader = false) {
    const list = document.getElementById('symbolSuggestions');
    if (matches.length === 0) {
        list.style.display = 'none';
        return;
    }

    list.innerHTML = '';

    // Add header for recent symbols
    if (showRecentHeader) {
        const header = document.createElement('div');
        header.className = 'suggestion-header';
        header.innerText = 'Recientes';
        header.style.cssText = 'padding: 8px 12px; color: #888; font-size: 0.8rem; border-bottom: 1px solid #333;';
        list.appendChild(header);
    }

    matches.forEach(m => {
        const div = document.createElement('div');
        div.className = 'suggestion-item';
        div.innerHTML = `
            <span class="symbol-text">${m.baseAsset}</span>
            ${m.isRecent ? '<span class="symbol-desc" style="color: #5e6ad2;">★</span>' : `<span class="symbol-desc">${m.symbol}</span>`}
        `;
        div.onclick = () => {
            document.getElementById('symbol').value = m.baseAsset;
            list.style.display = 'none';
        };
        list.appendChild(div);
    });
    list.style.display = 'block';
}



function handleStopExclusion(type) {
    const fixed = document.getElementById('useFixedSL');
    const breakeven = document.getElementById('useBreakeven');
    const trailing = document.getElementById('useTrailing');

    // Uncheck others
    if (type === 'FIXED' && fixed.checked) {
        breakeven.checked = false;
        trailing.checked = false;
    } else if (type === 'BREAKEVEN' && breakeven.checked) {
        fixed.checked = false;
        trailing.checked = false;
    } else if (type === 'TRAILING' && trailing.checked) {
        fixed.checked = false;
        breakeven.checked = false;
    }

    // Enable/Disable inputs
    document.getElementById('stopLossPct').disabled = !fixed.checked;
    document.getElementById('trailingPct').disabled = !trailing.checked;

    updateUsdtValues();
}

function updateUsdtValues() {
    const margin = parseFloat(document.getElementById('orderSize').value) || 0;
    const lev = parseFloat(document.getElementById('leverage').value) || 1;
    const positionSize = margin * lev;

    // Fixed Calc
    const fixedPct = parseFloat(document.getElementById('stopLossPct').value) || 0;
    const fixedUsdt = positionSize * (fixedPct / 100);
    document.getElementById('fixedUsdt').innerText = fixedUsdt.toFixed(2) + ' USDT';

    // Trailing Calc
    const trailPct = parseFloat(document.getElementById('trailingPct').value) || 0;
    const trailUsdt = positionSize * (trailPct / 100);
    document.getElementById('trailingUsdt').innerText = trailUsdt.toFixed(2) + ' USDT';
}

async function runBacktest() {
    const runBtn = document.getElementById('runBtn');
    runBtn.innerText = 'Corriendo...';
    runBtn.disabled = true;

    // Determine valid SL Mode
    let derivedMode = 'FIXED'; // default
    if (document.getElementById('useBreakeven').checked) derivedMode = 'BREAKEVEN';
    else if (document.getElementById('useTrailing').checked) derivedMode = 'TRAILING';
    else if (!document.getElementById('useFixedSL').checked) derivedMode = 'NONE'; // If none checked? Or treat as Fixed 0?

    const config = {
        symbol: document.getElementById('symbol').value,
        timeframe: document.getElementById('timeframe').value,
        initialCapital: document.getElementById('initialCapital').value,
        orderSize: document.getElementById('orderSize').value,
        stopLossPct: document.getElementById('stopLossPct').value,
        leverage: document.getElementById('leverage').value,
        feePct: document.getElementById('feePct').value,
        direction: document.getElementById('direction').value,
        strategy: document.getElementById('strategy').value,
        slMode: derivedMode,
        trailingPct: document.getElementById('trailingPct').value,
        startDate: document.getElementById('startDate').value,
        endDate: document.getElementById('endDate').value
    };

    // Save symbol to recent list
    saveRecentSymbol(config.symbol);

    try {
        const res = await fetch('/api/backtest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        if (!res.ok) throw new Error(await res.text());

        const data = await res.json();
        renderResults(data);

    } catch (err) {
        alert('Error: ' + err.message);
    } finally {
        runBtn.innerText = 'Ejecutar Simulación';
        runBtn.disabled = false;
    }
}

function renderResults(data) {
    document.getElementById('results').style.display = 'block';

    // 1. Stats
    const stats = data.stats;

    // ROI Card styling
    const roiEl = document.getElementById('roi');
    const roiCard = document.getElementById('card-roi');
    roiEl.innerText = stats.roi.toFixed(2) + '%';

    if (stats.roi >= 0) {
        roiCard.classList.add('positive');
    } else {
        roiCard.classList.remove('positive');
    }

    document.getElementById('finalBalance').innerText = '$' + stats.finalBalance.toFixed(2);
    document.getElementById('winRate').innerText = (stats.winRate * 100).toFixed(1) + '%';
    document.getElementById('totalTrades').innerText = stats.totalTrades;

    // 2. Table Rendering
    const tbody = document.getElementById('tradesTableBody');
    tbody.innerHTML = '';

    // Sort trades: newest first
    const sortedTrades = [...data.trades].reverse();

    sortedTrades.forEach(t => {
        const entDate = new Date(t.entryTime);
        const exitDate = new Date(t.exitTime);

        // Formato DD/MM/YYYY
        const formatDate = (d) => d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const formatTime = (d) => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const tr = document.createElement('tr');

        // PnL Color
        const pnlClass = t.pnl >= 0 ? 'text-green' : 'text-red';
        const pnlSign = t.pnl >= 0 ? '+' : '';

        // Badge
        const badgeClass = t.type === 'LONG' ? 'badge-long' : 'badge-short';

        tr.innerHTML = `
            <td>${formatDate(entDate)}</td>
            <td>${formatTime(entDate)}</td>
            <td>${formatDate(exitDate)}</td>
            <td>${formatTime(exitDate)}</td>
            <td><span class="badge ${badgeClass}">${t.type}</span></td>
            <td>${t.entryPrice.toFixed(4)}</td>
            <td>${t.exitPrice.toFixed(4)}</td>
            <td>${t.size.toFixed(4)}</td>
            <td class="${pnlClass}" style="font-weight:bold;">$${t.pnl.toFixed(2)}</td>
            <td style="color: #888;">${t.reason}</td>
        `;
        tbody.appendChild(tr);
    });

    // 3. Chart
    if (data.trades.length > 0 || data.candles.length > 0) {
        drawChart(data.candles, data.trades);
    }
}

function drawChart(candles, trades) {
    const container = document.getElementById('chart');
    container.innerHTML = ''; // clear

    chart = createChart(container, {
        layout: {
            background: { type: 'solid', color: '#15151e' },
            textColor: '#d1d4f9',
        },
        grid: {
            vertLines: { color: 'rgba(42, 46, 57, 0.5)' },
            horzLines: { color: 'rgba(42, 46, 57, 0.5)' },
        },
        rightPriceScale: {
            borderColor: 'rgba(197, 203, 206, 0.8)',
        },
        timeScale: {
            borderColor: 'rgba(197, 203, 206, 0.8)',
            timeVisible: true,
            secondsVisible: false,
        },
        localization: {
            timeFormatter: (timestamp) => {
                const date = new Date(timestamp * 1000);
                return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
            },
            dateFormatter: (timestamp) => {
                const date = new Date(timestamp * 1000);
                return date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
            }
        }
    });

    candleSeries = chart.addCandlestickSeries({
        upColor: '#00e676',
        downColor: '#ff1744',
        borderDownColor: '#ff1744',
        borderUpColor: '#00e676',
        wickDownColor: '#ff1744',
        wickUpColor: '#00e676',
    });

    // Process candle data for Lightweight Charts (time in seconds)
    const chartData = candles.map(c => ({
        time: c.time / 1000,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
    }));

    // Sort just in case
    chartData.sort((a, b) => a.time - b.time);

    candleSeries.setData(chartData);

    // Add markers
    const markers = [];
    trades.forEach(t => {
        // Entry
        markers.push({
            time: t.entryTime / 1000,
            position: t.type === 'LONG' ? 'belowBar' : 'aboveBar',
            color: '#ffea00',
            shape: t.type === 'LONG' ? 'arrowUp' : 'arrowDown',
            text: 'ENTRY ' + t.type
        });
        // Exit
        markers.push({
            time: t.exitTime / 1000,
            position: t.type === 'LONG' ? 'aboveBar' : 'belowBar',
            color: t.pnl > 0 ? '#00e676' : '#ff1744',
            shape: 'circle',
            text: '$' + t.pnl.toFixed(2) // Short text
        });
    });
    // Sort markers by time
    markers.sort((a, b) => a.time - b.time);

    candleSeries.setMarkers(markers);

    // Auto fit
    chart.timeScale().fitContent();
}
