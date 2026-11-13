import { router } from 'expo-router';
import { api } from '@/lib/api';
import { backendSessionToken } from '@/lib/backend-session';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Onboarding's last step once you're signed in: pick an @handle, if you have none yet.
 * Runs after sign-in lands (the session can take a moment to arrive). Says nothing when
 * the server can't be reached; Settings still has "Claim handle".
 */
export async function offerHandle() {
  // After the landing (and any page you were headed to) is in place, so this sits on top.
  await wait(400);
  for (let i = 0; i < 20 && !backendSessionToken(); i++) await wait(250);
  const token = backendSessionToken();
  if (!token) return;
  try {
    if (await api.socialMe(token)) return;
  } catch {
    return;
  }
  router.push('/handle');
}
