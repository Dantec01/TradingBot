# SPIRIT_TEST Strategy — Full Specification for Clean Rebuild

## Objetivo

Construir dos bots **completamente independientes** que operan el mismo par en Binance Futures:

1. **Paper Bot**: simula trades sin dinero real, calcula señales, gestiona trailing por vela
2. **Real Bot**: opera con dinero real, entra ~1s antes del cierre de vela, usa trailing nativo de Binance

**NO hay mirror mode.** Cada bot tiene su propia lógica completa. El real bot comparte el array de velas del paper para tener las mismas señales.

---

## 1. Indicador: Range Filter

Archivo: `indicators.js`

### Parámetros
- `period = 100`
- `multiplier = 3.0`
- `predictionFactor = 0.75`
- `wper = period * 2 - 1` (199)
- `m = multiplier * predictionFactor` (2.25)

### Cálculo paso a paso

```javascript
// 1. Diffs: diferencia absoluta entre closes consecutivos
diffs[i] = Math.abs(close[i] - close[i-1])

// 2. Average Range: EMA de diffs con período 100
avrng = EMA(diffs, period)

// 3. Smooth Range: EMA de avrng con período 199, multiplicado por 2.25
smrng = EMA(avrng, wper) * m

// 4. Range Filter (el indicador principal)
rngfilt[0] = close[0]
for i = 1..n:
  if close[i] > rngfilt[i-1]:
    rngfilt[i] = max(rngfilt[i-1], close[i] - smrng[i])
  else:
    rngfilt[i] = min(rngfilt[i-1], close[i] + smrng[i])

// 5. Contadores de tendencia
if rngfilt[i] > rngfilt[i-1]: up_count++, dn_count=0
if rngfilt[i] < rngfilt[i-1]: dn_count++, up_count=0
else: mantienen valor anterior

// 6. Señales
longCond  = close[i] > rngfilt[i] AND up_count[i] > 0
shortCond = close[i] < rngfilt[i] AND dn_count[i] > 0

if longCond AND currentState != 1:
  currentState = 1, isTrigger = true   // TRANSICIÓN → señal de entrada
if shortCond AND currentState != -1:
  currentState = -1, isTrigger = true  // TRANSICIÓN → señal de entrada

// Salida por vela:
signalStr = "Buy" | "Sell" | "Neutral"
isTrigger = true SOLO en la vela donde cambia el estado
state = 1 (Buy), -1 (Sell), 0 (Neutral)
```

### EMA
```javascript
EMA[0] = values[0]
EMA[i] = values[i] * k + EMA[i-1] * (1-k)  donde k = 2/(period+1)
```

---

## 2. Paper Bot

### Inicialización
- Carga **500 velas** históricas de Binance con `fetchKlines(symbol, timeframe, 500)`
- Calcula indicadores con `recalculateIndicators()`
- Se recalculan en CADA tick (no solo al cierre de vela)

### Flujo de update (cada tick del WebSocket)

```
1. Si newCandle.time == última vela.time → actualizar vela actual
   Si newCandle.time > última vela.time → push nueva vela (buffer max 600)
2. recalculateIndicators() — recalcula Range Filter completo
3. Si newCandle.isFinal:
   a. processSignal()
   b. manageOpenPosition()
```

### processSignal() — Solo ejecuta en isFinal

```
SI tiene posición abierta:
  SI isTrigger AND señal es opuesta → cerrar posición ("Signal Reversal")
  (permite fall-through para abrir inmediatamente en dirección contraria)

SI NO tiene posición:
  Formas de entrar:
  1. isTrigger = true → señal nueva (transición de estado)
  2. isSpiritReEntry → pendingReEntry.neededSignal coincide con señal actual
  3. isInstantEntry → primera vela después de encender bot (si hay señal activa)

  Para 1, 2 o 3:
    type = "Buy" → LONG, "Sell" → SHORT
    Verificar dirección permitida (BOTH, LONG, SHORT)
    Abrir posición al precio close de la vela
    Registrar entryCandleTime = candle.time
```

### manageOpenPosition() — Trailing Stop del Paper

```
Condición: strategy == 'SPIRIT_TEST' AND slMode == 'TRAILING'
Solo ejecuta en tick.isFinal AND tick.time > position.entryCandleTime
(se salta la vela de entrada)

1. Actualizar extremos:
   LONG:  highestPrice = max(highestPrice || entryPrice, tick.high)
   SHORT: lowestPrice = min(lowestPrice || entryPrice, tick.low)

2. Calcular trailing SL:
   LONG:  trailingSLLevel = highestPrice * (1 - trailingPct/100)
   SHORT: trailingSLLevel = lowestPrice * (1 + trailingPct/100)

3. Verificar hit:
   LONG:  si tick.low <= trailingSLLevel → HIT
   SHORT: si tick.high >= trailingSLLevel → HIT

4. Si HIT → cerrar posición al precio trailingSLLevel
   Si NO HIT y SL cambió → emitir paper:sl_update (opcional, para logging)
```

