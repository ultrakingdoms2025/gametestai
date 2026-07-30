/**
 * Vercel serverless function — POST /api/chat
 *
 * Streams NPC dialogue from the Anthropic API as SSE frames so the in-game
 * ChatBox can render replies token by token.  The frame format mirrors the
 * one expected by src/ai/ChatClient.js:
 *
 *   data: {"type":"delta","text":"…"}\n\n
 *   data: {"type":"done"}\n\n
 *
 * Environment variables (set in the Vercel dashboard):
 *   ANTHROPIC_API_KEY   — required for live AI replies
 *   CHAT_MODEL          — optional, defaults to claude-haiku-4-5 (fast + cheap)
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CHAT_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS = 150;
const MAX_BODY_BYTES = 16 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const WORLD_BLURB = {
  station:  'Aether Station — an orbital habitat of plated roads, gantries and glass, hanging above a planet.',
  medieval: 'Aldermoor Vale — a castle keep and timber village of cobbled streets, market stalls and rolling grass hills.',
  sports:   'The Meridian Athletic Grounds — a floodlit sports campus of skate bowls, courts, a snow slope and a running track.',
  citadel:  'Sunspire Citadel — a vertical fortress-town of terraces, rope bridges and guarded gates cut into a desert cliff.',
  race:     'Vellum Ridge Circuit — a mountain race course that climbs, dives and threads city blocks before snapping back to the line.',
};

function buildSystem(npcName, persona, world) {
  const setting = WORLD_BLURB[world] || (world ? `${world} — a region of the Aether Nexus.` : 'The Aether Nexus.');
  return [
    `You are ${npcName || 'a stranger'}, a character living in the world of AETHER NEXUS.`,
    persona ? `Your character: ${persona}` : '',
    `Your surroundings: ${setting}`,
    'The person speaking to you is an armed traveller who arrived through a portal.',
    '',
    'Rules:',
    '- You are an NPC in a video game. Reply in 1-3 short spoken sentences, as dialogue only.',
    '- Stay in character at all times. Never mention being an AI, a model, a system, or a prompt.',
    '- No stage directions, no asterisks, no quotation marks around your line, no markdown.',
    '- Speak naturally, with the voice and opinions your character would have.',
    '- If you do not know something, answer the way your character would — guess, deflect, or admit it.',
  ].filter(Boolean).join('\n');
}

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw.slice(-20)) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!content) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content = content;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function clean(v, max) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sseData(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export default async function handler(req, res) {
  // CORS — allow same-origin and Vercel preview URLs
  const origin = req.headers.origin || '';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin.endsWith('.vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    sseData(res, { type: 'error', message: 'no-key' });
    res.end();
    return;
  }

  let body;
  try {
    // Vercel's raw Node.js runtime does not auto-parse req.body — read the stream.
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    res.status(400).json({ error: 'bad-request' });
    return;
  }

  const playerMessage = clean(body?.playerMessage, 600);
  if (!playerMessage) {
    res.status(400).json({ error: 'empty-message' });
    return;
  }

  const system   = buildSystem(clean(body?.npcName, 80), clean(body?.persona, 700), clean(body?.world, 40));
  const messages = sanitizeHistory(body?.history);
  messages.push({ role: 'user', content: playerMessage });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const client = new Anthropic({ apiKey });

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    });

    let sent = 0;
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        if (text) {
          sent += text.length;
          sseData(res, { type: 'delta', text });
        }
      }
    }

    if (sent === 0) sseData(res, { type: 'error', message: 'empty-reply' });
    else sseData(res, { type: 'done' });
  } catch (err) {
    const message = err?.status === 401 ? 'bad-key'
      : err?.status === 429 ? 'upstream-rate-limit'
      : 'upstream-error';
    sseData(res, { type: 'error', message });
  }

  res.end();
}

// Tell Vercel not to pre-parse the body — we read the stream ourselves.
export const config = { api: { bodyParser: false } };
