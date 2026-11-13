import { Text } from 'react-native';
import { ComingSoonSheet } from '@/components/sheets/ComingSoon';
import { closeSheet, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { LANGUAGES, updateSettings, useSettings } from '@/lib/settings';
import { UNWIRED_SETTINGS } from '@/lib/surface';
import { showToast } from '@/lib/toast';
import { makeStyles } from '@/theme';

/** There are no translations yet (lib/surface UNWIRED_SETTINGS): a link straight here says so. */
export default function LanguageRoute() {
  if (!UNWIRED_SETTINGS)
    return <ComingSoonSheet icon="language" hint="Other languages are coming soon." />;
  return <LanguageSheet />;
}

/** App language picker, with each language's flag and a check on the current one. */
function LanguageSheet() {
  const styles = useStyles();
  const { language } = useSettings();

  const choose = (next: string) => {
    tap();
    if (next !== language) {
      updateSettings({ language: next });
      showToast('Language changed');
    }
    closeSheet();
  };

  return (
    <SheetScreen title="Language" scroll>
      {LANGUAGES.map(([name, flag]) => (
        <SheetRow
          key={name}
          leading={
            <Text style={styles.flag} accessible={false}>
              {flag}
            </Text>
          }
          title={name}
          accessory="check"
          selected={name === language}
          onPress={() => choose(name)}
        />
      ))}
    </SheetScreen>
  );
}

const useStyles = makeStyles(() => ({
  flag: {
    fontSize: 24,
  },
}));
