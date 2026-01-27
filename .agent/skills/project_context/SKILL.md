---
name: project_context
description: Comprehensive overview and context for the HYDRA Trading Bot project. Contains details on architecture, key files, strategies, and development rules.
title: HYDRA Trading Bot Context & Memory
---

# HYDRA Trading Bot - Project Context

This skill serves as the long-term memory for the HYDRA Trading Bot project. It outlines the architecture, key components, and strategy logic to ensure consistency across development sessions.

## 1. Project Overview
HYDRA is a web-based cryptocurrency trading bot platform that supports:
- **Backtesting**: Testing strategies against historical data.
- **Paper Trading (Live Bot)**: Simulated real-time trading with fake money.
- **Real Trading (BOT 01)**: Execution on Binance Futures with real funds (with password protection).

## 2. Technology Stack
- **Backend**: Node.js with Express (`server.js`).
- **Frontend**: HTML5, Vanilla JavaScript (`public/app.js`), CSS (`public/style.css`).
- **Charting**: Lightweight Charts (TradingView library).
- **Data**: Binance Futures API (Public & Private endpoints).

## 3. Directory Structure & Key Files
- **Root**:
  - `server.js`: Main entry point. Handles API routes (`/api/backtest`, `/api/bot/...`), static file serving, and bot orchestration.
- **public/** (Frontend):
  - `index.html`: Main UI. Contains tabs for Backtest, Bot (Paper), Real Bot.
  - `app.js`: Core frontend logic. Handles UI interactions, API calls, Chart rendering, and WebSocket/Polling updates.
  - `style.css`: Main styling.
- **lib/** (Backend Logic):
  - `strategies.js` (Assumed): Contains strategy logic (SPIRIT, VANGUARD, etc.).
  - `paperBot.js` (Assumed): Logic for simulated bots.
  - `realBot.js`: Logic for real execution on Binance.
  - `binance.js` / `exchange.js`: API wrappers for Binance.

## 4. Key Features & Strategies
### A. Strategies
The bot implements several strategies, selectable in the UI:
- **CLOSE_ENTRY / OPEN_ENTRY**: Basic candle-based entries.
- **SPIRIT Series**:
  - `SPIRIT`: Base strategy with re-entries.
  - `SPIRIT_SHIELD`: Adds "Smart Breakeven" logic.
  - `SPIRIT_ELITE`: Adds "Limit + Profit-Triggered SL" logic.
- **VANGUARD**: Multi-timeframe strategy (checks 5m and 1m confirmation). *Forces 5m timeframe on UI.*
- **BACKGUARD**: Limit entry with delayed trailing stop.

### B. Stop Loss Modes
- **FIXED**: Standard % based SL.
- **BREAKEVEN**: Moves SL to entry price after a certain condition (or immediately, depending on logic).
- **TRAILING**: Dynamic SL that follows price.
- **SPIRIT SHIELD/ELITE**: Special internal logic that overrides standard SL.

## 5. Critical Implementation Details (Do Not Forget)
1. **Frontend State**: `app.js` uses `botStateHistory` to track bot states and trigger audio alerts (Cashier Sound).
2. **Event Listeners**: `app.js` is large. When adding listeners (e.g., for `setupSpiritShieldLock` or `setupVanguardLock`), ensure they are not duplicated and are initialized in `DOMContentLoaded`.
3. **Real Bot Protection**: The "Real Bot" tab is protected by a password overlay in the UI.
4. **VANGUARD Constraint**: When `VANGUARD` is selected, the Timeframe dropdown is forced to `5m`.

## 6. Development Rules
- **UI Design**: Maintain the "Cyber/Dark" aesthetic. Use neon accents (Green/Red/Yellow).
- **Consolidation**: Avoid creating multiple `<script>` tags or scattered logic. Keep `app.js` organized.
- **Safety**: Real trading code (`realBot.js`) must be handled with extreme care. Double-check order execution logic.

## 7. Useful Commands
- Start Server: `node server.js`
- The app runs on `http://localhost:3001` (usually).

Use this skill to refresh your context on the project's architecture and logic.
