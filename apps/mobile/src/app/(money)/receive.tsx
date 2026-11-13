import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { ChainPicker } from '@/components/wallet/ChainPicker';
import { LabeledRule, TokenIcon } from '@/components/wallet/parts';
import { QRCode } from '@/components/wallet/QRCode';
import { useCopy } from '@/lib/copy';
import { demoLabel } from '@/lib/demo-money-copy';
import { tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import { isWeb } from '@/lib/platform';
import { useArrivalToast } from '@/lib/portfolio-arrival';
import { useProfile } from '@/lib/profile';
import { type ReceiveAddress, receiveAddresses } from '@/lib/receive';
import { useWalletRequired } from '@/lib/wallet-gate';
import { isMainWallet, useActiveWallet } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';

/** Receive sheet: your address to copy or show as a QR code. */
// Needs a wallet; browsing visitors are taken to "Get started" first (lib/wallet-gate).
export default function ReceiveSheetRoute() {
  const walletHere = useWalletRequired('receive crypto');
  return walletHere ? <ReceiveSheet /> : null;
}

function ReceiveSheet() {
  const styles = useStyles();
  const c = useTheme();
  const profile = useProfile();
  const wallet = useActiveWallet();
  // While this is open, watch the chain and say when a deposit lands.
  useArrivalToast(wallet);
  const isMain = isMainWallet(wallet);
  const [showExchange, setShowExchange] = useState(false);
  // Wallets with keys here have an address per chain; list them all, labelled.
  const list = receiveAddresses(wallet);
  const address = list[0]?.address ?? '';
  const { copied, copy } = useCopy(address);
  const perChain = list.length > 1;

  if (!list.length)
    return (
      <SheetScreen title={demoLabel('Demo wallet', 'Receive crypto')}>
        <Text style={{ color: c.text }}>Create or import a wallet before receiving funds.</Text>
      </SheetScreen>
    );

  return (
    <SheetScreen title="Receive crypto">
      <SheetText lead>
        {perChain
          ? // review: shorter in the 600px-tall extension popup, so the exchange steps fit.
            isWeb
            ? 'Pick the network you’re sending on. Each has its own address.'
            : 'Which network are you sending on? Each one has its own address.'
          : 'Fund your wallet by transferring crypto from another wallet or account'}
      </SheetText>

      {perChain ? (
        // The network first, then its address and QR code (My QR), so the address you
        // copy is the right one. Before: every chain's address listed here (AddressRow).
        <View style={styles.firstCard}>
          <ChainPicker
            entries={list}
            onPick={(chain) => router.push({ pathname: '/my-qr', params: { chain } })}
          />
        </View>
      ) : (
        <View style={[styles.card, styles.firstCard]}>
          {isMain ? (
            <Avatar name={profile.name} size={44} uri={profile.photo} seed={profile.avatarSeed} />
          ) : (
            <Avatar name={wallet.label} size={44} seed={wallet.id} />
          )}
          <View style={styles.flex}>
            <Text style={styles.name}>{wallet.label}</Text>
            <Text style={styles.address}>{shortAddress(address, 6, 4)}</Text>
          </View>
          <PressableScale
            accessibilityLabel="Copy address"
            scaleTo={0.97}
            onPress={copy}
            style={styles.round}
          >
            <IconSwap name={copied ? 'check' : 'copy'} size={15} color={c.text} />
          </PressableScale>
          <PressableScale
            accessibilityLabel="Show QR code"
            scaleTo={0.97}
            onPress={() => {
              tap();
              router.push('/my-qr');
            }}
            style={styles.round}
          >
            <Icon name="qr" size={15} color={c.text} />
          </PressableScale>
        </View>
      )}

      <LabeledRule label="From an account" />
      {/* The card holds the fill: PressableRow paints its own pressed background. */}
      <View style={styles.exchangeCard}>
        <PressableRow
          accessibilityState={{ expanded: showExchange }}
          onPress={() => {
            tap();
            setShowExchange((v) => !v);
          }}
          style={[styles.exchangeRow, isWeb && styles.exchangeRowWeb]}
        >
          <View style={[styles.exchange, isWeb && styles.exchangeWeb]}>
            <Icon name="bank" size={18} color={c.accentText} />
          </View>
          <Text style={[styles.name, styles.flex]}>From an exchange</Text>
          <AccordionChevron open={showExchange} size={13} color={c.textSecondary} />
        </PressableRow>
      </View>
      <Accordion open={showExchange}>
        <ExchangeSteps list={list} />
      </Accordion>
    </SheetScreen>
  );
}

/**
 * Withdrawing from an exchange: pick the network, then the exchange needs this exact
 * address, so it's shown as a QR code to scan (bare address: exchange scanners don't
 * read payment URIs) with the full text to copy, then the steps.
 */
function ExchangeSteps({ list }: { list: ReceiveAddress[] }) {
  const styles = useStyles();
  const c = useTheme();
  const [family, setFamily] = useState(list[0]?.family);
  const entry = list.find((e) => e.family === family) ?? list[0];
  const { copied, copy } = useCopy(entry?.address ?? '');
  if (!entry) return null;
  const perChain = list.length > 1;
  const half = Math.ceil(entry.address.length / 2);
  const steps = [
    // A watched wallet is someone else's: not "your" address.
    perChain ? 'Pick the network you’ll withdraw on.' : `Send to this ${entry.title} address.`,
    'In your exchange, choose Withdraw. Scan this code or paste the address.',
    `Choose ${entry.title} as the network, then confirm. Funds usually arrive in minutes.`,
  ];
  return (
    <View style={[styles.steps, isWeb && styles.stepsWeb]}>
      <ExchangeStep n={1} text={steps[0] as string} />
      {perChain ? (
        <View style={styles.chips}>
          {list.map((e) => {
            const on = e.family === entry.family;
            return (
              <PressableScale
                key={e.family}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                scaleTo={0.96}
                onPress={() => {
                  tap();
                  setFamily(e.family);
                }}
                style={[styles.chip, on && styles.chipOn]}
              >
                <TokenIcon symbol={e.symbol} size={20} />
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{e.title}</Text>
              </PressableScale>
            );
          })}
        </View>
      ) : null}
      <View style={styles.qrCard}>
        <View style={styles.qrWell}>
          <QRCode
            value={entry.address}
            size={isWeb ? 132 : 176}
            color="#111111"
            center={
              <View style={styles.qrCenter}>
                <TokenIcon symbol={entry.symbol} size={isWeb ? 26 : 34} />
              </View>
            }
          />
        </View>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Copy ${entry.title} address`}
          scaleTo={0.98}
          onPress={copy}
          style={styles.qrAddress}
        >
          <Text style={[styles.qrAddressText, styles.flex]}>
            {`${entry.address.slice(0, half)}\n${entry.address.slice(half)}`}
          </Text>
          <IconSwap name={copied ? 'check' : 'copy'} size={15} color={c.text} />
        </PressableScale>
      </View>
      <ExchangeStep n={2} text={steps[1] as string} />
      <ExchangeStep n={3} text={steps[2] as string} />
    </View>
  );
}

/** One numbered step of withdrawing from an exchange. */
function ExchangeStep({ n, text }: { n: number; text: string }) {
  const styles = useStyles();
  return (
    <View style={styles.step}>
      <Text style={styles.stepNumber}>{n}</Text>
      <Text style={[styles.stepText, styles.flex]}>{text}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  card: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    ...radius(20),
    backgroundColor: c.card,
  },
  firstCard: {
    marginTop: 8,
  },
  name: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  address: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  round: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  steps: {
    paddingTop: 14,
    gap: 12,
  },
  step: {
    flexDirection: 'row',
    gap: 12,
  },
  stepNumber: {
    width: 22,
    height: 22,
    borderRadius: 11,
    overflow: 'hidden',
    textAlign: 'center',
    lineHeight: 22,
    color: c.accentText,
    backgroundColor: c.accentSurface,
    fontSize: 13,
    fontWeight: '600',
  },
  stepText: {
    color: c.text,
    fontSize: 15,
    lineHeight: 21,
  },
  exchangeCard: {
    ...radius(20),
    overflow: 'hidden',
    backgroundColor: c.card,
  },
  exchangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  // review: a tighter exchange row and steps in the extension popup.
  exchangeRowWeb: {
    paddingVertical: 10,
  },
  exchangeWeb: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  stepsWeb: {
    paddingTop: 10,
    gap: 8,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingLeft: 8,
    paddingRight: 12,
    borderRadius: 18,
    backgroundColor: c.card,
  },
  chipOn: {
    backgroundColor: c.accentSurface,
  },
  chipText: {
    color: c.textSecondary,
    fontSize: 14,
    fontWeight: '500',
  },
  chipTextOn: {
    color: c.text,
  },
  qrCard: {
    alignItems: 'center',
    gap: 12,
    padding: 14,
    ...radius(20),
    backgroundColor: c.card,
  },
  // Always dark-on-white, in dark mode too, so every exchange's scanner reads it.
  qrWell: {
    padding: 12,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
  },
  qrCenter: {
    padding: 3,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
  },
  qrAddress: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: c.raised,
  },
  qrAddressText: {
    color: c.text,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  exchange: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
}));
