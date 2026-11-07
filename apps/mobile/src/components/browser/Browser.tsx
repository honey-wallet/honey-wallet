import { PHONE_PROVIDER } from '@honey-wallet/extension/phone';
import { getRandomBytes } from 'expo-crypto';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Share, Text, TextInput, View } from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import {
  canLoad,
  hostOfUrl,
  keyScript,
  newKey,
  onSiteEvent,
  originOf,
  readMessage,
  replyScript,
  toProviderError,
  toUrl,
} from '@/lib/browser';
import { tap } from '@/lib/haptics';
import { goBackOr } from '@/lib/navigation';
import { showErrorToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

/**
 * The in-app browser: websites see Honey the way they do in Chrome (an EIP-1193 provider
 * and a Solana wallet), and every connect, signature and transaction comes to the same
 * approval screen as WalletConnect's. Plumbing in lib/browser.ts.
 */
export function Browser({ url: start }: { url: string }) {
  const styles = useStyles();
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  // One key per site, made the first time it says hello (lib/browser.ts).
  const keys = useRef(new Map<string, string>());
  const [nav, setNav] = useState({ url: start, canGoBack: false, canGoForward: false });
  const [progress, setProgress] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const current = useRef(start);

  // Account and network changes for the site on screen.
  useEffect(
    () =>
      onSiteEvent((origin, reply) => {
        if (originOf(current.current) === origin)
          web.current?.injectJavaScript(replyScript(origin, reply));
      }),
    [],
  );

  const onMessage = async ({ nativeEvent }: WebViewMessageEvent) => {
    const message = readMessage(nativeEvent.data, nativeEvent.url, (o) => keys.current.get(o));
    if (!message) return;
    const { origin } = message;
    if (message.kind === 'hello') {
      let key = keys.current.get(origin);
      if (!key) {
        key = newKey(getRandomBytes(16));
        keys.current.set(origin, key);
      }
      web.current?.injectJavaScript(keyScript(origin, key));
      return;
    }
    const { request } = message;
    const { wcRouter } = await import('@/lib/walletconnect');
    const reply = await wcRouter
      .fromPage(origin, `${origin}/favicon.ico`, request)
      .then((result) => ({ id: request.id, result: result ?? null }))
      .catch((error: unknown) => ({ id: request.id, error: toProviderError(error) }));
    web.current?.injectJavaScript(replyScript(origin, reply));
  };

  const onNavigation = (state: WebViewNavigation) => {
    current.current = state.url;
    setNav({ url: state.url, canGoBack: state.canGoBack, canGoForward: state.canGoForward });
  };

  const open = (text: string) => {
    const next = toUrl(text);
    if (!next) {
      showErrorToast('Enter a website address');
      return;
    }
    setEditing(null);
    web.current?.injectJavaScript(`location.href=${JSON.stringify(next)};true;`);
  };

  const origin = originOf(nav.url);
  const secure = origin?.startsWith('https://') ?? false;
  const bar = useAnimatedStyle(() => ({
    width: `${progress * 100}%`,
    opacity: withTiming(progress < 1 ? 1 : 0, { duration: DURATION.medium }),
  }));

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.top}>
        <HeaderShortcut icon="close" label="Close browser" onPress={() => goBackOr('/home')} />
        {editing === null ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Address, ${hostOfUrl(nav.url)}. Edit`}
            scaleTo={0.98}
            onPress={() => {
              tap();
              setEditing(nav.url);
            }}
            style={styles.address}
          >
            <Icon
              name={secure ? 'lock' : 'warning'}
              size={13}
              color={secure ? c.textSecondary : c.error}
            />
            <Text style={styles.host} numberOfLines={1}>
              {hostOfUrl(nav.url)}
            </Text>
          </PressableScale>
        ) : (
          <View style={styles.address}>
            <TextInput
              value={editing}
              onChangeText={setEditing}
              onSubmitEditing={() => open(editing)}
              onBlur={() => setEditing(null)}
              autoFocus
              selectTextOnFocus
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              placeholder="Website address"
              placeholderTextColor={c.placeholder}
              selectionColor={c.primary}
              accessibilityLabel="Website address"
              style={styles.input}
            />
          </View>
        )}
        <HeaderShortcut icon="refresh" label="Reload" onPress={() => web.current?.reload()} />
      </View>
      <View style={styles.track}>
        <Animated.View style={[styles.progress, bar]} />
      </View>

      <WebView
        ref={web}
        source={{ uri: start }}
        style={styles.web}
        injectedJavaScriptBeforeContentLoaded={PHONE_PROVIDER}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        onMessage={onMessage}
        onNavigationStateChange={onNavigation}
        onLoadProgress={({ nativeEvent }) => setProgress(nativeEvent.progress)}
        onShouldStartLoadWithRequest={(request) => canLoad(request.url)}
        originWhitelist={['http://*', 'https://*']}
        // Links that open a new window open here instead.
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        allowFileAccess={false}
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction
        pullToRefreshEnabled
        webviewDebuggingEnabled={__DEV__}
      />

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 6 }]}>
        <Tool
          icon="chevronLeft"
          label="Back"
          disabled={!nav.canGoBack}
          onPress={() => web.current?.goBack()}
        />
        <Tool
          icon="chevronRight"
          label="Forward"
          disabled={!nav.canGoForward}
          onPress={() => web.current?.goForward()}
        />
        <Tool
          icon="share"
          label="Share"
          onPress={() => void Share.share({ url: nav.url, message: nav.url }).catch(() => {})}
        />
        <Tool
          icon="globe"
          label="Connected sites"
          onPress={() => router.push('/connected-sites')}
        />
      </View>
    </View>
  );
}

function Tool({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: 'chevronLeft' | 'chevronRight' | 'share' | 'globe';
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      scaleTo={0.97}
      onPress={() => {
        tap();
        onPress();
      }}
      style={styles.tool}
    >
      <Icon name={icon} size={22} color={disabled ? c.disabledText : c.textSecondary} />
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  screen: {
    flex: 1,
    backgroundColor: c.canvas,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  address: {
    flex: 1,
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  host: {
    flexShrink: 1,
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
  input: {
    flex: 1,
    height: '100%',
    color: c.text,
    fontSize: 15,
  },
  track: {
    height: 2,
  },
  progress: {
    height: 2,
    backgroundColor: c.primary,
  },
  web: {
    flex: 1,
    backgroundColor: c.canvas,
  },
  bottom: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 6,
    backgroundColor: c.canvas,
  },
  tool: {
    width: 48,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
