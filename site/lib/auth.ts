import NextAuth, { type NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import {
  consumeRecoveryCode,
  createUser,
  getUserByEmail,
  getUserByGoogleId,
  getUserById,
  linkGoogleAccount,
  looksLikeRecoveryCode,
  verifyPassword,
} from '@/lib/db';
import { sendWelcomeEmail } from '@/lib/email';
import { getPlayerStatus, syncPlayerProfile } from '@/lib/playerDb';
import { verifyTotp } from '@/lib/totp';
import { readTotpSecret } from '@/lib/db';
import { appSecret } from '@/lib/appSecret';

/**
 * Sessions.
 *
 * ── The secret is no longer allowed to be a constant from this repository ──
 *
 * This file used to open with
 *
 *     secret: process.env.NEXTAUTH_SECRET ?? process.env.APP_SECRET ?? 'dev-secret-change-me'
 *
 * so a deployment that had not been given the variable signed and verified its
 * session tokens with a string published in the repository — which is not a
 * degraded mode, it is "anyone can mint a valid session for any account,
 * including an administrator's". `appSecret()` refuses instead. See
 * `lib/appSecret.ts` for why the floor is 32 characters and why the throw is at
 * the point of use rather than at import.
 *
 * That is also why the config is built by a function rather than being a
 * literal: `NextAuth()` accepts `(request) => config` and calls it per request,
 * so a missing secret fails the requests that need one — with the reason in the
 * server log — instead of taking the whole deployment down at import time,
 * including the pages that need no session at all. It is the same choice
 * `admin/proxy.ts` documents.
 *
 * ── Tokens now expire, and can be invalidated ─────────────────────────────
 *
 * `strategy: 'jwt'` with no `maxAge` meant a session token was good for
 * NextAuth's default 30 days, and — because a JWT is self-contained — nothing
 * the server did to a row could reach one. Resetting a password did not sign
 * the attacker out. Neither did enabling 2FA, nor disabling it.
 *
 * So `site_users.session_epoch` is stamped into the token at sign-in and
 * compared on every session read; every credential change bumps it (see
 * `setPassword`, `setTotpSecret`, `promoteTotpSecret`, `clearTotp`). A bumped
 * epoch is "sign every device out", which is what a password reset always
 * implied and never did. `maxAge` is seven days on top of that, because a
 * revocation check is not a substitute for tokens that expire.
 *
 * The comparison costs nothing extra: the session callback was already loading
 * the user row on every request to refresh the email and handle.
 */

/** A week. Long enough not to be a nuisance, short enough to bound a theft. */
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7;

const config: NextAuthConfig = {
  debug: process.env.NODE_ENV === 'development',

  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      authorization: { params: { prompt: 'consent', access_type: 'offline', response_type: 'code' } },
    }),

    Credentials({
      name: 'Email & Password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        code: { label: 'Authenticator or recovery code', type: 'text' },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === 'string' ? credentials.email : '';
        const password = typeof credentials?.password === 'string' ? credentials.password : '';
        const code = typeof credentials?.code === 'string' ? credentials.code : '';
        if (!email || !password) return null;

        const user = await getUserByEmail(email);
        if (!user) return null;
        if (!user.password_hash) return null; // Google-only account

        const ok = await verifyPassword(user, password);
        if (!ok) return null;

        /* The second factor, which this function did not ask for until the
         * TOTP module was split out.
         *
         * `totp_enabled` was set by the setup flow, the account page rendered
         * "2FA is enabled on your account", and sign-in never read either
         * column - so the control was decorative. Anyone who turned it on was
         * told they had a second factor and had exactly one, their password.
         *
         * Deliberately AFTER the password check, so a wrong password and a
         * wrong code are indistinguishable from outside; asking for a code only
         * once the password is right would tell an attacker when they had
         * guessed it.
         *
         * A RECOVERY CODE IS ACCEPTED IN THE SAME FIELD. Before they existed,
         * a lost phone was a permanent lockout and the only way back in was
         * Google sign-in on the same address - which this file did not check
         * against `totp_enabled`, so the escape hatch was a 2FA bypass and the
         * lockout was what made people reach for it. The two are one problem
         * and this is half of the fix; the Google half is in `signIn` below.
         *
         * The shape tells the two apart: a TOTP token is exactly six digits, a
         * recovery code is ten characters that are not all digits. Neither
         * shape is a secret, so choosing between them leaks nothing, and a
         * recovery code is consumed by the attempt - `consumeRecoveryCode`
         * marks it used in the same UPDATE that matches it, so it is genuinely
         * single-use even against two simultaneous attempts. */
        if (user.totp_enabled) {
          if (looksLikeRecoveryCode(code)) {
            if (!(await consumeRecoveryCode(user.id, code))) return null;
          } else {
            const secret = readTotpSecret(user);
            if (!secret || !verifyTotp(secret, code)) return null;
          }
        }

        return { id: user.id, email: user.email, name: user.email.split('@')[0] };
      },
    }),
  ],

  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_S },

  pages: {
    signIn: '/login',
    error: '/login',
  },

  callbacks: {
    async signIn({ user, account, profile }) {
      // Google sign-in: upsert user in our DB
      if (account?.provider === 'google' && profile?.email) {
        try {
          const googleId = typeof profile.sub === 'string' ? profile.sub : String(profile.sub ?? '');
          const email = profile.email.toLowerCase().trim();
          const displayName = typeof profile.name === 'string' && profile.name.trim()
            ? profile.name.trim()
            : email.split('@')[0];

          // Check by email first, then by Google ID
          let existing = await getUserByEmail(email);
          let createdNow = false;
          if (!existing && googleId) {
            existing = await getUserByGoogleId(googleId);
          }

          /* GOOGLE IS NOT A WAY PAST THE SECOND FACTOR.
           *
           * `authorize()` above enforces TOTP; this callback never did. So for
           * any account that had both a password and a Google link, "sign in
           * with Google" was a one-click bypass of the 2FA that account had
           * deliberately turned on — the second factor was enforced on the door
           * with the lock and not on the one beside it.
           *
           * ── Why refuse here rather than ask for a code ────────────────────
           *
           * There is nowhere to ask. The OAuth callback is a redirect with no
           * form in it, so "require a second step" would mean inventing a
           * pending-sign-in state and a page to consume it, and until that
           * exists the honest options are refuse or allow. Refusing is the one
           * that matches what the user asked for when they enabled 2FA.
           *
           * ── Why this cannot lock anybody out ─────────────────────────────
           *
           * It only refuses accounts that have a PASSWORD as well, and those
           * accounts have a working way in that honours the second factor:
           * email, password, and a TOTP or recovery code. An account with 2FA
           * and no password is left alone, because for that account Google is
           * the only credential there is and refusing would be a permanent
           * lockout — the exact failure recovery codes exist to prevent. That
           * state cannot be created any more (`/api/auth/setup-2fa` will not
           * enrol an account with no password), so it is a legacy case, and it
           * is logged when it is hit.
           *
           * Google's own account security still applies to those users; what
           * they do not get is OUR second factor, and the log line says so. */
          if (existing?.totp_enabled) {
            if (existing.password_hash) {
              console.warn(
                `[auth] refused Google sign-in for ${existing.id}: the account has `
                + 'two-factor authentication enabled. Sign in with the password and a code.'
              );
              return '/login?error=TwoFactorRequired';
            }
            console.warn(
              `[auth] account ${existing.id} has 2FA enabled and no password, so `
              + 'Google remains its only credential and the second factor cannot be '
              + 'enforced. It should set a password and re-enrol.'
            );
          }

          if (existing) {
            if (!existing.google_id && googleId) {
              await linkGoogleAccount(existing.id, googleId);
            }
            user.id = existing.id;
          } else {
            const created = await createUser({ email, googleId: googleId || undefined });
            user.id = created.id;
            createdNow = true;
          }
          if (user.id) {
            await syncPlayerProfile(user.id, email, {
              handle: displayName,
              fullName: displayName,
              autoAdjustHandle: true,
              overwrite: false,
            });
            user.name = displayName;
            if (createdNow) {
              try {
                await sendWelcomeEmail(email, displayName);
              } catch (err) {
                console.error('[auth] Failed to send OAuth welcome email:', err);
              }
            }
          }
        } catch (err) {
          // Log full error detail to Vercel function logs
          console.error('[auth] Google signIn DB error:', err instanceof Error ? err.message : String(err));
          // Redirect to login with a specific error code (not generic AccessDenied)
          return '/login?error=ServiceUnavailable';
        }
      }
      return true;
    },

    async jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id;
        /* Stamped once, at sign-in. Read on every session check against the
         * row's current value; see the `session` callback. Reading it here on
         * every request instead would be a second query per request for a
         * number the session callback is already fetching the row for. */
        const row = await getUserById(user.id);
        token.epoch = row?.session_epoch ?? 1;
      }
      return token;
    },

    async session({ session, token }) {
      if (token.sub) {
        const user = await getUserById(token.sub);

        /* THE REVOCATION CHECK.
         *
         * A missing row is an account that has been deleted; a moved epoch is a
         * password reset, a 2FA enrolment or a 2FA removal since this token was
         * issued. Either way the token is no longer evidence of anything, and
         * the whole app decides "signed in?" by `session?.user?.id`, so
         * clearing that id is what makes the refusal effective everywhere at
         * once. `expires` is dated into the past as well, so the client-side
         * session provider drops it rather than re-rendering a signed-in header
         * over a server that disagrees. */
        const stale = !user || Number(token.epoch ?? 0) !== Number(user.session_epoch ?? 1);
        if (stale) {
          session.user = { ...session.user, id: '', email: '' } as typeof session.user;
          session.expires = new Date(0).toISOString() as typeof session.expires;
          return session;
        }

        session.user.id = token.sub;
        session.user.email = user.email;
        const profile = await getPlayerStatus(token.sub);
        session.user.name = profile?.handle ?? profile?.fullName ?? user.email.split('@')[0];
      }
      return session;
    },
  },
};

/**
 * Built per request, so `appSecret()` throws where it can be reported rather
 * than at import. Everything else is the module-level `config` above; only the
 * secret has to be late.
 */
export const { handlers, signIn, signOut, auth } = NextAuth(() => ({
  ...config,
  secret: appSecret(),
}));
