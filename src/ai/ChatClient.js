/**
 * Streaming chat transport for NPC conversation.
 *
 * Talks to `POST /api/chat` (see `server/chat-server.js`) and parses the SSE
 * response. The backend is optional by design: if it is unreachable, returns a
 * non-stream, or reports `no-key`, we transparently fall back to a local
 * persona-driven generator so the feature always visibly works. Failures are
 * surfaced once as an "offline persona" flag rather than a stream of errors.
 */

const HISTORY_TURNS = 10; // player+npc pairs retained per NPC
const ENDPOINTS = ['/api/chat', 'http://127.0.0.1:8787/api/chat'];

export class ChatClient {
  /** @param {import('../core/EventBus.js').EventBus} bus */
  constructor(bus) {
    this.bus = bus;

    /** @type {Map<string, Array<{role:string, content:string}>>} */
    this._history = new Map();
    /** Endpoint that last worked; avoids re-probing every message. */
    this._endpoint = null;
    /** True once we have decided the backend is unavailable. */
    this.offline = false;
    /** Set when the server explicitly reported a missing API key. */
    this.reason = null;
    /** Remembers which template each NPC used last so replies never repeat verbatim. */
    this._lastPick = new Map();
    this._warned = false;
  }

  /** @returns {Array<{role:string, content:string}>} live history for an NPC. */
  history(npcId) {
    let h = this._history.get(npcId);
    if (!h) {
      h = [];
      this._history.set(npcId, h);
    }
    return h;
  }

  reset(npcId) {
    if (npcId == null) this._history.clear();
    else this._history.delete(npcId);
  }

  /**
   * Send a player line and stream the reply.
   * @param {any} npc            NPC object (`.id .name .persona`)
   * @param {string} text        player message
   * @param {{onToken?:(t:string)=>void, signal?:AbortSignal, world?:string}} opts
   * @returns {Promise<string>}  the complete reply text
   */
  async send(npc, text, { onToken, signal, world } = {}) {
    const npcId = npc?.id ?? 'unknown';
    const history = this.history(npcId);
    const worldName = world ?? npc?.worldId ?? npc?.world ?? 'the Nexus';

    this.bus?.emit('chat:npc-message', { npc, text: '', streaming: true });

    let reply = '';
    if (!this.offline) {
      try {
        reply = await this._sendRemote(
          { npcId, npcName: npc?.name ?? 'Stranger', persona: npc?.persona ?? '', world: worldName, playerMessage: text, history: history.slice(-HISTORY_TURNS * 2) },
          onToken,
          signal
        );
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        this._goOffline(err?.message);
        reply = '';
      }
    }

    if (!reply) {
      reply = await this._sendLocal(npc, text, worldName, onToken, signal);
    }

    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
    while (history.length > HISTORY_TURNS * 2) history.shift();

    this.bus?.emit('chat:npc-message', { npc, text: reply, streaming: false });
    return reply;
  }

  _goOffline(message) {
    this.offline = true;
    this.reason = message || 'unreachable';
    if (!this._warned) {
      this._warned = true;
      // One informational line only — never spam the console during play.
      console.info(`[ChatClient] backend unavailable (${this.reason}); using offline personas.`);
    }
  }

  /* ----------------------------------------------------------- transport -- */

  async _sendRemote(payload, onToken, signal) {
    const candidates = this._endpoint ? [this._endpoint] : ENDPOINTS.filter((u) => u[0] === '/' || location.protocol === 'http:');

    let lastError = null;
    for (const url of candidates) {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(payload),
          signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        lastError = err;
        continue;
      }

      if (!res.ok || !res.body) {
        lastError = new Error(`http ${res.status}`);
        continue;
      }
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/event-stream')) {
        // A dev server 404 page would land here; treat it as "no backend".
        lastError = new Error('not an sse stream');
        continue;
      }