### Cierre de posición (Paper)

```
Calcular PnL:
  LONG:  pnl = (exitPrice - entryPrice) * size
  SHORT: pnl = (entryPrice - exitPrice) * size
  netPnL = pnl - comisión entrada - comisión salida - funding

Si razón es "Trailing Stop" → configurar reentrada:
  pendingReEntry = {
    neededSignal: lastType == 'LONG' ? 'Buy' : 'Sell'
  }
  (espera la próxima señal en la misma dirección para reentrar)
```

---

## 3. Real Bot

### Arquitectura: SIN mirror mode

El real bot es completamente independiente. No escucha eventos del paper.
Usa el **mismo array de velas** que el paper (compartido por referencia) para garantizar que los indicadores sean idénticos.

### Inicialización

```
- Usa el MISMO array de velas del paper: this.candles = paperBot.candles
  (NO carga sus propias 500 velas — usa las del paper para evitar divergencia)
- Configura conexión con Binance API (leverage, exchange info)
- Conecta WebSocket de User Data Stream (para detectar fills)
```

### Flujo de update (cada tick del WebSocket)

```
1. Actualizar vela actual (igual que paper)
2. recalculateIndicators()
3. BLOQUE PREEMPTIVE (T-1s antes del cierre):
   Si timeToClose > 0 AND timeToClose <= 1000ms:
     Si NO tiene posición AND NO está entrando:
       Leer señal de this.candles (compartidas con paper)
       Si isTrigger OR manualTrigger OR isSpiritReEntry OR isInstantEntry:
         → MARKET ORDER inmediata
4. Si newCandle.isFinal:
   _preemptiveEntryDone = false (reset para próxima vela)
   processSignal() — como backup, misma lógica que paper
5. manageOpenPosition() — coloca trailing nativo en Binance
```

### ¿Qué es manualTrigger?

Detección redundante de transición para cubrir edge cases donde `isTrigger` falla:

```javascript
manualTrigger = !isTrigger 
  && signal !== 'Neutral' 
  && prevCandle.state !== candle.state  // estado cambió vs vela anterior
```

### Entrada con MARKET

```javascript
async openPosition(type, price, candleTime) {
  // Calcular quantity basado en margin y leverage
  quantity = Math.floor((margin * leverage) / price)  // redondeado a stepSize
  
  // Enviar orden MARKET a Binance
  order = await client.futuresOrder({
    symbol, side: type == 'LONG' ? 'BUY' : 'SELL',
    type: 'MARKET', quantity
  })
  
  // Guardar posición
  this.position = {
    type, entryPrice: avgPrice, size: quantity,
    entryCandleTime: candleTime, entryTime: Date.now()
  }
}
```

### Trailing Stop Nativo de Binance

Se coloca en `manageOpenPosition()` al cierre de la primera vela DESPUÉS de la entrada:

```
Condición: tick.isFinal AND tick.time > position.entryCandleTime AND !_trailingStopPlaced

1. callbackRate = max(0.1, min(trailingPct, 5))  // Binance limita 0.1% a 5%

2. Si trailingActivation > 0:
   activationRate = trailingActivation / 100
   LONG:  activationPrice = entryPrice * (1 + activationRate)
   SHORT: activationPrice = entryPrice * (1 - activationRate)
   (redondeado a tickSize del exchange)

3. Enviar orden:
   client.futuresOrder({
     symbol, side: opuesto al position.type,
     type: 'TRAILING_STOP_MARKET',
     quantity: position.size,
     callbackRate,
     activationPrice (opcional, solo si > 0),
     reduceOnly: true
   })

4. _trailingStopPlaced = true (previene repetición)
5. Guardar activeStopOrder = { orderId, orderType, ... }
```

### Detección de Fill del Trailing

Via WebSocket User Data Stream (`ORDER_TRADE_UPDATE`):

```
Cuando llega un evento de orden:
  Si orderType es TRAILING_STOP_MARKET y status es FILLED:
    Match por orderId (o por tipo si orderId es null)
    → handleStopMarketFilled()
    → Registrar trade, calcular PnL real
    → handleSpiritReEntry() para configurar reentrada
    → _trailingStopPlaced = false (reset para próxima posición)
    → position = null
```

### Re-entrada (Real Bot)

```
Después de cierre por trailing stop:
  pendingReEntry = { neededSignal: 'Buy' o 'Sell' }

En el próximo ciclo de preemptive entry (T-1s):
  isSpiritReEntry = pendingReEntry && signal == pendingReEntry.neededSignal
  Si true → entra con MARKET
```

