const { createChart } = LightweightCharts;

let chart = null;
let candleSeries = null;
let markers = [];
let allSymbols = []; // Cache for symbols
let recentSymbols = []; // Last 5 used symbols
let botStateHistory = new Map(); // symbol -> { tradesCount: 0, hasPosition: false }
// Sound Effect
const CASHIER_SOUND = new Audio('https://www.myinstants.com/media/sounds/ka-ching.mp3');
// Sonido de Alarma (Alerta Nuclear / Sirena) - Loop infinito hasta que se pare
const ALARM_SOUND = new Audio('https://www.myinstants.com/media/sounds/nuclear-alarm.mp3');
ALARM_SOUND.loop = true;

let isAlarmPlaying = false;

function playCashier() {
    CASHIER_SOUND.currentTime = 0;
    const playPromise = CASHIER_SOUND.play();

    if (playPromise !== undefined) {
        playPromise.catch(e => {
            console.warn("Audio play blocked (Browser Autoplay Policy). User interaction needed first.", e);
            showVisualNotification('💰 Operación Detectada (Sonido Bloqueado)');
        });
    }
}

function playAlarm() {
    if (isAlarmPlaying) return;

    // Solo reproducir si el usuario ya interactuó con la página
    ALARM_SOUND.currentTime = 0;
    const playPromise = ALARM_SOUND.play();

    if (playPromise !== undefined) {
        playPromise.then(() => {
            isAlarmPlaying = true;
            document.body.style.animation = "flashRed 1s infinite"; // Efecto visual
            alert("⚠️ ALERTA CRÍTICA: ¡CONEXIÓN CON EL BOT PERDIDA! ⚠️");
        }).catch(() => {
            // Audio blocked by browser policy (user hasn't interacted yet)
            // Using visual fallback silently
            showVisualNotification('⚠️ DESCONECTADO ⚠️');
        });
    }
}

function stopAlarm() {
    if (!isAlarmPlaying) return;
    ALARM_SOUND.pause();
    ALARM_SOUND.currentTime = 0;
    isAlarmPlaying = false;
    document.body.style.animation = ""; // Quitar efecto visual
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
    setupVanguardLock();
    setupSpiritShieldLock();

    loadPersistedData();
    loadSymbols();
    setupAutocomplete();
    setupAutocompleteBot(); // New
    setupDatePersistence();
    setupClearButton();
    setupClearButtonBot(); // New

    // Initial fetch and start interval
    refreshActiveBots();
    refreshBotHistory(); // Fetch history
    setInterval(refreshActiveBots, 3000);
    setInterval(refreshBotHistory, 10000); // Poll history every 10s

    // REAL BOT INIT
    setupAutocompleteReal();
    setupClearButtonReal();
    refreshRealActiveBots();
    refreshRealBotHistory();
    setInterval(refreshRealActiveBots, 3000);
    setInterval(refreshRealBotHistory, 10000);

    // Unlock Audio Context on first interaction
    document.body.addEventListener('click', () => {
        CASHIER_SOUND.play().then(() => {
            CASHIER_SOUND.pause();
            CASHIER_SOUND.currentTime = 0;
        }).catch(() => { });
    }, { once: true });

    // Load version info
    loadVersion();
});

