
"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SymbolSearch } from "@/components/ui/symbol-search"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Loader2, TrendingUp, TrendingDown, DollarSign, Percent, Calendar } from "lucide-react"

export function BacktestTab() {
  const [isLoading, setIsLoading] = useState(false)
  const [results, setResults] = useState<any>(null)
  
  const [config, setConfig] = useState({
    symbol: "BTC",
    timeframe: "15m",
    initialCapital: "100",
    orderSize: "10", // Nuevo: tamaño de la orden en USDT
    leverage: "20",
    stopLossPct: "1.0",
    feePct: "0.04", // Taker fee habitual
    direction: "BOTH", // LONG, SHORT, BOTH
    stopAtEntry: false, // Nuevo: cerrar stop al precio de entrada
    startDate: "2026-01-01",
    endDate: new Date().toISOString().split('T')[0],
    sampleSize: "" // Nuevo: tamaño de muestra para 1d
  })

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setConfig({ ...config, [e.target.name]: e.target.value })
  }

  const runBacktest = async () => {
    setIsLoading(true)
    setResults(null)
    try {
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      })
      const data = await res.json()
      if (data.error) {
        alert(data.error)
      } else {
        setResults(data)
      }
    } catch (error) {
      alert("Error ejecutando prueba")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      
      {/* --- CONFIGURACION --- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Configuración de la Prueba
          </CardTitle>
          <CardDescription>
            Simulación de estrategia Range Filter 100 con gestión de riesgo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            
            {/* Symbol */}
            <div className="space-y-2">
              <Label>Moneda (Ej: BTC, ETH)</Label>
              <SymbolSearch 
                value={config.symbol}
                onChange={v => setConfig({ ...config, symbol: v })}
              />
            </div>

            {/* Timeframe */}
            <div className="space-y-2">
              <Label>Temporalidad</Label>
              <select 
                name="timeframe" 
                value={config.timeframe} 
                onChange={handleChange}
                className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="5m">5 Minutos</option>
                <option value="15m">15 Minutos</option>
                <option value="1h">1 Hora</option>
                <option value="4h">4 Horas</option>
                <option value="1d">1 Día</option>
              </select>
            </div>


            {/* Dates */}
            <div className="space-y-2">
              <Label>Fecha Inicio</Label>
              <Input 
                type="date" 
                name="startDate" 
                value={config.startDate} 
                onChange={handleChange} 
              />
            </div>
            <div className="space-y-2">
              <Label>Fecha Fin</Label>
              <Input 
                type="date" 
                name="endDate" 
                value={config.endDate} 
                onChange={handleChange} 
              />
            </div>

            {/* Opciones extra solo para 1d */}
            {config.timeframe === "1d" && (
              <div className="space-y-2">
                <Label>Tamaño de muestra (número de velas)</Label>
                <Input
                  type="number"
                  name="sampleSize"
                  value={config.sampleSize}
                  onChange={handleChange}
                  min={1}
                  placeholder="Ej: 300"
                />
                <div className="text-xs text-muted-foreground">Puedes limitar el análisis a las últimas N velas diarias para ver señales recientes o simular activos nuevos.</div>
              </div>
            )}

            {/* Risk Management */}

            <div className="space-y-2">
              <Label>Capital Total (USDT)</Label>
              <Input 
                type="number" 
                name="initialCapital" 
                value={config.initialCapital} 
                onChange={handleChange} 
              />
            </div>

            <div className="space-y-2">
              <Label>Tamaño de la Orden (USDT)</Label>
              <Input 
                type="number" 
                name="orderSize" 
                value={config.orderSize} 
                onChange={handleChange} 
                min={1}
                max={config.initialCapital}
              />
            </div>

            <div className="space-y-2">
              <Label>Apalancamiento (x)</Label>
              <Input 
                type="number" 
                name="leverage" 
                value={config.leverage} 
                onChange={handleChange} 
              />
            </div>

             <div className="space-y-2">
              <Label>Stop Loss (%)</Label>
              <Input 
                type="number" 
                name="stopLossPct" 
                value={config.stopLossPct} 
                onChange={handleChange} 
              />
            </div>


            <div className="space-y-2">
              <Label>Comisión (%)</Label>
              <Input 
                type="number" 
                name="feePct" 
                value={config.feePct} 
                onChange={handleChange} 
              />
            </div>

            <div className="flex items-center space-x-2 mt-2">
              <input
                type="checkbox"
                id="stopAtEntry"
                name="stopAtEntry"
                checked={config.stopAtEntry}
                onChange={e => {
                  const checked = e.target.checked;
                  if (checked) {
                    // Al activar, ignorar el valor de stopLossPct (pero lo dejamos en el input para no perderlo visualmente)
                    setConfig({ ...config, stopAtEntry: true });
                  } else {
                    // Al desactivar, si el stopLossPct es 0, poner un valor por defecto (1.0)
                    setConfig({
                      ...config,
                      stopAtEntry: false,
                      stopLossPct: config.stopLossPct === "0" ? "1.0" : config.stopLossPct
                    });
                  }
                }}
              />
              <Label htmlFor="stopAtEntry">Cerrar stop loss al precio de entrada</Label>
            </div>

             {/* Direction */}
             <div className="space-y-2">
              <Label>Dirección</Label>
              <select 
                name="direction" 
                value={config.direction} 
                onChange={handleChange}
                className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="BOTH">Long & Short</option>
                <option value="LONG">Solo Long</option>
                <option value="SHORT">Solo Short</option>
              </select>
            </div>

          </div>
        </CardContent>
        <CardFooter>
            <Button onClick={runBacktest} disabled={isLoading} className="w-full md:w-auto">
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isLoading ? "Simulando..." : "Ejecutar Prueba"}
            </Button>
        </CardFooter>
      </Card>

      {/* --- RESULTADOS --- */}
      {results && results.stats && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            
            {/* KPI Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card className={results.stats.roi >= 0 ? "border-green-500/50" : "border-red-500/50"}>
                    <CardContent className="pt-6">
                        <div className="text-2xl font-bold font-mono">
                            {results.stats.roi.toFixed(2)}%
                        </div>
                        <p className="text-xs text-muted-foreground">Retorno Total (ROI)</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-2xl font-bold font-mono">
                            ${results.stats.finalBalance.toFixed(2)}
                        </div>
                        <p className="text-xs text-muted-foreground">Balance Final</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-2xl font-bold font-mono">
                            {(results.stats.winRate * 100).toFixed(1)}%
                        </div>
                        <p className="text-xs text-muted-foreground">Tasa de Acierto</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-2xl font-bold font-mono">
                            {results.stats.totalTrades}
                        </div>
                        <p className="text-xs text-muted-foreground">Total Trades</p>
                    </CardContent>
                </Card>
            </div>

            {/* Trades Table */}
            <Card>
                <CardHeader>
                    <CardTitle>Historial de Operaciones</CardTitle>
                </CardHeader>
                <CardContent className="max-h-[500px] overflow-auto">
                    <table className="w-full text-sm">
                        <thead className="text-left text-muted-foreground sticky top-0 bg-background/95">
                            <tr>
                              <th className="pb-2">Fecha Ent</th>
                              <th className="pb-2">Hora Ent</th>
                              <th className="pb-2">Fecha Sal</th>
                              <th className="pb-2">Hora Sal</th>
                              <th className="pb-2">Tipo</th>
                              <th className="pb-2">Entrada</th>
                              <th className="pb-2">Salida</th>
                              <th className="pb-2">Tamaño</th>
                              <th className="pb-2">PnL</th>
                              <th className="pb-2">Razón</th>
                            </tr>
                        </thead>
                        <tbody>
                            {results.trades.length === 0 ? (
                                <tr><td colSpan={6} className="text-center py-4">Sin operaciones</td></tr>
                            ) : results.trades.map((t: any, i: number) => (
                                <tr key={i} className="border-t border-border/50">
                                    <td className="py-2 text-muted-foreground">
                                      {new Date(t.entryTime).toLocaleDateString('es-ES', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' })}
                                    </td>
                                    <td className="py-2 text-muted-foreground">
                                      {new Date(t.entryTime).toLocaleTimeString('en-US', { timeZone: 'America/La_Paz', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                                    </td>
                                    <td className="py-2 text-muted-foreground">
                                      {new Date(t.exitTime).toLocaleDateString('es-ES', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' })}
                                    </td>
                                    <td className="py-2 text-muted-foreground">
                                      {new Date(t.exitTime).toLocaleTimeString('en-US', { timeZone: 'America/La_Paz', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                                    </td>
                                    <td className="py-2">
                                        <Badge variant={t.type === 'LONG' ? 'default' : 'destructive'} className={t.type === 'SHORT' ? 'bg-red-900 text-red-100 hover:bg-red-800' : 'bg-green-900 text-green-100 hover:bg-green-800'}>
                                            {t.type}
                                        </Badge>
                                    </td>
                                    <td className="py-2 font-mono">{t.entryPrice.toFixed(4)}</td>
                                    <td className="py-2 font-mono">{t.exitPrice.toFixed(4)}</td>
                                    <td className="py-2 font-mono">{t.size ? t.size.toFixed(4) : '-'}</td>
                                    <td className={`py-2 font-bold font-mono ${t.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}> 
                                      ${t.pnl.toFixed(2)}
                                    </td>
                                    <td className="py-2 text-xs opacity-70">{t.reason}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </CardContent>
            </Card>

        </div>
      )}

    </div>
  )
}
