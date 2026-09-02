import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  /**
   * The token generation this session was issued under.
   *
   * A JWT is self-contained, so nothing the server does to a row reaches a
   * token already sitting in someone's cookie jar — a password reset did not
   * sign the attacker out, and neither did enabling or disabling 2FA. This
   * number is stamped in at sign-in and compared against
   * `site_users.session_epoch` on every session read; every credential change
   * bumps the column, which is what makes "sign every device out" possible at
   * all. See `lib/auth.ts` and the column's comment in `lib/db.ts`.
   */
  interface JWT {
    epoch?: number;
  }
}
