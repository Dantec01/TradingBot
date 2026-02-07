# SPIRIT ELITE Strategy
## Descripción General
**SPIRIT ELITE** es una versión evolucionada de las estrategias SPIRIT, diseñada para maximizar la precisión en entradas y la protección de ganancias mediante un sistema de Stop Loss dinámico y escalonado.

A diferencia de las versiones anteriores que operan puramente a mercado, ELITE prioriza las órdenes límite y la "supervivencia" del trade mediante breakevens rápidos y trailing stops retardados.

---

## 1. Lógica de Entrada (Entry)
*   **Tipo de Orden:** **LÍMITE (Limit Order)**.
*   **Precio:** Precio de **Cierre (Close)** de la vela que genera la señal.
*   **Comportamiento:**
    *   Al recibir una señal (Buy/Sell) y cerrar la vela, el bot coloca una orden límite exactamente al precio de cierre.
    *   Si el precio retrocede y toca nuestra orden, entramos. Esto evita el "slippage" negativo de entrar a mercado en momentos de alta volatilidad.

## 2. Gestión de Stop Loss (SL)
ELITE utiliza un sistema híbrido que evoluciona con el tiempo del trade:

### Fase 1: Inicio (Vela de Entrada)
*   **Experimental SL:** Se establece dinámicamente basado en la estructura de la vela (igual que SPIRIT_EXPERIMENTAL) una vez que cierra la primera vela del trade.

### Fase 2: Consolidación (Vela Siguiente)
*   **Breakeven Elite ("Profit Lock"):**
    *   Se activa automáticamente al **comienzo de la siguiente vela** después de la entrada.
    *   **Nivel:** Precio de Entrada +/- `Tick Offset` (Configurable, defecto 0.0001).
    *   **Objetivo:** Si el precio vuelve al punto de entrada, salimos con una ganancia mínima (1 tick) para cubrir comisiones, en lugar de salir en pérdida o cero.
    *   *El bot comparará este SL con el Experimental y usará el que esté más cerca del precio actual (el más protector).*

### Fase 3: Tendencia (Después de 5 Velas)
*   **Delayed Trailing Stop:**
    *   Se activa si el trade dura más de **5 velas**.
    *   Utiliza el porcentaje de Trailing configurado (ej: 1%).
    *   Si el precio se mueve a favor, el SL sube persiguiendo el precio.

---

## 3. Lógica de Salida (Exit)
El trade se cierra si:
1.  **Señal Opuesta:** El indicador da una señal contraria (ej: Sell mientras estamos en Long).
2.  **Stop Loss Hit:** El precio toca cualquiera de los niveles de SL activos (Breakeven, Experimental o Trailing).

---

## 4. Re-Entradas (The "Spirit" Component)
Si el bot es sacado por un Stop Loss pero la señal original sigue vigente:
*   **Acción:** Re-entrar en la misma dirección.
*   **ya no se usa ahora se usa market - Método:** **Orden LÍMITE** al precio de salida anterior.
    *   *Ejemplo:* Si nos saca un SL en 100.00 (Long), ponemos una orden de compra límite en 100.00. Solo si el precio baja a 100.00 de nuevo, volvemos a entrar.

---

## Resumen de Configuración
| Parámetro | Valor Recomendado | Descripción |
| :--- | :--- | :--- |
| **Tick Offset** | `0.0001` (o 1 tick del activo) | Margen de ganancia para el Breakeven Elite. |
| **Trailing %** | `0.5% - 1.0%` | Distancia del Trailing Stop (activo tras 5 velas). |
| **Tiempo de Vela** | `1m` - `15m` | Funciona mejor en temporalidades rápidas. |

## Ventajas Clave
1.  **Cero Slippage en Entrada:** Al usar Limit, nunca entras peor que el precio de señal.
2.  **Protección de Comisiones:** El Breakeven Elite asegura que los trades "neutros" paguen sus propias comisiones.
3.  **Captura de Tendencias:** El Trailing Stop retardado permite que el trade "respire" al inicio y luego asegura grandes ganancias si la tendencia se extiende.
