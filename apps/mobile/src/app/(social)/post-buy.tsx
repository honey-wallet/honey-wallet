import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { JarAmount } from '@/components/jars/JarAmount';
import { SheetScreen } from '@/components/sheets/Sheet';
import { tokensProposal } from '@/components/social/parts';
import { TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import type { Chain } from '@/lib/mock-wallet';
import { updateSwap } from '@/lib/swap';
import { chatDraft } from '@/lib/thesis-chat';
import { makeStyles } from '@/theme';

/** Feed amounts are a tap, not a plan: smaller quick picks than a jar's. */
const PRESETS = [25, 50, 100];

/**
 * "Buy" a token from a post (the Feed, a profile, a token page): how much, with the
 * keypad, then Swap with the amount in (paid in USDC on Base).
 *
 * Params: `symbol`+`chain`. Older links with `jar` (a jar's id on this phone) or `tokens`
 * (`SYM:Chain,SYM:Chain` from a thesis, with `title`) go on to "How much?" (thesis-new),
 * the amount screen every jar passes through, replacing this one so Back returns to the post.
 */
export default function PostBuySheet() {
  const styles = useStyles();
  const params = useLocalSearchParams<{
    symbol?: string;
    chain?: string;
    jar?: string;
    tokens?: string;
    title?: string;
  }>();
  // A thesis's tokens wait in chatDraft, set once before the redirect.
  const [tokens] = useState(() => {
    if (params.jar || params.symbol || !params.tokens) return false;
    const list = params.tokens
      .split(',')
      .filter(Boolean)
      .map((t) => {
        const [symbol = '', chain = ''] = t.split(':');
        return { symbol, chain };
      });
    chatDraft.set(tokensProposal(list, params.title));
    return true;
  });

  if (params.jar)
    return (
      <Redirect
        href={{ pathname: '/thesis-new', params: { step: 'proposal', copy: params.jar } }}
      />
    );
  if (tokens)
    return (
      <Redirect href={{ pathname: '/thesis-new', params: { step: 'proposal', manual: '1' } }} />
    );

  const symbol = params.symbol ?? '';
  return (
    <SheetScreen title="How much?" size="fill">
      <JarAmount
        header={
          <View style={styles.what}>
            <TokenIcon symbol={symbol} size={28} />
            <Text style={styles.whatText}>{symbol}</Text>
          </View>
        }
        presets={PRESETS}
        cta="Review"
        onDone={(amount) => {
          tap();
          // Paid in USDC on Base, so the dollars typed are the amount sold.
          updateSwap({
            sell: { symbol: 'USDC', chain: 'Base' },
            buy: { symbol, chain: (params.chain ?? 'Ethereum') as Chain },
            presetAmount: String(amount),
          });
          router.dismissAll();
          router.navigate('/trade');
        }}
      />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  what: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  whatText: { flexShrink: 1, color: c.text, fontSize: 17, fontWeight: '500' },
}));
