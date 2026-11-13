import { useEffect } from 'react';
import { FollowingEmpty } from '@/components/social/FindPeople';
import { PushedScreen, SCREEN } from '@/components/wallet/parts';
import { loadLeaderboard, social, useSocialMe } from '@/lib/social';

/**
 * Search's People to follow → See all: the Following tab's Find people (faces, then Who to
 * follow), on its own page. Signed out it's the same; Follow asks you to sign in first.
 */
export default function FindPeopleScreen() {
  const { signedIn } = useSocialMe();
  // Its suggestions are the Feed's shelf: fetch it if nothing has yet.
  useEffect(() => {
    if (!social.get().leaderboard) void loadLeaderboard();
  }, []);
  return (
    <PushedScreen
      title="People to follow"
      fallback="/search"
      contentStyle={{ paddingHorizontal: SCREEN.gutter }}
    >
      <FollowingEmpty signedIn={signedIn} />
    </PushedScreen>
  );
}
