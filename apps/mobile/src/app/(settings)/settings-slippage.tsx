import { closeSheet, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { JAR_SLIPPAGES, updateSettings, useSettings } from '@/lib/settings';

/** The most a jar's buys may move from today's price: where Launch your jar starts. */
export default function SlippageSheet() {
  const { jarSlippage } = useSettings();
  const choose = (value: number) => {
    tap();
    updateSettings({ jarSlippage: value });
    closeSheet();
  };
  return (
    <SheetScreen title="Max slippage">
      {JAR_SLIPPAGES.map((value) => (
        <SheetRow
          key={value}
          icon="trade"
          title={`${value}%`}
          accessory="check"
          selected={value === jarSlippage}
          onPress={() => choose(value)}
        />
      ))}
    </SheetScreen>
  );
}
