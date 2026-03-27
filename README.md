# 🤖 Binance AI Trading Bot

> Sistema de trading algorítmico con motor de decisiones basado en **Claude AI** (Anthropic), dashboard en tiempo real y gestión de riesgo configurable.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?style=flat-square&logo=node.js)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)
![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)

---

## 📸 Vista del Dashboard

> Dashboard con precio en tiempo real, indicadores técnicos, análisis de IA y gestión de posiciones.

![Dashboard Preview](docs/preview.png)
*(Agregá una captura de pantalla del dashboard)*

---

## ✨ Features

- **Motor de decisiones con IA** — Claude AI analiza el mercado y decide BUY / SELL / HOLD con razonamiento en español
- **6 Indicadores técnicos** — RSI(14), EMA 9/21, MACD, Bollinger Bands, ATR calculados en tiempo real
- **Dashboard en tiempo real** — Gráfico de precios, P&L, historial de trades y señales
- **Modos Paper y Live** — Testeo sin riesgo antes de operar con capital real
- **Gestión de riesgo configurable** — Stop Loss, Take Profit, Trailing Stop, R:R mínimo, drawdown máximo
- **Circuit Breaker automático** — Pausa el bot si se supera la pérdida diaria límite
- **Integración Polymarket** — Contexto de sentimiento de mercado para mejorar decisiones de IA
- **Backend seguro** — Autenticación por token, rate limiting, Helmet, logs con Winston
- **Autenticación Binance** — HMAC-SHA256 para requests firmados

---

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────────┐
│           Dashboard (index.html)            │
│  Chart.js · 6 Indicadores · Panel de riesgo │
└────────────────┬────────────────────────────┘
                 │ HTTP (token auth)
┌────────────────▼────────────────────────────┐
│         Backend Node.js/Express             │
│  /ai  /order  /balance  /positions  /macro  │
└──────┬─────────────────────┬────────────────┘
       │                     │
