/**
 * What an access code IS: its alphabet, how one is minted, how a typed one is
 * put back into canonical form, and what gets stored instead of the code.
 *
 * -- This file exists TWICE, byte for byte --------------------------------
 *
 * `site/lib/accessCodeFormat.ts` and `admin/lib/accessCodeFormat.ts` are the
 * same file. They have to be: the admin app MINTS a code and stores its digest,
 * the site app takes what a player typed and looks that digest up, and if the
 * two ever disagree about a single character -- whether `O` folds to `0`, what
 * the hash is salted with, how long the body is -- then every code the admin
 * hands out is a code the site cannot find, and the failure looks exactly like
 * a customer mistyping.
 *
 * Two Next apps, two deployments, two `node_modules`, no shared package: there
 * is no import that reaches from one to the other. So the copy is deliberate,
 * and `accessCodes.test.ts` reads both files off disk and fails if a single
 * byte differs. A duplicated file with a gate is honest; a duplicated file
 * without one is the drift this repository has paid for before.
 *
 * That is also why this file imports nothing but `node:crypto`. The moment it
 * reaches for a database client, a config helper or an env var, the two copies
 * stop being interchangeable and the equality test starts failing for reasons
 * that have nothing to do with the code format.
 */
import { createHash, randomInt } from 'node:crypto';

/**
 * Crockford base32: the digits and the capitals, less `I`, `L`, `O` and `U`.
 *
 * `I`/`L`/`O` come out because they are what people mistype for `1` and `0`
 * when reading a code off a Discord message or a printed card, and
 * `normalizeAccessCode` below folds them back rather than rejecting them. `U`
 * comes out because excluding it is what keeps a random 12-character string
 * from spelling something the recipient screenshots.
 */
export const ACCESS_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The human-facing prefix. Not entropy -- it is there so a code LOOKS like one. */
export const ACCESS_CODE_PREFIX = 'AN';

/**
 * Random characters per code: 12, over a 32-letter alphabet, so 60 bits.
 *
 * The threat is somebody hammering `/api/redeem` with guesses, not somebody
 * with the digest and a GPU -- the digest never leaves the database. At 60 bits
 * a guessing run makes about one hit per 10^18 attempts, which is not a rate
 * limiter's problem, and 12 characters is still short enough to read down a
 * phone line.
 */
export const ACCESS_CODE_BODY_LENGTH = 12;

/** Characters between the dashes when a code is shown to a human. */
export const ACCESS_CODE_GROUP = 4;

/**
 * The fixed access window, in days, that `players.access_granted_at` is
 * measured against.
 *
 * It is NOT a policy this module gets to choose. `site/lib/playerDb.ts`
 * (`ACCESS_DAYS`) and `admin/lib/playerAccess.ts` (`ACCESS_WINDOW_DAYS`) both
 * derive an expiry as `access_granted_at + 30 days`, and a code that grants
 * days does it by moving that one timestamp -- so this constant has to equal
 * theirs or a "30-day" code grants some other number of days. The test suite
 * scrapes all three and fails if they diverge.
 */
export const ACCESS_WINDOW_DAYS = 30;

/** What a code buys. */
export const ACCESS_CODE_KINDS = ['play', 'server'] as const;
export type AccessCodeKind = (typeof ACCESS_CODE_KINDS)[number];

export function isAccessCodeKind(value: unknown): value is AccessCodeKind {
  return typeof value === 'string' && (ACCESS_CODE_KINDS as readonly string[]).includes(value);
}

/** `AN-7Q2K-4M8P-XR3T` from a bare 12-character body. */
export function formatAccessCode(body: string): string {
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += ACCESS_CODE_GROUP) {
    groups.push(body.slice(i, i + ACCESS_CODE_GROUP));
  }
  return [ACCESS_CODE_PREFIX, ...groups].join('-');
}

/**
 * A new code, formatted for handing to a person.
 *
 * `randomInt` rather than `randomBytes(n)[i] % 32`: the modulo of a byte over a
 * 32-letter alphabet happens to be unbiased, but only because 256 divides by
 * 32, and the next person to widen the alphabet by one character would inherit
 * a skew nobody would think to look for. `randomInt` is rejection-sampled by
 * Node and stays correct whatever the alphabet becomes.
 */
