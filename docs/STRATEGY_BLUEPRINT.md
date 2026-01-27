# HYDRA TRADING BOT - STRATEGY BLUEPRINT

Este documento actúa como la **Fuente de Verdad Técnica** para el desarrollo.
Si hay discrepancia entre este documento y el código, **el código está mal**.

## Tabla de Especificaciones Técnicas: Familia SPIRIT

| Componente | Característica | SPIRIT EXPERIMENTAL | SPIRIT ELITE (PRO) | Estado Actual Código |
| :--- | :--- | :--- | :--- | :--- |
| **1. ENTRADA INICIAL** | **Tipo de Orden** | `MARKET` | `LIMIT` | ✅ Correcto |
| | **Timing Ideal** | Apertura Vela 1 (Inmediata tras señal) | Apertura Vela 1 (Inmediata tras señal) | ⚠️ Backtest tiene delay (Entra en Vela 2) |
| | **Precio Objetivo** | Precio de Mercado | Precio Cierre Vela 0 (+/-) Offset Agresivo | ✅ Correcto en Real |
| | **Cálculo Precio** | N/A | `LONG`: Close + Offset<br>`SHORT`: Close - Offset<br>*(Para asegurar llenado inmediato tipo Limit)* | ✅ Correcto |
| **2. RE-ENTRADA** | **Condición** | Stop Loss ejecutado + Señal Intacta | Stop Loss ejecutado + Señal Intacta | ✅ Correcto |
| | **Tipo de Orden** | `MARKET` | `LIMIT` | ✅ Correcto |
| | **Precio Base** | N/A (Mercado) | Precio de Salida (Exit Price) donde saltó el SL | ✅ Correcto |
| | **Ajuste Precio (Offset)** | NO | **SÍ req.** (Debe aplicar el mismo Offset Agresivo que la entrada inicial para asegurar re-pesca) | ❌ **FALTA EN CÓDIGO** (Usa ExitPrice puro) |
| **3. STOP LOSS** | **SL Inicial** | `Breakeven` (Precio Entrada) | `Breakeven` +/- Tick (Precio Entrada +/- Tick) | ✅ Correcto |
| | **SL Experimental** | **Cierre de Vela 1**<br>(Se fija al cerrar la vela de entrada) | **Cierre de Vela 1**<br>(Se fija al cerrar la vela de entrada) | ✅ Correcto |
| | **Trailing Stop** | NO | **SÍ**. `Delayed Trailing` (Diferido). | ✅ Correcto |
| | **Config Trailing** | N/A | Se activa tras `eliteTrailingDefer` velas (Def: 5). | ✅ Corregido (estaba Hardcoded 5) |
| **4. GESTIÓN** | **Prioridad Cierre** | 1. SL Experimental<br>2. SL Breakeven<br>3. Reversión | 1. Trailing Stop (si activo)<br>2. SL Experimental<br>3. SL Breakeven<br>4. Reversión | ✅ Correcto |

## Glosario de Variables
*   **eliteTickOffset:** Valor pequeño (ej: 0.0001 o 0.05%) sumado/restado al precio para hacer órdenes Limit agresivas o colocar SL apenas por encima del BE.
*   **eliteTrailingDefer:** Número de velas a esperar antes de que el Trailing Stop empiece a moverse.

## Tareas Pendientes (Bugs Detectados)
1.  [ ] **Backtest Timing:** Corregir bucle en `backtest.js` para que la entrada ocurra en Vela 1, no Vela 2.
2.  [ ] **Re-entrada Elite:** Agregar `eliteTickOffset` a la lógica de precio de re-entrada en `backtest.js`, `bot.js` y `realBot.js`.
