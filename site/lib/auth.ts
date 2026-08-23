import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { getUserByEmail, getUserByGoogleId, createUser, getUserById, linkGoogleAccount, verifyPassword } from '@/lib/db';
import { sendWelcomeEmail } from '@/lib/email';
import { getPlayerStatus, syncPlayerProfile } from '@/lib/playerDb';
import { verifyTotp } from '@/lib/totp';
import { readTotpSecret } from '@/lib/db';

export const { handlers, signIn, signOut, auth } = NextAuth({
  secret: process.env.NEXTAUTH_SECRET ?? process.env.APP_SECRET ?? 'dev-secret-change-me',
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
        code: { label: 'Authenticator code', type: 'text' },
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

        /* The second factor, which this function did not ask for until now.
         *
         * `totp_enabled` was set by the setup flow, the account page rendered
         * "2FA is enabled on your account", and sign-in never read either
         * column - so the control was decorative. Anyone who turned it on was
         * told they had a second factor and had exactly one, their password.
         *
         * Deliberately AFTER the password check, so a wrong password and a
         * wrong code are indistinguishable from outside; asking for a code only
         * once the password is right would tell an attacker when they had
         * guessed it. */
        if (user.totp_enabled) {
          const secret = readTotpSecret(user);
          if (!secret || !verifyTotp(secret, code)) return null;
        }

        return { id: user.id, email: user.email, name: user.email.split('@')[0] };
      },
    }),
  ],

  session: { strategy: 'jwt' },

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
      if (user?.id) token.sub = user.id;
      return token;
    },

    async session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub;
        const user = await getUserById(token.sub);
        if (user) session.user.email = user.email;
        if (user?.email) {
          const profile = await getPlayerStatus(token.sub);
          session.user.name = profile?.handle ?? profile?.fullName ?? user.email.split('@')[0];
        }
      }
      return session;
    },
  },
});