export function mintAccessCode(): string {
  let body = '';
  for (let i = 0; i < ACCESS_CODE_BODY_LENGTH; i++) {
    body += ACCESS_CODE_ALPHABET[randomInt(0, ACCESS_CODE_ALPHABET.length)];
  }
  return formatAccessCode(body);
}

/** The alphabet as a character class, derived so it cannot drift from the string. */
const BODY_RE = new RegExp(`^[${ACCESS_CODE_ALPHABET}]{${ACCESS_CODE_BODY_LENGTH}}$`);

/**
 * The canonical 12-character body of whatever a human typed, or `null`.
 *
 * Accepts the code with or without its `AN-` prefix, with any spacing or
 * dashes, in any case, and folds the three letters the alphabet excludes for
 * being mistypeable (`I`/`L` to `1`, `O` to `0`). A recipient reading a code
 * off a card should not lose 30 days to a serif.
 *
 * -- Why the prefix is dropped by LENGTH and not by `startsWith` ----------
 *
 * `A` and `N` are both in the alphabet, so a body can legitimately begin `AN`
 * -- and stripping a leading `AN` unconditionally would eat two characters of
 * entropy from one code in 1024 and turn it into a permanent "invalid code"
 * for the person holding it. The prefix is therefore removed only when what
 * remains is exactly a body's worth of characters, which is the one case where
 * it cannot have been part of the body.
 */
export function normalizeAccessCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (
    text.length === ACCESS_CODE_BODY_LENGTH + ACCESS_CODE_PREFIX.length &&
    text.startsWith(ACCESS_CODE_PREFIX)
  ) {
    text = text.slice(ACCESS_CODE_PREFIX.length);
  }
  return BODY_RE.test(text) ? text : null;
}

/**
 * The digest stored in `access_codes.code_hash`, or `null` for an unusable code.
 *
 * A code is a bearer credential -- whoever holds the characters gets the grant
 * -- so the characters are not what the lookup table is keyed on, in the same
 * spirit as `site_password_resets.token_hash`. (The admin app additionally
 * keeps the code encrypted under `ENCRYPTION_KEY` so an operator can re-read a
 * code they have already handed out; that is a separate, decryptable copy for
 * a human, not the thing redemption matches against.)
 *
 * Domain-separated with a fixed label because this database is full of other
 * SHA-256 digests -- `players.email_hash` among them -- and a bare `sha256(x)`
 * shared between two purposes is a lookup that can be crossed. Changing this
 * label invalidates every code ever issued, which is why it is a constant here
 * and not something assembled from config.
 */
const HASH_LABEL = 'aether-nexus:access-code:v1';

export function hashAccessCode(raw: unknown): string | null {
  const body = normalizeAccessCode(raw);
  if (!body) return null;
  return createHash('sha256').update(`${HASH_LABEL}:${body}`).digest('hex');
}

/**
 * The part of a code shown in listings -- `AN-7Q2K-...`.
 *
 * Enough to tell two rows apart at a glance, not enough to redeem. The admin
 * dashboard can decrypt and reveal the whole code deliberately; a hint is what
 * it renders when nobody has asked it to.
 */
export function accessCodeHint(body: string): string {
  return `${ACCESS_CODE_PREFIX}-${body.slice(0, ACCESS_CODE_GROUP)}-...`;
}

/**
 * What marks a hosting slot as one somebody was GIVEN rather than sold.
 *
 * Lives here, in the file both apps share, rather than only in
 * `site/lib/premium.ts` where the rest of the entitlement vocabulary is,
 * because both apps have to derive the same string: the site writes the slot
 * when a code is redeemed, and the admin app expires that same slot when an
 * operator claws the code back. A prefix agreed in two places is a claw-back
 * button that quietly revokes nothing.
 */
export const COMP_PREFIX = 'comp_';

/**
 * The subscription id of the hosting slot a `server` code funds.
 *
 * Derived from the code rather than random, which is what makes redeeming
 * idempotent: the same code redeemed twice by the same player upserts one slot
 * row instead of minting a second server. Two different codes derive two ids
 * and therefore two slots, which is also right -- two comps are two servers.
 *
 * Truncated to half a SHA-256 because this id is read by humans in an admin
 * listing, and because the slot table keys it per player anyway, so the digest
 * only has to distinguish one operator's codes from each other.
 */
export function compSubscriptionId(codeHash: string): string {
  return `${COMP_PREFIX}sub_${String(codeHash).slice(0, 32)}`;
}
