import { scanFromURLAsync } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  FadeIn,
  Keyframe,
  ReduceMotion,
  useReducedMotion,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { SHEET, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { createHardwareScanner, type HardwareScan, holdHardwareImport } from '@/lib/hardware-scan';
import { showErrorToast } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';

type Device = 'ledger' | 'keystone' | 'qr';

/**
 * How each device connects. Keystone and the other QR wallets show their account as a
 * QR code (the same UR standard), so they're real here; Ledger needs Bluetooth, which
 * isn't built yet, so it says so instead of pretending to search.
 */
const DEVICES: Record<
  Device,
  { name: string; qr: boolean; steps: { title: string; hint: string }[] }
> = {
  keystone: {
    name: 'Keystone',
    qr: true,
    steps: [
      { title: 'Unlock your Keystone', hint: 'Enter your PIN on the device itself.' },
      {
        title: 'Open Connect Software Wallet',
        hint: 'Find it in the menu, then choose MetaMask.',
      },
      {
        title: 'Scan its QR code',
        hint: 'Hold your phone up to it until the code fills in.',
      },
    ],
  },
  qr: {
    name: 'QR wallet',
    qr: true,
    steps: [
      { title: 'Unlock your device', hint: 'OneKey, NGRAVE, AirGap Vault and others.' },
      {
        title: 'Show your Ethereum account QR',
        hint: 'Often under Connect, Export or Sync with a wallet (MetaMask).',
      },
      { title: 'Scan its QR code', hint: 'Or take a photo of it and choose it here.' },
    ],
  },
  ledger: {
    name: 'Ledger',
    qr: false,
    steps: [
      { title: 'Unlock your Ledger', hint: 'Enter your PIN on the device itself.' },
      { title: 'Open the Ethereum app', hint: 'Pick the app for the coins you hold.' },
      { title: 'Keep Bluetooth on', hint: 'Stay close to your phone while it connects.' },
    ],
  },
};

/**
 * Steps rise in one after another (40ms apart) after the headline: a rare setup flow,
 * so they get the longer 400ms on a strong ease-out. Under Reduce Motion only the fade
 * remains (Reanimated would otherwise skip it entirely).
 */
const rise = (i: number, reduced: boolean) =>
  reduced
    ? FadeIn.duration(DURATION.fast)
        .delay(DURATION.stagger * (i + 2))
        .reduceMotion(ReduceMotion.Never)
    : new Keyframe({
        0: { opacity: 0, transform: [{ translateY: DISTANCE.medium }] },
        100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
      })
        .duration(DURATION.verySlow)
        .delay(DURATION.stagger * (i + 2));

/**
 * Connect a hardware wallet (`device=keystone|qr|ledger`): its steps, then scan its
 * account code (camera or a photo of it) into the account picker.
 */
export default function HardwareWalletSheet() {
  const reduceMotion = useReducedMotion();
  const styles = useStyles();
  const c = useTheme();
  const params = useLocalSearchParams<{ device?: Device }>();
  // Keystone (which works today) unless a device was asked for; Ledger only by name.
  const device: Device =
    params.device === 'ledger' || params.device === 'qr' ? params.device : 'keystone';
  const { name, qr, steps } = DEVICES[device];
  const [reading, setReading] = useState(false);

  const scan = () => {
    tap();
    router.replace({ pathname: '/scan', params: { purpose: 'hardware' } });
  };

  // A photo or screenshot of the code: works for single-frame codes (an animated one
  // needs the camera).
  const photo = async () => {
    tap();
    let picked: ImagePicker.ImagePickerResult;
    try {
      picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
    } catch {
      showErrorToast('Couldn’t open your photos. Check Honey’s photo access in Settings');
      return;
    }
    if (picked.canceled) return;
    setReading(true);
    try {
      const codes = await scanFromURLAsync(picked.assets[0].uri, ['qr']);
      const scanner = createHardwareScanner();
      let last: HardwareScan = { state: 'scanning', progress: 0 };
      for (const code of codes) {
        last = scanner.feed(code.data);
        if (last.state !== 'scanning') break;
      }
      if (last.state === 'done') {
        holdHardwareImport(last.result);
        router.replace('/hardware-accounts');
      } else if (last.state === 'error') {
        showErrorToast(last.message);
      } else if (last.foreign) {
        showErrorToast('That isn’t an account code. On the device, pick Connect Software Wallet');
      } else {
        showErrorToast(
          codes.length ? 'That code animates. Scan it with the camera' : 'No QR code found',
        );
      }
    } catch {
      // Unreadable image (format, a cloud photo not downloaded): say so, never crash.
      showErrorToast('Couldn’t read that image. Try a screenshot of the code');
    } finally {
      setReading(false);
    }
  };

  return (
    <SheetScreen>
      <View style={styles.hero}>
        <View style={styles.tile}>
          <Icon name="hardware" size={26} color={c.accentText} />
        </View>
        <TextsReveal
          id="hardware"
          align="center"
          first={<Text style={styles.title}>Connect {name}</Text>}
          second={
            <Text style={styles.subtitle}>
              {qr
                ? `Your keys never leave your ${name}. Honey reads its public address only.`
                : `Approve every transaction on your ${name}. Your keys never touch your phone.`}
            </Text>
          }
        />
      </View>

      <View style={styles.steps}>
        {steps.map((step, i) => (
          <Animated.View key={step.title} entering={rise(i, reduceMotion)} style={styles.step}>
            <View style={styles.number}>
              <Text style={styles.numberLabel}>{i + 1}</Text>
            </View>
            <View style={styles.flex}>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.stepHint}>{step.hint}</Text>
            </View>
          </Animated.View>
        ))}
      </View>

      {qr ? (
        // The main action last, at the bottom (the photo option above it).
        <View style={styles.actions}>
          <PillButton
            label={reading ? 'Reading…' : 'Choose a photo of the code'}
            variant="secondary"
            disabled={reading}
            onPress={photo}
          />
          <PillButton label="Scan QR code" onPress={scan} />
        </View>
      ) : (
        <View style={styles.actions}>
          <View style={styles.notice}>
            <Icon name="info" size={16} color={c.textSecondary} />
            <Text style={styles.noticeText}>Honey connects to Keystone and other QR wallets.</Text>
          </View>
          <PillButton
            label="Connect a QR wallet"
            onPress={() => {
              tap();
              router.setParams({ device: 'keystone' });
            }}
          />
        </View>
      )}
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  hero: {
    alignItems: 'center',
    gap: 14,
  },
  tile: {
    width: 60,
    height: 60,
    ...radius(18),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  title: {
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  steps: {
    marginTop: 22,
    gap: 16,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
  },
  number: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
  numberLabel: {
    color: c.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  stepTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  stepHint: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  actions: {
    marginTop: SHEET.footerGap + 4,
    gap: 10,
  },
  notice: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  noticeText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
}));
