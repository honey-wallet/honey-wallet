import { Linking, Text } from 'react-native';
import { SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { buildInfo } from '@/lib/build-info';
import { tap } from '@/lib/haptics';
import { leaveSheetTo } from '@/lib/navigation';
import { makeStyles } from '@/theme';

const PRIVACY_URL = 'https://honeywallet.org/privacy';
const TERMS_URL = 'https://honeywallet.org/terms';

/** Legal links, plus the app version. */
export default function AboutSheet() {
  const styles = useStyles();

  const open = (url: string) => {
    tap();
    Linking.openURL(url);
  };

  return (
    <SheetScreen title="About">
      <SheetRow
        icon="lock"
        title="Privacy Policy"
        accessory="chevron"
        onPress={() => open(PRIVACY_URL)}
      />
      <SheetRow
        icon="book"
        title="Terms of Service"
        accessory="chevron"
        onPress={() => open(TERMS_URL)}
      />
      <SheetRow
        icon="recovery"
        title="Disclosures"
        accessory="chevron"
        onPress={() => {
          tap();
          leaveSheetTo('/disclosures');
        }}
      />
      <Text style={styles.version}>{buildInfo()}</Text>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  version: {
    marginTop: 18,
    color: c.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
}));
