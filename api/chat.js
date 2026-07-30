/**
 * Vercel serverless function — POST /api/chat
 *
 * Streams NPC dialogue from the Anthropic API as SSE frames so the in-game
 * ChatBox can render replies token by token.  The frame format mirrors the
 * one expected by src/ai/ChatClient.js:
 *
 *   data: {"type":"delta","text":"..."}\n\n
 *   data: {"type":"done"}\n\n
 *
 * Vercel automatically parses JSON request bodies into req.body, so no
 * manual stream reading is needed here.
 *
 * Environment variables (set in the Vercel dashboard):
 *   ANTHROPIC_API_KEY   required for live AI replies
 *   CHAT_MODEL          optional, defaults to claude-haiku-4-5
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CHAT_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS = 150;

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
  // CORS
  const origin = req.headers.origin || '';
  if (
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
    origin.endsWith('.vercel.app') ||
    origin.includes('aethernexus.games')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')   { res.status(405).json({ error: 'method not allowed' }); return; }

  // Vercel auto-parses JSON bodies; handle object and string forms.
  let body = req.body;
  console.log('[chat] body type:', typeof body, '| raw:', JSON.stringify(body)?.slice(0, 120));

  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { res.status(400).json({ error: 'bad-json' }); return; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    console.log('[chat] bad-request: body is', typeof body);
    res.status(400).json({ error: 'bad-request' });
    return;
  }

  const playerMessage = clean(body.playerMessage, 600);
  if (!playerMessage) {
    console.log('[chat] empty-message: playerMessage=', body.playerMessage);
    res.status(400).json({ error: 'empty-message' });
    return;
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  console.log('[chat] apiKey present:', !!apiKey, '| model:', MODEL);

  if (!apiKey) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    sseData(res, { type: 'error', message: 'no-key' });
    res.end();
    return;
  }

  const system   = buildSystem(clean(body.npcName, 80), clean(body.persona, 700), clean(body.world, 40));
  const messages = sanitizeHistory(body.history);
  messages.push({ role: 'user', content: playerMessage });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({ model: MODEL, max_tokens: MAX_TOKENS, system, messages });

    let sent = 0;
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        sent += event.delta.text.length;
        sseData(res, { type: 'delta', text: event.delta.text });
      }
    }

    console.log('[chat] done, chars sent:', sent);
    sseData(res, sent === 0 ? { type: 'error', message: 'empty-reply' } : { type: 'done' });
  } catch (err) {
    console.error('[chat] upstream error:', err?.status, err?.message);
    const msg = err?.status === 401 ? 'bad-key'
              : err?.status === 429 ? 'rate-limited'
              : 'upstream-error';
    sseData(res, { type: 'error', message: msg });
  }

  res.end();
}