// Fetch and display version info
async function loadVersion() {
    try {
        const res = await fetch('/api/version');
        const data = await res.json();
        const versionEl = document.getElementById('app-version');
        if (versionEl && data.commit) {
            versionEl.innerText = `HYDRA v${data.commit} (${data.date}) — ${data.message || 'No message'}`;
        }
    } catch (e) {
        const versionEl = document.getElementById('app-version');
        if (versionEl) versionEl.innerText = 'HYDRA Trading Bot';
    }
}

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
        endDate: document.getElementById('endDate').value,
        takerFee: document.getElementById('takerFee').value,
        // SPIRIT_ELITE Config
        eliteActivationPct: (parseFloat(document.getElementById('eliteActivationPct')?.value) || 0.2) / 100, // Convert % to decimal
        eliteTickOffset: parseFloat(document.getElementById('eliteTickOffset')?.value) || 0.0001,
        eliteTrailingDefer: parseFloat(document.getElementById('eliteTrailingDefer')?.value) || 5
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
        lastBacktestData = data;
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

        // Use 5 decimals for low-price coins, 4 for others
        const priceDecimals = t.entryPrice < 1 ? 5 : 4;

        tr.innerHTML = `
            <td>${formatDate(entDate)}</td>
            <td>${formatTime(entDate)}</td>
            <td>${formatDate(exitDate)}</td>
            <td>${formatTime(exitDate)}</td>
            <td><span class="badge ${badgeClass}">${t.type}</span></td>
            <td>${t.entryPrice.toFixed(priceDecimals)}</td>
            <td>${t.exitPrice.toFixed(priceDecimals)}</td>
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

    // Add SL Series
    const slSeries = chart.addLineSeries({
        color: '#ff9800', // Orange
        lineWidth: 1,
        lineStyle: 2, // Dashed
        title: 'Stop Loss',
        crosshairMarkerVisible: false
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

    // SL Data
    const slData = [];
    candles.forEach(c => {
        if (c.stopLoss && c.stopLoss > 0) {
            slData.push({ time: c.time / 1000, value: c.stopLoss });
        } else {
            // Optional: Insert NaN to break the line if supported, or just skip
            // Using whitespace or just skipping relies on library behavior. 
            // For now, skipping. If lines connect across large gaps, it's acceptable.
            // slData.push({ time: c.time / 1000, value: NaN }); 
        }
    });
    // Sort just in case
    slData.sort((a, b) => a.time - b.time);
    slSeries.setData(slData);

    // Create a Set of valid candle times (seconds) for O(1) lookup/snapping
    // Assuming candles are sorted.
    // If a trade time doesn't match, we map it to the candle that covers it.
    // Since we don't know the interval explicitly here easily without calculation, 
    // we can assume the trade belongs to the candle with time <= tradeTime.

    // 1. Build map of times
    const validTimes = new Set(chartData.map(d => d.time));
    const sortedTimes = chartData.map(d => d.time); // ASC sorted

    // Helper to find closest candle time (floor)
    const findCandleTime = (tsSec) => {
        if (validTimes.has(tsSec)) return tsSec;

        // Binary search or linear scan (efficient enough for < 10k bars usually, but binary is better)
        // Let's do a simple reverse find since trades usually happen near end or recent? 
        // No, binary search or simple approximation.
        // Actually, just iterating backwards from the end of sortedTimes until <= tsSec is fine 
        // IF we assume coverage. But trades might be outside range? 

        // Let's use a simpler approach: 
        // The exit time MUST be >= Candle Open Time and < Next Candle Open Time.
        // So we find the largest validTime <= tsSec.

        let l = 0, r = sortedTimes.length - 1;
        let ans = -1;
        while (l <= r) {
            const mid = Math.floor((l + r) / 2);
            if (sortedTimes[mid] <= tsSec) {
                ans = sortedTimes[mid];
                l = mid + 1;
            } else {
                r = mid - 1;
            }
        }
        return ans;
    };

    // Add markers
    const markers = [];
    trades.forEach(t => {
        // Entry - usually matches candle open time exactly if CLOSE_ENTRY from backtest
        // But for OPEN_ENTRY or VANGUARD it might vary.
        const entryTimeSec = t.entryTime / 1000;
        const snappedEntry = findCandleTime(entryTimeSec);

        if (snappedEntry !== -1) {
            markers.push({
                time: snappedEntry,
                position: t.type === 'LONG' ? 'belowBar' : 'aboveBar',
                color: '#ffea00',
                shape: t.type === 'LONG' ? 'arrowUp' : 'arrowDown',
                text: 'ENTRY ' + t.type
            });
        }

        // Exit
        const exitTimeSec = t.exitTime / 1000;
        const snappedExit = findCandleTime(exitTimeSec);

        if (snappedExit !== -1) {
            const priceDecimals = t.exitPrice < 1 ? 5 : 4;
            markers.push({
                time: snappedExit,
                position: t.type === 'LONG' ? 'aboveBar' : 'belowBar',
                color: t.pnl > 0 ? '#00e676' : '#ff1744',
                shape: 'circle',
                text: `$${t.pnl.toFixed(2)} (${t.exitPrice.toFixed(priceDecimals)}) [${t.reason}]`
            });
        }
    });

    // Sort markers by time (required by library)
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
        mode: document.getElementById('live-mode').value,
        // SPIRIT_ELITE Config
        eliteActivationPct: (parseFloat(document.getElementById('live-eliteActivationPct')?.value) || 0.2) / 100,
        eliteTickOffset: parseFloat(document.getElementById('live-eliteTickOffset')?.value) || 0.0001,
        eliteTrailingDefer: parseFloat(document.getElementById('live-eliteTrailingDefer')?.value) || 5
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
        // Update connection badge
        const wsBadge = document.getElementById('ws-status');
        if (wsBadge) {
            if (data.connection === 'CONNECTED') {
                wsBadge.innerText = 'CONECTADO';
                wsBadge.style.background = 'rgba(0, 230, 118, 0.2)';
                wsBadge.style.color = '#00e676';
                if (isAlarmPlaying) stopAlarm(); // Recuperó conexión -> parar alarma
            } else if (data.connection === 'RECONNECTING') {
                wsBadge.innerText = `RECONECTANDO (Intento ${data.reconnectAttempts})...`;
                wsBadge.style.background = 'rgba(255, 171, 0, 0.2)';
                wsBadge.style.color = '#ffab00';
                playAlarm(); // Perdió conexión -> sonar alarma
            } else if (data.connection === 'CONNECTING') {
                wsBadge.innerText = 'CONECTANDO...';
                wsBadge.style.background = 'rgba(33, 150, 243, 0.2)';
                wsBadge.style.color = '#2196f3';
            } else {
                wsBadge.innerText = 'DESCONECTADO';
                wsBadge.style.background = 'rgba(255, 23, 68, 0.2)';
                wsBadge.style.color = '#ff1744';
                playAlarm(); // Totalmente muerto -> sonar alarma
            }
        }

        const bots = data.bots;
        const tbody = document.getElementById('activeBotsBody');
        const tradesBody = document.getElementById('liveTradesBody');

        if (bots.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-secondary); padding: 2rem;">No hay monedas en seguimiento</td></tr>';
            tradesBody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-secondary); padding: 2rem;">Esperando primer trade...</td></tr>';
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
                <td><span style="font-size: 0.75rem; color: #ccc;">${bot.slMode}</span></td>
                <td><span style="font-size: 0.75rem; color: #ccc;">${bot.stopLossPct}%</span></td>
                <td>$${Number(bot.initialCapital).toFixed(2)}</td>
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
                const entryStr = new Date(t.entryTime).toLocaleTimeString();
                const exitStr = new Date(t.exitTime).toLocaleTimeString();
                const pnlClass = t.pnl >= 0 ? 'text-green' : 'text-red';
                // Dynamic decimal places based on price magnitude
                const priceDecimals = t.entryPrice < 1 ? 5 : (t.entryPrice < 100 ? 4 : 2);
                const offsetValue = t.eliteTickOffset || 0;

                tr.innerHTML = `
                    <td style="color: #888;">${entryStr}</td>
                    <td style="color: #888;">${exitStr}</td>
                    <td><strong>${t.symbol}</strong></td>
                    <td><span class="badge ${t.type === 'LONG' ? 'badge-long' : 'badge-short'}">${t.type}</span></td>
                    <td>${t.entryPrice.toFixed(priceDecimals)}</td>
                    <td>${t.exitPrice.toFixed(priceDecimals)}</td>
                    <td style="color: #9c27b0; font-size: 0.8rem;">${offsetValue > 0 ? offsetValue.toFixed(5) : '-'}</td>
                    <td style="color: #888;">$${(t.commission || 0).toFixed(4)}</td>
                    <td style="color: #888;">$${(t.funding || 0).toFixed(4)}</td>
                    <td class="${pnlClass}">$${t.pnl.toFixed(4)}</td>
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
    if (!confirm(`¿Detener bot para ${symbol}? Se guardará el historial de sesión.`)) return;
    try {
        await fetch('/api/bot/pair/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol })
        });
        refreshActiveBots();
        setTimeout(refreshBotHistory, 1000); // Wait for FS save
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
        setTimeout(refreshBotHistory, 1000);
        logBotEvent(`[SISTEMA] Todos los bots han sido detenidos.`);
    } catch (err) {
        alert("Error al detener todo: " + err.message);
    }
}

