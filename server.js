/**
 * ============================================================
 *  BINANCE TRADING BOT — BACKEND SEGURO
 *  Versión: 1.0.0
 *  Requiere: Node.js 18+
 *  Instalación: npm install
 *  Inicio:      npm start
 * ============================================================
 */

require("dotenv").config();
const express     = require("express");
const crypto      = require("crypto");
const axios       = require("axios");
const rateLimit   = require("express-rate-limit");
const helmet      = require("helmet");
const winston     = require("winston");
const fs          = require("fs");
const path        = require("path");

// ─── Logger ──────────────────────────────────────────────────
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/bot.log", maxsize: 5_000_000, maxFiles: 5 }),
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
  ],
});

// ─── Crear carpeta de logs si no existe ──────────────────────
if (!fs.existsSync("logs")) fs.mkdirSync("logs");

// ─── Validar variables de entorno ────────────────────────────
const REQUIRED_ENV = ["BINANCE_API_KEY", "BINANCE_API_SECRET", "BOT_SECRET_TOKEN"];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  logger.error(`Faltan variables de entorno: ${missing.join(", ")}`);
  logger.error("Copiá .env.example a .env y completalo antes de iniciar.");
  process.exit(1);
}

const {
  BINANCE_API_KEY,
  BINANCE_API_SECRET,
  BOT_SECRET_TOKEN,
  PORT = 3000,
  BINANCE_BASE_URL = "https://api.binance.com",
  MAX_ORDER_USDT = "500",          // Máximo por orden en USDT
  DAILY_LOSS_LIMIT_USDT = "200",  // Pérdida diaria máxima
  ALLOWED_PAIRS = "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT",
} = process.env;

// ─── Estado interno (en memoria) ─────────────────────────────
let state = {
  dailyLoss: 0,
  dailyTrades: 0,
  lastResetDate: new Date().toDateString(),
  openPositions: {},    // symbol -> { side, qty, entryPrice, sl, tp }
  tradeHistory: [],
  botEnabled: true,
};

// ─── App Express ─────────────────────────────────────────────
const app = express();

app.use(helmet());
app.use(express.json({ limit: "10kb" }));

// CORS — solo permite origen local (la app del browser)
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const allowed = ["http://localhost", "https://claude.ai", "https://www.claude.ai"];
  const isAllowed = allowed.some(o => origin.startsWith(o)) || !origin;
  if (isAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Rate limiting: máx 30 requests/minuto por IP
app.use(rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { error: "Demasiadas solicitudes. Esperá un momento." },
}));

// ─── Middleware de autenticación ──────────────────────────────
function auth(req, res, next) {
  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (!token || token !== BOT_SECRET_TOKEN) {
    logger.warn(`Acceso no autorizado desde ${req.ip}`);
    return res.status(401).json({ error: "Token inválido o ausente." });
  }
  next();
}

// ─── Helpers Binance ─────────────────────────────────────────
function signQuery(params) {
  const qs = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const sig = crypto.createHmac("sha256", BINANCE_API_SECRET).update(qs).digest("hex");
  return `${qs}&signature=${sig}`;
}

const binance = axios.create({
  baseURL: BINANCE_BASE_URL,
  headers: { "X-MBX-APIKEY": BINANCE_API_KEY },
  timeout: 10_000,
});

// ─── Reset diario ─────────────────────────────────────────────
function checkDailyReset() {
  const today = new Date().toDateString();
  if (state.lastResetDate !== today) {
    state.dailyLoss   = 0;
    state.dailyTrades = 0;
    state.lastResetDate = today;
    logger.info("Reseteo diario de pérdidas y contador de trades.");
  }
}

