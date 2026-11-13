import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { JarAmount } from '@/components/jars/JarAmount';
import { JarIcon, StrategyCard } from '@/components/jars/JarParts';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { FlowTray, InlineTray } from '@/components/sheets/Tray';
import { TokenIcon } from '@/components/wallet/parts';
import { confirmOwner } from '@/lib/auth';
import { success, tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { TEST_MODE } from '@/lib/test-mode';
import { jarValue, thesisJars, useThesisJars } from '@/lib/thesis';
import { showErrorToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

const TRAY_PAGES = ['review', 'sold'] as const;

/**
 * Selling your jar the way Send works: the amount on the How much? screen (the jar's
 * card, keypad, 25%, 50%, Max), then the review in the wallet's small tray ("You're
 * selling", where it goes, Confirm sell, Face ID), then the receipt in the same tray.
 * It comes back as USDC on Base, the money jars are bought with.
 */
export default function JarSellSheet() {
  const { id = '' } = useLocalSearchParams<{ id?: string }>();
  const live = useThesisJars().find((j) => j.id === id);
  // Kept from when the screen opened: selling all of it removes the jar.
  const [jar] = useState(live);
  const styles = useStyles();
  const c = useTheme();
  const [usd, setUsd] = useState(0);
  const [page, setPage] = useState<'amount' | 'review' | 'sold'>('amount');
  const [selling, setSelling] = useState(false);
  if (!jar) return null;
  const value = jarValue(live ?? jar);
  const cap = Math.floor(value * 100) / 100;
  const all = usd >= cap - 0.01;

  const confirm = async () => {
    tap();
    setSelling(true);
    try {
      if (!(await confirmOwner(`Sell ${formatUsd(usd)} of ${jar.name}`, true)))
        throw new Error('Cancelled');
      // Real sells (each token back to USDC through NEAR Intents) aren't wired yet:
      // test mode shows the whole flow; the real app says so plainly.
      if (!TEST_MODE) throw new Error('Selling jars from the app is coming soon');
      const frac = Math.min(1, usd / (value || 1));
      thesisJars.set((list) =>
        frac >= 0.999
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
      success();
      setPage('sold');
    } catch (error) {
      if (!(error instanceof Error && /cancel/i.test(error.message)))
        showErrorToast(error instanceof Error ? error.message : 'Couldn’t sell');
    } finally {
      setSelling(false);
    }
  };

  const finish = () => {
    tap();
    if (all) router.dismissAll();
    else router.back();
  };
  const trayPage = page === 'amount' ? null : page;

  return (
    <FlowTray>
      <SheetScreen title="Sell" size="fill" onBack={() => router.back()}>
        <JarAmount
          sell={{ available: cap }}
          initial={cap}
          header={
            <StrategyCard split jar={jar} picks={jar.picks} name={jar.name} meta="Your jar" />
          }
          note="Comes back as USDC on Base"
          cta={(amount) => `Sell ${formatUsd(amount)}`}
          onDone={(amount) => {
            tap();
            setUsd(amount);
            setPage('review');
          }}
        />
      </SheetScreen>
      <InlineTray onClose={() => (page === 'sold' ? finish() : setPage('amount'))}>
        {trayPage ? (
          <ContentSwap id={trayPage} index={TRAY_PAGES.indexOf(trayPage)}>
            {trayPage === 'review' ? (
              <SheetScreen title="Review sell" onBack={() => setPage('amount')}>
                <View style={styles.summary}>
                  <Text style={styles.summaryLabel}>You're selling</Text>
                  <Text style={styles.summaryAmount} adjustsFontSizeToFit numberOfLines={1}>
                    {formatUsd(usd)}
                  </Text>
                  <View style={styles.summaryUsd}>
                    <JarIcon jar={jar} size={20} />
                    <Text style={styles.summaryUsdLabel}>
                      {all ? `All of ${jar.name}` : `Of ${jar.name}`}
                    </Text>
                  </View>
                </View>
                <View style={styles.rule} />
                <View style={styles.rows}>
                  <StatRow
                    label="You get"
                    value={
                      <View style={styles.inline}>
                        <TokenIcon symbol="USDC" size={20} ring={c.sheet} />
                        <Text style={styles.rowValue}>≈ {usd.toFixed(2)} USDC</Text>
                      </View>
                    }
                  />
                  <StatRow label="Network" value="Base" />
                  <StatRow label="Network cost" value="<$0.01" />
                  <StatRow
                    label="Total"
                    value={<Text style={styles.total}>{formatUsd(usd)}</Text>}
                  />
                </View>
                <PillButton
                  label={selling ? 'Selling…' : 'Confirm sell'}
                  disabled={selling}
                  onPress={() => void confirm()}
                  style={styles.cta}
                />
              </SheetScreen>
            ) : (
              <SheetScreen>
                <SuccessPage
                  compact
                  title={all ? 'Jar sold' : 'Sold'}
                  amount={{ symbol: 'USDC', text: `${usd.toFixed(2)} USDC`, usd: formatUsd(usd) }}
                  rows={[
                    { label: 'From', value: jar.name },
                    { label: 'To', value: 'Your wallet' },
                    { label: 'Network', value: 'Base' },
                    { label: 'Sold', value: 'Just now' },
                  ]}
                  onDone={finish}
                />
              </SheetScreen>
            )}
          </ContentSwap>
        ) : null}
      </InlineTray>
    </FlowTray>
  );
}

const useStyles = makeStyles((c) => ({
  summary: { alignItems: 'center', paddingTop: 28, paddingBottom: 26, gap: 6 },
  summaryLabel: { color: c.textSecondary, fontSize: 15 },
  summaryAmount: { color: c.text, fontSize: 44, fontWeight: '500', letterSpacing: -1 },
  summaryUsd: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  summaryUsdLabel: { color: c.textSecondary, fontSize: 17 },
  rule: { height: 1, backgroundColor: c.divider },
  rows: { paddingTop: 12, gap: 4 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowValue: { color: c.text, fontSize: 16 },
  total: { color: c.text, fontSize: 16, fontWeight: '600' },
  cta: { marginTop: 20 },
}));
