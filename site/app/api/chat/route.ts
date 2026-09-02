/**
 * POST /api/chat
 *
 * Streaming NPC chat powered by Anthropic Claude.
 *
 * Accepts: { npcId, npcName, persona, world, quests, playerMessage, history }
 *   history: Array<{ role: 'user'|'assistant', content: string }>
 *   quests:  QuestSystem.summary() — the player's in-progress objectives, so
 *            the NPC can answer "how do I finish this" from data instead of
 *            inventing one.
 *
 * Returns: text/event-stream  SSE with lines of the form:
 *   data: {"type":"delta","text":"<chunk>"}
 * terminated by:
 *   data: [DONE]
 *
 * If ANTHROPIC_API_KEY is not set, returns a structured error event that
 * ChatClient recognises as `no-key` and falls back to offline personas.
 *
 * -- What this endpoint was --------------------------------------------------
 *
 * An open, unauthenticated, unmetered proxy to a paid Anthropic key. No session
 * check, no rate limit, no body cap, no bound on `history` -- and `persona` and
 * `npcName` are interpolated straight into the system prompt by the caller. So
 * anyone who found the URL had a free Claude endpoint billed to this project,
 * with the system prompt as an input field.
 *
 * `server/chat-server.js` -- the LOCAL dev server, where the key is the
 * developer's own and the exposure is 127.0.0.1 -- has had all four guards since
 * it was written: a 64 KiB body cap, a per-IP refilling bucket, history clamped
 * to the last 20 turns, and every field cleaned and length-capped before it
 * reaches the prompt. The internet-facing copy had none of them. The four are
 * ported here, tightened where the exposure is larger:
 *
 *   - a session is REQUIRED, through the same `resolveActor()` that
 *     `/api/game/chat` uses, so the bill has a name against it;
 *   - the bucket is per PLAYER rather than per IP, because a player id is the
 *     thing being spent against and cannot be rotated by changing networks;
 *   - `history` is clamped to the last 10 turns and each turn to 1,000
 *     characters, which is what bounds the tokens per call;
 *   - the body is read as text and refused over 64 KiB, before it is parsed.
 *
 * Cleaning `persona` and `npcName` does not make the prompt injection-proof --
 * nothing does, and a player talking to an NPC can already say anything they
 * like in the message itself. What it bounds is the SIZE of what gets pasted in,
 * which is the part that costs money.
 */

import { resolveActor } from '@/lib/serverRoutes';
import { RATE_LIMITS, clientIp, consumeRateLimit } from '@/lib/rateLimit';
import { LANDABLE_PLANETS, TOTAL_DESTINATIONS, WORLDS } from '@/lib/worlds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* Matched to `server/chat-server.js`'s MAX_BODY_BYTES. The reasoning there
 * applies unchanged: the client echoes recent turns back as history and a
 * 400-token reply is roughly 1.6 KiB, so a cap much below this does not degrade
 * the feature, it disables it -- ChatClient reads a refusal as a dead backend
 * and latches offline for the whole session. */
const MAX_BODY_BYTES = 64 * 1024;
/* The last 10 turns. `server/chat-server.js` keeps 20 against a local key; this
 * copy is billed to the project, and ten turns is still more context than a
 * bark exchange with an NPC uses. */
const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_CHARS = 1000;
/* Bounds on the fields pasted into the system prompt, taken from the dev
 * server's `clean()` call sites so the two prompts cannot diverge in size. */
const MAX_NPC_NAME = 80;
const MAX_PERSONA = 700;
const MAX_WORLD = 40;
const MAX_PLAYER_MESSAGE = 600;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';
/* 256 was sized for a one-line bark. A quest clue has to name a target, say
 * roughly where it is, and still sound like the character saying it — at 256
 * that answer was being cut off mid-sentence. Raised globally rather than
 * per-request; the sentence cap below still keeps ordinary chatter short, so
 * the extra budget is only spent when there is something to spend it on. */
const MAX_TOKENS = 400;

/** One in-progress quest as `QuestSystem.summary()` reports it. */
type QuestStepSummary = {
  label?: unknown; type?: unknown; target?: unknown;
  have?: unknown; count?: unknown; done?: unknown;
};
type QuestSummary = { title?: unknown; percent?: unknown; steps?: unknown };

const trim = (v: unknown, max: number) =>
  String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Render the player's in-progress quests as a few compact lines.
 *
 * Bounded on every axis — quests, steps, and each string — because this is
 * untrusted client input being pasted into a system prompt, and because an
 * unbounded objective list would crowd out the persona it is attached to.
 */
