import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { SHEET, SheetRowSkeletons, SheetScreen } from '@/components/sheets/Sheet';
import { PersonJarRow } from '@/components/social/PersonJarRow';
import { BOARD_RANGES, type BoardRange, RANGE_WINDOW, rangeLine, rankFor } from '@/lib/board';
import { tap } from '@/lib/haptics';
import { openSocialJar, useBoard } from '@/lib/social';
import { useTheme } from '@/theme';

/**
 * The Leaderboard's "+N more": the ranks the map had no room for, from `from` on, as
 * flat rows like Find people's (rank, face, name and jar, line, return) for the same
 * range, with no title. A row opens its jar; the face or name, the profile.
 */
export default function BoardMoreSheet() {
  const c = useTheme();
  const { range: raw = 'week', from: at = '0' } = useLocalSearchParams<{
    range: string;
    from: string;
  }>();
  const range: BoardRange = (BOARD_RANGES as readonly string[]).includes(raw)
    ? (raw as BoardRange)
    : 'week';
  const from = Math.max(0, Number(at) || 0);
  const { jars: loaded } = useBoard(RANGE_WINDOW[range]);
  const jars = useMemo(
    () => (loaded ? rankFor(range, loaded).slice(from) : null),
    [loaded, range, from],
  );
  return (
    <SheetScreen scroll>
      {!jars ? (
        <SheetRowSkeletons count={4} />
      ) : (
        jars.map((jar, i) => {
          const value = jar.periodReturn ?? jar.returnSincePublish;
          return (
            <PersonJarRow
              key={jar.id}
              jar={jar}
              rank={from + i + 1}
              value={value}
              line={rangeLine(jar, range, value)}
              last={i === jars.length - 1}
              gutter={SHEET.gutter}
              ring={c.sheet}
              onPress={() => {
                tap();
                router.push({ pathname: '/jar/[id]', params: { id: openSocialJar(jar) } });
              }}
            />
          );
        })
      )}
    </SheetScreen>
  );
}
