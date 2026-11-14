import { ComingSoonSheet } from '@/components/sheets/ComingSoon';
import { closeSheet, SheetRow, SheetScreen, SheetText } from '@/components/sheets/Sheet';
// Honey keeps the copy fee (2026-11-14): no payout or earnings line for creators.
// import { useCopyEarnings, useCopyFeeAccount } from '@/lib/copy-fee-account';
// import { copyFeePayoutText, withdrawLine } from '@/lib/copy-fees';
// import { useMoney } from '@/lib/fx';
import { tap } from '@/lib/haptics';
import { JAR_FEES, updateSettings, useSettings } from '@/lib/settings';
import { COPY_FEES } from '@/lib/surface';
// import { TEST_MODE } from '@/lib/test-mode';

/** No copy fee is charged yet (lib/surface COPY_FEES): a link straight here says so. */
export default function CopyFeeRoute() {
  if (!COPY_FEES)
    return <ComingSoonSheet icon="pie" hint="Creator fees on copies are coming soon." />;
  return <CopyFeeSheet />;
}

/** Your cut when people copy a jar you launch: where Launch your jar starts. */
function CopyFeeSheet() {
  const { jarCopyFee } = useSettings();
  // // Where the cut is paid, or that it can't be (lib/copy-fees).
  // const payout = copyFeePayoutText(useCopyFeeAccount(!TEST_MODE));
  // // What copies have earned you so far (server data), and how to get it out.
  // const earnings = useCopyEarnings(!TEST_MODE);
  // const money = useMoney();
  const choose = (value: number) => {
    tap();
    updateSettings({ jarCopyFee: value });
    closeSheet();
  };
  return (
    <SheetScreen title="Your cut on copies">
      <SheetText lead>Of copiers' profit only, never of a loss.</SheetText>
      {/* {payout ? <SheetText>{payout}</SheetText> : null}
      {earnings ? (
        <SheetText>
          {`Earned from copies so far: ${money.format(earnings.earnedUsd)}. ${withdrawLine(earnings.nearAccount)}`.trim()}
        </SheetText>
      ) : null} */}
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
