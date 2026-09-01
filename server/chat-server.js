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
/* 150 was sized for a one-line bark and nothing else. A quest clue has to name
 * a target, say roughly where it is and still sound like the character saying
 * it, and at 150 that answer was being cut off mid-sentence. Raised globally
 * rather than per-request: the sentence cap below still keeps ordinary chatter
 * short, so the extra budget is only ever spent when there is something to
 * spend it on. */
const MAX_TOKENS = 400;
/* 16 KiB was sized against 150-token replies. Two things grew past it: the
 * client echoes the last 20 turns back as history, and a 400-token reply is
 * roughly 1.6 KiB, so ten of them alone are 16 KiB before the new quest
 * context is added. A body over the cap is rejected as `bad-request`, which
 * ChatClient reads as a dead backend and latches offline for the whole
 * session — so a too-small cap here does not degrade, it disables. */
const MAX_BODY_BYTES = 64 * 1024;

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

/**
 * WHERE THE PLAYER IS STANDING, AS ONE LINE OF SETTING.
 *
 * THIS IS NOW THE ONLY COPY, and it is dev-only. It used to say "TWO COPIES
 * OF THIS TABLE EXIST - this one and the one in `api/chat.js`", and warned
 * that a row added to one and not the other was invisible until somebody
 * talked to an NPC on the half that was missing it. `api/chat.js` was a stale
 * duplicate of the deployed route and has been deleted (Sep 2026).
 *
 * The deployed equivalent is `site/app/api/chat/route.ts`, which no longer
 * hand-types its world roster at all — it derives it from `site/lib/worlds.ts`.
 * So this table is the one that can still drift, and it drifts only in local
 * development, where the drift is visible to whoever caused it.
 *
 * `buildSystem` falls back to "<world id> - a region of the Aether Nexus",
 * which is why a missing row is silent rather than broken: an NPC standing in
 * a lava field is told they are in a region of the Aether Nexus and answers
 * accordingly. The nine planets Phase 2 added went in here on the day they
 * were added, for exactly that reason.
 *
 * Keys are WORLD IDS. For a planet that is the bare descriptor id -
 * `PlanetWorld.of` sets `static id = descriptor.id` - so `cinder`, never
 * `planet:cinder`. Every claim below is taken from the docblocks in
 * `src/worlds/space/Bodies.js`, which is the source of truth for what each
 * body is.
 */
const WORLD_BLURB = {
  station: 'Aether Station — an orbital habitat of plated roads, gantries and glass, hanging above a planet.',
  medieval: 'Karnholt — a castle keep and timber village of cobbled streets, market stalls and rolling grass hills.',
  sports: 'The Meridian Complex — a floodlit sports campus of skate bowls, courts, a snow slope and a running track.',
  citadel: 'Sunspire Citadel — a vertical fortress-town of terraces, rope bridges and guarded gates cut into a desert cliff.',
  race: 'Vellum Ridge Circuit — a mountain race course that climbs, dives and threads city blocks before snapping back to the line.',
  maze: 'The Verdant Coil — a hedge maze that re-rolls its layout on every entry, so its districts and levels never repeat.',
  dock: 'Lodestar Yard — the shipyard behind gateway six: an assembly bay of cradles, gantries, piers and berths, with four fitted-out hulls standing in it.',
  space: 'Open space beyond Lodestar Yard — a black volume some 640 km across holding a star, a ringed gas giant, an asteroid belt, and ten planets a ship can land on.',

  /* The ten landable planets, nearest first - the order Bodies.js lists them
     in, which is distance from Lodestar Yard. */
  cinder:    'Cinder — a volcanic world of near-black basalt: a caldera, lava lakes, and a fissure network that still glows orange on the night side.',
  tessera:   'Tessera — an airless cratered moonlet at a sixth of a gravity. No air and no haze, so the sky is black at noon and nothing fills the shadows.',
  sirocco:   'Sirocco — a desert world of dune seas and salt pans under deep orange dust, with one slot canyon cut down through it.',
  shoal:     'Shoal — an ocean world: island chains strung across a shallow shelf, and one tidal chasm that drains and fills.',
  vitrine:   'Vitrine — an ice world of crevasse fields and pressure ridges, with a subglacial vault underneath them.',
  verdigris: 'Verdigris — a living world of canopy mesas standing over river gorges.',
  lathe:     'Lathe — an airless shepherd moon riding just outside the rings of the gas giant Ceraunus, which fills most of its sky.',
  carnelian: 'Carnelian — red iron highlands of scarps and dust under thin air, cut by one very deep gorge.',
  sallow:    'Sallow — a sulfur world of acid lakes and fumarole fields under permanent yellow overcast.',
  cathedra:  'Cathedra — a crystal world of shattered plates and spire fields, with a hollow vault beneath them. The furthest thing in the system.',
};

