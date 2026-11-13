import { closeSheet, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { COPY_STEPS, updateSettings, useSettings } from '@/lib/settings';

/** Where Copy starts on posts and jars; − and + still step from there. */
export default function CopyAmountSheet() {
  const { copyAmount } = useSettings();
  const choose = (value: number) => {
    tap();
    updateSettings({ copyAmount: value });
    closeSheet();
  };
  return (
    <SheetScreen title="Default copy amount" scroll>
      {COPY_STEPS.map((value) => (
        <SheetRow
          key={value}
          leading={<TokenIcon symbol="USDC" size={28} />}
          title={`${value.toLocaleString()} USDC`}
          accessory="check"
          selected={value === copyAmount}
          onPress={() => choose(value)}
        />
      ))}
    </SheetScreen>
  );
}