      this._endpoint = url;
      return await this._readStream(res.body, onToken, signal);
    }

    throw lastError ?? new Error('no endpoint');
  }

  async _readStream(body, onToken, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let out = '';

    try {
      for (;;) {
        if (signal?.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let msg;
            try {
              msg = JSON.parse(raw);
            } catch {
              continue;
            }
            if (msg.type === 'delta' && msg.text) {
              out += msg.text;
              onToken?.(msg.text);
            } else if (msg.type === 'error') {
              throw new Error(msg.message || 'server error');
            }
          }
        }
      }
    } finally {
      try {
        reader.cancel();
      } catch {
        /* stream already closed */
      }
    }

    if (!out.trim()) throw new Error('empty stream');
    return out.trim();
  }

  /* -------------------------------------------------- offline generation -- */

  /** Renders the local reply with the same token-by-token cadence as the API. */
  async _sendLocal(npc, text, world, onToken, signal) {
    const reply = this._compose(npc, text, world);
    if (!onToken) return reply;

    const chunks = reply.match(/\S+\s*/g) ?? [reply];
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      onToken(chunks[i]);
      // Slightly irregular pacing reads as speech rather than a progress bar.
      await delay(26 + Math.random() * 44);
    }
    return reply;
  }

  /**
   * Persona-driven local response generator.
   * Classifies intent by keyword, then fills a template with facts drawn from
   * the NPC's own persona, name and world so lines stay in character.
   */
  _compose(npc, text, world) {
    const name = npc?.name ?? 'Stranger';
    const persona = npc?.persona ?? '';
    const hostile = npc?.type === 'hostile';
    const bits = personaBits(persona, name);
    const worldName = prettyWorld(world);
    const q = (text ?? '').toLowerCase();
    const intent = classify(q, hostile);
    const subject = keyNoun(text) || bits.role;

    const bank = TEMPLATES[intent] ?? TEMPLATES.default;
    const key = `${npc?.id ?? name}:${intent}`;
    const idx = this._pick(key, bank.length);
    const template = bank[idx];

    return template
      .replace(/\{name\}/g, name)
      .replace(/\{world\}/g, worldName)
      .replace(/\{role\}/g, bits.role)
      .replace(/\{trait\}/g, bits.trait)
      .replace(/\{creed\}/g, bits.creed)
      .replace(/\{subject\}/g, subject)
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Pick an index that is not the one used last time for this key. */
  _pick(key, length) {
    if (length <= 1) return 0;
    const last = this._lastPick.get(key);
    let idx = Math.floor(Math.random() * length);
    if (idx === last) idx = (idx + 1 + Math.floor(Math.random() * (length - 1))) % length;
    this._lastPick.set(key, idx);
    return idx;
  }
}

/* ====================================================================== */
/* Local persona engine                                                   */
/* ====================================================================== */

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const WORLD_NAMES = {
  station: 'Aether Station',
  medieval: 'Karnholt',
  sports: 'the Meridian Complex',
};

function prettyWorld(id) {
  if (!id) return 'the Nexus';
  return WORLD_NAMES[id] ?? id;
}

/**
 * Pull a role, a trait and a creed out of a free-text persona brief so the
 * offline lines still sound like the character the world author wrote.
 */
const ROLE_WORDS = [
  'engineer', 'mechanic', 'technician', 'quartermaster', 'dockmaster', 'pilot', 'medic',
  'guard', 'sentinel', 'marshal', 'ranger', 'scout', 'smith', 'blacksmith', 'baker',
  'farrier', 'herbalist', 'merchant', 'trader', 'innkeeper', 'knight', 'squire',
  'archivist', 'scholar', 'monk', 'bard', 'coach', 'referee', 'lifeguard', 'groundskeeper',
  'skater', 'instructor', 'trainer', 'analyst', 'courier', 'welder', 'botanist', 'cook',
];

const TRAIT_WORDS = [
  'gruff', 'weary', 'cheerful', 'nervous', 'sardonic', 'patient', 'restless', 'proud',
  'superstitious', 'meticulous', 'blunt', 'wry', 'kind', 'suspicious', 'devout', 'anxious',
  'brash', 'quiet', 'hopeful', 'bitter', 'curious', 'stoic', 'loud', 'sharp', 'gentle',
];

