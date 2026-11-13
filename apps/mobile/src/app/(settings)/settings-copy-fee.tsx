import { closeSheet, SheetRow, SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { JAR_FEES, updateSettings, useSettings } from '@/lib/settings';

/** Your cut when people copy a jar you launch: where Launch your jar starts. */
export default function CopyFeeSheet() {
  const { jarCopyFee } = useSettings();
  const choose = (value: number) => {
    tap();
    updateSettings({ jarCopyFee: value });
    closeSheet();
  };
  return (
    <SheetScreen title="Your cut on copies">
      <SheetText lead>Of copiers' profit only, never of a loss.</SheetText>
      {JAR_FEES.map((value) => (
        <SheetRow
          key={value}
          icon="pie"
          title={`${value}%`}
          accessory="check"
          selected={value === jarCopyFee}
          onPress={() => choose(value)}
        />
      ))}
    </SheetScreen>
  );
}
