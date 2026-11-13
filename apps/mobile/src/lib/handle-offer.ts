import { router } from 'expo-router';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A saved Honey session may still be resuming (a phone that has signed in before). */
const resuming = () => {
  const s = backendSession.get();
  return s.busy || s.resumeAvailable;
};

let offering = false;

/**
 * Onboarding's last step once you're signed in: pick an @handle, if you have none yet.
 * Without one you have no profile, so nobody can find or follow you in Search.
 *
 * Runs after Apple, Google or email sign-in, and again after the wallet sign-in. The
 * first only makes the account: the Honey session a handle is claimed with comes from
 * the wallet sign-in (your own tap and Face ID). So with no session (a new account) this
 * opens that sign-in, and its success offers the handle. Nothing is claimed for you:
 * both screens can be closed, and Settings still has "Claim handle". Says nothing when
 * the server can't be reached.
 */
export async function offerHandle() {
  if (offering) return;
  offering = true;
  try {
    // After the landing (and any page you were headed to) is in place, so this sits on top.
    await wait(400);
    for (let i = 0; i < 20 && !backendSessionToken() && resuming(); i++) await wait(250);
    const token = backendSessionToken();
    if (!token) {
      router.push('/wallet-sign-in');
      return;
    }
    try {
      if (await api.socialMe(token)) return;
    } catch {
      return;
    }
    router.push('/handle');
  } finally {
    offering = false;
  }
}
