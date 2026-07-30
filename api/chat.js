/**
 * Vercel serverless function - POST /api/chat
 * Uses manual body reading since Vercel does not auto-parse bodies for this project.
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
    '',
    'Rules:',
    '- You are an NPC in a video game. Reply in 1-3 short spoken sentences, as dialogue only.',
    '- Answer the player directly first; do not dodge the question with another question unless they were just greeting you.',
    '- Keep any extra flavor to one short clause. Do not monologue.',
    '- Stay in character at all times. Never mention being an AI, a model, a system, or a prompt.',
    '- No stage directions, no asterisks, no quotation marks around your line, no markdown, and no narration about body language.',
    '- Speak naturally, with the voice and opinions your character would have.',
    '- If you do not know something, answer plainly, admit it, or give the shortest believable guess.',
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
    origin.endsWith('.vercel.app') ||
    origin.includes('aethernexus.games')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  // Manually read the request body from the stream
  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (e) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'read-error' }));
    return;
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'bad-json', raw: rawBody.slice(0, 80) }));
    return;
  }

  if (!body || typeof body !== 'object') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'bad-request' }));
    return;
  }

  const playerMessage = clean(body.playerMessage, 600);
  if (!playerMessage) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'empty-message' }));
    return;
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    res.statusCode = 200;
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

  res.statusCode = 200;
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

    sseData(res, sent === 0 ? { type: 'error', message: 'empty-reply' } : { type: 'done' });
  } catch (err) {
    const msg = err?.status === 401 ? 'bad-key'
              : err?.status === 429 ? 'rate-limited'
              : 'upstream-error';
    sseData(res, { type: 'error', message: msg });
  }

  res.end();
}