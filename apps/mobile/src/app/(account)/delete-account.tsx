import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Checkbox } from '@/components/motion/Checkbox';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen } from '@/components/sheets/Sheet';
import { deleteAccount } from '@/lib/account-deletion';
import { confirmOwner } from '@/lib/auth';
import { failure, tap } from '@/lib/haptics';
import { RecentSignInRequired } from '@/lib/identity';
import { showErrorToast } from '@/lib/toast';
import { Gate } from '@/lib/warnings';
import { makeStyles, useTheme } from '@/theme';

const POLICY_URL = 'https://honeywallet.org/delete-account';

/** Settings → Delete account: the server's data, the sign-in account, and this device. */
export default function DeleteAccountSheet() {
  const styles = useStyles();
  const c = useTheme();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!saved || busy) return;
    tap();
    setBusy(true);
    try {
      if (!(await confirmOwner('Delete your Honey account', false))) {
        setBusy(false);
        return;
      }
      await deleteAccount();
    } catch (error) {
      failure();
      setBusy(false);
      showErrorToast(
        error instanceof RecentSignInRequired
          ? 'Sign in again, then delete your account'
          : 'Couldn’t delete your account. Try again.',
      );
    }
  };

  return (
    <SheetScreen>
      <Gate id="deleteAccountRecoveryWarning">
        <View style={styles.tile}>
          <Icon name="warning" size={22} color={c.error} />
        </View>
      </Gate>
      <Text style={styles.title}>Delete your account?</Text>
      <Gate id="deleteAccountRecoveryWarning">
        <Text style={styles.body}>
          Deleting Honey does not delete your funds, which stay on the blockchain. But without your
          recovery phrase, nobody, including us, can restore access to them.
        </Text>
      </Gate>
      <Text style={styles.body}>
        We delete your waitlist email, your sign-in account and the data our servers hold for it,
        then your wallets, keys, settings and profile on this device. Transactions on public
        blockchains are permanent and can’t be deleted.
      </Text>
      <Text style={styles.link} onPress={() => Linking.openURL(POLICY_URL).catch(() => {})}>
        What we delete
      </Text>
      <View style={styles.check}>
        <Checkbox
          label="I’ve saved my recovery phrase or an encrypted backup and its password"
          checked={saved}
          onChange={setSaved}
        />
      </View>
      <View style={styles.buttons}>
        <PillButton label="Cancel" variant="secondary" onPress={closeSheet} style={styles.flex} />
        <PillButton
          label={busy ? 'Deleting…' : 'Delete'}
          variant="danger"
          disabled={!saved || busy}
          onPress={confirm}
          style={styles.flex}
        />
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  tile: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${c.error}1F`,
  },
  title: { marginTop: 14, color: c.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.2 },
  body: { marginTop: 8, color: c.textSecondary, fontSize: 15, lineHeight: 20 },
  link: { marginTop: 14, color: c.accentText, fontSize: 15, fontWeight: '600' },
  check: { marginTop: 16 },
  buttons: { marginTop: 24, flexDirection: 'row', gap: 10 },
}));
