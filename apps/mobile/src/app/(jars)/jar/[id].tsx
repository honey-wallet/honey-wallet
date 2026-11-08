import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { PriceChart } from '@/components/charts/PriceChart';
import { Icon } from '@/components/Icon';
import { Facts, HoldingRow, layersOf, Owners, signedPct } from '@/components/jars/JarParts';
import { PressableScale } from '@/components/motion/PressableScale';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { PillButton } from '@/components/onboarding/PillButton';
import { EmptyState, PushedScreen } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { refreshJarBuy } from '@/lib/jar-buy';
import { formatUsd } from '@/lib/mock-wallet';
import { approvalsLeft, useMultisig, useProposal } from '@/lib/multisig';
import { copyJar, jarReturn, jarValue, updateJarBuy, useThesisJars } from '@/lib/thesis';
import { showToast } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';

type Range = '1W' | '1M' | 'All';
const COPY_AMOUNTS = [50, 100, 250];
const FINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED', 'NOT_SENT']);
const STATE_TEXT: Record<string, string> = {
  NOT_SENT: 'Not sent',
  PENDING_DEPOSIT: 'Waiting for payment',
  KNOWN_DEPOSIT_TX: 'Payment seen',
  PROCESSING: 'Swapping',
  SUCCESS: 'Done',
  INCOMPLETE_DEPOSIT: 'Paid too little',
  REFUNDED: 'Refunded',
  FAILED: 'Failed',
};
const RANGE_POINTS: Record<Range, number> = { '1W': 8, '1M': 30, All: Number.POSITIVE_INFINITY };

/**
 * One jar, laid out like an Aave market: the jar and its value up top with a ranged
 * chart, the key numbers as tiles, then holdings as asset rows, owners and the idea.
 * Private jars show other people only their returns.
 */
