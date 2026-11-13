import type { SocialGroup } from '@honey-wallet/api-client';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, SheetScreen, SheetSection } from '@/components/sheets/Sheet';
import { FACE, FaceRow, FaceTile } from '@/components/social/FaceTile';
import { PersonResult } from '@/components/social/FeedSections';
import { SocialAvatar } from '@/components/social/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { api } from '@/lib/api';
import { backendSessionToken } from '@/lib/backend-session';
import { MAX_FRIENDS } from '@/lib/group-jar-core';
import { friendPicks, groups } from '@/lib/group-jars';
import { tap } from '@/lib/haptics';
import { type SocialProfileCard, useSocial } from '@/lib/social';
import { showToast } from '@/lib/toast';
import { makeStyles } from '@/theme';

/** At most this many faces in each row. */
const PER_ROW = 16;

/**
 * Launch's "Add friends": find people by @handle and tick up to 4. Under the search, two
 * rows of faces: Recent (the friends you've shared group jars with lately) and Followers
 * & following. Done takes them back to "Who's in"; nothing is sent until the jar is
 * launched.
 */
export default function GroupFriendsSheet() {
  const styles = useStyles();
  const { me } = useSocial();
  const picked = friendPicks.useValue();
  const [query, setQuery] = useState('');
  const { recent, network } = useSuggestions(me?.handle);
  const isPicked = (who: SocialProfileCard) => picked.some((p) => p.handle === who.handle);
  const toggle = (who: SocialProfileCard) => {
    tap();
    const on = isPicked(who);
    if (!on && picked.length >= MAX_FRIENDS) {
      showToast(`Up to ${MAX_FRIENDS} friends`);
      return;
    }
    friendPicks.set(on ? picked.filter((p) => p.handle !== who.handle) : [...picked, who]);
  };
  const searching = query.trim().length > 0;
  return (
    <SheetScreen
      title="Add friends"
      scroll
      sticky={
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search by @handle"
          autoFocus
          style={styles.search}
        />
      }
      footer={<PillButton label="Done" onPress={() => router.back()} />}
    >
      {searching ? null : (
        <>
          <FaceSection title="Recent" people={recent} isPicked={isPicked} onToggle={toggle} />
          <FaceSection
            title="Followers & following"
            people={network}
            isPicked={isPicked}
            onToggle={toggle}
          />
        </>
      )}
      {picked.length > 0 && !searching ? (
        <>
          <SheetSection title="Added" style={styles.label} />
          {picked.map((p) => (
            <SheetRow
              key={p.handle}
              leading={<SocialAvatar who={p} size={40} />}
              title={p.displayName}
              subtitle={`@${p.handle}`}
              accessory="check"
              selected
              checked
              onPress={() => toggle(p)}
            />
          ))}
        </>
      ) : null}
      <PersonResult
        query={query}
        onPick={toggle}
        picked={picked.map((p) => p.handle)}
        exclude={me ? [me.handle] : []}
      />
    </SheetScreen>
  );
}

/** One row of faces under its label; nothing at all when there's no one to show. */
function FaceSection({
  title,
  people,
  isPicked,
  onToggle,
}: {
  title: string;
  people: SocialProfileCard[];
  isPicked: (who: SocialProfileCard) => boolean;
  onToggle: (who: SocialProfileCard) => void;
}) {
  const styles = useStyles();
  if (!people.length) return null;
  return (
    <>
      <SheetSection title={title} style={styles.label} />
      <FaceRow>
        {people.map((who) => (
          <FaceTile
            key={who.handle}
            face={<SocialAvatar who={who} size={FACE} />}
            label={who.displayName}
            sublabel={`@${who.handle}`}
            badge={isPicked(who) ? 'check' : undefined}
            accessibilityLabel={`${isPicked(who) ? 'Remove' : 'Add'} @${who.handle}`}
            onPress={() => onToggle(who)}
          />
        ))}
      </FaceRow>
    </>
  );
}

/**
 * Who to suggest. Recent: people from your group jars, newest group first. Followers &
 * following: your followers, then people you follow, leaving out anyone already in
 * Recent. Once each, never you, at most PER_ROW a row. Each list loads on its own; one
 * failing just leaves its people out.
 */
function useSuggestions(myHandle: string | undefined) {
  const local = groups.useValue();
  const [remote, setRemote] = useState<SocialGroup[]>([]);
  const [network, setNetwork] = useState<SocialProfileCard[]>([]);
  useEffect(() => {
    let live = true;
    const token = backendSessionToken();
    if (token) {
      api
        .socialMyGroups(token)
        .then((list) => {
          if (live) setRemote(list);
        })
        .catch(() => {});
    }
    if (myHandle) {
      Promise.all([
        api.socialFollowers(myHandle).catch(() => [] as SocialProfileCard[]),
        api.socialFollowing(myHandle).catch(() => [] as SocialProfileCard[]),
      ]).then(([followers, following]) => {
        if (live) setNetwork([...followers, ...following]);
      });
    }
    return () => {
      live = false;
    };
  }, [myHandle]);

  const byGroup = new Map<string, SocialGroup>();
  for (const g of [...Object.values(local), ...remote]) byGroup.set(g.id, g);
  const fromGroups = [...byGroup.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((g) => [g.creator, ...g.members].filter((m) => !('isMe' in m && m.isMe)));

  const seen = new Set<string>(myHandle ? [myHandle] : []);
  const pick = (list: SocialProfileCard[]) => {
    const out: SocialProfileCard[] = [];
    for (const who of list) {
      if (!who?.handle || seen.has(who.handle)) continue;
      seen.add(who.handle);
      // Only the card's own fields: group members carry their state and payment too.
      out.push({ handle: who.handle, displayName: who.displayName, avatarSeed: who.avatarSeed });
      if (out.length >= PER_ROW) break;
    }
    return out;
  };
  const recent = pick(fromGroups);
  return { recent, network: pick(network) };
}

const useStyles = makeStyles((c) => ({
  search: { marginBottom: 8 },
  // Room between a row's label and its faces; semibold in the text colour (white in
  // dark mode), so it stands apart from the names under the faces.
  label: { marginBottom: 16, color: c.text, fontWeight: '600' },
}));
