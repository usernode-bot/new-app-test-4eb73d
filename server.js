const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
// Platform LLM proxy — staging containers receive neither env var, so this
// is the sanctioned "AI unavailable, degrade gracefully" signal.
const LLM_ENABLED = !!process.env.USERNODE_LLM_PROXY_TOKEN;
const LLM_PROXY_URL = process.env.USERNODE_LLM_PROXY_URL;
const LLM_PROXY_TOKEN = process.env.USERNODE_LLM_PROXY_TOKEN;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

// Uploaded chart screenshots arrive as base64 JSON (~150–400 KB after the
// client's canvas compression); 8mb leaves generous headroom.
app.use(express.json({ limit: '8mb' }));

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/llm-status', (_req, res) => res.json({ enabled: LLM_ENABLED }));

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic per-image limit
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const ANALYSIS_TOOL = {
  name: 'record_chart_analysis',
  description: 'Record the structured technical analysis of the uploaded price chart screenshot.',
  input_schema: {
    type: 'object',
    properties: {
      is_chart: {
        type: 'boolean',
        description: 'true only if the image is a readable financial price chart (candlestick/line/bar). false for anything else.',
      },
      instrument: {
        type: 'string',
        description: 'Instrument/pair read from the chart, e.g. "XAU/USD" (gold), "EUR/USD", or "BTC/USDT". Normalize gold tickers like GOLD, XAUUSD, GC to "XAU/USD". "Tidak terbaca" if not visible.',
      },
      instrument_class: {
        type: 'string',
        enum: ['gold', 'forex', 'crypto', 'index', 'stock', 'commodity', 'other'],
        description: 'Asset class of the instrument. Use "gold" for XAU/USD / spot gold specifically.',
      },
      signal: { type: 'string', enum: ['buy', 'sell', 'hold'] },
      confidence: {
        type: 'integer', minimum: 0, maximum: 100,
        description: 'Honest confidence 0-100. Use low values when the chart is ambiguous.',
      },
      trend: { type: 'string', enum: ['up', 'down', 'sideways'] },
      support_levels: { type: 'array', items: { type: 'string' }, description: 'Key support levels as strings (prices may not be readable).' },
      resistance_levels: { type: 'array', items: { type: 'string' } },
      patterns: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, note: { type: 'string' } },
          required: ['name'],
        },
        description: 'Candlestick/chart patterns visible, each with a short plain-language note in Bahasa Indonesia.',
      },
      reasoning: { type: 'string', description: 'Short technical reasoning summary in Bahasa Indonesia.' },
      stop_loss_zone: { type: 'string', description: 'Suggested stop-loss zone, e.g. "1.0800–1.0815".' },
      take_profit_zone: { type: 'string' },
      timeframe_note: { type: 'string', description: 'Detected chart timeframe if visible, e.g. "H4".' },
    },
    required: ['is_chart', 'signal', 'confidence', 'trend', 'reasoning'],
  },
};

const SYSTEM_PROMPT = [
  'You are a conservative, experienced forex/crypto technical analyst.',
  'You are given a screenshot of a price chart and must record a structured analysis via the record_chart_analysis tool.',
  'Rules:',
  '- If the image is NOT a readable financial price chart (a selfie, meme, unrelated screenshot, unreadable image), set is_chart to false and leave signal as "hold" with confidence 0.',
  '- Be conservative: when the chart is ambiguous or signals conflict, prefer "hold" and a low confidence score. Never overstate certainty.',
  '- Read support/resistance levels and price zones from the chart axes when legible; otherwise describe them relatively (e.g. "area support terdekat di bawah harga saat ini").',
  '- Write all free-text fields (reasoning, pattern notes, zones, timeframe_note) in Bahasa Indonesia, keeping standard trading terms in English (BUY/SELL/HOLD, stop-loss, take-profit, breakout, dll).',
  '- Suggested stop-loss/take-profit zones are aids, not guarantees — keep them realistic relative to visible volatility.',
  '- Always identify the instrument and set instrument_class. Recognize GOLD / XAU / XAUUSD / GC / "spot gold" as instrument "XAU/USD" with instrument_class "gold".',
  '- If instrument_class is "gold" (XAU/USD): tailor the analysis to gold\'s behavior — it typically moves in larger absolute points than forex pairs (e.g. quote levels around 1900–2500 with round-number magnets at 10/25/50-dollar steps), is sensitive to USD strength, real yields, and risk sentiment, and often shows wider intraday ranges. Read support/resistance to gold\'s actual price scale (whole dollars, not 4-decimal pip levels), size stop-loss/take-profit zones to gold\'s wider volatility (tens of dollars, not a handful of pips), mention key round numbers when relevant, and note gold-specific context in the reasoning. Keep BUY/SELL/HOLD conservative as usual.',
].join('\n');

