import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { PriceChart } from '@/components/charts/PriceChart';
import { Icon, type IconName } from '@/components/Icon';
import {
  HoldingRow,
  layersOf,
  Owners,
  signedPct,
  Tiles,
  TokenStack,
  visibilityLabel,
} from '@/components/jars/JarParts';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PressableScale } from '@/components/motion/PressableScale';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { Description } from '@/components/sheets/Description';
import { DetailGroup, StatusPill } from '@/components/sheets/Details';
import { StatRow } from '@/components/sheets/Sheet';
import { OptionChips } from '@/components/trade/TradeForm';
import { Change, EmptyState, PushedScreen, SCREEN } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { refreshJarBuy } from '@/lib/jar-buy';
import { useDaoJar } from '@/lib/jar-dao';
import { formatUsd } from '@/lib/mock-wallet';
import { approvalsLeft, useMultisig, useProposal } from '@/lib/multisig';
import { copyJar, jarReturn, jarValue, updateJarBuy, useThesisJars } from '@/lib/thesis';
import { showToast } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';

type Range = '1W' | '1M' | 'All';
const COPY_AMOUNTS = ['$50', '$100', '$250'] as const;
type CopyAmount = (typeof COPY_AMOUNTS)[number];
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
const CHART_HEIGHT = 220;

/**
 * One jar, laid out like a Perps market page: what it is and its value (or, for
 * someone else's jar, its return) with the change, the chart across the full width and
 * its ranges, anything waiting on you, the jar's numbers as Perps' tiles, its holdings
 * as related-market rows, owners, and the idea as a Description. Copying sits at the
 * bottom like an order. Private jars show other people only their returns.
 */
