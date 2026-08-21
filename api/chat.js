/**
 * Vercel serverless function - POST /api/chat
 * Uses manual body reading since Vercel does not auto-parse bodies for this project.
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CHAT_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS = 150;

/**
 * WHERE THE PLAYER IS STANDING, AS ONE LINE OF SETTING.
 *
 * TWO COPIES OF THIS TABLE EXIST - this one and the one in `server/chat-server.js`.
 * The Vercel function and the local dev server share no module, so neither
 * reads the other and nothing compares them: a row added to one and not the
 * other is invisible until somebody talks to an NPC on the half that is
 * missing it, and then only on that half. Add to BOTH.
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
  station:  'Aether Station — an orbital habitat of plated roads, gantries and glass, hanging above a planet.',
  medieval: 'Aldermoor Vale — a castle keep and timber village of cobbled streets, market stalls and rolling grass hills.',
  sports:   'The Meridian Athletic Grounds — a floodlit sports campus of skate bowls, courts, a snow slope and a running track.',
  citadel:  'Sunspire Citadel — a vertical fortress-town of terraces, rope bridges and guarded gates cut into a desert cliff.',
  race:     'Vellum Ridge Circuit — a mountain race course that climbs, dives and threads city blocks before snapping back to the line.',
  maze:     'The Verdant Coil — a hedge maze that re-rolls its layout on every entry, so its districts and levels never repeat.',
  dock:     'Lodestar Yard — the shipyard behind gateway six: an assembly bay of cradles, gantries, piers and berths, with four fitted-out hulls standing in it.',
  space:    'Open space beyond Lodestar Yard — a black volume some 640 km across holding a star, a ringed gas giant, an asteroid belt, and ten planets a ship can land on.',

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
    '- Core controls: E talks to friendlies, opens the quest board at quest managers, picks up loot, and enters portals; T opens chat; F1 shows help; F2 customizes the character; F3 opens diagnostics; F4 opens audio; F5 saves; F6 rebinds; F7 opens the race panel; F9 reports a bug; I opens inventory; B opens the marketplace; M opens the mount wheel; F dismounts; K unstucks; V swaps camera; [ and ] zoom the minimap.',
    '- Gameplay facts: there are five mounts, four weapons, climbing works on near-vertical surfaces, water can be swum in, credits are spent in the marketplace, and the bag holds 30 slots.',
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