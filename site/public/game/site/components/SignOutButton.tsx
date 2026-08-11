'use client';

import { signOut } from 'next-auth/react';
import { useState } from 'react';

export default function SignOutButton({
  className = 'btn btn-ghost',
  label = 'Sign out',
}: {
  className?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signOut({ callbackUrl: '/' });
      }}
    >
      {busy ? 'Signing out…' : label}
    </button>
  );
}
