---
name: project_context
description: Comprehensive overview and context for the HYDRA Trading Bot project. Contains details on architecture, key files, strategies, and development rules.
title: HYDRA Trading Bot Context & Memory
---

# HYDRA Trading Bot - Project Context

This skill serves as the long-term memory for the HYDRA Trading Bot project. It outlines the architecture, key components, and strategy logic to ensure consistency across development sessions.

## 1. Project Overview
HYDRA is a web-based cryptocurrency trading bot platform that supports:
- **Backtesting**: Testing strategies against historical data (`lib/backtest.js`).
- **Paper Trading (Live Bot)**: Simulated real-time trading with virtual money (`lib/bot.js`).
- **Real Trading (BOT 01)**: Execution on Binance Futures with real funds (`lib/realBot.js`).

## 2. Technology Stack
- **Backend**: Node.js with Express (`server.js`).
- **Frontend**: HTML5, Vanilla JavaScript (`public/app.js`), CSS (`public/style.css`).
- **Charting**: Lightweight Charts (TradingView library).
- **Data**: Binance Futures API (Public & Private endpoints).
- **Real-time**: WebSockets for Paper and Real Bot price updates.

## 3. Directory Structure & Key Files
- **Root**:
  - `server.js`: Main entry point. Handles API routes, WebSocket management, bot orchestration.
- **public/** (Frontend):
  - `index.html`: Main UI with tabs for Backtest, Bot (Paper), Real Bot.
  - `app.js`: Core frontend logic. Handles UI interactions, API calls, Chart rendering.
  - `style.css`: Main styling (Cyber/Dark aesthetic).
- **lib/** (Backend Logic):
  - `bot.js`: **Paper Trading Engine**. All strategy logic (SL, entries, re-entries) is defined here.
  - `realBot.js`: **Real Trading Engine**. MUST mirror `bot.js` logic exactly, with real API execution.
  - `backtest.js`: Backtesting logic. Strategy behavior should match `bot.js`.
  - `binance.js`: API wrappers for Binance (klines, funding, commission, exchange info).
  - `indicators.js`: Range Filter indicator calculation.
  - `botManager.js` / `realBotManager.js`: Orchestration for Paper/Real bots.

## 4. Key Strategies

### A. Strategy List
| Strategy | Entry Type | Stop Loss | Re-entry |
|----------|------------|-----------|----------|
| CLOSE_ENTRY | Market at close | Standard | No |
| SPIRIT | Market | Standard | Yes (wait for signal) |
| SPIRIT_EXPERIMENTAL | Market | Experimental SL (next candle close) | Yes |
| SPIRIT_SHIELD | Market | Smart Breakeven (1% risk → BE at 0.2% profit) | Yes |
| **SPIRIT_ELITE** | **Aggressive Limit (+0.5%)** | Experimental + Breakeven+Tick + Delayed Trailing | Yes |
| BACKGUARD | Limit at close | Initial SL + Trailing after 3 candles | No |
| VANGUARD | Market | Multi-timeframe exit (5m + 1m) | No |

### B. SPIRIT_ELITE v4 (Key Strategy)
The most advanced strategy. Logic MUST be identical in `bot.js`, `realBot.js`, and `backtest.js`:

1. **Entry**: Aggressive Limit Order at `close * (1 ± 0.5%)` (maker fee benefit)
2. **Stop Loss** (picks most protective):
   - **Experimental SL**: Set at close of first candle AFTER entry
   - **Breakeven+Tick**: `entryPrice ± eliteTickOffset` after 1 candle
   - **Delayed Trailing**: After `eliteTrailingDefer` candles (default 5)
3. **Re-entry**: After SL hit, waits for same-direction signal, uses Aggressive Limit

## 5. Critical Implementation Details

### A. Code Consistency Rules
> **IMPORTANT**: `realBot.js` MUST have identical logic to `bot.js` for all strategies.
> Only differences allowed are:
> - `console.log()` → `this.log()`
> - `pendingLimitOrder` object → `placeLimitOrder()` API call
> - Sync → Async/await for API operations

### B. Timestamp Consistency
All time-sensitive operations use **Binance candle timestamps** (`candleTime`), NOT `Date.now()`:
- `entryTime`, `exitTime`, `lastFundingCheck`, `setupTime`
- Exception: `experimentalSLActivatedTime` uses `Date.now()` for 500ms delay (intentional)

### C. Key Variables (SPIRIT_ELITE)
| Variable | Default | Description |
|----------|---------|-------------|
| `eliteTickOffset` | 0.0001 | Price offset for Breakeven+Tick SL |
| `eliteTrailingDefer` | 5 | Candles before Trailing Stop activates |
| `candlesSinceEntry` | 0 | Counter incremented in `manageOpenPosition` |
| `lastCandleTime` | candleTime | Tracks last counted candle |

### D. Frontend State
- `app.js` uses `botStateHistory` for audio alerts (Cashier Sound on trade close)
- Real Bot tab is password protected

## 6. Development Rules
1. **Strategy Changes**: Always update ALL THREE files: `backtest.js`, `bot.js`, `realBot.js`
2. **UI Design**: Maintain "Cyber/Dark" aesthetic with neon accents (Green/Red/Yellow)
3. **Safety**: Real trading code requires extreme care. Test with minimum order size first.
4. **Testing Order**: Backtest → Paper Bot → Real Bot (with 10 USDT minimum)

## 7. Useful Commands
```bash
# Start Server
node server.js

# Syntax Check
node -c lib/realBot.js
node -c lib/bot.js

# App URL
http://localhost:3001
```

## 8. Recent Changes (2026-01-29)
- ✅ `realBot.js` `manageOpenPosition` rewritten to match `bot.js` exactly
- ✅ All timestamps use Binance candle time
- ✅ `eliteTickOffset` added to Real Bot constructor
- ✅ `lastCandleTime` added to position objects
- ✅ SPIRIT_ELITE entry uses Aggressive Limit (+0.5%)