// --- REAL BOT FUNCTIONS (BOT 01) ---

function setupClearButtonReal() {
    const clearBtn = document.getElementById('real-clearSymbol');
    const input = document.getElementById('real-symbol');
    if (!clearBtn || !input) return;

    clearBtn.addEventListener('click', () => {
        input.value = '';
        input.focus();
        input.dispatchEvent(new Event('input'));
    });
}

function setupAutocompleteReal() {
    const input = document.getElementById('real-symbol');
    const list = document.getElementById('real-symbolSuggestions');
    if (!input || !list) return;

    input.addEventListener('input', (e) => {
        const val = e.target.value.toUpperCase();
        if (val === '') {
            const popular = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA'].map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }));
            const matches = recentSymbols.length > 0
                ? recentSymbols.map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }))
                : popular;
            renderSuggestionsReal(matches, true);
            return;
        }

        const matches = allSymbols.filter(s => s.symbol.includes(val) || s.baseAsset.includes(val)).slice(0, 10);
        renderSuggestionsReal(matches);
    });

    input.addEventListener('focus', () => {
        if (input.value === '') {
            const popular = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA'].map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }));
            const matches = recentSymbols.length > 0
                ? recentSymbols.map(s => ({ symbol: s + 'USDT', baseAsset: s, isRecent: true }))
                : popular;
            renderSuggestionsReal(matches, true);
        }
    });

    document.addEventListener('click', (e) => {
        const clearBtn = document.getElementById('real-clearSymbol');
        if (e.target !== input && e.target !== list && !list.contains(e.target) && e.target !== clearBtn) {
            list.style.display = 'none';
        }
    });
}

