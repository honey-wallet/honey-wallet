import { closeSheet, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { JAR_VISIBILITY, shownVisibility, updateSettings, useSettings } from '@/lib/settings';
import type { Visibility } from '@/lib/thesis';

/** Who sees a new jar: where Launch your jar starts; each jar can still change it. */
export default function JarVisibilitySheet() {
  const { jarVisibility } = useSettings();
  const choose = (value: Visibility) => {
    tap();
    updateSettings({ jarVisibility: value });
    closeSheet();
  };
  return (
    <SheetScreen title="Who sees new jars">
      {JAR_VISIBILITY.map((v) => (
        <SheetRow
          key={v.id}
          icon={v.icon}
          title={v.title}
          subtitle={v.hint}
          accessory="check"
          selected={v.id === shownVisibility(jarVisibility)}
          onPress={() => choose(v.id)}
        />
      ))}
    </SheetScreen>
  );
}
