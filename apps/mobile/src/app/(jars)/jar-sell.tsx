import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { TokenIcon } from '@/components/wallet/parts';
import { confirmOwner } from '@/lib/auth';
import { success, tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { TEST_MODE } from '@/lib/test-mode';
import { jarValue, thesisJars, useThesisJars } from '@/lib/thesis';
import { showErrorToast } from '@/lib/toast';
import { makeStyles } from '@/theme';

const PARTS = ['25%', '50%', 'All'] as const;
type Part = (typeof PARTS)[number];
const SHARE: Record<Part, number> = { '25%': 0.25, '50%': 0.5, All: 1 };

/**
 * Selling your jar, as any sale in Honey goes: how much (a quarter, half or all of it),
 * what each token turns into, one Face ID, then a receipt. Everything comes back as
 * USDC on Base, the money jars are bought with.
 */
export default function JarSellSheet() {
  const { id = '' } = useLocalSearchParams<{ id?: string }>();
  const jar = useThesisJars().find((j) => j.id === id);
  const styles = useStyles();
  const [part, setPart] = useState<Part>('All');
  const [stage, setStage] = useState<'review' | 'selling' | 'done'>('review');
  const [sold, setSold] = useState(0);
  if (!jar) return null;
  const value = jarValue(jar);
  const usd = value * SHARE[part];

  const sell = async () => {
    tap();
    setStage('selling');
    try {
      if (!(await confirmOwner(`Sell ${formatUsd(usd)} of ${jar.name}`, true)))
        throw new Error('Cancelled');
      // Real sells (each token back to USDC through NEAR Intents) aren't wired yet:
      // test mode shows the whole flow; the real app says so plainly.
      if (!TEST_MODE) throw new Error('Selling jars from the app is coming soon');
      const frac = SHARE[part];
      thesisJars.set((list) =>
        frac >= 1
          ? list.filter((j) => j.id !== jar.id)
          : list.map((j) =>
              j.id === jar.id
                ? {
                    ...j,
                    invested: j.invested * (1 - frac),
                    history: [...j.history, jarValue(j) * (1 - frac)],
                  }
                : j,
            ),
      );
      setSold(usd);
      success();
      setStage('done');
    } catch (error) {
      setStage('review');
      if (!(error instanceof Error && /cancel/i.test(error.message)))
        showErrorToast(error instanceof Error ? error.message : 'Couldn’t sell');
    }
  };

  if (stage === 'done')
    return (
      <SheetScreen title="" size="fill">
        <SuccessPage
          title={SHARE[part] >= 1 ? 'Jar sold' : 'Sold'}
          amount={{ symbol: 'USDC', text: `${sold.toFixed(2)} USDC`, usd: formatUsd(sold) }}
          rows={[
            { label: 'From', value: jar.name },
            { label: 'To', value: 'USDC on Base' },
          ]}
          onDone={() => {
            tap();
            if (SHARE[part] >= 1) router.dismissAll();
            else router.back();
          }}
        />
      </SheetScreen>
    );

  return (
    <SheetScreen
      title={`Sell ${jar.name}`}
      size="fill"
      footer={
        <PillButton
          label={stage === 'selling' ? 'Selling…' : `Sell ${formatUsd(usd)}`}
          disabled={stage === 'selling' || usd <= 0}
          onPress={() => void sell()}
        />
      }
    >
      <View style={styles.body}>
        <SegmentedTabs<Part> options={[...PARTS]} value={part} onChange={setPart} fill />
        <View style={styles.amount}>
          <Text style={styles.big}>{formatUsd(usd)}</Text>
          <Text style={styles.hint}>
            {part === 'All' ? 'The whole jar' : `${part} of ${formatUsd(value)}`}
          </Text>
        </View>
        <View>
          {jar.picks.map((p) => (
            <View key={p.symbol} style={styles.row}>
              <TokenIcon symbol={p.symbol} size={28} />
              <Text style={styles.symbol}>{p.symbol}</Text>
              <Text style={styles.usd}>{formatUsd((usd * p.weight) / 100)}</Text>
            </View>
          ))}
        </View>
        <View>
          <StatRow label="You get" value={`≈ ${usd.toFixed(2)} USDC`} />
          <StatRow label="To" value="USDC on Base" />
        </View>
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  body: { gap: 20 },
  amount: { alignItems: 'center', gap: 4, paddingVertical: 8 },
  big: { color: c.text, fontSize: 44, fontWeight: '700', fontVariant: ['tabular-nums'] },
  hint: { color: c.textSecondary, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  symbol: { flex: 1, color: c.text, fontSize: 16, fontWeight: '500' },
  usd: { color: c.textSecondary, fontSize: 15, fontVariant: ['tabular-nums'] },
}));