function renderSuggestionsReal(matches, showRecentHeader = false) {
    const list = document.getElementById('real-symbolSuggestions');
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
            ${m.isRecent ? '<span class="symbol-desc" style="color: #ffeb3b;">★</span>' : `<span class="symbol-desc">${m.symbol}</span>`}
        `;
        div.onclick = () => {
            document.getElementById('real-symbol').value = m.baseAsset;
            list.style.display = 'none';
        };
        list.appendChild(div);
    });
    list.style.display = 'block';
}

function handleStopExclusionReal(type) {
    const fixed = document.getElementById('real-useFixedSL');
    const breakeven = document.getElementById('real-useBreakeven');
    const trailing = document.getElementById('real-useTrailing');

    if (type === 'FIXED' && fixed.checked) {
        breakeven.checked = false;
        trailing.checked = false;
        document.getElementById('real-stopLossPct').disabled = false;
        document.getElementById('real-trailingPct').disabled = true;
    } else if (type === 'BREAKEVEN' && breakeven.checked) {
        fixed.checked = false;
        trailing.checked = false;
        document.getElementById('real-stopLossPct').disabled = true;
        document.getElementById('real-trailingPct').disabled = true;
    } else if (type === 'TRAILING' && trailing.checked) {
        fixed.checked = false;
        breakeven.checked = false;
        document.getElementById('real-stopLossPct').disabled = true;
        document.getElementById('real-trailingPct').disabled = false;
    }
    updateUsdtValuesReal();
}

function updateUsdtValuesReal() {
    const cap = parseFloat(document.getElementById('real-orderSize').value) || 0;

    // Fixed SL Value
    const slPct = parseFloat(document.getElementById('real-stopLossPct').value) || 0;
    const fixedUsdt = (cap * (slPct / 100)).toFixed(2);
    document.getElementById('real-fixedUsdt').innerText = `${fixedUsdt} USDT`;

    // Trailing SL Value (Estimate based on gap)
    const trainlingPct = parseFloat(document.getElementById('real-trailingPct').value) || 0;
    const trailingUsdt = (cap * (trainlingPct / 100)).toFixed(2);
    document.getElementById('real-trailingUsdt').innerText = `${trailingUsdt} USDT`;
}

// ========== REAL BOT LOG FUNCTIONS ==========

function updateRealBotLog(logs) {
    const logContainer = document.getElementById('real-log');
    const resultsDiv = document.getElementById('real-results');

    if (!logContainer || !resultsDiv) return;

    // Show the console section
    resultsDiv.style.display = 'block';

    if (!logs || logs.length === 0) {
        logContainer.innerHTML = '<span style="color: #666;">Sin logs...</span>';
        return;
    }

    // Render logs with color coding
    logContainer.innerHTML = logs.slice(0, 50).map(log => {
        let color = '#aaa';
        if (log.level === 'ERROR') color = '#ff1744';
        else if (log.level === 'WARN') color = '#ffab00';
        else if (log.level === 'SUCCESS') color = '#00e676';
        else if (log.level === 'INFO') color = '#2196f3';

        const time = new Date(log.time).toLocaleTimeString();
        return `<div style="color: ${color}; margin-bottom: 4px;">[${time}] ${log.message}</div>`;
    }).join('');
}

function logRealBotEvent(message) {
    const logContainer = document.getElementById('real-log');
    const resultsDiv = document.getElementById('real-results');

    if (resultsDiv) resultsDiv.style.display = 'block';
    if (logContainer) {
        const time = new Date().toLocaleTimeString();
        logContainer.innerHTML = `<div style="color: #2196f3; margin-bottom: 4px;">[${time}] ${message}</div>` + logContainer.innerHTML;
    }
}

function clearRealBotLogs() {
    const logContainer = document.getElementById('real-log');
    if (logContainer) {
        logContainer.innerHTML = '<span style="color: #666;">Logs limpiados. Esperando nuevos eventos...</span>';
    }
}

// ========================================

async function runRealBot() {
    const runBtn = document.getElementById('real-runBtn');
    runBtn.innerText = 'Iniciando...';
    runBtn.disabled = true;

    let derivedMode = 'FIXED';
    if (document.getElementById('real-useBreakeven').checked) derivedMode = 'BREAKEVEN';
    else if (document.getElementById('real-useTrailing').checked) derivedMode = 'TRAILING';
    else if (!document.getElementById('real-useFixedSL').checked) derivedMode = 'NONE';

    const config = {
        symbol: document.getElementById('real-symbol').value,
        timeframe: document.getElementById('real-timeframe').value,
        initialCapital: document.getElementById('real-initialCapital').value,
        orderSize: document.getElementById('real-orderSize').value,
        stopLossPct: document.getElementById('real-stopLossPct').value,
        leverage: document.getElementById('real-leverage').value,
        direction: document.getElementById('real-direction').value,
        strategy: document.getElementById('real-strategy').value,
        slMode: derivedMode,
        trailingPct: document.getElementById('real-trailingPct').value,
        mode: document.getElementById('real-mode').value,
        // SPIRIT_ELITE Config
        eliteActivationPct: (parseFloat(document.getElementById('real-eliteActivationPct')?.value) || 0.2) / 100,
        eliteTickOffset: parseFloat(document.getElementById('real-eliteTickOffset')?.value) || 0.0001,
        eliteTrailingDefer: parseFloat(document.getElementById('real-eliteTrailingDefer')?.value) || 5
    };

    saveRecentSymbol(config.symbol);

    try {
        const res = await fetch('/api/real-bot/pair/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        if (!res.ok) throw new Error(await res.text());

        await res.json();
        logRealBotEvent(`[REAL BOT] Iniciado para ${config.symbol}`);
        refreshRealActiveBots();

    } catch (err) {
        alert('Error Real Bot: ' + err.message);
    } finally {
        runBtn.innerText = 'Iniciar BOT 01';
        runBtn.disabled = false;
    }
}

async function refreshRealActiveBots() {
    try {
        const res = await fetch('/api/real-bot/status');
        const data = await res.json();

        // Update Logs
        if (data.logs) {
            updateRealBotLog(data.logs);
        }

        // Update Balance
        // Update Balance (Protected)
        const balanceEl = document.getElementById('real-total-balance');
        if (balanceEl && data.totalBalance !== undefined) {
            const newBal = parseFloat(data.totalBalance);
            // Solo actualizamos si el nuevo valor es significativo (> 0)
            // O si el valor actual es un placeholder ("---" o "...")
            if (newBal > 0) {
                balanceEl.innerText = `$${newBal.toFixed(2)}`;
            } else if (newBal === 0 && (balanceEl.innerText === '---' || balanceEl.innerText === '...')) {
                // Si realmente es 0 y no tenemos nada, mostramos 0.
                balanceEl.innerText = `$0.00`;
            }
        }

        // Update connection badge
        const wsBadge = document.getElementById('real-ws-status');
        if (wsBadge) {
            if (data.connection === 'CONNECTED') {
                wsBadge.innerText = 'CONECTADO';
                wsBadge.style.background = 'rgba(0, 230, 118, 0.2)';
                wsBadge.style.color = '#00e676';
            } else if (data.connection === 'RECONNECTING') {
                wsBadge.innerText = `RECONECTANDO...`;
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
        const tbody = document.getElementById('realActiveBotsBody');
        const tradesBody = document.getElementById('realTradesBody');

        if (bots.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-secondary); padding: 2rem;">No hay monedas en seguimiento</td></tr>';
            tradesBody.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-secondary); padding: 2rem;">Esperando primer trade...</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        let allLiveTrades = [];

        bots.forEach(bot => {
            // Check for new trades (Sound logic duplicated or shared? Shared CASHIER_SOUND but separate tracking)
            // Ideally we need separate tracking for real bot states to avoid conflicts
            // For now, let's play sound on any trade
            const prev = botStateHistory.get('REAL_' + bot.symbol) || { tradesCount: 0, hasPosition: false };
            const currentHasPos = !!bot.position;
            const currentTradesCount = bot.totalTrades;

            if ((currentHasPos && !prev.hasPosition) || (currentTradesCount > prev.tradesCount)) {
                playCashier();
                console.log(`[AUDIO] Sound triggered for REAL ${bot.symbol}`);
            }

            botStateHistory.set('REAL_' + bot.symbol, {
                tradesCount: currentTradesCount,
                hasPosition: currentHasPos
            });

            const tr = document.createElement('tr');
            let posBadge = '';
            if (bot.position) {
                posBadge = `<span class="badge ${bot.position.type === 'LONG' ? 'badge-long' : 'badge-short'}">${bot.position.type}</span>`;
            } else if (bot.waitingForLimitFill) {
                const signal = bot.waitingForLimitFill.type;
                posBadge = `<span class="badge" style="background: rgba(33, 150, 243, 0.2); color: #2196f3;">LIMIT ${signal}</span>`;
            } else if (bot.pendingVirtualOrder) {
                const signal = bot.pendingVirtualOrder.type;
                posBadge = `<span class="badge" style="background: rgba(156, 39, 176, 0.2); color: #ce93d8;">VIRTUAL ${signal}</span>`;
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
                <td><span style="font-size: 0.75rem; color: #ccc;">${bot.slMode}</span></td>
                <td><span style="font-size: 0.75rem; color: #ccc;">${bot.stopLossPct}%</span></td>
                <td>$${Number(bot.initialCapital).toFixed(2)}</td>
                <td>$${bot.balance.toFixed(2)}</td>
                <td>${posBadge}</td>
                <td>${bot.roi.toFixed(2)}%</td>
                <td>
                    <button type="button" class="btn-primary" onclick="stopRealBot('${bot.symbol}')" style="background: var(--danger); min-width: auto; font-size: 0.7rem; padding: 4px 8px;">Detener</button>
                </td>
            `;
            tbody.appendChild(tr);

            bot.trades.forEach(t => {
                allLiveTrades.push({ ...t, symbol: bot.symbol });
            });
        });

        allLiveTrades.sort((a, b) => b.exitTime - a.exitTime);

        if (allLiveTrades.length > 0) {
            tradesBody.innerHTML = '';
            allLiveTrades.slice(0, 50).forEach(t => {
                const tr = document.createElement('tr');
                const entryStr = new Date(t.entryTime).toLocaleTimeString();
                const exitStr = new Date(t.exitTime).toLocaleTimeString();
                const pnlClass = t.pnl >= 0 ? 'text-green' : 'text-red';
                // Dynamic decimal places based on price magnitude
                const priceDecimals = t.entryPrice < 1 ? 5 : (t.entryPrice < 100 ? 4 : 2);
                const offsetValue = t.eliteTickOffset || 0;

                tr.innerHTML = `
                    <td style="color: #888;">${entryStr}</td>
                    <td style="color: #888;">${exitStr}</td>
                    <td><strong>${t.symbol}</strong></td>
                    <td><span class="badge ${t.type === 'LONG' ? 'badge-long' : 'badge-short'}">${t.type}</span></td>
                    <td>${t.entryPrice.toFixed(priceDecimals)}</td>
                    <td>${t.exitPrice.toFixed(priceDecimals)}</td>
                    <td style="color: #9c27b0; font-size: 0.8rem;">${offsetValue > 0 ? offsetValue.toFixed(5) : '-'}</td>
                    <td style="color: #888;">$${(t.commission || 0).toFixed(4)}</td>
                    <td style="color: #888;">$${(t.funding || 0).toFixed(4)}</td>
                    <td class="${pnlClass}">$${t.pnl.toFixed(4)}</td>
                    <td style="color: #666; font-size: 0.8rem;">${t.reason}</td>
                `;
                tradesBody.appendChild(tr);
            });
        }

    } catch (err) {
        console.error("Error refreshing REAL bots:", err);
    }
}

