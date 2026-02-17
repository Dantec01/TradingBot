# Estrategia SPIRIT_TEST — Paper & Real Bot

## Resumen

SPIRIT_TEST usa **Range Filter** (período 100, multiplicador 3.0) para señales de entrada y trailing stop porcentual para salidas. El real bot opera **independientemente** — usa los mismos indicadores pero con órdenes nativas de Binance.

---

## Indicador: Range Filter

- **Función:** `calculateRangeFilter()` en `indicators.js`
- **Señal Buy:** `close > rngfilt` Y `up_count > 0`
- **Señal Sell:** `close < rngfilt` Y `dn_count > 0`
- **isTrigger:** `true` solo cuando el `state` cambia (ej: 1→-1 o -1→1)
- **signalStr:** `'Buy'`, `'Sell'`, o `'Neutral'`

---

## Flujo Paper Bot

1. WebSocket envía vela con `isFinal=true`
2. `recalculateIndicators()` — calcula Range Filter
3. `processSignal()` — si `isTrigger=true`, abre posición al `close`
4. Siguiente vela `isFinal` → `manageOpenPosition()`
   - Actualiza `highestPrice` con el `high` de la vela
   - Calcula `trailingSL = highestPrice × (1 - rate)`
   - Si `low ≤ trailingSL` → cierra al nivel del SL
5. Configura `pendingReEntry` para reentrada

### Detalles del Trailing (Paper)
- **Activación:** Primera vela cerrada DESPUÉS de la entrada
- **Frecuencia:** Solo al cierre de vela (`isFinal = true`)
- **Precio de salida:** Nivel del SL (precio ideal, puede estar en el pasado)

---

## Flujo Real Bot (Independiente)

### Entrada (T-1s antes del cierre)
1. En cada tick, `recalculateIndicators()` recalcula señales
2. Si `timeToClose <= 1000ms` y hay señal detectada → MARKET
3. Detección de señal por 4 métodos (en orden de prioridad):
   - `isTrigger` — transición del indicador en vela actual
   - `manualTrigger` — `candle.state !== prevCandle.state`
   - `isSpiritReEntry` — señal coincide con `pendingReEntry`
   - `isInstantEntry` — primera entrada al encender bot

### Trailing (Binance nativo)
1. `manageOpenPosition()` al cierre de la 1ra vela post-entrada
2. Coloca `TRAILING_STOP_MARKET` con:
   - `callbackRate` = trailing % configurado en UI
   - `activationPrice` = precio entrada × (1 + activación%) — si activación > 0
3. Binance monitorea **tick a tick** (no por vela)
4. Cuando precio retrocede `callbackRate%` del máximo → ejecuta

### Cierre
- Binance ejecuta trailing → `handleStopMarketFilled()` → registra trade
- `handleSpiritReEntry()` → configura reentrada

---

## Condiciones de Activación

```
preemptiveCloseEnabled = strategy === 'SPIRIT_TEST' && slMode === 'TRAILING'
```

No hay restricción de porcentaje. Cualquier `trailingPct` funciona.

---

## Interacción Paper ↔ Real

| Evento Paper | Efecto en Real |
|-------------|---------------|
| `paper:open` | **Ignorado** — entrada por bloque anticipado |
| `paper:sl_update` | **Ignorado** — Binance trailing maneja SL |
| `paper:close` (Trailing Stop) | **Ignorado** — real tiene su propio trailing |
| `paper:close` (Signal Reversal) | **SÍ cierra** — cambio de tendencia → cierra real |

---

## Parámetros UI

| Parámetro | Campo UI | Efecto |
|-----------|----------|--------|
| `trailingPct` | Trailing (%) | Binance `callbackRate` (0.1–5%) |
| `trailingActivation` | Activación (%) | Binance `activationPrice` — 0 = inmediato |

### Recomendación para STO (~$0.057):
- **Trailing 0.1%, Activación 0.3%:** protege ~$0.24 mínimo con posición de $200

---

## Guardas de Seguridad

| Caso | Cómo se maneja |
|------|---------------|
| Doble entrada en misma vela | `_preemptiveEntryDone` (reset en `isFinal`) |
| Trailing colocado repetidamente | `_trailingStopPlaced` (reset en `position = null`) |
| Signal Reversal con posición | `paper:close(Signal Reversal)` cierra real |
| orderId null del API | Match por tipo de orden en WebSocket |
| `paper:open` después de entrada | `if (this.position) skip` |