---

## 4. Parámetros Configurables (UI)

| Parámetro | ID HTML | Valores | Efecto |
|-----------|---------|---------|--------|
| Timeframe | `timeframe` | 5m, 15m, 1h... | Período de las velas |
| Margin | `margin` | USDT | Capital por trade |
| Leverage | `leverage` | 1-125x | Apalancamiento |
| Direction | `direction` | BOTH/LONG/SHORT | Dirección permitida |
| SL Mode | checkbox `trailing` | checked = TRAILING | Tipo de stop loss |
| Trailing % | `trailingPct` | 0.1-5.0 | callbackRate del trailing (Binance) |
| Activación % | `trailingActivation` | 0-10 | Precio de activación del trailing (0 = inmediato) |
| Instant Entry | `instantEntry` | checkbox | Entra en señal actual al iniciar |

---

## 5. Ejemplo Completo: Trade LONG en STO

```
Configuración: trailingPct=0.1%, trailingActivation=0.3%
Precio: ~$0.0560, Margin: $10, Leverage: 20x

1. Vela 14:59:59 — T-1s antes del cierre de vela 15:00
   Range Filter calcula: close > rngfilt, state cambia de -1 a 1
   isTrigger = true → MARKET BUY
   size = floor(10 * 20 / 0.0560) = 3571 STO
   
2. Posición abierta: LONG 3571 @ $0.05600

3. Vela 15:05:00 — isFinal de la primera vela post-entrada
   Coloca TRAILING_STOP_MARKET:
   - callbackRate: 0.1%
   - activationPrice: 0.05600 * 1.003 = $0.05617
   
   Binance NO activa el trailing hasta que precio >= $0.05617

4. Precio sube a $0.05630 → trailing se activa
   Binance rastrea máximo tick a tick
   highestPrice = $0.05650
   trailing stop level = $0.05650 * (1 - 0.001) = $0.05644

5. Precio baja a $0.05644 → trailing ejecutado
   Binance cierra la posición automáticamente
   PnL = (0.05644 - 0.05600) * 3571 = $1.57

6. handleStopMarketFilled() → registra trade
7. handleSpiritReEntry() → pendingReEntry = { neededSignal: 'Buy' }
8. Próxima transición Buy → reentrada con MARKET
```

---

## 6. Guards y Edge Cases

| Caso | Solución |
|------|----------|
| Doble entrada en misma vela | `_preemptiveEntryDone` (reset en isFinal) |
| Race condition async | `_isEntering` lock (set antes del await) |
| Trailing colocado repetidamente | `_trailingStopPlaced` (reset en position=null) |
| orderId null del API response | Match por orderType en WebSocket |
| Precio no llega a activación | Sin trailing → posición sin SL, solo cierra por Signal Reversal o manual |
| Signal Reversal con posición | processSignal() cierra posición y abre en dirección contraria |

---

## 7. Diferencia Clave Paper vs Real

| Aspecto | Paper | Real |
|---------|-------|------|
| Momento de entrada | isFinal (cierre exacto de vela) | T-1s antes del cierre |
| Precio de entrada | close exacto de la vela | Precio de mercado ~1s antes |
| Trailing | Por vela (isFinal, usa high/low) | Tick a tick (Binance nativo) |
| Precio de salida | Nivel calculado del SL (ideal) | Precio real de mercado |
| Ejecución | Simulada (instantánea) | MARKET order (requiere fill) |
| Re-entrada | Próxima señal en processSignal | Próxima señal en bloque preemptive |
| Fuente de datos | Sus propias velas | **Mismas velas que paper** (compartidas) |

---

## 8. Archivos Relevantes del Proyecto Actual

| Archivo | Contenido |
|---------|-----------|
| `lib/indicators.js` | calculateRangeFilter() — el indicador completo |
| `lib/bot.js` | Paper bot — processSignal(), manageOpenPosition() |
| `lib/realBot.js` | Real bot — preemptive entry, placeTrailingStopNative() |
| `lib/realBotManager.js` | Gestión de WebSocket, detección de fills |
| `lib/binance.js` | fetchKlines() para cargar velas históricas |
| `lib/botManager.js` | Gestión del paper bot, WebSocket de mercado |
| `public/app.js` | Frontend — envía config al servidor |
| `public/index.html` | UI — campos de configuración |

---

## 9. Bug Conocido: Divergencia de Indicadores

Si paper y real cargan velas por separado (cada uno llama fetchKlines), los indicadores PUEDEN divergir porque:
- Se cargan en momentos ligeramente diferentes (milisegundos de diferencia)
- El Range Filter es sensible al precio exacto de la primera vela

**Solución**: El real bot debe compartir el MISMO array de velas del paper (`this.candles = paperBot.candles`) o leer directamente del paper para señales.
