const { createChart } = LightweightCharts;

let chart = null;
let candleSeries = null;
let markers = [];
let allSymbols = []; // Cache for symbols
let recentSymbols = []; // Last 5 used symbols
let botStateHistory = new Map(); // symbol -> { tradesCount: 0, hasPosition: false }
const CASHIER_SOUND = new Audio('https://cdn.pixabay.com/audio/2024/09/13/audio_29108b3303.mp3'); // Classic Cha-Ching Sound

function playCashier() {
    CASHIER_SOUND.currentTime = 0;
    CASHIER_SOUND.play().catch(e => {
        console.warn("Audio play blocked by browser:", e);
        // Visual fallback: flash the status badge or show notification
        showVisualNotification('🔔 Nueva operación detectada');
    });
}

// Visual notification fallback when audio is blocked
function showVisualNotification(message) {
    const badge = document.getElementById('ws-status');
    if (badge) {
        const originalText = badge.innerText;
        const originalBg = badge.style.background;
        badge.innerText = message;
        badge.style.background = 'rgba(255, 234, 0, 0.3)';
        setTimeout(() => {
            badge.innerText = originalText;
            badge.style.background = originalBg;
        }, 2000);
    }
}

const STORAGE_KEYS = {
    START_DATE: 'backtest_startDate',
    END_DATE: 'backtest_endDate',
    RECENT_SYMBOLS: 'backtest_recentSymbols',
    ACTIVE_TAB: 'active_tab'
};

// Tab Switching Logic
function switchTab(tabId) {
    const buttons = document.querySelectorAll('.tab-btn');
    const panes = document.querySelectorAll('.tab-pane');

    buttons.forEach(btn => btn.classList.remove('active'));
    panes.forEach(pane => pane.classList.remove('active'));

    const targetPane = document.getElementById(`${tabId}-pane`);
    const targetBtn = Array.from(buttons).find(btn => btn.getAttribute('onclick').includes(`'${tabId}'`));

    if (targetPane) targetPane.classList.add('active');
    if (targetBtn) targetBtn.classList.add('active');

    // Save state
    localStorage.setItem(STORAGE_KEYS.ACTIVE_TAB, tabId);
}

