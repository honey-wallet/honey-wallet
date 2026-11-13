import { parsePairUri } from '@honey-wallet/keyring';
import { CameraView, scanFromURLAsync, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { SCREEN } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { createHardwareScanner, holdHardwareImport } from '@/lib/hardware-scan';
import { holdScannedKey } from '@/lib/key-scan';
import { goBackOr } from '@/lib/navigation';
import { holdScannedOffer, offerDirection } from '@/lib/pair-offer';
import { LANDING } from '@/lib/surface';
import { showErrorToast, showToast } from '@/lib/toast';
import { isWalletConnectUri, pairWalletConnect } from '@/lib/walletconnect';
import { pairingErrorMessage } from '@/lib/walletconnect-uri';
import { isEvmAddress } from '@/lib/wallets';
import { holdWatchedAddress } from '@/lib/watch-scan';
import { makeStyles, useTheme } from '@/theme';

const FRAME = 260;
const CORNER = 44;

/** Full-screen QR scanner. The camera needs a real device; simulators show the frame only. */
export default function ScanScreen() {
  const { purpose } = useLocalSearchParams<{ purpose?: string }>();
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);
  // A hardware wallet's account code may animate over many frames: keep reading them.
  const hardware = useRef(purpose === 'hardware' ? createHardwareScanner() : null);
  const [progress, setProgress] = useState<number | null>(null);
  const [foreign, setForeign] = useState(false);
  const lastError = useRef({ message: '', at: 0 });

  /**
   * A code from the camera or a photo: a browser's pairing code opens pairing; a
   * WalletConnect code connects that site (it then asks in the approval screen);
   * anything else is an address, so go straight to sending to it.
   */
  const onCode = (data: string) => {
    if (handled.current) return;
    if (hardware.current) {
      const scan = hardware.current.feed(data);
      if (scan.state === 'scanning') {
        // Another kind of QR (an address, a link) in view: say what to point at.
        setForeign(!!scan.foreign && !(scan.progress > 0));
        if (scan.progress > 0) setProgress(scan.progress);
        return;
      }
      if (scan.state === 'error') {
        // Toast once per message (the camera sees each frame many times), not forever:
        // a different problem, or the same one after a fresh start, shows again.
        const now = Date.now();
        if (lastError.current.message !== scan.message || now - lastError.current.at > 4000)
          showErrorToast(scan.message);
        lastError.current = { message: scan.message, at: now };
        setProgress(null);
        return;
      }
      handled.current = true;
      tap();
      holdHardwareImport(scan.result);
      router.replace('/hardware-accounts');
      return;
    }
    handled.current = true;
    tap();
    if (purpose === 'watch') {
      const address = data.replace(/^ethereum:/i, '').split(/[?@]/)[0];
      if (!isEvmAddress(address)) {
        showErrorToast('Not an EVM address');
        handled.current = false;
        return;
      }
      holdWatchedAddress(address);
      router.back();
      return;
    }
    // From Import with a private key: hand the key back in memory, never as a param.
    if (purpose === 'key') {
      const key = data.trim();
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
        showErrorToast('Not a private key');
        handled.current = false;
        return;
      }
      holdScannedKey(key);
      router.back();
      return;
    }
    // From onboarding (no wallet yet): only Honey for Chrome's "Send wallet to phone" code.
    if (purpose === 'pair') {
      if (offerDirection(data) !== 'toPhone') {
        showToast('Send it from the extension');
        handled.current = false;
        return;
      }
      holdScannedOffer(data);
      router.replace({ pathname: '/pair-extension', params: { onboarding: '1' } });
      return;
    }
    // From the setup checklist: only Honey for Chrome's "Pair with your phone" code.
    if (purpose === 'extension' && offerDirection(data) !== 'toBrowser') {
      showToast('Pair from the extension');
      handled.current = false;
      return;
    }
    if (isWalletConnectUri(data)) {
      router.back();
      showToast('Connecting…');
      pairWalletConnect(data.trim()).catch((error) => showErrorToast(pairingErrorMessage(error)));
      return;
    }
    if (parsePairUri(data)) {
      // Passed in memory, not as a route param, so only this scanner can start pairing.
      holdScannedOffer(data);
      router.replace('/pair-extension');
      return;
    }
    showToast('Address scanned');
    // Payment links look like "ethereum:0xabc…@1?value=…"; keep just the address.
    const to = data.replace(/^[a-z]+:/i, '').split(/[?@]/)[0] || data;
    router.replace({ pathname: '/send-amount', params: { to } });
  };

  const scanPhoto = async () => {
    tap();
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
    if (picked.canceled) return;
    const [code] = await scanFromURLAsync(picked.assets[0].uri, ['qr']);
    if (code) onCode(code.data);
    else showErrorToast('No QR code found');
  };

  const close = () => goBackOr(LANDING);

  return (
    <View style={styles.root}>
      {permission?.granted && (
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => onCode(data)}
        />
      )}
      <View style={styles.dim} />

      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <PressableScale
          accessibilityLabel="Close"
          hitSlop={10}
          scaleTo={0.97}
          onPress={close}
          style={styles.close}
        >
          <Icon name="close" size={16} color="#FFFFFF" />
        </PressableScale>
      </View>

      <View style={styles.center}>
        <TextsReveal
          id="scan"
          align="center"
          first={
            <Text style={styles.title}>
              {/* {purpose === 'pair' || purpose === 'extension'
                ? 'Scan the code in the browser extension'
                : 'Scan a QR code'} */}
              {purpose === 'pair' || purpose === 'extension'
                ? 'Scan the extension’s code'
                : purpose === 'hardware'
                  ? 'Scan your wallet’s code'
                  : 'Scan a QR code'}
            </Text>
          }
          // One short line under it, centred, instead of a two-line title (review).
          second={
            purpose === 'pair' || purpose === 'extension' ? (
              <Text style={styles.hint}>
                It’s in Honey in your browser, under Pair with your phone.
              </Text>
            ) : purpose === 'hardware' ? (
              <Text style={styles.hint}>
                {progress != null && progress > 0
                  ? `Keep it in view… ${Math.round(progress * 100)}%`
                  : foreign
                    ? 'That’s a different kind of code. On the device, open Connect Software Wallet and show its code.'
                    : 'Hold steady. Animated codes take a few seconds.'}
              </Text>
            ) : undefined
          }
        />
        <View style={styles.frame}>
          {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
            <View key={corner} style={[styles.corner, styles[corner]]} />
          ))}
          {/* Nothing until the permission is known, so "Allow camera" doesn't flash up
              for someone who already allowed it. Once iOS stops asking, only Settings can. */}
          {permission && !permission.granted && (
            <View style={styles.permission}>
              <Text style={styles.permissionText}>
                {permission.canAskAgain
                  ? 'Honey needs your camera to scan codes.'
                  : 'Camera access is off. Turn it on in Settings to scan codes.'}
              </Text>
              <PillButton
                label={permission.canAskAgain ? 'Allow camera' : 'Open Settings'}
                onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()}
                style={styles.permissionButton}
              />
            </View>
          )}
        </View>
        <PressableScale
          accessibilityLabel="Choose from photos"
          scaleTo={0.97}
          onPress={scanPhoto}
          style={styles.photo}
        >
          <Icon name="photo" size={18} color="#FFFFFF" />
          <Text style={styles.photoLabel}>Choose from photos</Text>
        </PressableScale>
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + SCREEN.footerBottom }]}>
        {/* No wallet yet while onboarding, so no QR code of yours to show. */}
        {purpose === 'pair' ? null : (
          <PressableScale
            onPress={() => {
              tap();
              // From the scanner, My QR offers a way back to scanning.
              router.replace({ pathname: '/my-qr', params: { from: 'scan' } });
            }}
            style={styles.myQr}
          >
            <Icon name="qr" size={18} color={c.text} />
            <Text style={styles.myQrLabel}>Show my QR code</Text>
          </PressableScale>
        )}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  dim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  top: {
    paddingHorizontal: 20,
  },
  close: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
  },
  title: {
    paddingHorizontal: 32,
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '600',
    textAlign: 'center',
  },
  hint: {
    marginTop: 8,
    paddingHorizontal: 40,
    color: 'rgba(255,255,255,0.7)',
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  frame: {
    width: FRAME,
    height: FRAME,
    alignItems: 'center',
    justifyContent: 'center',
  },
  corner: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    borderColor: '#FFFFFF',
  },
  tl: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 24 },
  tr: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 24 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 24 },
  br: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 24,
  },
  permission: {
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 24,
  },
  permissionText: {
    color: '#FFFFFF',
    fontSize: 15,
    textAlign: 'center',
  },
  permissionButton: {
    paddingHorizontal: 22,
  },
  // A labelled pill, so it says what it does (review: cleaner scanner).
  photo: {
    flexDirection: 'row',
    gap: 8,
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  photoLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  bottom: {
    alignItems: 'center',
  },
  myQr: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 52,
    paddingHorizontal: 22,
    borderRadius: 26,
    backgroundColor: c.raised,
  },
  myQrLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
}));
