import type { IconName } from '@/components/Icon';
import { closeSheet, SheetScreen } from '@/components/sheets/Sheet';
import { EmptyState } from '@/components/wallet/parts';

/**
 * A coming-soon feature's sheet when a link opens it directly (lib/surface `SOON`): the
 * shared wallets' "Not available yet", with what works today or Close.
 */
export function ComingSoonSheet({
  icon,
  hint,
  action = { label: 'Close', onPress: closeSheet },
}: {
  icon: IconName;
  hint: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <SheetScreen>
      <EmptyState icon={icon} title="Not available yet" hint={hint} action={action} />
    </SheetScreen>
  );
}
