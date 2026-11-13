import { useRef } from 'react';
import { ComingSoonSheet } from '@/components/sheets/ComingSoon';
import { closeSheet, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { type Settings, updateSettings, useSettings } from '@/lib/settings';
import { UNWIRED_SETTINGS } from '@/lib/surface';

type Mode = Settings['networkCost'];

const OPTIONS: { value: Mode; label: string; hint: string; recommended?: boolean }[] = [
  {
    value: 'auto',
    label: 'Auto',
    // hint: 'Set automatically for fast, reliable transactions.',
    hint: 'Fast and reliable',
    recommended: true,
  },
  {
    value: 'custom',
    label: 'Custom',
    // hint: 'Fine-tune exact network costs for transactions.',
    hint: 'Set your own for each transaction',
  },
];

/** Sends don't apply a custom network cost yet (lib/surface UNWIRED_SETTINGS): a link straight here says so. */
export default function NetworkCostRoute() {
  if (!UNWIRED_SETTINGS)
    return <ComingSoonSheet icon="gas" hint="Setting your own network cost is coming soon." />;
  return <NetworkCostSheet />;
}

/** Auto (recommended) or custom network cost for every transaction. */
function NetworkCostSheet() {
  const { networkCost } = useSettings();
  // Closes once, even if a second option is tapped before the sheet goes.
  const closing = useRef(false);

  const choose = (value: Mode) => {
    if (closing.current) return;
    closing.current = true;
    tap();
    updateSettings({ networkCost: value });
    setTimeout(closeSheet, 250);
  };

  return (
    <SheetScreen title="Network cost">
      {OPTIONS.map((o) => (
        <SheetRow
          key={o.value}
          title={o.label}
          subtitle={o.hint}
          value={o.recommended ? 'Recommended' : undefined}
          accessory="check"
          selected={o.value === networkCost}
          onPress={() => choose(o.value)}
        />
      ))}
    </SheetScreen>
  );
}
