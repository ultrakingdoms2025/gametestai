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
   * @param {{onToken?:(t:string)=>void, signal?:AbortSignal, world?:string,
   *          quests?:Array<object>|null}} opts  `quests` is
   *   `QuestSystem.summary()` — the player's in-progress objectives, so the
   *   model can answer "how do I finish this" instead of inventing an answer.
   * @returns {Promise<string>}  the complete reply text
   */
  async send(npc, text, { onToken, signal, world, quests } = {}) {
    const npcId = npc?.id ?? 'unknown';
    const history = this.history(npcId);
    const worldName = world ?? npc?.worldId ?? npc?.world ?? 'the Nexus';
    const questList = Array.isArray(quests) ? quests : [];

    this.bus?.emit('chat:npc-message', { npc, text: '', streaming: true });

    let reply = '';
    if (!this.offline) {
      try {
        reply = await this._sendRemote(
          {
            npcId,
            npcName: npc?.name ?? 'Stranger',
            persona: npc?.persona ?? '',
            world: worldName,
            // Own field, not folded into `persona`: that one is cut at 700
            // characters by both chat backends.
            quests: questList,
            playerMessage: text,
            history: history.slice(-HISTORY_TURNS * 2),
          },
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
      reply = await this._sendLocal(npc, text, worldName, onToken, signal, questList);
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
  async _sendLocal(npc, text, world, onToken, signal, quests = []) {
    const reply = this._compose(npc, text, world, quests);
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
  _compose(npc, text, world, quests = []) {
    const name = npc?.name ?? 'Stranger';
    const persona = npc?.persona ?? '';
    const hostile = npc?.type === 'hostile';
    const bits = personaBits(persona, name);
    const worldName = prettyWorld(world);
    const q = (text ?? '').toLowerCase();
    const intent = classify(q, hostile);
    const subject = keyNoun(text) || bits.role;

    /* A player with no API key used to get "Help? Always." when they asked how
     * to finish a quest — a canned line from the `help` template bank, which
     * matches on the word "quest" and then says nothing about one. The offline
     * generator now reads the same summary the remote prompt gets, so the one
     * question a quest-blind fallback most obviously fails at is answered from
     * real data. Hostiles are excluded: they are not a hint system.
     * Checked before `_gameFactReply` because "how do I …" hits that too. */
    if (!hostile) {
      const questReply = questClue(q, quests);
      if (questReply) return questReply.replace(/\{name\}/g, name).replace(/\{world\}/g, worldName);
    }

    const factReply = this._gameFactReply(q);
    if (factReply) return factReply.replace(/\{name\}/g, name).replace(/\{world\}/g, worldName);

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

  _gameFactReply(q) {
    if (/\b(how many|count|number of)\b/.test(q) && /\b(portal|gate|gateway|world|worlds)\b/.test(q)) {
      return 'There are five worlds in the Nexus. Aether Station is the hub and has four outbound portals; each of the other four worlds has one return portal.';
    }
    if (/\b(portal|gate|gateway)\b/.test(q)) {
      return 'The Nexus has five worlds: Aether Station, Medieval Valley, Meridian Athletic Grounds, Sunspire Citadel, and Vellum Ridge (three race circuits: Vellum Ridge Circuit, Cinder Gorge, and Aurora Rise, which has a 360 loop). Station is the hub; the other four worlds each have one return portal.';
    }
    if (/\b(how do i|how do you|controls|key|keys|button|buttons|move|play|do i)\b/.test(q)) {
      return 'J opens the quest board anywhere; E talks to friendlies, picks up loot, and enters portals; T opens chat; F1 shows help; I opens inventory; B opens the marketplace; K unstucks.';
    }
    if (/\b(worlds?|places?|where is|where do|what is in)\b/.test(q)) {
      return 'The Nexus has five worlds: Aether Station, Medieval Valley, Meridian Athletic Grounds, Sunspire Citadel, and Vellum Ridge (three race circuits: Vellum Ridge Circuit, Cinder Gorge, and Aurora Rise, which has a 360 loop).';
    }
    return '';
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

/* ---------------------------------------------------------------- quests -- */

/**
 * Asking about a quest, as opposed to asking how to walk.
 *
 * Two tiers rather than one loose pattern. A bare "how do I …" is far more
 * often a controls question — `_gameFactReply` answers those — so the phrase
 * only counts here when the player also named a quest-shaped noun. The second
 * tier catches the ways a player asks "what now" without ever using the word.
 */
const QUEST_NOUN_RE = /\b(quest|quests|objective|objectives|mission|missions|task|tasks|assignment|errand|bounty|contract)\b/;
const QUEST_NEXT_RE = /\b(what (do|should) i do next|what(?:'s| is) next|what next|what now|where (do|should) i go( next)?|what am i (supposed to|meant to) do)\b/;

/** A target id like `nexus_shard` reads as prose once the underscores go. */
function readable(target) {
  return String(target ?? '').replace(/[_-]+/g, ' ').trim();
}

/**
 * An in-character CLUE for one quest step — what to go and do, not a
 * numbered walkthrough. Falls back to the step's own label, which is the
 * author's own words for it.
 */
function stepClue(step) {
  const what = readable(step?.target);
  const label = String(step?.label ?? '').trim();
  switch (step?.type) {
    case 'kill':
      return what ? `Something needs putting down — ${what}. They don't come quietly.` : 'There is killing to be done, and it will not do itself.';
    case 'collect':
      return what ? `You're short on ${what}. It does not walk to you; go where it falls.` : 'You are short on salvage. Look where things break.';
    case 'visit':
      return what ? `You have not set foot in ${prettyWorld(step.target)} yet. The portals are how.` : 'There is ground you have not walked yet.';
    case 'talk':
      return what ? `${what} is the one to ask. Find them and open your mouth.` : 'Somebody here is waiting to be spoken to.';
    case 'interact':
      return what ? `${what} — put your hands on it. E does the rest.` : 'Something out there wants handling, not looking at.';
    case 'purchase':
      return what ? `The market has ${what}. Credits talk; B opens the stalls.` : 'The market has what you need. B opens the stalls.';
    case 'race':
      return what ? `${what}. Get in and drive it, and mind that finishing is the point — quitting halfway counts for nothing.` : 'A circuit is waiting. Finishing is the part that counts.';
    case 'survive':
      return 'Stay on your feet and stay untouched. The moment something lands a hit, that clock starts again.';
    case 'customize':
      return 'Change your own look first — F2 opens that.';
    default:
      return label ? `It comes down to this: ${label.toLowerCase()}.` : 'The board words it better than I can.';
  }
}

/**
 * Offline quest answer, or '' to let the persona templates handle the line.
 *
 * @param {string} q lower-cased player message
 * @param {Array<object>} quests `QuestSystem.summary()`
 */
function questClue(q, quests) {
  const asked = QUEST_NOUN_RE.test(q) || QUEST_NEXT_RE.test(q);
  if (!asked) return '';

  const list = Array.isArray(quests) ? quests : [];
  if (!list.length) {
    // Still useful: it names the thing the player could not find, which is the
    // whole reason the board got a hotkey.
    return 'Nothing on your slate that I can see. Press J — the board lists what is going, wherever you happen to be standing.';
  }

  const quest = list[0];
  const step = quest?.steps?.find((s) => !s.done);
  if (!step) {
    return `"${quest?.title ?? 'That job'}" is as good as done — every part of it is behind you. Go and collect on it.`;
  }

  const progress = step.count > 1 ? ` You are ${step.have} of ${step.count} in.` : '';
  const elsewhere = step.world && quest.world && step.world !== quest.world
    ? ` And not here — that part is in ${prettyWorld(step.world)}.`
    : '';
  const more = list.length > 1 ? ` You have ${list.length} jobs running, mind.` : '';
  return `"${quest.title}" is the one still open. ${stepClue(step)}${progress}${elsewhere}${more}`;
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
    "About the {subject}? Best answer I can give is this: nobody agrees, but I can tell you what people here say.",
    "About the {subject}: the plain version is that nobody really knows for certain.",
    "The {subject} is messy, but the shortest honest answer is that it changes depending on who you ask.",
    "I'd rather be clear than clever: what I know about the {subject} is part fact, part rumor.",
    "Ask around {world} and you'll get different stories. Mine is only one of them.",
  ],
  hostile: [
    "You shouldn't be here.",
    'Last warning. Turn around.',
    "That's close enough.",
    'Wrong ground, wrong day.',
  ],
  default: [
    "I hear you. If you want the short version, say so and I'll keep it brief.",
    "The {subject}? I can talk about that, but I need a clearer question.",
    "Understood. {creed}, and that keeps me busy enough.",
    "Maybe. {world} has a way of making odd talk sound reasonable.",
    "Say it again in plain words and I’ll give you a plain answer.",
  ],
};
