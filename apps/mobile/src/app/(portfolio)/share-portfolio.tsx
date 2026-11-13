import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import type { View } from 'react-native';
import {
  PerformanceShareCard,
  PerformanceShareCardSkeleton,
  shareCardImage,
} from '@/components/home/PerformanceShareCard';
import { SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
import { Toggle } from '@/components/motion/Toggle';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { EmptyState } from '@/components/wallet/parts';
import { SHOW_DEMO_LABELS } from '@/lib/demo-money-copy';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import {
  BALANCE,
  BALANCE_CHANGE,
  formatUsd,
  RANGE_LABEL,
  RANGES,
  type Range,
  series,
} from '@/lib/mock-wallet';
import { useProfile } from '@/lib/profile';
import { addMoneyHref } from '@/lib/surface';
import { useWalletView } from '@/lib/wallet-view';

/**
 * Share your portfolio's performance as an image card. Amounts are hidden by
 * default, so only the percentage change leaves the phone unless you choose otherwise.
 */
export default function SharePortfolioSheet() {
  const profile = useProfile();
  const params = useLocalSearchParams<{ range?: Range }>();
  const range = params.range && RANGES.includes(params.range) ? params.range : '1D';
  const [showAmounts, setShowAmounts] = useState(false);
  const [sharing, setSharing] = useState(false);
  const card = useRef<View>(null);
  // The card is drawn from the balance history behind Portfolio's chart.
  const view = useWalletView();
  const loading = useFirstLoad(LOADS.history(view.wallet.id));

  // A real wallet has no balance history yet: its card shows today's move (from live
  // 24h prices) at any range, ending at the live total.
  const live = 'live' in view;
  const total = live ? view.usd : BALANCE;
  const todayPct = live
    ? view.usd - view.change > 0
      ? (view.change / (view.usd - view.change)) * 100
      : 0
    : (BALANCE_CHANGE / (BALANCE - BALANCE_CHANGE)) * 100;
  const data = live
    ? [total - view.change, total]
    : series('portfolio', range, BALANCE, range === '1D' ? todayPct : undefined);
  const delta = total - data[0];
  const pct = data[0] ? (delta / data[0]) * 100 : 0;
  const down = delta < 0;
  const label = live ? RANGE_LABEL['1D'] : RANGE_LABEL[range];
  const period = label[0].toUpperCase() + label.slice(1);

  const share = async () => {
    setSharing(true);
    await shareCardImage(card, 'Share your portfolio');
    setSharing(false);
  };

  // A wallet with nothing in it has no performance to share.
  if (view.empty) {
    return (
      <SheetScreen title="Share portfolio">
        <EmptyState
          icon="chart"
          title="Nothing to share yet"
          hint="Add money first, then share how it's doing."
          action={{
            label: 'Add money',
            onPress: () => router.replace(addMoneyHref('USDC')),
          }}
        />
      </SheetScreen>
    );
  }

  return (
    <SheetScreen
      title="Share portfolio"
      footer={
        <PillButton
          label={sharing ? 'Preparing…' : 'Share'}
          disabled={sharing || loading}
          onPress={share}
        />
      }
    >
      <SkeletonReveal
        loading={loading}
        skeleton={<PerformanceShareCardSkeleton footnote={SHOW_DEMO_LABELS} />}
      >
        <PerformanceShareCard
          ref={card}
          name={profile.name}
          photo={profile.photo}
          seed={profile.avatarSeed}
          period={period}
          pct={pct}
          amounts={
            showAmounts
              ? `${down ? '−' : '+'}${formatUsd(Math.abs(delta))} · ${formatUsd(total)} total`
              : undefined
          }
          data={data}
          footnote={
            SHOW_DEMO_LABELS
              ? 'Sample data · illustrative values, not wallet performance'
              : undefined
          }
        />
      </SkeletonReveal>

      <SheetRow
        title="Show amounts"
        subtitle="Include dollar values, not just the percentage"
        accessory={
          <Toggle
            accessibilityLabel="Show amounts"
            value={showAmounts}
            onValueChange={(on) => {
              tap();
              setShowAmounts(on);
            }}
          />
        }
      />
    </SheetScreen>
  );
}
