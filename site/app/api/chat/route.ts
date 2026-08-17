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
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    '- The Nexus has six worlds: Aether Station, Aldermoor Vale (Medieval Valley), Meridian Athletic Grounds, Sunspire Citadel, Vellum Ridge (which carries three circuits — Vellum Ridge Circuit, Cinder Gorge and Aurora Rise), and The Verdant Coil.',
    '- Aether Station is the hub world and has five outbound portals to the other five worlds.',
    '- Each of the other five worlds has one return portal back to Aether Station.',
    '- If asked how many portals exist, do not guess: say there are six worlds / five destinations from the Nexus hub, and note that the station itself has five outbound gates.',
    '- Core controls: J opens the quest board from anywhere; E talks to friendlies, opens the quest board at quest managers, picks up loot, and enters portals; T opens chat; F1 shows help; F2 customizes the character; F3 opens diagnostics; F4 opens audio; F5 saves; F6 rebinds; F7 opens the race panel; F9 reports a bug; I opens inventory; B opens the marketplace; M opens the mount wheel; F dismounts; K unstucks; V swaps camera; [ and ] zoom the minimap.',
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return sseError('no-key');

  let body: Record<string, unknown>;
  try {
    body = await req.json();
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

  // Anthropic requires messages to alternate user/assistant and start with user.
  // Sanitise the history and append the current player message.
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of Array.isArray(history) ? history : []) {
    if (m?.role === 'user' || m?.role === 'assistant') {
      messages.push({ role: m.role as 'user' | 'assistant', content: String(m.content ?? '') });
    }
  }
  if (playerMessage) {
    messages.push({ role: 'user', content: String(playerMessage) });
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
        system: buildSystem(
          String(npcName),
          String(persona),
          String(world),
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
