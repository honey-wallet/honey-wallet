import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { Description } from '@/components/sheets/Description';
import { Copyable } from '@/components/sheets/Details';
import { closeSheet, SHEET, SheetScreen, StatRow } from '@/components/sheets/Sheet';
import {
  approveBackendSignIn,
  approveWalletLink,
  backendSession,
  clearBackendSession,
  clearWalletLinkReview,
  forgetSavedBackendSession,
  prepareBackendSignIn,
  prepareWalletLink,
  refreshLinkedWallets,
  resumeBackendSession,
  walletLinks,
} from '@/lib/backend-session';
import { offerHandle } from '@/lib/handle-offer';
import { success, tap } from '@/lib/haptics';
import { useProfile } from '@/lib/profile';
import { showToast } from '@/lib/toast';
import { loadAccounts, type VaultAccount } from '@/lib/vault';
import { useWalletRequired } from '@/lib/wallet-gate';
import { isFixtureWallet, isMainWallet, useActiveWallet } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

const EXTENSION_TARGET = process.env.EXPO_PUBLIC_TARGET === 'extension';

const EVM_NAMES: Record<string, string> = {
  '1': 'Ethereum',
  '8453': 'Base',
  '42161': 'Arbitrum',
  '10': 'Optimism',
  '137': 'Polygon',
  '56': 'BNB Chain',
};

/** "eip155:8453" → "Base": people read network names, not CAIP ids. */
function networkName(chainId: string) {
  const [ns, ref = ''] = chainId.split(':');
  if (ns === 'eip155') return EVM_NAMES[ref] ?? 'Ethereum network';
  if (ns === 'solana') return 'Solana';
  if (ns === 'near') return 'NEAR';
  return chainId;
}

const UNLOCK = Platform.OS === 'ios' ? 'Face ID' : 'your screen lock';

/*
 * Signing in to Honey (2026-11-13: a tray like the transaction reviews, was a pushed
 * page). Opening it fetches the sign-in message so the review is ready: who signs, on
 * which network, that it approves nothing, and the message itself. Sign in confirms
 * with Face ID, signs, and ends on a success page that closes back to where you were.
 * A saved session resumes with Face ID alone. Signed in, it shows the session, linked
 * wallets and Sign out (Settings → Wallet sign-in).
 */

// Needs a wallet; browsing visitors are taken to "Get started" first (lib/wallet-gate).
export default function WalletSignInScreenRoute() {
  const walletHere = useWalletRequired('sign in to Honey');
  return walletHere ? <WalletSignInSheet /> : null;
}

function WalletSignInSheet() {
  const state = backendSession.useValue();
  // Signed in while this was open: the success page, then back to where you were.
  const signedOutAtOpen = useRef(!state.profile);
  useEffect(
    () => () => {
      if (backendSession.get().review) clearBackendSession();
    },
    [],
  );
  // Signing in is a step, not a destination: once it works the sheet just closes, back to
  // where you were, with a quiet toast (no "Signed in" page with Share and Done).
  const justSignedIn = !!state.profile && signedOutAtOpen.current;
  useEffect(() => {
    if (!justSignedIn) return;
    success();
    showToast('Signed in');
    closeSheet();
    void offerHandle();
  }, [justSignedIn]);
  if (justSignedIn) return null;
  const page = state.profile ? 'session' : 'review';
  return (
    <ContentSwap id={page} index={page === 'review' ? 0 : 1}>
      {page === 'review' ? <Review /> : <Session />}
    </ContentSwap>
  );
}

/** The wallet's face, as at the top left of every tab. */
function WalletFace({ size }: { size: number }) {
  const wallet = useActiveWallet();
  const profile = useProfile();
  return isMainWallet(wallet) ? (
    <Avatar name={wallet.label} size={size} uri={profile.photo} seed={profile.avatarSeed} />
  ) : (
    <Avatar name={wallet.label} size={size} seed={wallet.id} />
  );
}

function Review() {
  const styles = useStyles();
  const c = useTheme();
  const wallet = useActiveWallet();
  const state = backendSession.useValue();
  const eligible = !isFixtureWallet(wallet) && !wallet.watchOnly && wallet.kind === 'wallet';
  const resume = state.resumeAvailable && !state.review;

  // Fetch the message straight away, so the review is ready to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on opening.
  useEffect(() => {
    const now = backendSession.get();
    if (eligible && !now.review && !now.busy && !now.resumeAvailable) void prepareBackendSignIn();
  }, []);

  // Signing needs the message on screen first: without one, this fetches it.
  const signIn = () => {
    tap();
    if (resume) void resumeBackendSession();
    else if (state.review) void approveBackendSignIn();
    else void prepareBackendSignIn();
  };
  const label = state.busy
    ? state.review || resume
      ? 'Signing in…'
      : 'Preparing…'
    : state.error && !state.review && !resume
      ? 'Try again'
      : 'Sign in';

  return (
    <SheetScreen
      footer={
        <View style={styles.buttons}>
          {resume ? (
            <PillButton
              label="New sign-in"
              variant="secondary"
              disabled={state.busy || !eligible}
              onPress={() => {
                tap();
                void prepareBackendSignIn();
              }}
              style={styles.flex}
            />
          ) : null}
          <PillButton
            label={label}
            disabled={state.busy || !eligible}
            onPress={signIn}
            style={styles.flex}
          />
        </View>
      }
    >
      <WalletFace size={52} />
      <Text style={styles.title}>Sign in to Honey</Text>
      <Text style={styles.body}>Signing proves this wallet is yours. It can’t move funds.</Text>
      <View style={styles.rule} />
      <View style={styles.rows}>
        <StatRow
          label="Wallet"
          value={
            <Copyable value={state.review?.address ?? wallet.address} toast="Address copied" />
          }
        />
        {resume ? null : (
          <StatRow
            label="Network"
            value={
              state.review ? (
                networkName(state.review.chainId)
              ) : (
                <SkeletonBar width={80} height={14} />
              )
            }
          />
        )}
        <StatRow label="Approves" value="Nothing, sign-in only" />
      </View>
      {resume ? null : (
        // The whole message is on screen before it's signed.
        <Description
          title="Message"
          text={state.review?.challenge.message ?? ''}
          lines={3}
          background={c.sheet}
          loading={!state.review}
        />
      )}
      {!eligible ? (
        <Text style={styles.error}>Choose a wallet with keys on this device.</Text>
      ) : state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : (
        <View style={styles.hint}>
          <Icon name="faceId" size={15} color={c.textSecondary} />
          <Text style={styles.hintText}>
            {resume ? `Resumes your saved session with ${UNLOCK}.` : `Confirm with ${UNLOCK}.`}
          </Text>
        </View>
      )}
      {resume ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          disabled={state.busy}
          onPress={() => {
            tap();
            void forgetSavedBackendSession();
          }}
        >
          <Text style={styles.link}>Forget saved session</Text>
        </Pressable>
      ) : null}
    </SheetScreen>
  );
}