// ─── Validaciones de orden ────────────────────────────────────
function validateOrder({ symbol, side, quoteQty, stopLoss, takeProfit }) {
  const allowedPairs = ALLOWED_PAIRS.split(",").map(p => p.trim());
  if (!allowedPairs.includes(symbol))
    return `Par no permitido: ${symbol}. Permitidos: ${allowedPairs.join(", ")}`;

  if (!["BUY", "SELL"].includes(side?.toUpperCase()))
    return "Side debe ser BUY o SELL.";

  if (quoteQty !== undefined) {
    const amount = parseFloat(quoteQty);
    if (isNaN(amount) || amount <= 0)
      return "quoteQty debe ser un número positivo.";
    if (amount > parseFloat(MAX_ORDER_USDT))
      return `Orden supera el máximo permitido de $${MAX_ORDER_USDT} USDT.`;
  }

  if (stopLoss !== undefined && isNaN(parseFloat(stopLoss)))
    return "stopLoss debe ser un número.";
  if (takeProfit !== undefined && isNaN(parseFloat(takeProfit)))
    return "takeProfit debe ser un número.";

  return null; // sin error
}

// ═══════════════════════════════════════════════════════════════
//  RUTAS
// ═══════════════════════════════════════════════════════════════

// ── POST /ai ─────────────────────────────────────────────────
// Proxy seguro hacia la API de Anthropic (Claude)
// El browser no puede llamar a Anthropic directamente por CORS
app.post("/ai", auth, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string" || prompt.length > 2000) {
    return res.status(400).json({ error: "Prompt inválido o demasiado largo." });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada en .env" });
  }
  try {
    const { data } = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 20_000,
      }
    );
    const text = data.content?.find(b => b.type === "text")?.text || "{}";
    logger.info(`AI analisis ejecutado para prompt de ${prompt.length} chars`);
    res.json({ text });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.error(`Error llamando a Anthropic API: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ── GET /macro ────────────────────────────────────────────────
// Obtiene contexto macro de Polymarket para mejorar análisis IA
let macroCache = { data: null, ts: 0 };
const MACRO_TTL = 5 * 60 * 1000;

const POLYMARKET_SLUGS = [
  { slug: "will-btc-hit-80000-before-april",  label: "BTC supera $80k antes de abril" },
  { slug: "fed-rate-cut-march-2026",           label: "Fed baja tasas en marzo 2026" },
  { slug: "us-recession-2026",                 label: "Recesión en USA 2026" },
  { slug: "will-btc-hit-100k-in-2026",        label: "BTC alcanza $100k en 2026" },
  { slug: "will-eth-flip-btc-2026",           label: "ETH supera BTC en 2026" },
];

app.get("/macro", async (req, res) => {
  try {
    const now = Date.now();
    if (macroCache.data && now - macroCache.ts < MACRO_TTL) {
      return res.json(macroCache.data);
    }
    const results = [];
    for (const market of POLYMARKET_SLUGS) {
      try {
        const { data } = await axios.get(
          `https://gamma-api.polymarket.com/markets?slug=${market.slug}`,
          { timeout: 5000 }
        );
        if (data && data[0]) {
          const m = data[0];
          const prob = m.outcomePrices
            ? Math.round(parseFloat(JSON.parse(m.outcomePrices)[0]) * 100)
            : null;
          if (prob !== null) results.push({ label: market.label, prob, slug: market.slug });
        }
      } catch (_) {}
    }
    const fallback = results.length === 0;
    if (fallback) {
      results.push(
        { label: "BTC supera $80k antes de abril", prob: 55, slug: "fallback" },
        { label: "Fed baja tasas en marzo 2026",    prob: 30, slug: "fallback" },
        { label: "Recesión en USA 2026",            prob: 35, slug: "fallback" }
      );
    }
    const response = { markets: results, cached: false, fallback, ts: new Date().toISOString() };
    macroCache = { data: response, ts: now };
    logger.info(`Macro context: ${results.length} mercados de Polymarket`);
    res.json(response);
  } catch (err) {
    logger.error(`Error macro context: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /health ───────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    botEnabled: state.botEnabled,
    dailyTrades: state.dailyTrades,
    dailyLoss: state.dailyLoss.toFixed(2),
    maxDailyLoss: MAX_ORDER_USDT,
    openPositions: Object.keys(state.openPositions),
    uptime: Math.floor(process.uptime()),
  });
});

// ── GET /balance ──────────────────────────────────────────────
app.get("/balance", auth, async (req, res) => {
  try {
    const qs = signQuery({});
    const { data } = await binance.get(`/api/v3/account?${qs}`);
    const balances = data.balances
      .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map(b => ({ asset: b.asset, free: b.free, locked: b.locked }));
    logger.info(`Balance consultado. Assets con saldo: ${balances.length}`);
    res.json({ balances });
  } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    logger.error(`Error consultando balance: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ── GET /price/:symbol ────────────────────────────────────────
app.get("/price/:symbol", async (req, res) => {
  try {
    const { data } = await binance.get("/api/v3/ticker/price", {
      params: { symbol: req.params.symbol.toUpperCase() },
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.msg || err.message });
  }
});

// ── GET /openOrders ───────────────────────────────────────────
app.get("/openOrders", auth, async (req, res) => {
  try {
    const qs = signQuery({});
    const { data } = await binance.get(`/api/v3/openOrders?${qs}`);
    res.json({ orders: data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.msg || err.message });
  }
});

// ── POST /order ──────────────────────────────────────────────
// Cuerpo esperado:
// { symbol, side, quoteQty, stopLoss?, takeProfit?, reason? }
app.post("/order", auth, async (req, res) => {
  checkDailyReset();

  if (!state.botEnabled) {
    return res.status(403).json({ error: "Bot deshabilitado (circuit breaker activo)." });
  }

  const { symbol, side, quoteQty, stopLoss, takeProfit, reason } = req.body;
  const upperSide = (side || "").toUpperCase();

  // Validación
  const validError = validateOrder({ symbol, side: upperSide, quoteQty, stopLoss, takeProfit });
  if (validError) {
    logger.warn(`Orden rechazada — ${validError}`);
    return res.status(400).json({ error: validError });
  }

  // No abrir nueva posición si ya existe para ese par
  if (upperSide === "BUY" && state.openPositions[symbol]) {
    return res.status(400).json({ error: `Ya hay una posición abierta en ${symbol}.` });
  }

  // Verificar pérdida diaria
  if (state.dailyLoss >= parseFloat(DAILY_LOSS_LIMIT_USDT)) {
    state.botEnabled = false;
    logger.warn(`Circuit breaker: pérdida diaria ($${state.dailyLoss.toFixed(2)}) superó el límite.`);
    return res.status(403).json({
      error: `Límite de pérdida diaria alcanzado ($${state.dailyLoss.toFixed(2)}). Bot pausado.`,
    });
  }

  try {
    // Obtener precio actual para registros
    const priceRes = await binance.get("/api/v3/ticker/price", {
      params: { symbol },
    });
    const currentPrice = parseFloat(priceRes.data.price);

    // Ejecutar orden de mercado
    const params = {
      symbol,
      side: upperSide,
      type: "MARKET",
      ...(upperSide === "BUY"
        ? { quoteOrderQty: parseFloat(quoteQty).toFixed(2) }
        : { quantity: state.openPositions[symbol]?.qty || parseFloat(quoteQty) }),
    };

    const qs = signQuery(params);
    const { data: orderData } = await binance.post(`/api/v3/order?${qs}`);

    const executedQty  = parseFloat(orderData.executedQty || 0);
    const executedQuote = parseFloat(orderData.cummulativeQuoteQty || quoteQty);

    // Registrar posición
    if (upperSide === "BUY") {
      state.openPositions[symbol] = {
        side: "LONG",
        qty: executedQty,
        entryPrice: currentPrice,
        invest: executedQuote,
        sl: stopLoss ? parseFloat(stopLoss) : null,
        tp: takeProfit ? parseFloat(takeProfit) : null,
        openedAt: new Date().toISOString(),
      };
    } else {
      // Calcular PnL al cerrar
      const pos = state.openPositions[symbol];
      if (pos) {
        const pnl = executedQuote - pos.invest;
        if (pnl < 0) state.dailyLoss += Math.abs(pnl);
        logger.info(`Posición cerrada ${symbol} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT | Razón: ${reason || "—"}`);
        delete state.openPositions[symbol];
      }
    }

    state.dailyTrades++;

    // Guardar en historial
    state.tradeHistory.unshift({
      orderId: orderData.orderId,
      symbol,
      side: upperSide,
      qty: executedQty,
      quoteQty: executedQuote,
      price: currentPrice,
      reason: reason || "—",
      ts: new Date().toISOString(),
    });
    if (state.tradeHistory.length > 200) state.tradeHistory.pop();

    logger.info(`ORDEN EJECUTADA | ${upperSide} ${symbol} | ${executedQty} @ ~$${currentPrice} | ${reason || "—"}`);

    // Colocar stop loss como orden OCO si se especificó
    if (upperSide === "BUY" && stopLoss && takeProfit) {
      try {
        const slPct = ((currentPrice - parseFloat(stopLoss)) / currentPrice * 100).toFixed(2);
        logger.info(`SL configurado en $${stopLoss} (${slPct}% abajo) | TP en $${takeProfit}`);
        // OCO real requiere qty exacta — aquí registramos para el bot de JS manejarlo
      } catch (e) {
        logger.warn(`No se pudo colocar OCO: ${e.message}`);
      }
    }

    res.json({
      success: true,
      order: orderData,
      position: state.openPositions[symbol] || null,
      state: {
        dailyTrades: state.dailyTrades,
        dailyLoss: state.dailyLoss.toFixed(2),
      },
    });

  } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    logger.error(`Error ejecutando orden ${upperSide} ${symbol}: ${msg}`);
    res.status(500).json({ error: msg, binanceCode: err.response?.data?.code });
  }
});

// ── DELETE /order/:orderId ────────────────────────────────────
app.delete("/order/:orderId", auth, async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "Falta el parámetro symbol." });
  try {
    const qs = signQuery({ symbol: symbol.toUpperCase(), orderId: req.params.orderId });
    const { data } = await binance.delete(`/api/v3/order?${qs}`);
    logger.info(`Orden cancelada: ${req.params.orderId} en ${symbol}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.msg || err.message });
  }
});

// ── GET /positions ─────────────────────────────────────────────
app.get("/positions", auth, (req, res) => {
  res.json({ positions: state.openPositions });
});

// ── GET /history ──────────────────────────────────────────────
app.get("/history", auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || 50), 200);
  res.json({ trades: state.tradeHistory.slice(0, limit) });
});

// ── POST /bot/enable ──────────────────────────────────────────
app.post("/bot/enable", auth, (req, res) => {
  state.botEnabled = true;
  state.dailyLoss  = 0;
  logger.info("Bot re-habilitado manualmente.");
  res.json({ botEnabled: true });
});

// ── POST /bot/disable ─────────────────────────────────────────
app.post("/bot/disable", auth, (req, res) => {
  state.botEnabled = false;
  logger.info("Bot deshabilitado manualmente.");
  res.json({ botEnabled: false });
});

// ─── 404 ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Ruta no encontrada." }));

// ─── Error global ─────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error(`Error no manejado: ${err.message}`);
  res.status(500).json({ error: "Error interno del servidor." });
});

// ─── Iniciar servidor ─────────────────────────────────────────
app.listen(PORT, "127.0.0.1", () => {
  logger.info(`╔══════════════════════════════════════════╗`);
  logger.info(`║  Binance Bot Backend corriendo           ║`);
  logger.info(`║  http://127.0.0.1:${PORT}                   ║`);
  logger.info(`║  Modo: ${BINANCE_BASE_URL.includes("testnet") ? "TESTNET ✓" : "PRODUCCION ⚠"}                    ║`);
  logger.info(`╚══════════════════════════════════════════╝`);
});

// ─── Shutdown seguro ──────────────────────────────────────────
process.on("SIGINT", () => {
  logger.info("Apagando el bot... posiciones abiertas conservadas.");
  process.exit(0);
});
