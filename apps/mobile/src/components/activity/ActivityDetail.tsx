// Activity's detail, as Uniswap's (2026-11-14): a sheet over the list with a grabber, a
// header row (the token's face, what happened, when, and a ••• menu), the amount large
// and centred with its dollar value, then plain label/value rows. Built from Honey's
// tray frame (SheetScreen), StatRow and ActionMenu.
import type { ReactNode } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { type Action, ActionMenu } from '@/components/motion/ActionMenu';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { SheetScreen } from '@/components/sheets/Sheet';
import { useCopy } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import { makeStyles, useTheme } from '@/theme';

/** "November 14, 2026 1:08 PM". */
export const fullDate = (ms: number) => {
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} ${time}`;
};

export function DetailSheet({
  id,
  face,
  title,
  date,
  actions,
  amount,
  value,
  status,
  footer,
  children,
}: {
  /** Replays the amount's reveal when another transaction opens in the same sheet. */
  id: string;
  /** The token's logo with its network badge, or a swap's split face. */
  face: ReactNode;
  title: string;
  date?: string;
  /** The ••• menu: Share, the explorer link, and the like. */
  actions: Action[];
  /** The headline: "0.696 USDC", or a swap's two sides. */
  amount: ReactNode;
  /** Under the amount: a small token icon and its dollar value. */
  value?: ReactNode;
  /** Where it stands, when it isn't simply done (a StatusPill). */
  status?: ReactNode;
  footer?: ReactNode;
  /** StatRows. */
  children: ReactNode;
}) {
  const styles = useStyles();
  return (
    <SheetScreen footer={footer}>
      <View style={styles.grabber} />
      <View style={styles.header}>
        {face}
        <View style={styles.flex}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {date ? (
            <Text style={styles.date} numberOfLines={1}>
              {date}
            </Text>
          ) : null}
        </View>
        {actions.length ? <ActionMenu actions={actions} bare /> : null}
      </View>
      <View style={styles.divider} />
      <View style={styles.summary}>
        <TextsReveal id={id} align="center" first={amount} second={value} />
        {status}
      </View>
      <View style={styles.divider} />
      <View style={styles.rows}>{children}</View>
    </SheetScreen>
  );
}

/** The big amount line. */
export function Amount({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit>
      {children}
    </Text>
  );
}

/** "[icon] $0.70" under the amount. */
export function AmountValue({ icon, text }: { icon: ReactNode; text: string }) {
  const styles = useStyles();
  return (
    <View style={styles.value}>
      {icon}
      <Text style={styles.usd}>{text}</Text>
    </View>
  );
}

/** A transaction's short hash and a link-out icon: tap opens the explorer, hold copies. */
export function TxLink({ hash, url }: { hash: string; url?: string | null }) {
  const styles = useStyles();
  const c = useTheme();
  const { copy } = useCopy(hash, 'Transaction ID copied');
  return (
    <PressableScale
      accessibilityRole={url ? 'link' : 'button'}
      accessibilityLabel={hash}
      hitSlop={8}
      onPress={() => {
        if (!url) return void copy();
        tap();
        Linking.openURL(url).catch(() => {});
      }}
      onLongPress={() => void copy()}
      style={styles.inline}
    >
      <Text style={styles.text}>{hash.includes('…') ? hash : shortAddress(hash)}</Text>
      {url ? <Icon name="link" size={14} color={c.textSecondary} /> : null}
    </PressableScale>
  );
}

/** Who it went to or came from: their face and short address (tap copies), or a name. */
export function Counterparty({ value }: { value: string }) {
  const styles = useStyles();
  const { copy } = useCopy(value, 'Address copied');
  const address = /^(0x|[1-9A-HJ-NP-Za-km-z]{32,})/.test(value);
  if (!address) return <Text style={styles.text}>{value}</Text>;
  return (
    <PressableScale
      accessibilityLabel={value}
      hitSlop={8}
      onPress={() => void copy()}
      style={styles.inline}
    >
      <Avatar name={value} seed={value.toLowerCase()} size={18} />
      <Text style={styles.text}>{value.includes('…') ? value : shortAddress(value)}</Text>
    </PressableScale>
  );
}

/** A value with a leading icon, e.g. the network's logo before the network cost. */
export function IconValue({ icon, text }: { icon: ReactNode; text: string }) {
  const styles = useStyles();
  return (
    <View style={styles.inline}>
      {icon}
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  // The tray frame keeps a grabber's gap at the top; the grabber sits in it.
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 5,
    borderRadius: 3,
    marginTop: -14,
    marginBottom: 14,
    backgroundColor: c.raised,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingBottom: 14,
  },
  title: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  date: {
    marginTop: 1,
    color: c.textSecondary,
    fontSize: 14,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.divider,
  },
  summary: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 32,
  },
  amount: {
    color: c.text,
    fontSize: 36,
    fontWeight: '500',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  value: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  usd: {
    color: c.textSecondary,
    fontSize: 16,
  },
  rows: {
    paddingTop: 12,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  text: {
    color: c.text,
    fontSize: 16,
  },
}));