async function stopRealBot(symbol) {
    if (!confirm(`¿Detener REAL BOT para ${symbol}? Se guardará el historial.`)) return;
    try {
        await fetch('/api/real-bot/pair/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol })
        });
        refreshRealActiveBots();
        setTimeout(refreshRealBotHistory, 1000);
        logRealBotEvent(`[SISTEMA] Real Bot ${symbol} detenido.`);
    } catch (err) {
        alert("Error: " + err.message);
    }
}

async function stopRealBot(symbol) {
    if (!confirm(`¿Detener REAL BOT para ${symbol}? Se guardará el historial.`)) return;
    try {
        await fetch('/api/real-bot/pair/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol })
        });
        refreshRealActiveBots();
        setTimeout(refreshRealBotHistory, 1000);
        logRealBotEvent(`[SISTEMA] Real Bot ${symbol} detenido.`);
    } catch (err) {
        alert("Error: " + err.message);
    }
}

function clearRealBotLogs() {
    const logContainer = document.getElementById('real-log');
    if (logContainer) {
        logContainer.innerHTML = '<span style="color: #666;">Logs limpiados. Esperando nuevos eventos...</span>';
    }
}

async function stopAllRealBots() {
    if (!confirm("¿Detener TODOS los bots REALES?")) return;
    try {
        await fetch('/api/real-bot/stop-all', { method: 'POST' });
        refreshRealActiveBots();
        setTimeout(refreshRealBotHistory, 1000);
        logRealBotEvent(`[SISTEMA] Todos los bots reales detenidos.`);
    } catch (err) {
        alert("Error: " + err.message);
    }
}