export default function JarScreen() {
  const styles = useStyles();
  const c = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const jar = useThesisJars().find((j) => j.id === id);
  const [range, setRange] = useState<Range>('1M');
  const [copyAmount, setCopyAmount] = useState<CopyAmount>('$100');
  const [scrub, setScrub] = useState<number | null>(null);
  // The chart fits the page it's on (the extension popup is narrower than the window).
  const [width, setWidth] = useState(0);
  // A shared wallet's jar: its buy waits on members' approvals.
  const shared = useMultisig(jar?.sharedWallet?.walletId);
  // A shared jar on NEAR follows the chain while it's open.
  useDaoJar(jar?.sharedWallet?.walletId);
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
      <PushedScreen title="Jar" fallback="/jars" contentStyle={styles.gutter}>
        <EmptyState
          icon="pie"
          title="Jar not found"
          hint="It may have been closed."
          action={{ label: 'Browse jars', onPress: () => router.replace('/jars') }}
        />
      </PushedScreen>
    );

  const left = shared && approval ? approvalsLeft(shared, approval) : 0;
  const data = jar.history.slice(-RANGE_POINTS[range]);
  const first = data[0] ?? 0;
  const shown = scrub === null ? (data.at(-1) ?? jarValue(jar)) : (data[scrub] ?? 0);
  const change = first > 0 ? (shown - first) / first : 0;
  const ret = jarReturn(jar);
  const layers = layersOf(jar);
  const amount = Number(copyAmount.slice(1));
  const invited = jar.members.filter((m) => m.invited);
  // A new jar has no month behind it yet: no ranges, "since launch".
  const young = jar.history.length < 8;
  const period = young
    ? 'since launch'
    : range === 'All'
      ? 'all time'
      : `past ${range === '1W' ? 'week' : 'month'}`;
  const started = new Date(jar.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' });

  const copy = () => {
    tap();
    const next = copyJar(jar, amount);
    showToast(`Copied for $${amount} · ${jar.copyFee}% of profit goes to ${jar.creator}`);
    router.replace({ pathname: '/jar/[id]', params: { id: next } });
  };

  return (
    <PushedScreen
      fallback="/jars"
      title={
        <>
          {layers ? <TokenStack picks={jar.picks} size={20} ring={c.canvas} /> : null}
          <Text style={styles.headerTitle} numberOfLines={1}>
            {jar.name}
          </Text>
        </>
      }
      footer={
        jar.mine ? null : (
          // Copying is an order: pick the amount, then the honey button.
          <View style={styles.footer}>
            <OptionChips options={COPY_AMOUNTS} value={copyAmount} onChange={setCopyAmount} />
            <PillButton label={`Copy with ${copyAmount}`} onPress={copy} />
          </View>
        )
      }
    >
      {/* Who it's by and who sees it, then the number; while scrubbing, the value under the finger. */}
      <View style={styles.gutter}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {jar.mine
              ? jar.members.length > 1
                ? `${jar.members.length} owners`
                : 'Yours'
              : jar.creator}
          </Text>
          <Text style={styles.badge}>{visibilityLabel(jar)}</Text>
        </View>
        {jar.mine ? (
          scrub === null ? (
            <NumberPopIn value={formatUsd(shown)} style={styles.price} />
          ) : (
            <Text style={styles.price}>{formatUsd(shown)}</Text>
          )
        ) : (
          <Text style={styles.price}>{signedPct(change)}</Text>
        )}
        <View style={styles.changeRow}>
          {jar.mine ? <Change value={change * 100} /> : null}
          <TextSwap
            text={
              scrub !== null
                ? 'at this point'
                : jar.mine
                  ? `${change < 0 ? '−' : '+'}${formatUsd(Math.abs(shown - first))} ${period}`
                  : period
            }
            style={[styles.flex, styles.changeLabel]}
          />
        </View>
      </View>

      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 ? (
          <PriceChart data={data} width={width} height={CHART_HEIGHT} onScrub={setScrub} />
        ) : (
          <View style={{ height: CHART_HEIGHT }} />
        )}
      </View>
      {young ? null : (
        <View style={styles.ranges}>
          <SegmentedTabs<Range>
            bare
            options={['1W', '1M', 'All']}
            value={range}
            onChange={setRange}
          />
        </View>
      )}

      {/* Anything still waiting: an approval, a limit order, friends' shares. */}
      {jar.sharedWallet && approval && approval.status !== 'executed' ? (
        <View style={[styles.section, styles.gutter]}>
          <Notice
            icon={approval.status === 'pending' ? 'clock' : 'warning'}
            failed={approval.status !== 'pending'}
            title={
              approval.status === 'pending'
                ? `Waiting for ${left} more approval${left === 1 ? '' : 's'}`
                : `Not bought: the proposal was ${approval.status}`
            }
            hint={`${jar.sharedWallet.label} buys this jar once enough members approve.`}
            onPress={() => {
              tap();
              router.push({ pathname: '/proposal/[id]', params: { id: approval.id } });
            }}
          />
        </View>
      ) : null}
      {jar.openOrder ? (
        <View style={[styles.section, styles.gutter]}>
          <Notice
            icon="clock"
            title={`Limit order open · ${formatUsd(jar.openOrder.amount)}`}
            hint="Buys 1% under today's price. Waits up to 24 hours; cancel anytime."
          />
        </View>
      ) : null}
      {invited.length ? (
        <View style={[styles.section, styles.gutter]}>
          <Notice
            icon="person"
            title={`Waiting on ${invited.length} friend${invited.length === 1 ? '' : 's'}`}
            hint={`Invites sent for ${formatUsd(invited[0]?.asked ?? 0)} each. Their share joins when they accept.`}
          />
        </View>
      ) : null}

      {/* The jar's numbers, as a Perps market's four tiles */}
      <View style={[styles.section, styles.gutter]}>
        <Text style={styles.heading}>Jar</Text>
        <Tiles
          tiles={[
            {
              label: 'Total return',
              value: signedPct(ret),
              tone: ret < 0 ? 'down' : 'up',
            },
            ...(jar.copiedFrom
              ? [
                  { label: 'Copied from', value: jar.copiedFrom.creator },
                  { label: 'Their cut', value: `${jar.copiedFrom.fee}%`, hint: 'Of profit only' },
                ]
              : [
                  { label: 'Copied by', value: String(jar.copiers) },
                  { label: 'Copy fee', value: `${jar.copyFee}%`, hint: 'Of profit only' },
                ]),
            { label: 'Started', value: started },
          ]}
        />
      </View>

      {jar.buy?.length ? (
        <View style={[styles.detail, styles.gutter]}>
          <DetailGroup title="Swaps">
            {jar.buy.map((l) => (
              <StatRow
                key={l.depositAddress}
                label={`${l.symbol} on ${l.chain} · ${formatUsd(l.usd)}`}
                value={
                  <StatusPill
                    tone={
                      l.status === 'SUCCESS'
                        ? 'done'
                        : l.status === 'FAILED' || l.status === 'INCOMPLETE_DEPOSIT'
                          ? 'failed'
                          : 'waiting'
                    }
                    icon={
                      l.status === 'SUCCESS'
                        ? 'checkCircle'
                        : l.status === 'FAILED' || l.status === 'INCOMPLETE_DEPOSIT'
                          ? 'warning'
                          : 'clock'
                    }
                    text={STATE_TEXT[l.status] ?? l.status}
                  />
                }
              />
            ))}
          </DetailGroup>
        </View>
      ) : null}

      <View style={[styles.section, styles.gutter]}>
        <Text style={styles.heading}>Holdings</Text>
        {layers && jar.picks.length ? (
          jar.picks.map((p) => (
            <HoldingRow key={p.symbol} pick={p} total={jar.mine ? shown : undefined} />
          ))
        ) : (
          <View style={styles.card}>
            <EmptyState
              compact
              icon="eyeSlash"
              title="Holdings are private"
              hint="Only its members see what this jar holds. Copy it to hold the same mix."
            />
          </View>
        )}
      </View>

      {jar.mine && jar.members.length > 1 ? (
        <View style={[styles.section, styles.gutter]}>
          <Text style={styles.heading}>Who owns what</Text>
          <Owners jar={jar} />
        </View>
      ) : null}

      <View style={[styles.section, styles.gutter]}>
        <Description title="The idea" text={jar.thesis} />
      </View>

      <Text style={[styles.gutter, styles.disclaimer]}>
        Jars hold real tokens and can lose value. Past returns don't promise future ones.
      </Text>
    </PushedScreen>
  );
}

