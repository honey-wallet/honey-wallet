import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { LANDING } from '@/lib/surface';
import { showToast } from '@/lib/toast';
import { pairWalletConnect, walletConnectRelayError } from '@/lib/walletconnect';
import {
  isWalletConnectUri,
  pairingErrorMessage,
  takeWalletConnectUri,
} from '@/lib/walletconnect-uri';
import { makeStyles, useTheme } from '@/theme';

/** WalletConnect's link parameters, which the router splits off `uri` when it decodes it. */
const WC_KEYS = ['expiryTimestamp', 'relay-protocol', 'relay-data', 'symKey', 'methods'];

type State = { kind: 'connecting' } | { kind: 'error'; message: string; detail?: string };

/**
 * honeywallet://wc?uri=… : how a site on the phone hands a WalletConnect link to Honey
 * (the "open in wallet" button). The link handler (+native-intent) reads the whole link
 * and holds it; the router's own `uri` param stops at the first `&`. Pairing only starts
 * the conversation; the site still has to be approved in the approval screen.
 *
 * Always a screen: "Connecting", then on to the approval (the site's proposal opens it)
 * or a plain reason it didn't work. Before, it redirected at once, so a failed or silent
 * pairing (the relay refusing the app, say) left the user with nothing.
 */
export default function WalletConnectLink() {
  const styles = useStyles();
  const c = useTheme();
  const params = useLocalSearchParams<Record<string, string>>();
  const [uri] = useState(() => {
    const rebuilt = params.uri
      ? [params.uri, ...WC_KEYS.filter((k) => params[k]).map((k) => `${k}=${params[k]}`)].join(
          params.uri.includes('?') ? '&' : '?',
        )
      : null;
    return takeWalletConnectUri() ?? rebuilt;
  });
  const valid = !!uri && isWalletConnectUri(uri);
  const [state, setState] = useState<State>(() =>
    valid
      ? { kind: 'connecting' }
      : { kind: 'error', message: 'This isn’t a WalletConnect link. Get a new one from the site' },
  );
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const connect = useCallback(() => {
    if (!uri || !isWalletConnectUri(uri)) return;
    setState({ kind: 'connecting' });
    pairWalletConnect(uri)
      .then(() => {
        if (!live.current) return;
        // The site's proposal opens the approval screen over the landing tab.
        showToast('Waiting for the site…');
        router.replace(LANDING);
      })
      .catch((error) => {
        if (!live.current) return;
        const relay = walletConnectRelayError();
        const raw = error instanceof Error ? error.message : String(error ?? '');
        const message = pairingErrorMessage(relay && /timeout/i.test(raw) ? relay : error);
        // Builds for testing say exactly why (e.g. the app isn't on the project's allowlist).
        setState({ kind: 'error', message, detail: __DEV__ ? relay || raw : undefined });
      });
  }, [uri]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pair once when the screen opens.
  useEffect(() => {
    connect();
  }, []);

  const close = () => {
    tap();
    router.replace(LANDING);
  };

  if (state.kind === 'connecting')
    return (
      <SheetScreen
        title="Connecting"
        footer={<PillButton label="Cancel" variant="secondary" onPress={close} />}
      >
        <View style={styles.center}>
          <ActivityIndicator color={c.textSecondary} />
          <SheetText>Setting up a secure connection with the site.</SheetText>
        </View>
      </SheetScreen>
    );

  return (
    <SheetScreen
      title="Couldn’t connect"
      footer={
        <View style={styles.footer}>
          {valid ? <PillButton label="Close" variant="secondary" onPress={close} /> : null}
          <PillButton
            label={valid ? 'Try again' : 'Close'}
            onPress={() => {
              tap();
              if (valid) connect();
              else router.replace(LANDING);
            }}
          />
        </View>
      }
    >
      <View style={styles.center}>
        <View style={styles.well}>
          <Icon name="link" size={20} color={c.textSecondary} />
        </View>
        <SheetText>{`${state.message}.`}</SheetText>
        {state.detail ? <Text style={styles.detail}>{state.detail}</Text> : null}
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  center: { alignItems: 'center', gap: 12, paddingVertical: 12 },
  well: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  detail: { color: c.textSecondary, fontSize: 12, textAlign: 'center' },
  footer: { gap: 10 },
}));
