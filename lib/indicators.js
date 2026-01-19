// EMA Helper
function calculateEMA(values, period) {
    const k = 2 / (period + 1);
    const ema = new Array(values.length).fill(0);
    // Initialize with first value
    ema[0] = values[0];
    for (let i = 1; i < values.length; i++) {
        ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
    return ema;
}

function calculateRangeFilter(candles, config = {}) {
    // Default config values matching Pine Script defaults
    const period = config.period || 100;
    const multiplier = config.multiplier || 3.0; // multiplier
    const predictionFactor = 0.75; // hardcoded logic from prompt description often implied as separate var

    // According to Pine Script "Range Filter 5min" source commonly used:
    // wper = period * 2 - 1
    // avrng = ema(abs(close - close[1]), period)
    // smoothrng = ema(avrng, wper) * multiplier
    // predictionFactor usage depends on specific variation, but prompt says:
    // "m = multiplier * predictionFactor"

    // We will follow the prompt strictly:
    const wper = period * 2 - 1;
    const m = multiplier * predictionFactor; // 3.0 * 0.75 = 2.25

    const closePrices = candles.map(c => c.close);
    const n = closePrices.length;

    if (n < period) return []; // Not enough data

    // Step 1: Diffs
    const diffs = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
        diffs[i] = Math.abs(closePrices[i] - closePrices[i - 1]);
    }

    // Step 2: avrng
    const avrng = calculateEMA(diffs, period);

    // Step 3: smoothrng (EMA of avrng)
    const smoothrng_ema = calculateEMA(avrng, wper);
    const smrng = smoothrng_ema.map(v => v * m);

    // Step 4: rngfilt
    const rngfilt = new Array(n).fill(0);
    rngfilt[0] = closePrices[0];

    for (let i = 1; i < n; i++) {
        const x = closePrices[i];
        const r = smrng[i];
        const prev = rngfilt[i - 1];

        if (x > prev) {
            rngfilt[i] = (x - r) < prev ? prev : (x - r);
        } else {
            rngfilt[i] = (x + r) > prev ? prev : (x + r);
        }
    }

    // Step 5: up_count / dn_count
    const up_count = new Array(n).fill(0);
    const dn_count = new Array(n).fill(0);

    for (let i = 1; i < n; i++) {
        if (rngfilt[i] > rngfilt[i - 1]) {
            up_count[i] = up_count[i - 1] + 1;
            dn_count[i] = 0;
        } else if (rngfilt[i] < rngfilt[i - 1]) {
            dn_count[i] = dn_count[i - 1] + 1;
            up_count[i] = 0;
        } else {
            up_count[i] = up_count[i - 1];
            dn_count[i] = dn_count[i - 1];
        }
    }

    // Step 6: Signals
    const signals = new Array(n).fill(null);
    let currentState = 0; // 0: Neutral, 1: Buy, -1: Sell

    for (let i = 0; i < n; i++) {
        const longCond = (closePrices[i] > rngfilt[i] && up_count[i] > 0);
        const shortCond = (closePrices[i] < rngfilt[i] && dn_count[i] > 0);

        let signal = 'Neutral';
        let isTrigger = false;

        if (longCond) {
            if (currentState !== 1) {
                currentState = 1;
                isTrigger = true;
            }
        } else if (shortCond) {
            if (currentState !== -1) {
                currentState = -1;
                isTrigger = true;
            }
        }

        // If neither, state persists (in this specific pine script logic, usually state flips only on cond)
        // However, prompt says: "de lo contrario mantiene states[i-1]"

        signals[i] = {
            rngfilt: rngfilt[i],
            signalStr: currentState === 1 ? 'Buy' : (currentState === -1 ? 'Sell' : 'Neutral'),
            isTrigger: isTrigger,
            state: currentState
        };
    }

    return signals;
}

module.exports = { calculateRangeFilter };
