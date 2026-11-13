import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { SheetRow, SheetRowSkeletons, SheetScreen } from '@/components/sheets/Sheet';
import { TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { holdingsOf, loadProfile, useSocial } from '@/lib/social';

/**
 * What someone holds, from the token logos by their name on a profile: every token in
 * their public jars and theses, heaviest first, with its share. Tap one for its page.
 */
export default function HoldsSheet() {
  const { handle: raw = '' } = useLocalSearchParams<{ handle: string }>();
  const handle = raw.replace(/^@/, '').toLowerCase();
  const profile = useSocial().profiles[handle];
  const holds = useMemo(() => (profile ? holdingsOf(profile) : null), [profile]);

  // Opened from a link rather than the profile: fetch them.
  useEffect(() => {
    if (!profile && handle) void loadProfile(handle).catch(() => {});
  }, [profile, handle]);

  return (
    <SheetScreen title={`@${handle} holds`} scroll>
      {!holds ? (
        <SheetRowSkeletons count={4} />
      ) : (
        holds.map((t) => (
          <SheetRow
            key={t.symbol}
            leading={<TokenIcon symbol={t.symbol} size={36} />}
            title={t.symbol}
            value={`${Math.round(t.share * 100)}%`}
            accessory="chevron"
            onPress={() => {
              tap();
              router.push({ pathname: '/token/[symbol]', params: { symbol: t.symbol } });
            }}
          />
        ))
      )}
    </SheetScreen>
  );
}