function personaBits(persona, name) {
  const lower = (persona || '').toLowerCase();
  let role = '';
  for (const w of ROLE_WORDS) {
    if (lower.includes(w)) {
      role = w;
      break;
    }
  }
  let trait = '';
  for (const w of TRAIT_WORDS) {
    if (lower.includes(w)) {
      trait = w;
      break;
    }
  }
  // First clause of the brief doubles as a personal creed the character can quote.
  let creed = '';
  const sentences = (persona || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length) {
    creed = sentences[sentences.length - 1]
      .replace(/^(they|he|she|it)\s+/i, '')
      .replace(/[.!?]+$/, '')
      .toLowerCase();
    if (creed.length > 90) creed = creed.slice(0, 88).replace(/\s\S*$/, '');
  }
  return {
    role: role || 'hand around here',
    trait: trait || 'careful',
    creed: creed || `there is always work to do, ${name.split(/\s+/)[0].toLowerCase()} sees to it`,
  };
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'you', 'your', 'yours',
  'me', 'my', 'mine', 'we', 'us', 'they', 'them', 'this', 'that', 'these', 'those', 'what',
  'when', 'where', 'why', 'how', 'who', 'can', 'could', 'would', 'should', 'will', 'about',
  'here', 'there', 'have', 'has', 'had', 'and', 'but', 'for', 'with', 'from', 'into', 'been',
  'tell', 'know', 'think', 'like', 'want', 'need', 'get', 'got', 'say', 'said', 'going',
]);

