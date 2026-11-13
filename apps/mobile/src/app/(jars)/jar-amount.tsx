import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Old links to the amount step: "How much?" is now thesis-new's 'proposal' step, the one
 * amount screen every jar passes through. A copy (`copy` = its id) or your own picks
 * (`manual`, the tokens waiting in chatDraft) carry over. Replaces itself, so Back
 * returns to wherever this opened from.
 */
export default function JarAmountRedirect() {
  const { copy, manual } = useLocalSearchParams<{ copy?: string; manual?: string }>();
  return (
    <Redirect
      href={{
        pathname: '/thesis-new',
        params: { step: 'proposal', ...(copy ? { copy } : manual ? { manual } : {}) },
      }}
    />
  );
}