/**
 * Render the player's in-progress quests as a few compact lines.
 *
 * Input is `QuestSystem.summary()` — title plus each step's label, type,
 * target and have/count. Bounded on every axis (quests, steps, string lengths)
 * because it is untrusted client input being pasted into a system prompt, and
 * because an unbounded objective list would crowd out the persona it is
 * attached to.
 *
 * @param {unknown} raw
 * @returns {string} '' when there is nothing in progress
 */
function questContext(raw) {
  if (!Array.isArray(raw) || !raw.length) return '';
  const lines = [];
  for (const quest of raw.slice(0, 3)) {
    const title = clean(quest?.title, 90);
    if (!title) continue;
    lines.push(`- "${title}" (${Math.round(Number(quest?.percent) || 0)}% done)`);
    const steps = Array.isArray(quest?.steps) ? quest.steps.slice(0, 10) : [];
    for (const step of steps) {
      const label = clean(step?.label, 90) || clean(step?.type, 24) || 'objective';
      const type = clean(step?.type, 24);
      const target = clean(step?.target, 60);
      const count = Math.max(1, Number(step?.count) || 1);
      const have = Math.min(Math.max(0, Number(step?.have) || 0), count);
      const mark = step?.done ? 'DONE' : 'TODO';
      const progress = count > 1 ? ` ${have}/${count}` : '';
      const where = target ? ` [${type || 'step'}: ${target}]` : (type ? ` [${type}]` : '');
      lines.push(`  · ${mark} ${label}${progress}${where}`);
    }
  }
  return lines.join('\n');
}

/**
 * System prompt: persona first, then setting, then the hard format rules. The
 * format rules go last so they are the most recent instruction the model reads.
 *
 * `quests` is the player's live objective list. Without it the model had no
 * idea what the player had accepted, so "how do I finish this?" was answered
 * with invention — confidently, and wrongly.
 */
