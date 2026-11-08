import type { User } from 'firebase/auth';
import { onAuthStateChanged } from 'firebase/auth';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { IDENTITY_ENABLED } from '@/lib/identity';
import { identityAuth } from '@/lib/identity-client';

type IdentityState = { loaded: boolean; user: User | null };

const IdentityContext = createContext<IdentityState>({ loaded: !IDENTITY_ENABLED, user: null });

/** The signed-in Firebase user, if any (screens read it through `useIdentity`). */
export const useIdentityState = () => useContext(IdentityContext);

/**
 * Firebase Auth, when this build is configured for it. Its session is kept encrypted on
 * this device (lib/session-storage.ts); wallet secrets live in the vault, never here.
 */
export function IdentityProvider({ children }: { children: ReactNode }) {
  if (!IDENTITY_ENABLED) return children;
  return <FirebaseIdentity>{children}</FirebaseIdentity>;
}

function FirebaseIdentity({ children }: { children: ReactNode }) {
  const [state, setState] = useState<IdentityState>({ loaded: false, user: null });
  // Fires once with the stored session (or none), then on every sign-in and sign-out.
  useEffect(
    () => onAuthStateChanged(identityAuth(), (user) => setState({ loaded: true, user })),
    [],
  );
  return <IdentityContext.Provider value={state}>{children}</IdentityContext.Provider>;
}