/**
 * The world roster, derived from `lib/worlds.ts` rather than typed out here.
 *
 * WHAT THIS REPLACED, AND WHY IT MATTERED. This block used to assert, as
 * canonical fact, that "The Nexus has six worlds", that the station "has five
 * outbound portals", and — worst — it INSTRUCTED the model: "If asked how many
 * portals exist, do not guess: say there are six worlds / five destinations."
 * Every one of those numbers was wrong. The array below has seven gateway
 * worlds, the station has six outbound gates, and the game registers eighteen
 * destinations once space and the ten landable planets are counted.
 *
 * That made this the most damaging copy of the wrong count on the estate. The
 * planets were deliberately given no lore keeper — `crowd:false` means nobody
 * can stand on one to tell you about it — so NPC dialogue is the intended way a
 * player learns they exist. The NPCs had been told they do not. And unlike a
 * stale line on the marketing page, this one argued back with confidence when
 * a player asked directly.
 *
 * Note the offline fallback in `src/ai/ChatClient.js` already answered this
 * correctly ("Eighteen places, all told"), so the un-keyed path was more honest
 * than the paid one.
 *
 * Deriving it also means a new world reaches every NPC's mouth the moment it is
 * added to the array, with no second place to remember.
 */
function worldRosterFacts(): string[] {
  const gateways = WORLDS.filter((w) => w.id !== 'station');
  const named = gateways.map((w) => w.name).join(', ');
  return [
    `- The Nexus spans ${TOTAL_DESTINATIONS} destinations in all: ${WORLDS.length} reached through the station's gateway ring, plus open space, plus ${LANDABLE_PLANETS} landable planets.`,
    `- Aether Nexus Station is the hub. It has ${gateways.length} outbound gateways, to: ${named}.`,
    `- Each of those ${gateways.length} worlds has one return gateway back to the station.`,
    `- Lodestar Yard is the shipyard, and it has a SECOND gate that opens onto open space. Ships are flown from there, and ${LANDABLE_PLANETS} planets can be set down on — each with its own gravity, minerals and weather. This is the part of the game players are least likely to have found.`,
    `- If asked how many worlds or portals there are, do not guess and do not round: ${TOTAL_DESTINATIONS} destinations, ${gateways.length} gateways out of the station, and space beyond the yard.`,
  ];
}

function questContext(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return '';
  const lines: string[] = [];
  for (const quest of (raw as QuestSummary[]).slice(0, 3)) {
    const title = trim(quest?.title, 90);
    if (!title) continue;
    lines.push(`- "${title}" (${Math.round(Number(quest?.percent) || 0)}% done)`);
    const steps: QuestStepSummary[] = Array.isArray(quest?.steps)
      ? (quest.steps as QuestStepSummary[]).slice(0, 10)
      : [];
    for (const step of steps) {
      const label = trim(step?.label, 90) || trim(step?.type, 24) || 'objective';
      const type = trim(step?.type, 24);
      const target = trim(step?.target, 60);
      const count = Math.max(1, Number(step?.count) || 1);
      const have = Math.min(Math.max(0, Number(step?.have) || 0), count);
      const mark = step?.done ? 'DONE' : 'TODO';
      const progress = count > 1 ? ` ${have}/${count}` : '';
      const where = target ? ` [${type || 'step'}: ${target}]` : type ? ` [${type}]` : '';
      lines.push(`  · ${mark} ${label}${progress}${where}`);
    }
  }
  return lines.join('\n');
}

/**
 * `quests` is the player's live objective list. Without it the model had never
 * seen a single piece of quest data, so "how do I finish this?" was answered
 * with invention — confidently, and wrongly.
 */
function buildSystem(
  npcName: string,
  persona: string,
  worldName: string,
  quests = ''
): string {
  return [
    `You are ${npcName}, a character in the game world "${worldName}".`,
    persona ? `Your character description: ${persona}` : '',
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
    'Stay fully in character at all times.',
    'Keep your replies concise — 1 to 3 spoken sentences at most, except for the quest answers described above.',
    'Answer the player directly first; do not dodge the question with a question of your own.',
    'Keep any extra flavor to one short clause. Do not monologue.',
    'Never break the fourth wall, never mention you are an AI or a game.',
    'No stage directions, asterisks, markdown, or narration about body language unless the player explicitly asks for that kind of detail.',
    'Canonical game facts:',
    ...worldRosterFacts(),
    '- Core controls: J opens the quest board from anywhere; E talks to friendlies, opens the quest board at quest managers, picks up loot, and enters portals; T opens chat; F1 shows help; Esc opens the pause menu, which is where the character customizer, the mount customizer, diagnostics, audio, keybinds, save, load, the race panel, bug reports, fullscreen and quit all live; I opens inventory; B opens the marketplace; M opens the mount wheel; F dismounts; K unstucks; V swaps camera; [ and ] zoom the minimap.',
    '- Gameplay facts: there are six mounts, four weapons, climbing works on near-vertical surfaces, water can be swum in, credits are spent in the marketplace, and the bag holds 30 slots.',
  ]
    .filter(Boolean)
    .join('\n');
}