function buildSystem(npcName, persona, world, quests = '') {
  const setting = WORLD_BLURB[world] || (world ? `${world} — a region of the Aether Nexus.` : 'The Aether Nexus.');
  return [
    `You are ${npcName || 'a stranger'}, a character living in the world of AETHER NEXUS.`,
    persona ? `Your character: ${persona}` : '',
    `Your surroundings: ${setting}`,
    '',
    quests ? "The player's current quests (they can see this on their own quest board — J opens it):" : '',
    quests,
    quests
      ? [
        '',
        'Using the quest list:',
        '- If the player asks about a quest, what to do next, or how to finish something, use the list above. Never invent an objective, a target or a place that is not in it.',
        '- Give a CLUE, in character: point them at the target the step names and roughly where or how it is found. Do not read the list back to them and do not narrate a numbered walkthrough.',
        '- Answer about the first TODO step. Mention the count only if there is more than one to get.',
        '- For a quest answer you may take up to 5 short sentences instead of 3.',
        '- If the list is empty or none of it fits what they asked, say plainly that you know of nothing on their slate and point them at the quest board (J).',
        '',
      ].join('\n')
      : '',
    'Rules:',
    /* The exception is repeated here rather than left to the quest block above.
     * These rules are deliberately last so they are the most recent instruction
     * the model reads — which also means a bare "1-3 sentences" here would
     * override the longer allowance the quest block just granted. */
    quests
      ? '- You are an NPC in a video game. Reply in 1-3 short spoken sentences, as dialogue only — up to 5 when you are answering about a quest.'
      : '- You are an NPC in a video game. Reply in 1-3 short spoken sentences, as dialogue only.',
    '- Answer the player directly first; do not dodge the question with another question unless they were just greeting you.',
    '- Keep any extra flavor to one short clause. Do not monologue.',
    '- Stay in character at all times. Never mention being an AI, a model, a system, or a prompt.',
    '- No stage directions, no asterisks, no quotation marks around your line, no markdown, and no narration about body language.',
    '- Speak naturally, with the voice and opinions your character would have.',
    '- If you do not know something, answer plainly, admit it, or give the shortest believable guess.',
    '',
    'Canonical game facts:',
    /* THE COUNT IS `main.js`'s REGISTRATIONS, NOT A GUESS. Eight world
     * classes are registered by hand - station, medieval, sports, citadel,
     * race, maze, dock, space - and `worldClasses()` in
     * `src/worlds/planets/index.js` registers one more per planet
     * descriptor, of which there are ten. Eighteen. This block said FIVE
     * while the station ring already had six gateways and a shipyard behind
     * the sixth, so an NPC asked about the Verdant Coil or Lodestar Yard
     * denied that either of them existed - which is worse than not knowing. */
    '- The Nexus has eighteen worlds. Seven are reached through the gateway ring: Aether Station, Medieval Valley (Aldermoor Vale), the Meridian Athletic Grounds, Sunspire Citadel, Vellum Ridge, the Verdant Coil, and Lodestar Yard.',
    '- The other eleven are out past Lodestar Yard: open space itself, and the ten planets in it you can land a ship on - Cinder, Tessera, Sirocco, Shoal, Vitrine, Verdigris, Lathe, Carnelian, Sallow and Cathedra.',
    '- Aether Station is the hub world and has six outbound portals; each of the other six ring worlds has one return portal back to it.',
    '- Lodestar Yard is the shipyard behind gateway six, and the only world with a second portal: a launch portal onto open space. That one is crossed in a ship, not on foot.',
    '- The ten planets have no portals at all. You fly to them and set down, and the nearest is Cinder at 62 km from the Yard while the furthest is Cathedra at 288 km.',
    '- If asked how many portals exist, do not guess: the station hub has six outbound gates, the six worlds beyond them have one return gate each, and Lodestar Yard has one more that opens onto space.',
    '- Core controls: J opens the quest board from anywhere; E talks to friendlies, opens the quest board at quest managers, picks up loot, and enters portals; T opens chat; F1 shows help; F2 customizes the character; F3 opens diagnostics; F4 opens audio; F5 saves; F6 rebinds; F7 opens the race panel; F9 reports a bug; I opens inventory; B opens the marketplace; M opens the mount wheel; F dismounts; K unstucks; V swaps camera; [ and ] zoom the minimap.',
    '- Gameplay facts: there are five mounts, four weapons, climbing works on near-vertical surfaces, water can be swum in, credits are spent in the marketplace, and the bag holds 30 slots.',
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
 * Thinking is disabled deliberately: these are spoken lines, not reasoning, and
 * every token of the budget needs to reach the player rather than be spent
 * before the first word of dialogue.
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

  const system = buildSystem(
    clean(body?.npcName, 80),
    clean(body?.persona, 700),
    clean(body?.world, 40),
    // Not squeezed through `persona`: that argument is cut at 700 characters,
    // and the truncation would land on whichever of the two came second.
    questContext(body?.quests)
  );
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