// Init
document.addEventListener('DOMContentLoaded', () => {
    loadPersistedData();
    loadSymbols();
    setupAutocomplete();
    setupAutocompleteBot(); // New
    setupDatePersistence();
    setupClearButton();
    setupClearButtonBot(); // New

    // Initial fetch and start interval
    refreshActiveBots();
    setInterval(refreshActiveBots, 3000);
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

    // Restore active tab
    const savedTab = localStorage.getItem(STORAGE_KEYS.ACTIVE_TAB);
    if (savedTab) {
        switchTab(savedTab);
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
            // Show recent symbols or popular ones when input is empty
            const popular = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA'].map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }));
            const matches = recentSymbols.length > 0
                ? recentSymbols.map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }))
                : popular;
            renderSuggestions(matches, true);
            return;
        }

        const matches = allSymbols.filter(s => s.symbol.startsWith(val) || s.baseAsset.startsWith(val));
        renderSuggestions(matches.slice(0, 50), false);
    });

    // Show suggestions when focused and empty
    input.addEventListener('focus', () => {
        const val = input.value.toUpperCase();
        if (!val) {
            const popular = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA'].map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }));
            const matches = recentSymbols.length > 0
                ? recentSymbols.map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }))
                : popular;
            renderSuggestions(matches, true);
        }
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
        const clearBtn = document.getElementById('clearSymbol');
        if (e.target !== input && e.target !== list && !list.contains(e.target) && e.target !== clearBtn) {
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

// Toggle fee input based on checkbox
function toggleFeeInput() {
    const useBinance = document.getElementById('useBinanceFee').checked;
    const feeInput = document.getElementById('feePct');
    feeInput.disabled = useBinance;
    if (useBinance) {
        feeInput.value = '0.04'; // Default Binance taker fee
    }
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

    // Determine fee to use
    const useBinanceFee = document.getElementById('useBinanceFee').checked;
    const feeValue = useBinanceFee ? '0.04' : document.getElementById('feePct').value;

    const config = {
        symbol: document.getElementById('symbol').value,
        timeframe: document.getElementById('timeframe').value,
        initialCapital: document.getElementById('initialCapital').value,
        orderSize: document.getElementById('orderSize').value,
        stopLossPct: document.getElementById('stopLossPct').value,
        leverage: document.getElementById('leverage').value,
        feePct: feeValue,
        useBinanceFee: useBinanceFee,
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
        runBtn.innerText = 'Ejecutar Prueba';
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
            <td style="color: #888;">$${(t.commission || 0).toFixed(3)}</td>
            <td style="color: ${(t.funding || 0) < 0 ? '#00e676' : '#888'};">$${(t.funding || 0).toFixed(3)}</td>
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

// --- LIVE BOT FUNCTIONS ---
let botStatusInterval = null;

function setupClearButtonBot() {
    const clearBtn = document.getElementById('live-clearSymbol');
    const input = document.getElementById('live-symbol');
    if (!clearBtn || !input) return;

    clearBtn.addEventListener('click', () => {
        input.value = '';
        input.focus();
        input.dispatchEvent(new Event('input'));
    });
}

function setupAutocompleteBot() {
    const input = document.getElementById('live-symbol');
    const list = document.getElementById('live-symbolSuggestions');
    if (!input || !list) return;

    input.addEventListener('input', (e) => {
        const val = e.target.value.toUpperCase();
        if (val === '') {
            const popular = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA'].map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }));
            const matches = recentSymbols.length > 0
                ? recentSymbols.map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }))
                : popular;
            renderSuggestionsBot(matches, true);
            return;
        }

        const matches = allSymbols.filter(s =>
            s.symbol.includes(val) || s.baseAsset.includes(val)
        ).slice(0, 10);

        renderSuggestionsBot(matches);
    });

    input.addEventListener('focus', () => {
        if (input.value === '') {
            const popular = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA'].map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }));
            const matches = recentSymbols.length > 0
                ? recentSymbols.map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }))
                : popular;
            renderSuggestionsBot(matches, true);
        }
    });

    document.addEventListener('click', (e) => {
        const clearBtn = document.getElementById('live-clearSymbol');
        if (e.target !== input && e.target !== list && !list.contains(e.target) && e.target !== clearBtn) {
            list.style.display = 'none';
        }
    });
}

function renderSuggestionsBot(matches, showRecentHeader = false) {
    const list = document.getElementById('live-symbolSuggestions');
    if (matches.length === 0) {
        list.style.display = 'none';
        return;
    }

    list.innerHTML = '';
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
            document.getElementById('live-symbol').value = m.baseAsset;
            list.style.display = 'none';
        };
        list.appendChild(div);
    });
    list.style.display = 'block';
}

function handleStopExclusionBot(type) {
    const fixed = document.getElementById('live-useFixedSL');
    const breakeven = document.getElementById('live-useBreakeven');
    const trailing = document.getElementById('live-useTrailing');

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

    document.getElementById('live-stopLossPct').disabled = !fixed.checked;
    document.getElementById('live-trailingPct').disabled = !trailing.checked;

    updateUsdtValuesBot();
}

function updateUsdtValuesBot() {
    const margin = parseFloat(document.getElementById('live-orderSize').value) || 0;
    const lev = parseFloat(document.getElementById('live-leverage').value) || 1;
    const positionSize = margin * lev;

    const fixedPct = parseFloat(document.getElementById('live-stopLossPct').value) || 0;
    const fixedUsdt = positionSize * (fixedPct / 100);
    document.getElementById('live-fixedUsdt').innerText = fixedUsdt.toFixed(2) + ' USDT';

    const trailPct = parseFloat(document.getElementById('live-trailingPct').value) || 0;
    const trailUsdt = positionSize * (trailPct / 100);
    document.getElementById('live-trailingUsdt').innerText = trailUsdt.toFixed(2) + ' USDT';
}