┌──────▼──────┐    ┌─────────▼──────┐
│ Binance API │    │  Anthropic API  │
│  (HMAC-SHA) │    │  Claude Sonnet  │
└─────────────┘    └────────────────┘
```

---

## 🚀 Instalación rápida

### 1. Clonar el repositorio
```bash
git clone https://github.com/tu-usuario/binance-ai-bot.git
cd binance-ai-bot
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar variables de entorno
```bash
cp .env.example .env
```
Editá `.env` con tus claves de API (ver sección [Configuración](#-configuración)).

### 4. Iniciar el backend
```bash
npm start
```

### 5. Abrir el dashboard
Abrí `index.html` en tu navegador (doble click o con Live Server en VS Code).

---

## ⚙️ Configuración

Completá el archivo `.env` con tus credenciales:

| Variable | Descripción | Dónde obtenerla |
|---|---|---|
| `BINANCE_API_KEY` | API Key de Binance | [Binance API Management](https://www.binance.com/en/my/settings/api-management) |
| `BINANCE_API_SECRET` | API Secret de Binance | Mismo lugar |
| `ANTHROPIC_API_KEY` | Clave de Claude AI | [console.anthropic.com](https://console.anthropic.com) |
| `BOT_SECRET_TOKEN` | Token de autenticación interno | Generalo vos (string largo y random) |
| `BINANCE_BASE_URL` | URL de la API | `https://api.binance.com` o testnet |
| `MAX_ORDER_USDT` | Máximo por orden en USDT | Default: `500` |
| `DAILY_LOSS_LIMIT_USDT` | Pérdida diaria máxima antes del circuit breaker | Default: `200` |
| `ALLOWED_PAIRS` | Pares habilitados para operar | Default: `BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT` |

> ⚠️ **Importante:** Para testear sin riesgo, usá `BINANCE_BASE_URL=https://testnet.binance.vision` y activá el modo Paper en el dashboard.

---

## 🔌 API del Backend

| Método | Endpoint | Auth | Descripción |
|---|---|---|---|
| `POST` | `/ai` | ✅ | Proxy hacia Claude AI — analiza indicadores y decide |
| `POST` | `/order` | ✅ | Ejecuta orden de mercado (BUY/SELL) |
| `GET` | `/balance` | ✅ | Consulta balance de la cuenta Binance |
| `GET` | `/positions` | ✅ | Posiciones abiertas actuales |
| `GET` | `/history` | ✅ | Historial de trades (últimos 200) |
| `GET` | `/price/:symbol` | ❌ | Precio actual de un par |
| `GET` | `/macro` | ❌ | Contexto macro desde Polymarket (cache 5min) |
| `GET` | `/openOrders` | ✅ | Órdenes abiertas en Binance |
| `DELETE` | `/order/:orderId` | ✅ | Cancela una orden |
| `POST` | `/bot/enable` | ✅ | Reactiva el bot tras circuit breaker |
| `POST` | `/bot/disable` | ✅ | Pausa el bot manualmente |

Todos los endpoints con ✅ requieren header: `Authorization: Bearer TU_BOT_SECRET_TOKEN`

---

## 📊 Indicadores técnicos

| Indicador | Descripción |
|---|---|
| **RSI (14)** | Momentum — detecta sobrecompra/sobreventa |
| **EMA 9 / EMA 21** | Cruces para identificar tendencia |
| **MACD** | Divergencia de medias móviles |
| **Bollinger Bands** | Volatilidad y rangos de precio |
| **ATR** | Average True Range — calibra el stop loss dinámico |

---

## 🧠 Cómo funciona el motor de IA

Cada N ticks (configurable), el sistema construye un prompt con el contexto completo del mercado y lo envía a Claude:

```
Par: BTCUSDT | Precio: $67,420
RSI(14): 58.3 | EMA9: $67,100 | EMA21: $66,800
MACD: 0.42 | BB Width: 3.2% | ATR: $890
Posición: Sin posición. Capital: $500.00.
Risk — SL: 2%, TP: 4%, R:R mínimo: 1:2
```

Claude responde en JSON estructurado:
```json
{
  "decision": "BUY",
  "reasoning": "RSI en zona neutral con EMA9 cruzando sobre EMA21, señal alcista.",
  "confidence": "media",
  "risk_note": "ATR elevado, considerar reducir tamaño de posición."
}
```

Si la confianza supera el umbral configurado y el bot está activo, la orden se ejecuta automáticamente.

---

## 🛡️ Gestión de riesgo

- **Stop Loss configurable** por porcentaje desde el precio de entrada
- **Take Profit** con ratio R:R mínimo configurable
- **Trailing Stop** para proteger ganancias en tendencias
- **Drawdown máximo diario** — el bot se pausa automáticamente al alcanzarlo
- **Circuit Breaker** — mismo comportamiento ante pérdida diaria límite
- **Una posición por par** — evita acumulación de riesgo

---

## 🗂️ Estructura del proyecto

```
binance-ai-bot/
├── server.js          # Backend Express (API, auth, Binance, Claude)
├── index.html         # Dashboard frontend (Chart.js, indicadores, UI)
├── package.json
├── .env.example       # Template de variables de entorno
├── .gitignore
├── logs/              # Logs automáticos (bot.log, error.log)
└── README.md
```

---

## 🔐 Seguridad

- Las API keys nunca tocan el frontend — todo pasa por el backend
- Token de autenticación requerido para todos los endpoints sensibles
- Rate limiting: máx 30 requests/minuto por IP
- Helmet para headers HTTP seguros
- CORS restrictivo — solo permite origen local
- `.env` excluido de Git por `.gitignore`

---

## 📋 Requisitos

- Node.js 18+
- Cuenta en Binance (o Binance Testnet para pruebas)
- API Key de Anthropic (Claude)
- Navegador moderno para el dashboard

---

## ⚠️ Disclaimer

Este proyecto es educativo y experimental. Trading con criptomonedas implica riesgo de pérdida de capital. Siempre probá primero en testnet o paper trading. El autor no es responsable por pérdidas financieras derivadas del uso de este software.

---

## 👤 Autor

**Facundo Puebla** — Python & AI Developer
- LinkedIn: [linkedin.com/in/facundo-puebla-65150027b](https://www.linkedin.com/in/facundo-puebla-65150027b/)
- GitHub: [@tu-usuario](https://github.com/tu-usuario)

---

## 📄 Licencia

MIT © Facundo Puebla
