import { ComingSoonSheet } from '@/components/sheets/ComingSoon';
import { closeSheet, SheetRow, SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { JAR_FEES, updateSettings, useSettings } from '@/lib/settings';
import { COPY_FEES } from '@/lib/surface';

/** No copy fee is charged yet (lib/surface COPY_FEES): a link straight here says so. */
export default function CopyFeeRoute() {
  if (!COPY_FEES)
    return <ComingSoonSheet icon="pie" hint="Creator fees on copies are coming soon." />;
  return <CopyFeeSheet />;
}

/** Your cut when people copy a jar you launch: where Launch your jar starts. */
function CopyFeeSheet() {
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
