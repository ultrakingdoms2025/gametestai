import { auth } from '@/lib/auth';
import RedeemPanel from '@/components/RedeemPanel';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Redeem an access code — AETHER NEXUS',
  description: 'Turn an access code into full access to every world.',
};

/**
 * Where a code is turned into access.
 *
 * Signed-in state is resolved on the SERVER and handed down, rather than read in
 * the panel with `useSession`. The panel's whole first impression depends on the
 * answer — "Redeem code" versus "Continue" and a sign-in prompt — and a client
 * hook resolves it a beat after paint, so the page would flicker through the
 * signed-out copy for anyone who is already signed in. That flicker is
 * particularly bad here: it tells a returning player they need an account they
 * already have.
 */
export default async function RedeemPage() {
  const session = await auth();
  return (
    <main className="auth-shell">
      <RedeemPanel signedIn={!!session?.user?.id} />
    </main>
  );
}
