
import { NextResponse } from 'next/server'
import { calculateEMA } from '@/lib/indicators'

export const maxDuration = 60 // Permitir que corra hasta 60s en Vercel/Node

// Helper para dormir y respetar rate limits
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { 
        symbol, 
        timeframe, 
        startDate, 
        endDate, 
        initialCapital, 
        orderSize, // Nuevo: tamaño de la orden en USDT
        leverage, 
        stopLossPct, 
        feePct, 
        direction, // 'LONG', 'SHORT', 'BOTH'
        stopAtEntry, // Nuevo: si true, el stop cierra al precio de entrada
        sampleSize // Nuevo: tamaño de muestra para 1d
    } = body


    const pair = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`
    const limit = 1000
    // Determinar cuántas velas necesitamos para los indicadores
    let minCandles = 100
    if (timeframe === '1d' && sampleSize && !isNaN(Number(sampleSize)) && Number(sampleSize) > 0) {
        minCandles = Number(sampleSize)
    }

    // Helper: convertir timeframe a ms
    const tfToMs = (tf: string) => {
        if (tf.endsWith('m')) return parseInt(tf.slice(0, -1)) * 60 * 1000
        if (tf.endsWith('h')) return parseInt(tf.slice(0, -1)) * 60 * 60 * 1000
        if (tf.endsWith('d')) return parseInt(tf.slice(0, -1)) * 24 * 60 * 60 * 1000
        return 60 * 1000
    }
    const intervalMs = tfToMs(timeframe)

    // Si el usuario ha provisto un startDate, debemos descargar velas desde esa fecha (más un margen de warmup),
    // para asegurar que los indicadores se calculen correctamente en todo el rango solicitado.
    let allCandles: any[] = []
    const startTimeProvided = !!startDate
    const startTime = startDate ? new Date(startDate).getTime() : null
    const endTime = endDate ? new Date(endDate).getTime() : Date.now()

    if (startTimeProvided && startTime && startTime < endTime) {
        // Queremos al menos minCandles adicionales para warmup antes del inicio
        const warmupMs = minCandles * intervalMs
        let fetchStart = Math.max(0, startTime - warmupMs)

        // Paginamos desde fetchStart hasta endTime
        let loops = 0
        while (fetchStart < endTime && loops < 50) {
            const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${timeframe}&startTime=${fetchStart}&limit=${limit}`
            const res = await fetch(url)
            const data = await res.json()
            if (!Array.isArray(data) || data.length === 0) break

            const cleanData = data.map((d: any) => ({
                time: d[0],
                open: parseFloat(d[1]),
                high: parseFloat(d[2]),
                low: parseFloat(d[3]),
                close: parseFloat(d[4]),
                volume: parseFloat(d[5]),
                closeTime: d[6]
            }))

            allCandles = [...allCandles, ...cleanData]

            const last = cleanData[cleanData.length - 1]
            fetchStart = last.closeTime + 1
            if (cleanData.length < limit) break
            loops++
            await delay(100)
        }
    } else {
        // Sin startDate: descargamos las últimas minCandles + 10
        const candlesToFetch = minCandles + 10
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${timeframe}&limit=${candlesToFetch}`
        const res = await fetch(url)
        const data = await res.json()
        if (!Array.isArray(data) || data.length === 0) {
            return NextResponse.json({ error: `No se encontraron datos históricos para el símbolo y timeframe seleccionados.` }, { status: 400 })
        }
        allCandles = data.map((d: any) => ({
            time: d[0],
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
            closeTime: d[6]
        }))
        if (allCandles.length > minCandles) {
            allCandles = allCandles.slice(-minCandles)
        }
    }

    if (allCandles.length < minCandles) {
        return NextResponse.json({ error: `Insuficientes datos históricos para calcular indicadores. Solo se encontraron ${allCandles.length} velas, se requieren al menos ${minCandles}.` }, { status: 400 })
    }

    // Ahora aplicamos el filtro de fechas SOLO para la simulación (backtest)
    // Filtramos usando la fecha en la zona America/New_York para evitar desajustes por UTC
    let backtestCandles = allCandles
    if (startDate) {
        const startStr = startDate // formato esperado YYYY-MM-DD
        const endStr = endDate ? endDate : startDate
        backtestCandles = backtestCandles.filter(c => {
            const nyDate = new Date(c.time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) // YYYY-MM-DD
            return nyDate >= startStr && nyDate <= endStr
        })
    } else {
        if (endTime) backtestCandles = backtestCandles.filter(c => c.time <= endTime)
    }
    if (backtestCandles.length < 2) {
        return NextResponse.json({ error: `No hay suficientes velas dentro del rango de fechas seleccionado para simular el backtest.` }, { status: 400 })
    }

    // 2. Calcular Range Filter sobre TODO el array
    const closes = allCandles.map(c => c.close)
    const { signals } = calculateRangeFilterHistory(closes, 100, 3.0, 0.75)

    // Determinar la porción de señales que corresponde a backtestCandles
    const startIdxInAll = allCandles.findIndex(c => c.time === backtestCandles[0].time)
    const signalsForBacktest = startIdxInAll >= 0 ? signals.slice(startIdxInAll, startIdxInAll + backtestCandles.length) : signals.slice(-backtestCandles.length)

    // 3. Simulación de Trading (Loop de Velas) SOBRE backtestCandles
    let balance = parseFloat(initialCapital)
    let position: any = null // { type: 'LONG'|'SHORT', entryPrice: number, size: number, amount: number }
    const trades: any[] = []
    const equityCurve = [{ time: backtestCandles[0].time, balance }]
    const lev = parseFloat(leverage)
    const sl = parseFloat(stopLossPct) / 100
    const fee = parseFloat(feePct) / 100

    // Empezamos a simular cuando tenemos señal válida (los primeros periodos son neutros por falta de data)
    for (let i = 0; i < backtestCandles.length - 1; i++) {
        const candle = backtestCandles[i]       // Vela completada donde se confirma la señal
        const nextCandle = backtestCandles[i+1] // Vela siguiente donde ejecutamos trade (Open)

        const signal = signalsForBacktest[i]     // Señal confirmada al cierre de candle i
        
        // Precio de entrada: usar el cierre de la vela confirmatoria (candle.close)
        // Esto refleja la ejecución al cierre de la vela que confirma la señal.
        const currentPrice = candle.close
        
        // --- 3.1 GESTIÓN DE SALIDA (Exit) ---
        if (position) {
            let closeReason = null
            let exitPrice = 0

            // A) Check Stop Loss (Durante la vela 'nextCandle')
            // LONG: Si Low < SL Price
            if (position.type === 'LONG') {
                const slPrice = position.entryPrice * (1 - sl)
                if (
                    (stopAtEntry && nextCandle.low <= position.entryPrice) ||
                    (!stopAtEntry && sl > 0 && nextCandle.low <= slPrice)
                ) {
                    closeReason = 'Stop Loss'
                    exitPrice = stopAtEntry ? position.entryPrice : slPrice
                } else if (signal === 'Sell') { // Signal reversal confirmed
                    closeReason = 'Signal Reversal'
                    exitPrice = currentPrice
                }
            }
            // SHORT: Si High > SL Price
            else if (position.type === 'SHORT') {
                const slPrice = position.entryPrice * (1 + sl)
                if (
                    (stopAtEntry && nextCandle.high >= position.entryPrice) ||
                    (!stopAtEntry && sl > 0 && nextCandle.high >= slPrice)
                ) {
                    closeReason = 'Stop Loss'
                    exitPrice = stopAtEntry ? position.entryPrice : slPrice
                } else if (signal === 'Buy') { // Signal reversal confirmed
                    closeReason = 'Signal Reversal'
                    exitPrice = currentPrice
                }
            }

            // Ejecutar Cierre
            if (closeReason) {
                // PnL Calculation
                // Value = (Exit - Entry) * Size
                let pnlRaw = 0
                if (position.type === 'LONG') {
                    pnlRaw = (exitPrice - position.entryPrice) * position.size
                } else {
                    pnlRaw = (position.entryPrice - exitPrice) * position.size
                }
                
                const cost = position.amount * lev * fee // Fee de cierre sobre el nocional
                const netPnL = pnlRaw - cost

                balance += netPnL
                
                trades.push({
                    type: position.type,
                    entryPrice: position.entryPrice,
                    exitPrice: exitPrice,
                    entryTime: position.entryTime,
                    exitTime: nextCandle.time,
                    pnl: netPnL,
                    reason: closeReason,
                    balanceAfter: balance,
                    size: position.size, // cantidad de monedas
                    // Datos de depuración: vela que confirmó la señal usada para entrada
                    confirmCandleTime: position.entryTime,
                    confirmCandleClose: position.entryPrice
                })

                position = null // Reset position
            }
        }

        // --- 3.2 GESTIÓN DE ENTRADA (Entry) ---
        // Solo entramos si no hay posición (o acabamos de cerrar una)
        if (!position) {
            // Usar el tamaño de la orden en USDT, pero nunca mayor al balance disponible
            const tradeAmount = Math.min(parseFloat(orderSize), balance)
            // Check Long
            if (signal === 'Buy' && (direction === 'LONG' || direction === 'BOTH')) {
                 const notional = tradeAmount * lev
                 const entryFee = notional * fee
                 balance -= entryFee // Pagamos fee upfront
                 position = {
                     type: 'LONG',
                     entryPrice: currentPrice,
                     amount: tradeAmount,
                     entryTime: candle.time,
                     size: notional / currentPrice // Cantidad de monedas
                 }
            } 
            // Check Short
            else if (signal === 'Sell' && (direction === 'SHORT' || direction === 'BOTH')) {
                 const notional = tradeAmount * lev
                 const entryFee = notional * fee
                 balance -= entryFee
                 position = {
                     type: 'SHORT',
                     entryPrice: currentPrice,
                     amount: tradeAmount,
                     entryTime: candle.time,
                     size: notional / currentPrice
                 }
            }
        }
        
        // Guardar equidad al cierre del día (opcional, para gráfico)
        // equityCurve.push({ time: candle.time, balance }) 
    }

        // Si al finalizar hay una posición abierta, cerrarla al último precio disponible
        const lastCandle = backtestCandles[backtestCandles.length - 1]
        if (position) {
            let exitPrice = lastCandle.close
            let closeReason = 'Forced Close (end of range)'

            let pnlRaw = 0
            if (position.type === 'LONG') {
                pnlRaw = (exitPrice - position.entryPrice) * position.size
            } else {
                pnlRaw = (position.entryPrice - exitPrice) * position.size
            }
            const cost = position.amount * lev * fee
            const netPnL = pnlRaw - cost
            balance += netPnL

            trades.push({
                type: position.type,
                entryPrice: position.entryPrice,
                exitPrice: exitPrice,
                entryTime: position.entryTime,
                exitTime: lastCandle.time,
                pnl: netPnL,
                reason: closeReason,
                balanceAfter: balance,
                size: position.size,
                confirmCandleTime: position.entryTime,
                confirmCandleClose: position.entryPrice
            })
            position = null
        }

    return NextResponse.json({
        success: true,
        stats: {
            initialCapital,
            finalBalance: balance,
            totalTrades: trades.length,
            winRate: trades.filter(t => t.pnl > 0).length / trades.length,
            roi: ((balance - parseFloat(initialCapital)) / parseFloat(initialCapital)) * 100
        },
        trades: trades.reverse() // Más recientes primero
    })

  } catch (error) {
    console.error("Backtest Error:", error)
    return NextResponse.json({ error: 'Error en simulación' }, { status: 500 })
  }
}

// Lógica Range Filter Vectorizada para Arrays Completos
function calculateRangeFilterHistory(closePrices: number[], period: number, multiplier: number, predictionFactor: number) {
    // Implementación simplificada inline para tener el historial
    // NOTA: Esta lógica asume que tienes acceso a calculateEMA desde import
    // Si no, habría que copiar calculateEMA aquí también.
    
    // ... Copiamos la lógica básica pero devolviendo array 'signals' ...
    const n = closePrices.length
    const signals = new Array(n).fill('Neutral')
    
    // 1. Diffs
    const diffs: number[] = [0]; 
    for(let i=1; i<n; i++) diffs.push(Math.abs(closePrices[i] - closePrices[i-1]));
    const avrng = calculateEMA(diffs, period);
    
    // 2. Smooth Range
    const wper = period * 2 - 1;
    const m = multiplier * predictionFactor;
    const smoothrng_ema = calculateEMA(avrng, wper);
    const smrng = smoothrng_ema.map(v => v * m);
    
    // 3. Range Filter
    const rngfilt: number[] = [closePrices[0]];
    for(let i=1; i<n; i++) {
        const x = closePrices[i];
        const r = smrng[i];
        const prev_rngfilt = rngfilt[i-1];
        let current = prev_rngfilt;

        if (x > prev_rngfilt) {
            current = (x - r) < prev_rngfilt ? prev_rngfilt : (x - r);
        } else {
            current = (x + r) > prev_rngfilt ? prev_rngfilt : (x + r);
        }
        rngfilt.push(current);
    }
    
    // 4. Counts & Signals
    const up_count = new Array(n).fill(0);
    const dn_count = new Array(n).fill(0);
    const states = new Array(n).fill(0);

    for(let i=1; i<n; i++) {
        const filt = rngfilt[i];
        const prev_filt = rngfilt[i-1];
        
        up_count[i] = filt > prev_filt ? up_count[i-1] + 1 : (filt < prev_filt ? 0 : up_count[i-1]);
        dn_count[i] = filt < prev_filt ? dn_count[i-1] + 1 : (filt > prev_filt ? 0 : dn_count[i-1]);

        const x = closePrices[i];
        const longCond = (x > filt && up_count[i] > 0); 
        const shortCond = (x < filt && dn_count[i] > 0);

        let state = states[i-1];
        if (longCond) state = 1; else if (shortCond) state = -1;
        states[i] = state;
        
        if (state === 1) signals[i] = 'Buy'
        if (state === -1) signals[i] = 'Sell'
    }
    
    return { signals }
}
