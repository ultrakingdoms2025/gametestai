import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { getUserByEmail, getUserByGoogleId, createUser, getUserById, linkGoogleAccount, verifyPassword } from '@/lib/db';
import { getPlayerStatus, syncPlayerProfile } from '@/lib/playerDb';

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
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === 'string' ? credentials.email : '';
        const password = typeof credentials?.password === 'string' ? credentials.password : '';
        if (!email || !password) return null;

        const user = await getUserByEmail(email);
        if (!user) return null;
        if (!user.password_hash) return null; // Google-only account

        const ok = await verifyPassword(user, password);
        if (!ok) return null;

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
          }
          if (user.id) {
            await syncPlayerProfile(user.id, email, {
              handle: displayName,
              fullName: displayName,
              autoAdjustHandle: true,
              overwrite: false,
            });
            user.name = displayName;
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
