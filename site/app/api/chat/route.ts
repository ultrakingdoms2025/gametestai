/**
 * POST /api/chat
 *
 * Streaming NPC chat powered by Anthropic Claude.
 *
 * Accepts: { npcId, npcName, persona, world, playerMessage, history }
 *   history: Array<{ role: 'user'|'assistant', content: string }>
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
const MAX_TOKENS = 256;

function buildSystem(npcName: string, persona: string, worldName: string): string {
  return [
    `You are ${npcName}, a character in the game world "${worldName}".`,
    persona ? `Your character description: ${persona}` : '',
    'Stay fully in character at all times.',
    'Keep your replies concise — 1 to 3 spoken sentences at most.',
    'Answer the player directly first; do not dodge the question with a question of your own.',
    'Keep any extra flavor to one short clause. Do not monologue.',
    'Never break the fourth wall, never mention you are an AI or a game.',
    'No stage directions, asterisks, markdown, or narration about body language unless the player explicitly asks for that kind of detail.',
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
    playerMessage = '',
    history = [],
  } = body as {
    npcName?: string;
    persona?: string;
    world?: string;
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
        system: buildSystem(String(npcName), String(persona), String(world)),
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
