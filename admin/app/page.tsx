import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export default async function Root() {
  const session = await getSession();
  redirect(session.adminId ? '/dashboard' : '/login');
}