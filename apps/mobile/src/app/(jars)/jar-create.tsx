import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { requireWallet } from '@/lib/wallet-gate';
import { makeStyles, radius, useTheme } from '@/theme';

/** The two ways to make a jar, from Jars' Create jar button. */
const WAYS: { icon: IconName; title: string; hint: string; to: '/thesis-chat' | '/jar-build' }[] = [
  {
    icon: 'chat',
    title: 'Describe an idea',
    hint: 'Tell Honey what you believe; it finds what to buy.',
    to: '/thesis-chat',
  },
  {
    icon: 'pie',
    title: 'Pick tokens',
    hint: 'Choose the tokens and the split yourself.',
    to: '/jar-build',
  },
];

export default function JarCreateSheet() {
  const styles = useStyles();
  const c = useTheme();
  return (
    <SheetScreen title="Create a jar">
      <View style={styles.ways}>
        {WAYS.map((way) => (
          <PressableScale
            key={way.to}
            accessibilityRole="button"
            accessibilityLabel={`${way.title}. ${way.hint}`}
            scaleTo={0.98}
            onPress={() => {
              tap();
              if (!requireWallet('make a jar', way.to)) return;
              router.replace(way.to);
            }}
            style={styles.way}
          >
            <View style={styles.well}>
              <Icon name={way.icon} size={20} color={c.accentText} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.title}>{way.title}</Text>
              <Text style={styles.hint}>{way.hint}</Text>
            </View>
            <Icon name="chevronRight" size={12} color={c.textSecondary} />
          </PressableScale>
        ))}
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  ways: { gap: 10 },
  way: {
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
}));
