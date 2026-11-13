import { router } from 'expo-router';
import { useRef } from 'react';
import { Text, View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { FadeOut, LinearTransition } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { TokenStack } from '@/components/jars/JarParts';
import { PressableScale } from '@/components/motion/PressableScale';
import { SheetRow } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import type { Pick } from '@/lib/thesis';
import type { HistoryRow } from '@/lib/thesis-history';
import { tokenColor } from '@/lib/token-colors';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

const asPicks = (symbols: string[]): Pick[] =>
  symbols.map((symbol, i) => ({
    symbol,
    name: symbol,
    chain: '',
    weight: 0,
    match: 'direct',
    reason: '',
    color: tokenColor(symbol, i),
  }));

/** Opens a past chat on its saved answer. */
export const openChat = (row: { runId: string; text: string }) =>
  router.push({ pathname: '/thesis-chat', params: { run: row.runId, said: row.text } });

/**
 * One past chat with the Thesis agent: its picks' logos, the idea, when, and what it
 * found. With `onDelete`, swiping it left shows Delete.
 */
export function ChatRow({ row, onDelete }: { row: HistoryRow; onDelete?: () => void }) {
  const styles = useStyles();
  const c = useTheme();
  const swipe = useRef<SwipeableMethods>(null);
  const content = (
    <View style={styles.rowBack}>
      <SheetRow
        leading={
          row.symbols.length ? (
            <TokenStack picks={asPicks(row.symbols)} size={30} ring={c.canvas} />
          ) : (
            <View style={styles.well}>
              <Icon name="chat" size={16} color={c.accentText} />
            </View>
          )
        }
        title={row.title}
        subtitle={row.subtitle}
        accessory="chevron"
        onPress={() => openChat(row)}
      />
    </View>
  );
  if (!onDelete) return content;
  return (
    <Animated.View
      exiting={FadeOut.duration(DURATION.fast)}
      layout={LinearTransition.duration(DURATION.medium)}
    >
      <ReanimatedSwipeable
        ref={swipe}
        friction={1.6}
        rightThreshold={40}
        overshootRight={false}
        renderRightActions={() => (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Delete ${row.title}`}
            scaleTo={0.96}
            onPress={() => {
              tap();
              swipe.current?.close();
              onDelete();
            }}
            style={styles.delete}
          >
            <Icon name="trash" size={18} color={WHITE} />
            <Text style={styles.deleteText}>Delete</Text>
          </PressableScale>
        )}
      >
        {content}
      </ReanimatedSwipeable>
    </Animated.View>
  );
}

/** Delete's words on its red, the same in light and dark. */
const WHITE = '#FFFFFF';

const useStyles = makeStyles((c) => ({
  rowBack: { backgroundColor: c.canvas },
  well: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  delete: {
    width: 84,
    marginVertical: 6,
    marginLeft: 8,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: c.error,
  },
  deleteText: { color: WHITE, fontSize: 13, fontWeight: '600' },
}));