async function refreshRealBotHistory() {
    try {
        const res = await fetch('/api/real-bot/history');
        const history = await res.json();
        const tbody = document.getElementById('realHistoryBotsBody');

        if (history.length === 0) {
            tbody.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-secondary); padding: 2rem;">No hay historial disponible</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        history.forEach(entry => {
            const tr = document.createElement('tr');

            const formatDate = (ts) => new Date(ts).toLocaleString('es-ES', {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            });

            const pnlClass = entry.pnl >= 0 ? 'text-green' : 'text-red';
            const pnlSign = entry.pnl >= 0 ? '+' : '';

            tr.innerHTML = `
                <td><strong>${entry.symbol}</strong> <span style="font-size:0.7em; color:#888;">${entry.timeframe}</span></td>
                <td><span style="font-size: 0.75rem; color: var(--text-secondary);">${entry.strategy}</span></td>
                <td><span style="font-size: 0.75rem; color: #ccc;">${entry.slMode}</span></td>
                <td><span style="font-size: 0.75rem; color: #ccc;">${entry.stopLossPct}%</span></td>
                <td>$${Number(entry.initialCapital).toFixed(2)}</td>
                <td>$${Number(entry.finalBalance).toFixed(2)}</td>
                <td class="${pnlClass}" style="font-weight:bold;">${pnlSign}$${Number(entry.pnl).toFixed(2)}</td>
                <td style="font-size: 0.75rem; color: #aaa;">${formatDate(entry.startTime)}</td>
                <td style="font-size: 0.75rem; color: #aaa;">${formatDate(entry.endTime)}</td>
                <td><span class="badge" style="background:#333;">${entry.duration}</span></td>
                <td>${entry.totalTrades}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error("Error refreshing REAL history:", err);
    }
}

async function clearRealBotHistory() {
    if (!confirm("¿Borrar todo el historial de sesiones REALES?")) return;
    try {
        await fetch('/api/real-bot/history/clear', { method: 'POST' });
        refreshRealBotHistory();
    } catch (err) {
        alert("Error: " + err.message);
    }
}

// --- FETCH BALANCE ON DEMAND ---
async function fetchRealBalance() {
    const balanceEl = document.getElementById('real-total-balance');
    const originalText = balanceEl.innerText;
    balanceEl.innerText = '...';

    try {
        const res = await fetch('/api/real-bot/balance');
        if (!res.ok) throw new Error('Error API');
        const data = await res.json();
        const balanceVal = parseFloat(data.balance);

        // Update display text
        balanceEl.innerText = `$${balanceVal.toFixed(2)}`;

        // Update initial capital input automatically
        const capitalInput = document.getElementById('real-initialCapital');
        if (capitalInput) {
            capitalInput.value = Math.floor(balanceVal); // Round down to safer integer or keep decimals? Let's verify precision.
            // Better to keep up to 2 decimals but maybe floor slightly to avoid rounding issues on max balance usage
            // Let's use 2 decimals
            capitalInput.value = balanceVal.toFixed(2);
        }

    } catch (err) {
        console.error("Error fetching balance:", err);
        balanceEl.innerText = originalText;
        alert("Error obteniendo balance: " + err.message);
    }
}



async function refreshBotHistory() {
    try {
        const res = await fetch('/api/bot/history');
        const history = await res.json();
        const tbody = document.getElementById('historyBotsBody');

        if (history.length === 0) {
            tbody.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-secondary); padding: 2rem;">No hay historial disponible</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        history.forEach(entry => {
            const tr = document.createElement('tr');

            const formatDate = (ts) => new Date(ts).toLocaleString('es-ES', {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            });

            const pnlClass = entry.pnl >= 0 ? 'text-green' : 'text-red';
            const pnlSign = entry.pnl >= 0 ? '+' : '';

            tr.innerHTML = `
                <td><strong>${entry.symbol}</strong> <span style="font-size:0.7em; color:#888;">${entry.timeframe}</span></td>
                <td><span style="font-size: 0.75rem; color: var(--text-secondary);">${entry.strategy}</span></td>
                <td><span style="font-size: 0.75rem; color: #ccc;">${entry.slMode}</span></td>
                <td><span style="font-size: 0.75rem; color: #ccc;">${entry.stopLossPct}%</span></td>
                <td>$${Number(entry.initialCapital).toFixed(2)}</td>
                <td>$${Number(entry.finalBalance).toFixed(2)}</td>
                <td class="${pnlClass}" style="font-weight:bold;">${pnlSign}$${Number(entry.pnl).toFixed(2)}</td>
                <td style="font-size: 0.75rem; color: #aaa;">${formatDate(entry.startTime)}</td>
                <td style="font-size: 0.75rem; color: #aaa;">${formatDate(entry.endTime)}</td>
                <td><span class="badge" style="background:#333;">${entry.duration}</span></td>
                <td>${entry.totalTrades}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error("Error refreshing history:", err);
    }
}