/**
 * Something waiting on the jar, as Savings lays out its rows: a round honey well, a
 * title over one line, and a chevron when it opens something.
 */
function Notice({
  icon,
  title,
  hint,
  failed,
  onPress,
}: {
  icon: IconName;
  title: string;
  hint: string;
  failed?: boolean;
  onPress?: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const body = (
    <>
      <View style={[styles.well, failed && { backgroundColor: `${c.error}1A` }]}>
        <Icon name={icon} size={15} color={failed ? c.error : c.accentText} />
      </View>
      <View style={styles.flex}>
        <Text style={styles.noticeTitle}>{title}</Text>
        <Text style={styles.noticeHint}>{hint}</Text>
      </View>
      {onPress ? <Icon name="chevronRight" size={13} color={c.textSecondary} /> : null}
    </>
  );
  return onPress ? (
    <PressableScale
      accessibilityRole="button"
      scaleTo={0.98}
      onPress={onPress}
      style={styles.notice}
    >
      {body}
    </PressableScale>
  ) : (
    <View style={styles.notice}>{body}</View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  gutter: { paddingHorizontal: SCREEN.gutter },
  headerTitle: { flexShrink: 1, color: c.text, fontSize: 17, fontWeight: '600' },
  nameRow: { marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flexShrink: 1, color: c.textSecondary, fontSize: 15 },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    ...radius(6),
    overflow: 'hidden',
    color: c.accentText,
    backgroundColor: c.accentSurface,
    fontSize: 12,
    fontWeight: '600',
  },
  price: {
    color: c.text,
    fontSize: 36,
    fontWeight: '500',
    letterSpacing: -0.6,
    fontVariant: ['tabular-nums'],
  },
  changeRow: {
    marginTop: 2,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  changeLabel: { color: c.textSecondary, fontSize: 15, fontVariant: ['tabular-nums'] },
  ranges: { marginTop: 8, paddingHorizontal: 12 },
  section: { marginTop: 28 },
  // DetailGroup brings its own 16pt space above its title.
  detail: { marginTop: 12 },
  heading: { marginBottom: 10, color: c.textSecondary, fontSize: 15 },
  card: { ...radius(20), backgroundColor: c.card },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    ...radius(20),
    backgroundColor: c.card,
  },
  well: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  noticeTitle: { color: c.text, fontSize: 16, fontWeight: '500' },
  noticeHint: { marginTop: 2, color: c.textSecondary, fontSize: 14, lineHeight: 19 },
  disclaimer: { marginTop: 28, color: c.textSecondary, fontSize: 12, lineHeight: 17 },
  // The screen's footer is a row (for side-by-side buttons); this column fills it.
  footer: { flex: 1, minWidth: 0, gap: 10 },
}));