export default function JarScreen() {
  const styles = useStyles();
  const c = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const jar = useThesisJars().find((j) => j.id === id);
  const [range, setRange] = useState<Range>('1M');
  const [copyAmount, setCopyAmount] = useState(100);
  const [scrub, setScrub] = useState<number | null>(null);
  // The chart fits the page it's on (the extension popup is narrower than the window).
  const [width, setWidth] = useState(0);
  // A shared wallet's jar: its buy waits on members' approvals.
  const shared = useMultisig(jar?.sharedWallet?.walletId);
  const approval = useProposal(jar?.sharedWallet?.proposalId ?? '');
  // While any real swap is still moving, check on it every 10 seconds.
  const moving = jar?.buy?.some((l) => !FINAL.has(l.status)) ?? false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart only when the jar or its moving state changes, not on every status write.
  useEffect(() => {
    if (!jar?.buy || !moving) return;
    const tick = () => void refreshJarBuy(jar.buy ?? []).then((legs) => updateJarBuy(jar.id, legs));
    tick();
    const timer = setInterval(tick, 10_000);
    return () => clearInterval(timer);
  }, [jar?.id, moving]);

  if (!jar)
    return (
      <PushedScreen title="Jar" fallback="/jars">
        <EmptyState icon="pie" title="Jar not found" hint="It may have been closed." />
      </PushedScreen>
    );

  const left = shared && approval ? approvalsLeft(shared, approval) : 0;
  const data = jar.history.slice(-RANGE_POINTS[range]);
  const first = data[0] ?? 0;
  const shown = scrub === null ? (data.at(-1) ?? jarValue(jar)) : (data[scrub] ?? 0);
  const change = first > 0 ? (shown - first) / first : 0;
  const ret = jarReturn(jar);
  const layers = layersOf(jar);
  const _up = change >= 0;
  // A new jar has no month behind it yet: no ranges, "since launch".
  const young = jar.history.length < 8;
  const period = young
    ? 'since launch'
    : range === 'All'
      ? 'all time'
      : `past ${range === '1W' ? 'week' : 'month'}`;

  const copy = () => {
    tap();
    const next = copyJar(jar, copyAmount);
    showToast(`Copied for $${copyAmount} · ${jar.copyFee}% of profit goes to ${jar.creator}`);
    router.replace({ pathname: '/jar/[id]', params: { id: next } });
  };

  return (
    <PushedScreen
      title={jar.name}
      fallback="/jars"
      footer={
        jar.mine ? null : (
          <View style={styles.footer}>
            <View style={styles.amounts}>
              {COPY_AMOUNTS.map((a) => (
                <PressableScale
                  key={a}
                  accessibilityRole="button"
                  accessibilityState={{ selected: copyAmount === a }}
                  onPress={() => {
                    tap();
                    setCopyAmount(a);
                  }}
                  style={[styles.amount, copyAmount === a && styles.amountOn]}
                >
                  <Text style={styles.amountText}>${a}</Text>
                </PressableScale>
              ))}
            </View>
            <PillButton label={`Copy with $${copyAmount}`} onPress={copy} />
          </View>
        )
      }
    >
      <View style={styles.page}>
        {/* Aave's balance: a centred number with smaller cents, the change under it,
            then the chart across the full width; drag along it to read a day. */}
        <View style={styles.aave}>
          <Text style={styles.aaveLabel}>
            {jar.creator} ·{' '}
            {jar.visibility === 'public'
              ? 'Public'
              : jar.visibility === 'private'
                ? 'Returns only'
                : 'Members only'}
          </Text>
          {jar.mine ? (
            <Text style={styles.aaveValue}>
              {formatUsd(shown).split('.')[0]}
              <Text style={styles.aaveCents}>.{formatUsd(shown).split('.')[1] ?? '00'}</Text>
            </Text>
          ) : (
            <Text style={styles.aaveValue}>{signedPct(change)}</Text>
          )}
          <Text style={[styles.aaveChange, { color: change < 0 ? c.error : c.success }]}>
            {jar.mine
              ? `${change < 0 ? '−' : '+'}${formatUsd(Math.abs(shown - first))} (${signedPct(change)})`
              : ''}{' '}
            <Text style={styles.aavePeriod}>{scrub === null ? period : 'at this point'}</Text>
          </Text>
        </View>
        <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          {width > 0 ? (
            <PriceChart data={data} width={width} height={200} onScrub={setScrub} />
          ) : (
            <View style={{ height: 200 }} />
          )}
        </View>
        {young ? null : (
          <SegmentedTabs<Range>
            options={['1W', '1M', 'All']}
            value={range}
            onChange={setRange}
            fill
          />
        )}
        <Facts
          facts={[
            { label: 'Total return', value: signedPct(ret) },
            ...(jar.copiedFrom
              ? [
                  { label: 'Copied from', value: jar.copiedFrom.creator },
                  { label: 'Their cut', value: `${jar.copiedFrom.fee}% of profit` },
                ]
              : [
                  { label: 'Copied by', value: String(jar.copiers) },
                  { label: 'Copy fee', value: `${jar.copyFee}%` },
                ]),
          ]}
        />
        {jar.sharedWallet && approval && approval.status !== 'executed' ? (
          <PressableScale
            accessibilityRole="button"
            onPress={() => {
              tap();
              router.push({ pathname: '/proposal/[id]', params: { id: approval.id } });
            }}
            style={styles.order}
          >
            <Icon
              name={approval.status === 'pending' ? 'clock' : 'warning'}
              size={16}
              color={approval.status === 'pending' ? c.accentText : c.error}
            />
            <View style={styles.flex}>
              <Text style={styles.orderTitle}>
                {approval.status === 'pending'
                  ? `Waiting for ${left} more approval${left === 1 ? '' : 's'}`
                  : `Not bought: the proposal was ${approval.status}`}
              </Text>
              <Text style={styles.orderHint}>
                {jar.sharedWallet.label} buys this jar once enough members approve. Tap to see the
                proposal.
              </Text>
            </View>
          </PressableScale>
        ) : null}
        {jar.openOrder ? (
          <View style={styles.order}>
            <Icon name="clock" size={16} color={c.accentText} />
            <View style={styles.flex}>
              <Text style={styles.orderTitle}>
                Limit order open · {formatUsd(jar.openOrder.amount)}
              </Text>
              <Text style={styles.orderHint}>
                Buys 1% under today's price. Waits up to 24 hours; cancel anytime.
              </Text>
            </View>
          </View>
        ) : null}
        {jar.members.some((m) => m.invited) ? (
          <View style={styles.order}>
            <Icon name="person" size={16} color={c.accentText} />
            <View style={styles.flex}>
              <Text style={styles.orderTitle}>
                Waiting on {jar.members.filter((m) => m.invited).length} friend
                {jar.members.filter((m) => m.invited).length === 1 ? '' : 's'}
              </Text>
              <Text style={styles.orderHint}>
                Invites sent for {formatUsd(jar.members.find((m) => m.invited)?.asked ?? 0)} each.
                Their share joins when they accept.
              </Text>
            </View>
          </View>
        ) : null}

        {jar.buy?.length ? (
          <>
            <Text style={styles.section}>Swaps</Text>
            <View style={styles.card}>
              {jar.buy.map((l) => (
                <View key={l.depositAddress} style={styles.row}>
                  <Text style={[styles.thesis, styles.flex]} numberOfLines={1}>
                    {l.symbol} on {l.chain} · {formatUsd(l.usd)}
                  </Text>
                  <Text
                    style={[
                      styles.hint,
                      styles.swapState,
                      {
                        color:
                          l.status === 'SUCCESS'
                            ? c.success
                            : l.status === 'FAILED' || l.status === 'INCOMPLETE_DEPOSIT'
                              ? c.error
                              : c.textSecondary,
                      },
                    ]}
                  >
                    {STATE_TEXT[l.status] ?? l.status}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        <Text style={styles.section}>Holdings</Text>
        <View style={styles.card}>
          {layers && jar.picks.length ? (
            jar.picks.map((p) => (
              <HoldingRow key={p.symbol} pick={p} total={jar.mine ? shown : undefined} />
            ))
          ) : (
            <View style={styles.row}>
              <Icon name="eyeSlash" size={18} color={c.textSecondary} />
              <Text style={styles.hint}>
                This jar is private: holdings stay hidden. Copy it to hold the same mix.
              </Text>
            </View>
          )}
        </View>

        {jar.mine && jar.members.length > 1 ? (
          <>
            <Text style={styles.section}>Who owns what</Text>
            <Owners jar={jar} />
          </>
        ) : null}

        <Text style={styles.section}>The idea</Text>
        <View style={styles.card}>
          <Text style={styles.thesis}>{jar.thesis}</Text>
          <Text style={styles.hint}>
            Started {new Date(jar.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
          </Text>
        </View>
      </View>
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  swapState: { flex: 0, paddingBottom: 0, fontWeight: '600' },
  aave: { alignItems: 'center', gap: 0, paddingTop: 0, marginBottom: -4 },
  aaveLabel: { color: c.textSecondary, fontSize: 14 },
  aaveValue: {
    color: c.text,
    fontSize: 40,
    lineHeight: 46,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  aaveCents: { color: c.textSecondary, fontSize: 30, fontWeight: '700' },
  aaveChange: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  aavePeriod: { color: c.textSecondary, fontWeight: '400' },
  order: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    ...radius(18),
    backgroundColor: c.card,
  },
  orderTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  orderHint: { marginTop: 2, color: c.textSecondary, fontSize: 13, lineHeight: 18 },
  page: { paddingHorizontal: 16, gap: 12, paddingBottom: 24 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { flexShrink: 1, color: c.textSecondary, fontSize: 14 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 11,
    backgroundColor: c.card,
  },
  badgeText: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
  value: {
    marginTop: 4,
    color: c.text,
    fontSize: 36,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  period: { color: c.textSecondary, fontWeight: '400' },
  jarHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  jarHeadText: { color: c.textSecondary, fontSize: 14 },
  change: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  section: { marginTop: 10, color: c.textSecondary, fontSize: 15 },
  card: { paddingHorizontal: 16, paddingVertical: 8, ...radius(20), backgroundColor: c.card },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  hint: { flex: 1, color: c.textSecondary, fontSize: 14, lineHeight: 19, paddingBottom: 8 },
  thesis: { color: c.text, fontSize: 16, lineHeight: 23, paddingVertical: 8 },
  // The screen's footer is a row (for side-by-side buttons); this column fills it.
  footer: { flex: 1, minWidth: 0, gap: 10 },
  amounts: { flexDirection: 'row', gap: 8 },
  amount: {
    flex: 1,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.divider,
  },
  amountOn: { borderColor: c.text },
  amountText: { color: c.text, fontSize: 15, fontWeight: '600' },
}));