/** Signed in already: the session, wallets linked to it, and Sign out. */
function Session() {
  const styles = useStyles();
  const c = useTheme();
  const state = backendSession.useValue();
  const linkState = walletLinks.useValue();
  const [localAccounts, setLocalAccounts] = useState<VaultAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!state.profile?.userId) {
      setLocalAccounts([]);
      return () => {
        cancelled = true;
      };
    }
    void Promise.all([loadAccounts(), refreshLinkedWallets()])
      .then(([accounts]) => {
        if (!cancelled) setLocalAccounts(accounts);
      })
      .catch(() => {
        if (!cancelled) setLocalAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state.profile?.userId]);
  const profile = state.profile;
  if (!profile) return null;
  const linkable = localAccounts
    .filter(
      (account) =>
        !linkState.wallets.some(
          (linked) => linked.address.toLowerCase() === account.addresses.evm.toLowerCase(),
        ),
    )
    .filter(
      (account) => account.addresses.evm.toLowerCase() !== profile.wallet.address.toLowerCase(),
    );

  return (
    <SheetScreen
      footer={
        linkState.review ? (
          <View style={styles.buttons}>
            <PillButton
              label="Cancel"
              variant="secondary"
              disabled={linkState.busy}
              onPress={clearWalletLinkReview}
              style={styles.flex}
            />
            <PillButton
              label={linkState.busy ? 'Linking…' : 'Link wallet'}
              disabled={linkState.busy}
              onPress={() => void approveWalletLink()}
              style={styles.flex}
            />
          </View>
        ) : (
          <View style={styles.buttons}>
            <PillButton
              label="Sign out"
              variant="secondary"
              onPress={() => void forgetSavedBackendSession()}
              style={styles.flex}
            />
            <PillButton
              label="Done"
              onPress={() => {
                tap();
                closeSheet();
              }}
              style={styles.flex}
            />
          </View>
        )
      }
    >
      <WalletFace size={52} />
      <Text style={styles.title}>Signed in</Text>
      <Text style={styles.body}>
        Post, follow and run the agent. Payments still ask you to sign.
      </Text>
      <View style={styles.rule} />
      <View style={styles.rows}>
        <StatRow
          label="Wallet"
          value={<Copyable value={profile.wallet.address} toast="Address copied" />}
        />
        <StatRow label="Network" value={networkName(profile.wallet.chainId)} />
        <StatRow label="Ends" value={EXTENSION_TARGET ? 'After 15 minutes' : 'When Honey locks'} />
        {linkState.wallets.map((linked) => (
          <StatRow
            key={linked.id}
            label="Linked"
            value={<Copyable value={linked.address} toast="Address copied" />}
          />
        ))}
      </View>
      {linkState.review ? (
        <Description
          title="Link message"
          text={linkState.review.challenge.message}
          lines={3}
          background={c.sheet}
        />
      ) : linkable.length ? (
        <View style={styles.links}>
          {linkable.map((account) => (
            <PillButton
              key={account.id}
              label={linkState.busy ? 'Preparing link…' : `Link ${account.label}`}
              variant="secondary"
              disabled={linkState.busy}
              onPress={() => void prepareWalletLink(account)}
            />
          ))}
        </View>
      ) : null}
      {linkState.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {linkState.error}
        </Text>
      ) : null}
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  buttons: { flexDirection: 'row', gap: 10 },
  // Like the other trays' headers (Sign out): face, title, one line.
  title: {
    marginTop: 14,
    color: c.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  body: { marginTop: 4, color: c.textSecondary, fontSize: 15, lineHeight: 20 },
  // The send review's rule and rows.
  rule: { height: 1, marginTop: 18, backgroundColor: c.divider },
  rows: { paddingTop: 12, paddingBottom: 4, gap: 4 },
  hint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
    marginBottom: SHEET.footerGap - 14,
  },
  hintText: { color: c.textSecondary, fontSize: 13 },
  link: { marginBottom: 6, color: c.accentText, fontSize: 14, fontWeight: '600' },
  links: { marginTop: 12, gap: 10 },
  error: { marginTop: 16, color: c.error, fontSize: 14, lineHeight: 19 },
}));