function setupVanguardLock() {
    // 1. For Live Bot (Paper)
    const liveStrat = document.getElementById('live-strategy');
    const liveTf = document.getElementById('live-timeframe');
    const liveWarn = document.getElementById('live-vanguard-warning');

    if (liveStrat && liveTf) {
        liveStrat.addEventListener('change', () => {
            if (liveStrat.value === 'VANGUARD') {
                liveTf.value = '5m';
                liveTf.disabled = true;
                if (liveWarn) liveWarn.style.display = 'block';
            } else {
                liveTf.disabled = false;
                if (liveWarn) liveWarn.style.display = 'none';
            }
        });
    }

    // 2. For Real Bot
    // We use a specific selector for the Real Bot strategy dropdown if ID is ambiguous, 
    // but we updated index.html to likely use standard IDs or simply 'realBotForm' context.
    // Based on previous edits, the ID 'real-strategy' was NOT explicitly added, but the select exists.
    // Let's target it via the form to be safe: #realBotForm select (Strategy is usually the 2nd or 3rd select)
    // Or let's assume the user added ID or we target by name if available.
    // Best bet: Selector by structure since we didn't confirm ID addition.
    // Structure: #realBotForm .form-group select[id="real-strategy"] (if it exists) OR just finding the select with options.
    // However, since we edited index.html to include VANGUARD option, let's assume we can find it.

    // TRICK: We can find it by the options it contains if ID is missing!
    const selects = document.querySelectorAll('#realBotForm select');
    let realStrat = null;
    selects.forEach(s => {
        if (s.querySelector('option[value="VANGUARD"]')) realStrat = s;
    });

    const realTf = document.getElementById('real-timeframe');
    const realWarn = document.getElementById('real-vanguard-warning');

    if (realStrat && realTf) {
        realStrat.addEventListener('change', () => {
            if (realStrat.value === 'VANGUARD') {
                realTf.value = '5m';
                realTf.disabled = true;
                if (realWarn) realWarn.style.display = 'block';
            } else {
                realTf.disabled = false;
                if (realWarn) realWarn.style.display = 'none';
            }
        });
    }

    // 3. For Backtest
    const backtestStrat = document.getElementById('strategy');
    const backtestTf = document.getElementById('timeframe');

    if (backtestStrat && backtestTf) {
        backtestStrat.addEventListener('change', () => {
            if (backtestStrat.value === 'VANGUARD') {
                backtestTf.value = '5m';
                backtestTf.disabled = true;
            } else {
                backtestTf.disabled = false;
            }
        });
    }
}

