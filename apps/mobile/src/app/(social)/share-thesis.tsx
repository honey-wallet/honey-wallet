import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { JarIcon } from '@/components/jars/JarParts';
import { PressableScale } from '@/components/motion/PressableScale';
import { SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { leaveSheetTo } from '@/lib/navigation';
import { jarValue, useThesisJars } from '@/lib/thesis';
import { makeStyles, radius, useTheme } from '@/theme';

/**
 * Sharing a thesis is sharing a jar (2026-11-13): make a new one, or post one you
 * already have with the words it leads with. Replaces the old free-text composer.
 */
export default function ShareThesisSheet() {
  const styles = useStyles();
  const c = useTheme();
  const mine = useThesisJars().filter((j) => j.mine && !j.groupId);
  return (
    <SheetScreen title="Share a thesis">
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Create a jar. Turn an idea into tokens, then post it."
        scaleTo={0.98}
        onPress={() => {
          tap();
          leaveSheetTo('/jar-create');
        }}
        style={styles.create}
      >
        <View style={styles.well}>
          <Icon name="plus" size={20} color={c.accentText} />
        </View>
        <View style={styles.flex}>
          <Text style={styles.title}>Create a jar</Text>
          <Text style={styles.hint}>Turn an idea into tokens, then post it.</Text>
        </View>
        <Icon name="chevronRight" size={12} color={c.textSecondary} />
      </PressableScale>

      {/* Hidden until you have one: no "nothing here" filler. */}
      {mine.length ? (
        <View style={styles.section}>
          <Text style={styles.heading}>Or share one of yours</Text>
          {mine.map((jar) => (
            <SheetRow
              key={jar.id}
              leading={<JarIcon jar={jar} size={36} />}
              title={jar.name}
              subtitle={jar.visibility === 'public' ? 'On the Feed' : 'Only you see it'}
              value={formatUsd(jarValue(jar))}
              accessory="chevron"
              onPress={() => {
                tap();
                router.replace({ pathname: '/jar-post', params: { id: jar.id } });
              }}
            />
          ))}
        </View>
      ) : null}
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  create: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    ...radius(20),
    backgroundColor: c.card,
  },
  well: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  title: { color: c.text, fontSize: 17, fontWeight: '600' },
  hint: { marginTop: 2, color: c.textSecondary, fontSize: 14, lineHeight: 19 },
  section: { marginTop: 24, gap: 4 },
  heading: { color: c.textSecondary, fontSize: 15, marginBottom: 6 },
}));
