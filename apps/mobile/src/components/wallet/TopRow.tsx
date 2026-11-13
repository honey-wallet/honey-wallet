// Unused since 14 Nov (cleanup): only the commented-out TopTitle/SearchPill used these.
// import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
// import { Icon } from '@/components/Icon';
// import { PressableScale } from '@/components/motion/PressableScale';
import { HeaderIconButton } from '@/components/wallet/parts';
import { WalletButton } from '@/components/wallet/WalletButton';
// import { tap } from '@/lib/haptics';
// useTheme: unused since 14 Nov (cleanup), see above.
import { makeStyles } from '@/theme';

/** The row's height: Search's field, the Search pill and a big title all fit it. */
export const TOP_ROW_HEIGHT = 48;

/**
 * The one top row every main screen shares (Feed, Search, Swap, Jars): your wallet's
 * face, then `center` (a search field, a Search pill or a big title) filling the middle,
 * then `right` (shortcuts, the balance and settings). Same height, gaps and space under
 * it everywhere; the screen gives the side gutters.
 */
export function TopRow({
  center,
  right,
  onBack,
  title,
}: {
  center?: ReactNode;
  right?: ReactNode;
  /** A page you came to (Swap, Jars): a Back chevron in place of your face. */
  onBack?: () => void;
  /** With `onBack`: the page's name, centred like a navigation bar. */
  title?: string;
}) {
  const styles = useStyles();
  if (onBack)
    return (
      <View style={styles.row}>
        {title ? (
          <View pointerEvents="none" style={styles.titleCenter}>
            <Text style={styles.navTitle} numberOfLines={1} accessibilityRole="header">
              {title}
            </Text>
          </View>
        ) : null}
        <HeaderIconButton bare icon="chevronLeft" label="Back" onPress={onBack} />
        <View style={styles.center}>{center}</View>
        {right}
      </View>
    );
  return (
    <View style={styles.row}>
      <WalletButton />
      <View style={styles.center}>{center}</View>
      {right}
    </View>
  );
}

// Unused since 14 Nov (cleanup): nothing imports it.
// /** A screen's name as the row's middle, left-aligned and big, like Wallet's name. */
// export function TopTitle({ children }: { children: string }) {
//   const styles = useStyles();
//   return (
//     <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
//       {children}
//     </Text>
//   );
// }

// Unused since 14 Nov (cleanup): nothing imports it.
// /** A search field look-alike that opens Search (the Feed's middle). */
// export function SearchPill({ label = 'Search' }: { label?: string }) {
//   const styles = useStyles();
//   const c = useTheme();
//   return (
//     <PressableScale
//       accessibilityRole="search"
//       accessibilityLabel="Search people, jars and tokens"
//       scaleTo={0.98}
//       onPress={() => {
//         tap();
//         router.navigate('/search');
//       }}
//       style={styles.search}
//     >
//       <Icon name="search" size={18} color={c.textSecondary} />
//       <Text style={styles.searchText}>{label}</Text>
//     </PressableScale>
//   );
// }

const useStyles = makeStyles((c) => ({
  row: {
    minHeight: TOP_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  center: { flex: 1, minWidth: 0 },
  titleCenter: {
    position: 'absolute',
    left: 56,
    right: 56,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navTitle: { color: c.text, fontSize: 17, fontWeight: '600' },
  title: { color: c.text, fontSize: 30, fontWeight: '600', letterSpacing: -0.6 },
  // SearchField's shape (48pt, fully round, the card fill), as a button.
  search: {
    height: TOP_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    borderRadius: TOP_ROW_HEIGHT / 2,
    backgroundColor: c.card,
  },
  searchText: { color: c.placeholder, fontSize: 17 },
}));