// --- SPIRIT SHIELD LOCK (Smart Breakeven UI) ---
function setupSpiritShieldLock() {
    // Helper to lock SL fields
    const toggleSLFields = (formPrefix, isLocked) => {
        const slInputs = [
            `${formPrefix}useFixedSL`,
            `${formPrefix}stopLossPct`,
            `${formPrefix}useBreakeven`,
            `${formPrefix}useTrailing`,
            `${formPrefix}trailingPct`
        ];

        slInputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.disabled = isLocked;
                // Auto-uncheck if locking
                if (isLocked) {
                    if (el.type === 'checkbox') el.checked = false;
                    el.parentElement.style.opacity = '0.5';
                    el.parentElement.style.pointerEvents = 'none';
                } else {
                    el.parentElement.style.opacity = '1';
                    el.parentElement.style.pointerEvents = 'auto';
                }
            }
        });
    };

    // 1. Backtest
    const btStrat = document.getElementById('strategy');
    const eliteConfigDiv = document.getElementById('eliteConfig');

    if (btStrat) {
        btStrat.addEventListener('change', () => {
            toggleSLFields('', btStrat.value === 'SPIRIT_SHIELD' || btStrat.value === 'SPIRIT_ELITE' || btStrat.value === 'SPIRIT_TEST');
            // Show/hide elite config
            if (eliteConfigDiv) {
                eliteConfigDiv.style.display = (btStrat.value === 'SPIRIT_ELITE' || btStrat.value === 'SPIRIT_TEST') ? 'block' : 'none';
            }
        });
    }

    // 2. Live Bot (Paper)
    const liveStrat = document.getElementById('live-strategy');
    if (liveStrat) {
        liveStrat.addEventListener('change', () => {
            toggleSLFields('live-', liveStrat.value === 'SPIRIT_SHIELD' || liveStrat.value === 'SPIRIT_ELITE' || liveStrat.value === 'SPIRIT_TEST');

            // Show/hide elite config for Paper (Live) Bot
            const liveEliteConfig = document.getElementById('live-eliteConfig');
            if (liveEliteConfig) {
                liveEliteConfig.style.display = (liveStrat.value === 'SPIRIT_ELITE' || liveStrat.value === 'SPIRIT_TEST') ? 'block' : 'none';
            }
        });
    }

    // 3. Real Bot
    const realStratSelect = document.getElementById('real-strategy');
    if (realStratSelect) {
        realStratSelect.addEventListener('change', () => {
            const isEliteOrShield = realStratSelect.value === 'SPIRIT_SHIELD' || realStratSelect.value === 'SPIRIT_ELITE' || realStratSelect.value === 'SPIRIT_TEST';
            toggleSLFields('real-', isEliteOrShield);

            // Show/hide elite config for Real Bot
            const realEliteConfig = document.getElementById('real-eliteConfig');
            if (realEliteConfig) {
                realEliteConfig.style.display = (realStratSelect.value === 'SPIRIT_ELITE' || realStratSelect.value === 'SPIRIT_TEST') ? 'block' : 'none';
            }
        });
    }
}

// Init Locks (Consolidated in main DOMContentLoaded)

async function clearBotHistory() {
    if (!confirm("¿Borrar todo el historial de sesiones finalizadas?")) return;
    try {
        await fetch('/api/bot/history/clear', { method: 'POST' });
        refreshBotHistory();
    } catch (err) {
        alert("Error: " + err.message);
    }
}

// Store last backtest result for CSV export
let lastBacktestData = null;

function exportBacktestCSV() {
    if (!lastBacktestData || !lastBacktestData.trades || lastBacktestData.trades.length === 0) {
        alert('No hay datos de backtest para exportar. Ejecuta un backtest primero.');
        return;
    }

    const trades = lastBacktestData.trades;
    const headers = ['No', 'Tipo', 'Entrada Precio', 'Entrada Fecha', 'Entrada Hora', 'Salida Precio', 'Salida Fecha', 'Salida Hora', 'Comision', 'Funding', 'PnL', 'Razon'];
    const csvRows = [headers.join(',')];

    trades.forEach((t, i) => {
        const entDate = new Date(t.entryTime);
        const exitDate = new Date(t.exitTime);
        const formatDate = (d) => d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const formatTime = (d) => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const priceDecimals = t.entryPrice < 1 ? 5 : 4;

        const row = [
            i + 1,
            t.type,
            t.entryPrice.toFixed(priceDecimals),
            formatDate(entDate),
            formatTime(entDate),
            t.exitPrice.toFixed(priceDecimals),
            formatDate(exitDate),
            formatTime(exitDate),
            (t.commission || 0).toFixed(4),
            (t.funding || 0).toFixed(4),
            t.pnl.toFixed(4),
            `"${t.reason || ''}"`
        ];
        csvRows.push(row.join(','));
    });

    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `backtest_${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}

function exportBotHistory() {
    // Trigger download via direct navigation or hidden iframe (standard for file downloads)
    window.location.href = '/api/bot/history/export';
}

function exportRealBotHistory() {
    window.location.href = '/api/real-bot/history/export';
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
