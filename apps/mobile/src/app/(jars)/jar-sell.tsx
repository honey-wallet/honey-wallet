import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { JarAmount } from '@/components/jars/JarAmount';
import { StrategyCard } from '@/components/jars/JarParts';
import { SheetScreen } from '@/components/sheets/Sheet';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { confirmOwner } from '@/lib/auth';
import { success, tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { TEST_MODE } from '@/lib/test-mode';
import { jarValue, thesisJars, useThesisJars } from '@/lib/thesis';
import { showErrorToast } from '@/lib/toast';

/**
 * Selling your jar, on the same screen as How much?: the jar's card, the amount with
 * the keypad and quick amounts (25%, 50%, Max of the jar), then Sell, one Face ID and
 * a receipt. It comes back as USDC on Base, the money jars are bought with.
 */
export default function JarSellSheet() {
  const { id = '' } = useLocalSearchParams<{ id?: string }>();
  const jar = useThesisJars().find((j) => j.id === id);
  const [stage, setStage] = useState<'review' | 'selling' | 'done'>('review');
  const [sold, setSold] = useState(0);
  if (!jar && stage !== 'done') return null;
  const value = jar ? jarValue(jar) : 0;
  const cap = Math.floor(value * 100) / 100;
  const all = sold >= cap - 0.01;

  const sell = async (usd: number) => {
    if (!jar) return;
    tap();
    setStage('selling');
    try {
      if (!(await confirmOwner(`Sell ${formatUsd(usd)} of ${jar.name}`, true)))
        throw new Error('Cancelled');
      // Real sells (each token back to USDC through NEAR Intents) aren't wired yet:
      // test mode shows the whole flow; the real app says so plainly.
      if (!TEST_MODE) throw new Error('Selling jars from the app is coming soon');
      const frac = Math.min(1, usd / (value || 1));
      setSold(usd);
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
          title={all ? 'Jar sold' : 'Sold'}
          amount={{ symbol: 'USDC', text: `${sold.toFixed(2)} USDC`, usd: formatUsd(sold) }}
          rows={[{ label: 'To', value: 'USDC on Base' }]}
          onDone={() => {
            tap();
            if (all) router.dismissAll();
            else router.back();
          }}
        />
      </SheetScreen>
    );
  if (!jar) return null;

  return (
    <SheetScreen title="Sell" size="fill" onBack={() => router.back()}>
      <JarAmount
        sell={{ available: cap }}
        initial={cap}
        header={<StrategyCard split jar={jar} picks={jar.picks} name={jar.name} meta="Your jar" />}
        note="Comes back as USDC on Base"
        cta={(amount) => `Sell ${formatUsd(amount)}`}
        hold={stage === 'selling' ? 'Selling…' : undefined}
        onDone={(amount) => void sell(amount)}
      />
    </SheetScreen>
  );
}
