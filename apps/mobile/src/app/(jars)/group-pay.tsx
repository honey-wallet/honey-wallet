import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { TokenIcon } from '@/components/wallet/parts';
import { dollars } from '@/lib/group-jar-core';
import { groupError, payShare, useGroup } from '@/lib/group-jars';
import { success, tap } from '@/lib/haptics';
import { useMyNearUsdc } from '@/lib/jar-dao';
import { showErrorToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

const PAGES = ['review', 'done'] as const;

/**
 * Adding your share to a group jar, in the wallet's small tray as Send does: what leaves
 * your wallet and where it lands, Confirm (Face ID), then the receipt in the same tray.
 * Opened from the group page's "Add your $X".
 */
export default function GroupPayTray() {
  const { id = '' } = useLocalSearchParams<{ id?: string }>();
  const g = useGroup(id);
  const styles = useStyles();
  const c = useTheme();
  const [page, setPage] = useState<(typeof PAGES)[number]>('review');
  const [sending, setSending] = useState(false);
  const nearUsdc = useMyNearUsdc(!!g);
  if (!g) return null;
  const share = dollars(g.shareUsd);
  const fromNear = nearUsdc !== null && nearUsdc >= g.shareUsd;

  const pay = async () => {
    tap();
    setSending(true);
    try {
      await payShare(g, nearUsdc);
      success();
      setPage('done');
    } catch (error) {
      if (!(error instanceof Error && /cancel/i.test(error.message)))
        showErrorToast(groupError(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <ContentSwap id={page} index={PAGES.indexOf(page)}>
      {page === 'review' ? (
        <SheetScreen title="Review">
          <View style={styles.summary}>
            <Text style={styles.summaryLabel}>You're adding</Text>
            <Text style={styles.summaryAmount} adjustsFontSizeToFit numberOfLines={1}>
              {share}
            </Text>
            <Text style={styles.summaryTo} numberOfLines={1}>
              To {g.name}
            </Text>
          </View>
          <View style={styles.rule} />
          <View style={styles.rows}>
            <StatRow
              label="You pay"
              value={
                <View style={styles.inline}>
                  <TokenIcon symbol="USDC" size={20} ring={c.sheet} />
                  <Text style={styles.rowValue}>{g.shareUsd.toFixed(2)} USDC</Text>
                </View>
              }
            />
            {g.dao ? <StatRow label="To" value={shortDao(g.dao)} /> : null}
            <StatRow label="Network" value={fromNear ? 'NEAR' : 'Base'} />
            <StatRow label="Your share" value={`1 of ${g.people}`} />
            <StatRow label="Arrives" value={fromNear ? 'In seconds' : 'In about a minute'} />
          </View>
          <PillButton
            label={sending ? 'Sending…' : 'Confirm'}
            disabled={sending}
            onPress={() => void pay()}
            style={styles.cta}
          />
        </SheetScreen>
      ) : (
        <SheetScreen>
          <SuccessPage
            compact
            title="Your share is in"
            amount={{ symbol: 'USDC', text: `${g.shareUsd.toFixed(2)} USDC`, usd: share }}
            rows={[
              { label: 'To', value: g.name },
              { label: 'Your share', value: `1 of ${g.people}` },
              { label: 'Next', value: fromNear ? 'Buys when all are in' : 'Lands in ~1 min' },
            ]}
            onDone={() => {
              tap();
              router.back();
            }}
          />
        </SheetScreen>
      )}
    </ContentSwap>
  );
}

/** The jar's DAO account, its name cut in the middle when long: "japan-tr…ab12cd.sputnik-dao.near". */
function shortDao(dao: string) {
  const cut = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
  const suffix = '.sputnik-dao.near';
  // Anything else is shown as it is (cut), never dressed up as a jar; paying it is refused.
  return dao.endsWith(suffix) ? `${cut(dao.slice(0, -suffix.length))}${suffix}` : cut(dao);
}

const useStyles = makeStyles((c) => ({
  summary: { alignItems: 'center', paddingTop: 28, paddingBottom: 26, gap: 6 },
  summaryLabel: { color: c.textSecondary, fontSize: 15 },
  summaryAmount: { color: c.text, fontSize: 44, fontWeight: '500', letterSpacing: -1 },
  summaryTo: { color: c.textSecondary, fontSize: 17 },
  rule: { height: 1, backgroundColor: c.divider },
  rows: { paddingTop: 12, gap: 4 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowValue: { color: c.text, fontSize: 16 },
  cta: { marginTop: 20 },
}));