/** Echo a salient noun from the player's line so replies feel heard. */
function keyNoun(text) {
  const words = (text || '').toLowerCase().match(/[a-z][a-z'-]{3,}/g);
  if (!words) return '';
  for (let i = words.length - 1; i >= 0; i--) {
    if (!STOP_WORDS.has(words[i])) return words[i];
  }
  return '';
}

const INTENT_RULES = [
  ['greeting', /\b(hi|hey|hello|greetings|good (morning|day|evening)|howdy|yo|salutations)\b/],
  ['farewell', /\b(bye|goodbye|farewell|see ya|see you|later|i'?m off|take care)\b/],
  ['thanks', /\b(thanks|thank you|cheers|appreciate|much obliged)\b/],
  ['danger', /\b(danger|dangerous|enemy|enemies|hostile|attack|fight|kill|shoot|gun|weapon|safe|threat|raider|war)\b/],
  ['portal', /\b(portal|gate|gateway|nexus|travel|teleport|other world|another world|door)\b/],
  ['self', /\b(who are you|your name|about yourself|what do you do|your job|your work|you do here|tell me about you)\b/],
  ['world', /\b(this place|where am i|what is this|the station|the castle|the village|the complex|the world|around here|this world|history)\b/],
  ['help', /\b(help|quest|task|job|mission|need anything|assist|hand|favou?r|work)\b/],
  ['trade', /\b(buy|sell|trade|price|coin|credits|ammo|supplies|shop|barter)\b/],
  ['insult', /\b(idiot|stupid|shut up|useless|coward|fool|hate you)\b/],
  ['praise', /\b(nice|great|good job|impressive|beautiful|amazing|well done|love it)\b/],
];

function classify(q, hostile) {
  if (hostile) return 'hostile';
  for (const [intent, re] of INTENT_RULES) {
    if (re.test(q)) return intent;
  }
  if (/[?]/.test(q) || /^(what|why|how|where|when|who|do|does|can|is|are)\b/.test(q)) return 'question';
  return 'default';
}

/**
 * Several distinct lines per intent, each pulling different persona facts, so a
 * player who talks to the same NPC repeatedly never hears the same reply twice
 * in a row.
 */
const TEMPLATES = {
  greeting: [
    'Well met. Not many wander this far into {world} without a reason.',
    "Hey there. You caught me mid-shift — {trait} day, if I'm honest.",
    "{name}. Pleasure. Mind the footing around here, {world} bites the careless.",
    'Hello, traveller. Every face here is either lost or looking for something. Which are you?',
    "Good to see somebody upright and breathing. Welcome to {world}.",
  ],
  farewell: [
    'Go carefully. {world} does not forgive a wandering mind.',
    "Off already? Fine. If you find trouble, don't bring it back to my post.",
    'Safe roads. Come find me if you need a straight answer.',
    "Right then. Keep your head down and your hands where I can see them.",
  ],
  thanks: [
    "Don't thank me yet. Thank me when you're still standing tomorrow.",
    'Any time. Around here we look out for each other or we look out for nobody.',
    "Save it. Just remember the favour when I come calling.",
    "Hah. That's the friendliest thing I've heard all rotation.",
  ],
  danger: [
    "There's hostiles working the outer ground. Two rounds each and they stay down — mostly.",
    'Danger? Constant. I stopped counting the near-misses somewhere around the third one.',
    "Keep to the lit ground. Whatever's out past that has stopped pretending to be friendly.",
    "If you're going out there, go loud and go fast. Nothing here rewards a slow visitor.",
    "I've buried people who thought {world} was safe. Do not join them.",
  ],
  portal: [
    'The gateway? It hums when it likes you and it screams when it does not. Step through anyway.',
    "Nobody built the portals. They were simply here, and we learned to walk through them.",
    'Cross over and you land somewhere that plays by different rules. Same you, though. That is the hard part.',
    "The Nexus links three anchors. {world} is one. Where you go from here is your business.",
  ],
  self: [
    "{name}. I'm the {role} here, and I've been the {role} here longer than I'd like to admit.",
    "Me? {trait} {role}, mostly. {creed}.",
    "The name's {name}. {creed}. That's the whole story, more or less.",
    "I keep things running. {role} work is unglamorous until the day nobody does it.",
  ],
  world: [
    "{world}. Half of it works, half of it used to, and everyone's very calm about the difference.",
    "You're standing in {world}. It's older than the records claim, and the records already lie.",
    "This is {world}. Stay long enough and the place starts telling you its own stories.",
    "{world} runs on habit and stubbornness. Mostly stubbornness.",
  ],
  help: [
    "Help? Always. Whether I'd trust you with it is another question entirely.",
    "There's work if you want it. There's always work. {creed}.",
    "If you can carry, fix, or shoot, you'll be useful within the hour.",
    "Bring me anything about the {subject} and I'll consider us square.",
  ],
  trade: [
    "I'm no merchant, but I know who is — and I know which of them shorts you.",
    "Coin, credits, favours. Everything's currency somewhere in the Nexus.",
    'Supplies run thin here. Whatever the traders quote you, offer half.',
    "You want {subject}? Wrong pockets. Try the market side, and haggle.",
  ],
  insult: [
    "Charming. I've been called worse by better.",
    'That mouth is going to cost you a friend you actually need.',
    "Say what you like. I'll still be standing here when you come back needing something.",
    "Noted. I'll add it to the list.",
  ],
  praise: [
    "Kind of you. Don't let it get around, I have a reputation.",
    'Hah. Someone finally noticed. Took long enough.',
    "It holds together. That's about the highest praise anything here earns.",
  ],
  question: [
    "About the {subject}? I've heard three answers and I trust none of them.",
    "Straight answer: nobody really knows. Crooked answer: ask again after dark.",
    "The {subject}, is it? Sit with that one a while. It doesn't unravel quickly.",
    "I'd tell you, but half of what I know about the {subject} came from people who lied for sport.",
    "Ask around {world} and you'll get a different story from every mouth. Mine's no better.",
  ],
  hostile: [
    "You shouldn't be here.",
    'Last warning. Turn around.',
    "That's close enough.",
    'Wrong ground, wrong day.',
  ],
  default: [
    "Huh. Not the strangest thing said to me today, and that's the worrying part.",
    "The {subject}, right. Give me something more to work with and I'll give you something back.",
    "I hear you. {creed}, and that keeps me busy enough.",
    "Maybe. {world} has a way of making odd talk sound reasonable.",
    "You'll have to run that past me again — the machines here are loud and so am I.",
  ],
};