async function runBot() {
    const runBtn = document.getElementById('live-runBtn');
    runBtn.innerText = 'Iniciando...';
    runBtn.disabled = true;

    let derivedMode = 'FIXED';
    if (document.getElementById('live-useBreakeven').checked) derivedMode = 'BREAKEVEN';
    else if (document.getElementById('live-useTrailing').checked) derivedMode = 'TRAILING';
    else if (!document.getElementById('live-useFixedSL').checked) derivedMode = 'NONE';

    const config = {
        symbol: document.getElementById('live-symbol').value,
        timeframe: document.getElementById('live-timeframe').value,
        initialCapital: document.getElementById('live-initialCapital').value,
        orderSize: document.getElementById('live-orderSize').value,
        stopLossPct: document.getElementById('live-stopLossPct').value,
        leverage: document.getElementById('live-leverage').value,
        direction: document.getElementById('live-direction').value,
        strategy: document.getElementById('live-strategy').value,
        slMode: derivedMode,
        trailingPct: document.getElementById('live-trailingPct').value,
        mode: document.getElementById('live-mode').value
    };

    saveRecentSymbol(config.symbol);

    try {
        const res = await fetch('/api/bot/pair/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        if (!res.ok) throw new Error(await res.text());

        await res.json();
        logBotEvent(`[SISTEMA] Bot para ${config.symbol} iniciado en modo ${config.mode}`);

        // Start polling if not started
        if (!botStatusInterval) {
            botStatusInterval = setInterval(refreshActiveBots, 2000);
            refreshActiveBots();
        }

    } catch (err) {
        alert('Error Bot: ' + err.message);
    } finally {
        runBtn.innerText = 'Añadir a HYDRA';
        runBtn.disabled = false;
    }
}

async function refreshActiveBots() {
    try {
        const res = await fetch('/api/bot/status');
        const data = await res.json(); // Now structure is { connection, bots }

        // Update connection badge
        const wsBadge = document.getElementById('ws-status');
        if (wsBadge) {
            if (data.connection === 'CONNECTED') {
                wsBadge.innerText = 'CONECTADO';
                wsBadge.style.background = 'rgba(0, 230, 118, 0.2)';
                wsBadge.style.color = '#00e676';
            } else if (data.connection === 'RECONNECTING') {
                wsBadge.innerText = `RECONECTANDO (Intento ${data.reconnectAttempts})...`;
                wsBadge.style.background = 'rgba(255, 171, 0, 0.2)';
                wsBadge.style.color = '#ffab00';
            } else if (data.connection === 'CONNECTING') {
                wsBadge.innerText = 'CONECTANDO...';
                wsBadge.style.background = 'rgba(33, 150, 243, 0.2)';
                wsBadge.style.color = '#2196f3';
            } else {
                wsBadge.innerText = 'DESCONECTADO';
                wsBadge.style.background = 'rgba(255, 23, 68, 0.2)';
                wsBadge.style.color = '#ff1744';
            }
        }

        const bots = data.bots;
        const tbody = document.getElementById('activeBotsBody');
        const tradesBody = document.getElementById('liveTradesBody');

        if (bots.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 2rem;">No hay monedas en seguimiento</td></tr>';
            tradesBody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-secondary); padding: 2rem;">Esperando primer trade...</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        let allLiveTrades = [];

        bots.forEach(bot => {
            // Check for new trades or position openings to play sound
            const prev = botStateHistory.get(bot.symbol) || { tradesCount: 0, hasPosition: false };
            const currentHasPos = !!bot.position;
            const currentTradesCount = bot.totalTrades;

            // Trigger sound if:
            // 1. New trade opened (hasPosition false -> true)
            // 2. Trade closed (tradesCount increased)
            if ((currentHasPos && !prev.hasPosition) || (currentTradesCount > prev.tradesCount)) {
                playCashier();
                console.log(`[AUDIO] Sound triggered for ${bot.symbol}`);
            }

            // Update history
            botStateHistory.set(bot.symbol, {
                tradesCount: currentTradesCount,
                hasPosition: currentHasPos
            });

            const tr = document.createElement('tr');
            let posBadge = '';
            if (bot.position) {
                posBadge = `<span class="badge ${bot.position.type === 'LONG' ? 'badge-long' : 'badge-short'}">${bot.position.type}</span>`;
            } else if (bot.pendingReEntry) {
                const signal = bot.pendingReEntry.neededSignal === 'Buy' ? 'LONG' : 'SHORT';
                posBadge = `<span class="badge" style="background: rgba(255, 171, 0, 0.2); color: #ffab00;">ESPERANDO ${signal}</span>`;
            } else {
                posBadge = `<span class="badge" style="background: #222; color: #888;">MONITOREANDO</span>`;
            }

            tr.innerHTML = `
                <td><strong>${bot.symbol}</strong></td>
                <td><span style="font-size: 0.75rem; background: #222; padding: 2px 4px; border-radius: 4px; color: #aaa;">${bot.timeframe}</span></td>
                <td><span style="font-size: 0.75rem; color: var(--text-secondary);">${bot.strategy}</span></td>
                <td><span style="font-size: 0.75rem; background: #333; padding: 2px 6px; border-radius: 4px;">${bot.mode}</span></td>
                <td>$${bot.balance.toFixed(2)}</td>
                <td>${posBadge}</td>
                <td>${bot.roi.toFixed(2)}%</td>
                <td>
                    <button class="btn-primary" onclick="stopBot('${bot.symbol}')" style="background: var(--danger); min-width: auto; font-size: 0.7rem; padding: 4px 8px;">Detener</button>
                </td>
            `;
            tbody.appendChild(tr);

            // Collect trades with symbol info
            bot.trades.forEach(t => {
                allLiveTrades.push({ ...t, symbol: bot.symbol });
            });
        });

        // Sort trades newest first
        allLiveTrades.sort((a, b) => b.exitTime - a.exitTime);

        if (allLiveTrades.length > 0) {
            tradesBody.innerHTML = '';
            allLiveTrades.slice(0, 50).forEach(t => { // Show last 50
                const tr = document.createElement('tr');
                const timeStr = new Date(t.exitTime).toLocaleTimeString();
                const pnlClass = t.pnl >= 0 ? 'text-green' : 'text-red';

                tr.innerHTML = `
                    <td style="color: #888;">${timeStr}</td>
                    <td><strong>${t.symbol}</strong></td>
                    <td><span class="badge ${t.type === 'LONG' ? 'badge-long' : 'badge-short'}">${t.type}</span></td>
                    <td>${t.entryPrice.toFixed(2)}</td>
                    <td>${t.exitPrice.toFixed(2)}</td>
                    <td style="color: #888;">$${(t.commission || 0).toFixed(3)}</td>
                    <td style="color: #888;">$${(t.funding || 0).toFixed(3)}</td>
                    <td class="${pnlClass}">$${t.pnl.toFixed(2)}</td>
                    <td style="color: #666; font-size: 0.8rem;">${t.reason}</td>
                `;
                tradesBody.appendChild(tr);
            });
        }

    } catch (err) {
        console.error("Error refreshing bots:", err);
    }
}

async function stopBot(symbol) {
    if (!confirm(`¿Detener el bot de ${symbol}?`)) return;
    try {
        await fetch('/api/bot/pair/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol })
        });
        refreshActiveBots();
        logBotEvent(`[SISTEMA] Bot para ${symbol} detenido.`);
    } catch (err) {
        alert("Error al detener bot: " + err.message);
    }
}

async function stopAllBots() {
    if (!confirm("¿Detener TODOS los bots de HYDRA?")) return;
    try {
        await fetch('/api/bot/stop-all', { method: 'POST' });
        refreshActiveBots();
        logBotEvent(`[SISTEMA] Todos los bots han sido detenidos.`);
    } catch (err) {
        alert("Error al detener todo: " + err.message);
    }
}

function logBotEvent(msg) {
    const log = document.getElementById('live-log');
    const resDiv = document.getElementById('live-results');
    resDiv.style.display = 'block';

    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.style.marginBottom = '4px';
    entry.innerText = `[${time}] ${msg}`;
    log.prepend(entry);
}