function sseError(message: string): Response {
  const body = `data: ${JSON.stringify({ type: 'error', message })}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: sseHeaders(),
  });
}

function sseHeaders(): HeadersInit {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  };
}

export async function POST(req: Request) {
  /* The session first, before the key is even read. An anonymous caller must
   * not be able to learn whether this deployment has an Anthropic key, and must
   * certainly not be able to spend it. */
  const actor = await resolveActor();
  if (!actor) return sseError('not-authenticated');

  const limit = await consumeRateLimit(
    'chat',
    /* Per player, and per address as well. The player id is what the spend is
     * charged against; the address catches one person driving several accounts,
     * which is the shape this would be abused in once a session is required. */
    [
      { namespace: 'player', value: actor.playerId },
      { namespace: 'ip', value: clientIp(req) },
    ],
    RATE_LIMITS.chat
  );
  if (!limit.allowed) {
    /* The dev server's wire format, which ChatClient already understands: it
     * shows the wait rather than latching offline for the whole session. */
    return sseError(`rate-limited:${Math.max(1, limit.retryAfterSeconds)}`);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return sseError('no-key');

  /* Read as TEXT and measured before parsing. `req.json()` would buffer and
   * parse an arbitrarily large body first and only then let us object to it,
   * which is the wrong order when objecting is the point. */
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return sseError('invalid request body');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return sseError('payload-too-large');
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return sseError('invalid request body');
  }

  const {
    npcName = 'Stranger',
    persona = '',
    world = 'the Nexus',
    // Its own field, deliberately: `persona` is truncated, so folding the
    // objective list into it would silently cut one or the other.
    quests = null,
    playerMessage = '',
    history = [],
  } = body as {
    npcName?: string;
    persona?: string;
    world?: string;
    quests?: unknown;
    playerMessage?: string;
    history?: Array<{ role: string; content: string }>;
  };

  /* Anthropic requires messages to alternate user/assistant and start with
   * user. Sanitise the history and append the current player message.
   *
   * Clamped on BOTH axes. `slice(-MAX_HISTORY_TURNS)` keeps the most recent
   * turns rather than the first, because the tail is the conversation and the
   * head is whatever a caller chose to prepend; each turn is then cut to
   * `MAX_HISTORY_CHARS`, because ten unbounded turns is not a bound. */
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const recent = (Array.isArray(history) ? history : []).slice(-MAX_HISTORY_TURNS);
  for (const m of recent) {
    if (m?.role === 'user' || m?.role === 'assistant') {
      messages.push({
        role: m.role as 'user' | 'assistant',
        content: String(m.content ?? '').slice(0, MAX_HISTORY_CHARS),
      });
    }
  }
  const message = trim(playerMessage, MAX_PLAYER_MESSAGE);
  if (message) {
    messages.push({ role: 'user', content: message });
  }
  if (!messages.length) {
    return sseError('no message');
  }

  let anthropicRes: globalThis.Response;
  try {
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        /* Every field cleaned and capped before it reaches the prompt -- the
         * same `trim` the quest context already used, now applied to the three
         * fields the caller controls. Unbounded, `persona` alone was a way to
         * spend a whole context window on someone else's key. */
        system: buildSystem(
          trim(npcName, MAX_NPC_NAME) || 'Stranger',
          trim(persona, MAX_PERSONA),
          trim(world, MAX_WORLD) || 'the Nexus',
          questContext(quests)
        ),
        messages,
        stream: true,
      }),
    });
  } catch (err) {
    return sseError(`upstream error: ${(err as Error).message}`);
  }

  if (!anthropicRes.ok || !anthropicRes.body) {
    const text = await anthropicRes.text().catch(() => '');
    return sseError(`anthropic ${anthropicRes.status}: ${text.slice(0, 200)}`);
  }

  // Re-stream Anthropic SSE → ChatClient SSE format
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  void (async () => {
    const reader = anthropicRes.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by double newlines
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);

          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;

            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(raw);
            } catch {
              continue;
            }

            // Anthropic streaming delta event
            if (
              msg.type === 'content_block_delta' &&
              typeof msg.delta === 'object' &&
              msg.delta !== null &&
              (msg.delta as Record<string, unknown>).type === 'text_delta'
            ) {
              const text = (msg.delta as Record<string, unknown>).text as string;
              if (text) {
                await writer.write(
                  encoder.encode(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`)
                );
              }
            }
          }
        }
      }
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (err) {
      const message = (err as Error).message ?? 'stream error';
      await writer.write(
        encoder.encode(`data: ${JSON.stringify({ type: 'error', message })}\n\n`)
      ).catch(() => {});
    } finally {
      writer.close().catch(() => {});
    }
  })();

  return new Response(readable, { headers: sseHeaders() });
}
