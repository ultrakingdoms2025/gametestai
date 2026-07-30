/**
 * AETHER NEXUS — NPC dialogue backend.
 *
 * Zero-framework `node:http` server on 127.0.0.1:8787 exposing a single
 * streaming endpoint, `POST /api/chat`. Replies are streamed back as SSE frames
 * so the HUD can render them token by token.
 *
 * The game must run offline, so this server is strictly optional: with no
 * ANTHROPIC_API_KEY present it answers `{"type":"error","message":"no-key"}`
 * immediately and the client falls back to its local persona generator.
 *
 *   node server/chat-server.js
 *   npm run dev            # runs vite + this server together
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const HOST = '127.0.0.1';
const PORT = Number(process.env.CHAT_PORT || 8787);
const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 150;
const MAX_BODY_BYTES = 16 * 1024;

/* Per-IP rate limiting: a refilling bucket plus a hard floor between requests. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 24;
const RATE_MIN_GAP_MS = 350;

/* ------------------------------------------------------------------ .env -- */

/**
 * Minimal `.env` reader. Deliberately not dotenv: this repo ships with exactly
 * one runtime dependency and that is not going to change for six lines of
 * parsing. Supports `KEY=value`, `export KEY=value`, quotes and `#` comments.
 */
function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length > 1) {
      value = value.slice(1, -1);
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadEnv(path.join(REPO_ROOT, '.env'));
// Real environment variables win over the file so CI/shell overrides work.
for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

const API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();

/* ------------------------------------------------------------------ CORS -- */

const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && DEV_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* ------------------------------------------------------------ rate limit -- */

/** @type {Map<string, {tokens:number, reset:number, last:number}>} */
const buckets = new Map();

function rateLimit(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now > b.reset) {
    b = { tokens: RATE_MAX, reset: now + RATE_WINDOW_MS, last: 0 };
    buckets.set(ip, b);
  }
  if (now - b.last < RATE_MIN_GAP_MS) return { ok: false, retryMs: RATE_MIN_GAP_MS - (now - b.last) };
  if (b.tokens <= 0) return { ok: false, retryMs: b.reset - now };
  b.tokens--;
  b.last = now;
  return { ok: true };
}

// Keep the map from growing without bound on a long-lived dev session.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now > b.reset + RATE_WINDOW_MS) buckets.delete(ip);
}, RATE_WINDOW_MS).unref();

/* ------------------------------------------------------------------- SSE -- */

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseError(res, message) {
  if (!res.headersSent) openSse(res);
  sse(res, { type: 'error', message });
  res.end();
}

/* -------------------------------------------------------------- payload -- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const WORLD_BLURB = {
  station: 'Aether Station — an orbital habitat of plated roads, gantries and glass, hanging above a planet.',
  medieval: 'Karnholt — a castle keep and timber village of cobbled streets, market stalls and rolling grass hills.',
  sports: 'The Meridian Complex — a floodlit sports campus of skate bowls, courts, a snow slope and a running track.',
};

/**
 * System prompt: persona first, then setting, then the hard format rules. The
 * format rules go last so they are the most recent instruction the model reads.
 */
function buildSystem(npcName, persona, world) {
  const setting = WORLD_BLURB[world] || (world ? `${world} — a region of the Aether Nexus.` : 'The Aether Nexus.');
  return [
    `You are ${npcName || 'a stranger'}, a character living in the world of AETHER NEXUS.`,
    persona ? `Your character: ${persona}` : '',
    `Your surroundings: ${setting}`,
    '',
    'Rules:',
    '- You are an NPC in a video game. Reply in 1-3 short spoken sentences, as dialogue only.',
    '- Answer the player directly first; do not dodge the question with another question unless they were just greeting you.',
    '- Keep any extra flavor to one short clause. Do not monologue.',
    '- Stay in character at all times. Never mention being an AI, a model, a system, or a prompt.',
    '- No stage directions, no asterisks, no quotation marks around your line, no markdown, and no narration about body language.',
    '- Speak naturally, with the voice and opinions your character would have.',
    '- If you do not know something, answer plainly, admit it, or give the shortest believable guess.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Normalise stored history into strictly alternating user/assistant turns. */
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw.slice(-20)) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const content = clean(m?.content, 600);
    if (!content) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content = content;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/* ------------------------------------------------------------ Anthropic -- */

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk')
      .then((mod) => {
        const Anthropic = mod.default ?? mod.Anthropic;
        return new Anthropic({ apiKey: API_KEY });
      })
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

/**
 * Thinking is disabled deliberately: these are one-line barks and every token
 * of the 150-token budget needs to reach the player.
 */
function requestParams(system, messages) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages,
    thinking: { type: 'disabled' },
  };
}

async function streamReply(client, system, messages, res) {
  let sent = 0;
  const stream = client.messages.stream(requestParams(system, messages));
  for await (const event of stream) {
    if (res.writableEnded) {
      stream.abort?.();
      return sent;
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const text = event.delta.text;
      if (text) {
        sent += text.length;
        sse(res, { type: 'delta', text });
      }
    }
  }
  return sent;
}

/* --------------------------------------------------------------- routes -- */

async function handleChat(req, res) {
  const ip = req.socket.remoteAddress || 'local';
  const limit = rateLimit(ip);
  if (!limit.ok) {
    openSse(res);
    sse(res, { type: 'error', message: `rate-limited:${Math.ceil(limit.retryMs / 1000)}` });
    res.end();
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sseError(res, 'bad-request');
    return;
  }

  const playerMessage = clean(body?.playerMessage, 600);
  if (!playerMessage) {
    sseError(res, 'empty-message');
    return;
  }

  if (!API_KEY) {
    // The single most common case in a fresh clone. Answer instantly so the
    // client can drop to offline personas without a visible stall.
    sseError(res, 'no-key');
    return;
  }

  const system = buildSystem(clean(body?.npcName, 80), clean(body?.persona, 700), clean(body?.world, 40));
  const messages = sanitizeHistory(body?.history);
  messages.push({ role: 'user', content: playerMessage });

  openSse(res);
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15_000);

  try {
    const client = await getClient();
    const sent = await streamReply(client, system, messages, res);
    if (!res.writableEnded) {
      if (sent === 0) sse(res, { type: 'error', message: 'empty-reply' });
      else sse(res, { type: 'done' });
      res.end();
    }
  } catch (err) {
    const message = err?.status === 401 ? 'bad-key' : err?.status === 429 ? 'upstream-rate-limit' : 'upstream-error';
    console.error(`[chat] ${message}:`, err?.message ?? err);
    if (!res.writableEnded) {
      sse(res, { type: 'error', message });
      res.end();
    }
  } finally {
    clearInterval(keepAlive);
  }
}

const server = http.createServer((req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && (url === '/health' || url === '/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: MODEL, key: API_KEY ? 'present' : 'missing' }));
    return;
  }

  if (req.method === 'POST' && url === '/api/chat') {
    handleChat(req, res).catch((err) => {
      console.error('[chat] unhandled:', err);
      if (!res.writableEnded) sseError(res, 'internal-error');
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[chat] port ${PORT} is already in use — is another chat server running?`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`[chat] listening on http://${HOST}:${PORT}  model=${MODEL}`);
  if (!API_KEY) {
    console.log('[chat] ANTHROPIC_API_KEY not set — clients will use offline personas. See .env.example');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
