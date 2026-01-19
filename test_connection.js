const { fetchKlines } = require('./lib/binance');

async function testConnection() {
    try {
        console.log('Probando conexión a Binance Futures (fapi.binance.com)...');
        const klines = await fetchKlines('BTCUSDT', '15m', 5);

        if (klines && klines.length > 0) {
            console.log('✅ ÉXITO: Conexión establecida.');
            console.log(`Recibidos ${klines.length} velas.`);
            console.log('Ejemplo de vela (última):', klines[klines.length - 1]);
        } else {
            console.error('❌ FALLO: No se recibieron datos.');
        }
    } catch (error) {
        console.error('❌ ERROR DE CONEXIÓN:', error.message);
    }
}

testConnection();