// Analyze an uploaded chart screenshot via the platform LLM proxy.
app.post('/api/analyze', async (req, res) => {
  try {
    const { image, media_type: mediaType } = req.body || {};
    if (typeof image !== 'string' || !image) {
      return res.status(400).json({ code: 'bad_request', error: 'Gambar tidak ditemukan di permintaan.' });
    }
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      return res.status(400).json({ code: 'bad_request', error: 'Format gambar harus JPEG, PNG, atau WebP.' });
    }
    // Rough decoded size from base64 length.
    if (image.length * 0.75 > MAX_IMAGE_BYTES) {
      return res.status(400).json({ code: 'bad_request', error: 'Gambar terlalu besar (maks 5 MB).' });
    }
    if (!LLM_ENABLED) {
      return res.status(503).json({ code: 'llm_unavailable', error: 'Analisis AI tidak tersedia di lingkungan ini.' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    let resp;
    try {
      resp = await fetch(`${LLM_PROXY_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-usernode-app-token': LLM_PROXY_TOKEN,
          'x-usernode-user-token': req.headers['x-usernode-token'] || '',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          tools: [ANALYSIS_TOOL],
          tool_choice: { type: 'tool', name: 'record_chart_analysis' },
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
              { type: 'text', text: 'Analisis screenshot chart ini dan catat hasilnya lewat tool record_chart_analysis.' },
            ],
          }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      let body = {};
      try { body = await resp.json(); } catch {}
      const code = body && body.code;
      if (resp.status === 403 && code === 'grant_required') {
        return res.status(403).json({ code: 'grant_required' });
      }
      if (resp.status === 429 && (code === 'app_cap_exceeded' || code === 'budget_exceeded')) {
        return res.status(429).json({ code });
      }
      console.error('LLM proxy error', resp.status, JSON.stringify(body).slice(0, 500));
      return res.status(502).json({ code: 'llm_error', error: 'Analisis AI gagal — coba lagi sebentar lagi.' });
    }

    const message = await resp.json();
    const toolUse = (message.content || []).find((b) => b.type === 'tool_use' && b.name === 'record_chart_analysis');
    if (!toolUse || !toolUse.input) {
      return res.status(502).json({ code: 'llm_error', error: 'Respon AI tidak terbaca — coba lagi.' });
    }
    const analysis = toolUse.input;

    if (analysis.is_chart === false) {
      return res.status(422).json({
        code: 'not_a_chart',
        error: 'Gambar ini tidak terlihat seperti chart harga — coba upload screenshot chart yang lebih jelas.',
      });
    }

    const signal = ['buy', 'sell', 'hold'].includes(analysis.signal) ? analysis.signal : 'hold';
    const confidence = Math.max(0, Math.min(100, parseInt(analysis.confidence, 10) || 0));
    const imageDataUrl = `data:${mediaType};base64,${image}`;

    const { rows } = await pool.query(
      `INSERT INTO analyses (user_id, username, image_data, signal, confidence, analysis)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, signal, confidence, analysis, image_data, created_at`,
      [req.user.id, req.user.username, imageDataUrl, signal, confidence, JSON.stringify(analysis)]
    );

    // Keep storage bounded: prune each user's history beyond the newest 50.
    await pool.query(
      `DELETE FROM analyses
       WHERE user_id = $1 AND id NOT IN (
         SELECT id FROM analyses WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50
       )`,
      [req.user.id]
    );

    res.json({ item: rows[0] });
  } catch (err) {
    console.error('analyze failed:', err.message);
    res.status(500).json({ code: 'server_error', error: 'Terjadi kesalahan server — coba lagi.' });
  }
});

// Tiny SVG placeholder "chart" for staging demo rows.
function demoChartSvg(label, up) {
  const points = up ? '10,90 60,70 110,80 160,50 210,60 260,30 310,20' : '10,30 60,45 110,35 160,60 210,55 260,80 310,90';
  const color = up ? '#22c55e' : '#f59e0b';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">` +
    `<rect width="320" height="120" fill="#18181b"/>` +
    `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3"/>` +
    `<text x="12" y="20" fill="#a1a1aa" font-family="sans-serif" font-size="13">${label}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// Read-only demo rows for staging previews (analyses is staging:private, so
// the copied table is always empty there). Never persisted, never in prod.
const DEMO_ANALYSES = [
  {
    id: -3,
    signal: 'buy',
    confidence: 71,
    image_data: demoChartSvg('Staging demo — XAU/USD (Gold)', true),
    analysis: {
      is_chart: true,
      instrument: 'Staging demo — XAU/USD',
      instrument_class: 'gold',
      signal: 'buy',
      confidence: 71,
      trend: 'up',
      support_levels: ['2.320', '2.300 (round number)'],
      resistance_levels: ['2.360', '2.400 (round number)'],
      patterns: [{ name: 'Higher low', note: 'Contoh: emas menahan support di atas 2.300, khas perilaku gold.' }],
      reasoning: 'Data demo staging: XAU/USD (emas) uptrend, sensitif terhadap kekuatan USD dan real yield. Zona SL/TP dibuat lebih lebar sesuai volatilitas gold (puluhan dolar, bukan pip). Ini contoh, bukan analisis nyata.',
      stop_loss_zone: '2.298–2.305',
      take_profit_zone: '2.355–2.365',
      timeframe_note: 'H4 (contoh)',
    },
    created_at: '2026-07-02T10:00:00.000Z',
  },
  {
    id: -1,
    signal: 'buy',
    confidence: 68,
    image_data: demoChartSvg('Staging demo — EUR/USD', true),
    analysis: {
      is_chart: true,
      instrument: 'Staging demo — EUR/USD',
      instrument_class: 'forex',
      signal: 'buy',
      confidence: 68,
      trend: 'up',
      support_levels: ['1.0820', '1.0790'],
      resistance_levels: ['1.0910'],
      patterns: [{ name: 'Bullish engulfing', note: 'Contoh pola demo staging di area support.' }],
      reasoning: 'Data demo staging: tren naik dengan pola bullish engulfing di dekat support 1.0820. Ini contoh, bukan analisis nyata.',
      stop_loss_zone: '1.0800–1.0815',
      take_profit_zone: '1.0900–1.0920',
      timeframe_note: 'H4 (contoh)',
    },
    created_at: '2026-07-01T09:00:00.000Z',
  },
  {
    id: -2,
    signal: 'hold',
    confidence: 45,
    image_data: demoChartSvg('Staging demo — BTC/USDT', false),
    analysis: {
      is_chart: true,
      instrument: 'Staging demo — BTC/USDT',
      instrument_class: 'crypto',
      signal: 'hold',
      confidence: 45,
      trend: 'sideways',
      support_levels: ['64.200'],
      resistance_levels: ['67.800'],
      patterns: [],
      reasoning: 'Data demo staging: harga bergerak sideways di dalam range, sinyal belum jelas. Ini contoh, bukan analisis nyata.',
      stop_loss_zone: '63.900–64.100',
      take_profit_zone: '67.500–67.800',
      timeframe_note: 'D1 (contoh)',
    },
    created_at: '2026-06-30T15:30:00.000Z',
  },
];

// Per-user analysis history (newest first).
app.get('/api/analyses', async (req, res) => {
  try {
    if (IS_STAGING && req.query.demo === '1') {
      return res.json({ items: DEMO_ANALYSES });
    }
    const { rows } = await pool.query(
      `SELECT id, signal, confidence, analysis, image_data, created_at
       FROM analyses WHERE user_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 20`,
      [req.user.id]
    );
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated, otherwise an "open in Usernode"
// landing page so stray visits to the staging URL don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analyses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      image_data TEXT NOT NULL,
      signal VARCHAR(8) NOT NULL,
      confidence INTEGER NOT NULL,
      analysis JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Users' trading charts are owner-only content — keep rows out of staging.
  await pool.query(`COMMENT ON TABLE analyses IS 'staging:private'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS analyses_user_created_idx ON analyses (user_id, created_at DESC)`);
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
