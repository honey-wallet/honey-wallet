import type { SocialJar } from '@honey-wallet/api-client';

/**
 * The jars a profile's P&L is made of: the ones its owner owns. A group jar they're in
 * (listed on their profile) is the group creator's, and follows that one's privacy.
 */
export const pnlJars = (profile: { handle: string; jars: SocialJar[] } | null | undefined) =>
  profile?.jars.filter((j) => j.owner.handle === profile.handle);

/** A profile's P&L line when there's none: hidden by its owner, or just no jars yet. */
export const noPnlText = (jars: SocialJar[] | undefined) =>
  jars?.some((j) => j.returnsHidden) ? 'P&L is private' : 'No P&L yet';
