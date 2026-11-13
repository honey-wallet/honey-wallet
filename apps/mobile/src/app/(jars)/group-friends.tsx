import { router } from 'expo-router';
import { useState } from 'react';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, SheetScreen, SheetSection } from '@/components/sheets/Sheet';
import { PersonResult } from '@/components/social/FeedSections';
import { SocialAvatar } from '@/components/social/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { MAX_FRIENDS } from '@/lib/group-jar-core';
import { friendPicks } from '@/lib/group-jars';
import { tap } from '@/lib/haptics';
import { type SocialProfileCard, useSocial } from '@/lib/social';
import { showToast } from '@/lib/toast';
import { makeStyles } from '@/theme';

/**
 * Launch's "Add friends": find people by @handle and tick up to 4. Done takes them back
 * to "Who's in"; nothing is sent until the jar is launched.
 */
export default function GroupFriendsSheet() {
  const styles = useStyles();
  const { me } = useSocial();
  const picked = friendPicks.useValue();
  const [query, setQuery] = useState('');
  const toggle = (who: SocialProfileCard) => {
    tap();
    const on = picked.some((p) => p.handle === who.handle);
    if (!on && picked.length >= MAX_FRIENDS) {
      showToast(`Up to ${MAX_FRIENDS} friends`);
      return;
    }
    friendPicks.set(on ? picked.filter((p) => p.handle !== who.handle) : [...picked, who]);
  };
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
      {picked.length > 0 && !query.trim() ? (
        <>
          <SheetSection title="Added" />
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

const useStyles = makeStyles(() => ({
  search: { marginBottom: 8 },
}));
