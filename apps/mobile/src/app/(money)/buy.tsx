import { router, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { SheetScreen } from '@/components/sheets/Sheet';
import { dexAssetId, fetchAllDexTokens, findDexToken } from '@/lib/dex-tokens';
import { tap } from '@/lib/haptics';
import { fetchSwapTokens, sameToken, swapRefForSymbol } from '@/lib/intents-swap';
import { leaveSheetTo } from '@/lib/navigation';
// import { isWeb } from '@/lib/platform';
import { COMING_SOON, SOON, SOON_OPACITY } from '@/lib/surface';
import { pickToken, swap } from '@/lib/swap';
import { useWalletRequired } from '@/lib/wallet-gate';
import { makeStyles, radius, useTheme } from '@/theme';

/** Buy (or sell) sheet: with cash, or by swapping what you already hold. */
// Needs a wallet; browsing visitors are taken to "Get started" first (lib/wallet-gate).
export default function BuySheetRoute() {
  const walletHere = useWalletRequired('buy crypto');
  return walletHere ? <BuySheet /> : null;
}

function BuySheet() {
  const { mode, symbol } = useLocalSearchParams<{ mode?: string; symbol?: string }>();
  const styles = useStyles();
  const c = useTheme();
  const selling = mode === 'sell';
  const what = symbol ?? 'crypto';

  // No card or bank provider is connected outside test mode yet: the option stays,
  // dimmed with Coming soon, and does nothing (lib/surface SOON). Swapping is live.
  const cashSoon = selling ? SOON.sellCash : SOON.buyCash;
  const allOptions: {
    icon: IconName;
    title: string;
    hint: string;
    soon?: boolean;
    onPress: () => void;
  }[] = [
    {
      icon: 'bank',
      title: selling ? 'Sell for cash' : 'Buy with cash',
      hint: cashSoon
        ? COMING_SOON
        : selling
          ? `Send ${what} to your bank account`
          : 'Use a debit card or bank account',
      soon: cashSoon,
      onPress: () =>
        router.replace({
          pathname: '/buy-cash',
          params: { ...(symbol ? { symbol } : {}), ...(selling ? { mode: 'sell' } : {}) },
        }),
    },
    {
      icon: 'trade',
      title: 'Swap tokens',
      hint: 'Trade using your existing balance',
      onPress: () => openSwap(selling ? undefined : symbol),
    },
  ];
  // review: no trading in the extension, so Swap (a link into /trade) is phone-only.
  // review: Swap is back in the extension.
  // const options = isWeb ? allOptions.filter((o) => o.icon !== 'trade') : allOptions;
  const options = allOptions;

  return (
    <SheetScreen title={selling ? `Sell ${what}` : `Buy ${what}`}>
      <View style={styles.options}>
        {options.map((o) => (
          <PressableScale
            key={o.title}
            accessibilityRole="button"
            accessibilityLabel={`${o.title}. ${o.hint}`}
            accessibilityState={{ disabled: !!o.soon }}
            disabled={o.soon}
            scaleTo={0.98}
            onPress={() => {
              tap();
              o.onPress();
            }}
            style={[styles.option, o.soon && styles.soon]}
          >
            <View style={styles.icon}>
              <Icon name={o.icon} size={22} color={c.accentText} />
            </View>
            <View style={styles.text}>
              <Text style={styles.title}>{o.title}</Text>
              <Text style={styles.hint}>{o.hint}</Text>
            </View>
            {o.soon ? null : <Icon name="chevronRight" size={13} color={c.textSecondary} />}
          </PressableScale>
        ))}
      </View>
    </SheetScreen>
  );
}

/**
 * Opens Swap; from a token page's Buy, with that token on the buy side (1Click's entry
 * for the symbol, lib/intents-swap `swapRefForSymbol`). The list is usually cached; if it
 * arrives after Swap opens, it's only applied while the buy side is still untouched, and
 * without it Swap keeps its last pair.
 */
function openSwap(buySymbol?: string) {
  if (buySymbol) {
    const before = swap.get().buy;
    fetchSwapTokens()
      .then(async (tokens) => {
        const ref = swapRefForSymbol(tokens, buySymbol);
        if (!sameToken(swap.get().buy, before)) return;
        if (ref) return pickToken('buy', ref);
        // Not on NEAR Intents: Honey's DEX route, paid with USDC on the token's chain.
        const dex = findDexToken(await fetchAllDexTokens(), buySymbol);
        if (!dex || !sameToken(swap.get().buy, before)) return;
        pickToken('sell', { symbol: 'USDC', chain: dex.chain });
        pickToken('buy', {
          symbol: dex.symbol,
          chain: dex.chain,
          assetId: dexAssetId(dex.chain, dex.address),
        });
      })
      .catch(() => {});
  }
  leaveSheetTo('/trade', { navigate: true });
}

const useStyles = makeStyles((c) => ({
  soon: { opacity: SOON_OPACITY },
  options: {
    gap: 10,
  },
  // Each way to buy or sell is its own card, so the sheet reads as a clear choice.
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    ...radius(20),
    backgroundColor: c.card,
  },
  text: {
    flex: 1,
  },
  title: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  hint: {
    marginTop: 3,
    color: c.textSecondary,
    fontSize: 14,
  },
  // Round icon wells, like Add wallet's rows.
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
}));
