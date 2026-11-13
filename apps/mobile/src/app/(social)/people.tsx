import type { SocialProfileCard } from '@honey-wallet/api-client';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { SheetRow, SheetRowSkeletons, SheetScreen } from '@/components/sheets/Sheet';
import { SocialAvatar } from '@/components/social/parts';
import { EmptyState } from '@/components/wallet/parts';
import { api } from '@/lib/api';
import { tap } from '@/lib/haptics';
import { socialError } from '@/lib/social';
import { makeStyles } from '@/theme';

/** Someone's followers, or who they follow. Tap a person for their profile. */
export default function PeopleSheet() {
  const styles = useStyles();
  const { handle = '', kind = 'followers' } = useLocalSearchParams<{
    handle: string;
    kind?: 'followers' | 'following';
  }>();
  const [people, setPeople] = useState<SocialProfileCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = kind === 'following' ? api.socialFollowing : api.socialFollowers;
    load(handle)
      .then(setPeople)
      .catch((e) => setError(socialError(e)));
  }, [handle, kind]);

  return (
    <SheetScreen title={kind === 'following' ? `@${handle} follows` : `@${handle}’s followers`}>
      {error ? (
        <EmptyState icon="refresh" title="Couldn’t load" hint={error} compact />
      ) : !people ? (
        <SheetRowSkeletons count={4} />
      ) : people.length ? (
        people.map((who) => (
          <SheetRow
            key={who.handle}
            leading={<SocialAvatar who={who} size={40} />}
            title={who.displayName}
            subtitle={`@${who.handle}`}
            accessory="chevron"
            onPress={() => {
              tap();
              router.push({ pathname: '/u/[handle]', params: { handle: who.handle } });
            }}
          />
        ))
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {kind === 'following' ? 'Not following anyone yet.' : 'No followers yet.'}
          </Text>
        </View>
      )}
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  empty: { paddingVertical: 24, alignItems: 'center' },
  emptyText: { color: c.textSecondary, fontSize: 15 },
}));
