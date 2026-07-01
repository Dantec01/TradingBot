# TradingBot

Bot de trading de criptomonedas con interfaz web para **backtesting**, ejecución en **modo paper (simulado)** y módulo de **trading real** sobre Binance Futures.

> ⚠️ **Aviso importante**: Este software es experimental y conlleva riesgos financieros. Úsalo bajo tu responsabilidad.

---

## 📌 Descripción

**TradingBot** es una plataforma Node.js + Express con frontend web que permite:

- Ejecutar pruebas históricas (backtesting) sobre velas de Binance.
- Simular bots en vivo (modo paper).
- Ejecutar bots en entorno real (BOT 01) con gestión independiente.
- Gestionar múltiples pares y estrategias desde una sola interfaz.
- Persistir estado e historial de sesiones localmente en archivos JSON.

---

## ✨ Funcionalidades principales

- **Backtesting avanzado** con:
  - Capital inicial, tamaño de orden, apalancamiento.
  - Comisiones (personalizadas o Binance).
  - Cálculo de funding rate histórico.
  - Dirección de trading: `LONG`, `SHORT` o `BOTH`.
  - Múltiples estrategias:
    - `CLOSE_ENTRY`
    - `OPEN_ENTRY`
    - `SPIRIT`
    - `SPIRIT_IMPROVED`
    - `SPIRIT_TRAILING`
    - `SPIRIT_EXPERIMENTAL`
    - `SPIRIT_EXPERIMENTAL_FIXED`
    - `SPIRIT_SHIELD`
    - `SPIRIT_ELITE`
    - `BACKGUARD`
    - `VANGUARD`

- **Bots en vivo (HYDRA / Paper)**:
  - Alta y baja dinámica de pares.
  - Estado de conexión WebSocket.
  - Historial de trades y sesiones finalizadas.
  - Guardado/restauración automática de estado.

- **BOT 01 (Real Trading)**:
  - Gestión aislada para entorno real.
  - Consulta de balance USDT en Binance Futures.
  - Registro de eventos/logs.
  - Historial independiente del modo paper.

- **Interfaz web completa** con pestañas:
  - Backtesting
  - Bot en Vivo
  - BOT 01 (Real)
  - Información de estrategias

---

## 🧱 Stack tecnológico

- **Backend**: Node.js, Express, WebSocket (`ws`)
- **Frontend**: HTML, CSS, JavaScript
- **APIs / Integración**: Binance (REST + Futures WebSocket)
- **Utilidades**: dotenv, axios, cors
- **Visualización**: lightweight-charts

---

## 📁 Estructura del proyecto (alto nivel)

```text
TradingBot/
├── server.js
├── package.json
├── .env.example
├── vercel.json
├── public/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── results.css
│   ├── suggestions.css
│   └── alarm.css
├── lib/
│   ├── backtest.js
│   ├── botManager.js
│   ├── realBotManager.js
│   ├── bot.js
│   ├── realBot.js
│   ├── binance.js
│   └── indicators.js
└── data/
    ├── bot_state.json
    ├── bot_history.json
    ├── real_bot_state.json
    └── real_bot_history.json
```

> Nota: algunos archivos de `lib/` pueden variar según tu rama actual, pero esta es la organización funcional esperada.

---

## ⚙️ Requisitos

- Node.js 18+ recomendado
- npm 9+ recomendado
- Cuenta de Binance (solo si usarás módulo real)

---

## 🚀 Instalación y ejecución local

1. Clona el repositorio:
   ```bash
   git clone https://github.com/Dantec01/TradingBot.git
   cd TradingBot
   ```

2. Instala dependencias:
   ```bash
   npm install
   ```

3. Crea tu entorno:
   ```bash
   cp .env.example .env
   ```

4. Edita `.env`:
   ```env
   BINANCE_API_KEY=TU_API_KEY
   BINANCE_API_SECRET=TU_API_SECRET
   ```

5. Inicia el servidor:
   ```bash
   npm start
   ```

6. Abre en navegador:
   - `http://localhost:3001`

---

## 🔌 Variables de entorno

Archivo base: `.env.example`

```env
BINANCE_API_KEY=YOUR_KEY_HERE
BINANCE_API_SECRET=YOUR_SECRET_HERE
```

### Recomendaciones de seguridad
- Nunca subas `.env` al repositorio.
- Usa permisos restringidos en tus API keys.
- Si el repositorio fue público, rota claves si alguna vez se expusieron.

---

## 🧠 Resumen de endpoints API

### Backtest
- `POST /api/backtest`  
  Ejecuta un backtest con la configuración enviada en el body.

### Bot Paper (HYDRA)
- `POST /api/bot/pair/add`
- `POST /api/bot/pair/remove`
- `GET /api/bot/status`
- `GET /api/bot/history`
- `POST /api/bot/stop-all`
- `POST /api/bot/history/clear`

### Bot Real (BOT 01)
- `POST /api/real-bot/pair/add`
- `POST /api/real-bot/pair/remove`
- `GET /api/real-bot/status`
- `GET /api/real-bot/history`
- `POST /api/real-bot/stop-all`
- `GET /api/real-bot/balance`
- `POST /api/real-bot/history/clear`

---

## 🧪 Estado del proyecto

Proyecto funcional orientado a:
- investigación/validación de estrategias,
- simulación de ejecución,
- operación asistida de bots sobre Binance Futures.

Siguientes mejoras recomendadas:
- tests automatizados,
- autenticación para panel de control,
- logs estructurados y observabilidad,
- validaciones adicionales de riesgo.

---

## ⚠️ Descargo de responsabilidad

Este software **no constituye asesoramiento financiero**.  
El trading de criptomonedas implica alto riesgo y puedes perder capital.  
El autor no se hace responsable por pérdidas derivadas del uso del sistema.

---

## 👤 Autor

**Dantec01**  
Repositorio: https://github.com/Dantec01/TradingBot

---

## 📄 Licencia

Este proyecto se distribuye bajo una **licencia propietaria restrictiva**.  
Consulta el archivo [LICENSE](./LICENSE) para conocer los términos.
