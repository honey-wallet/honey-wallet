import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { TokenList } from '@/components/home/TokenList';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, useFirstLoad } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { Copyable, ExplorerLink } from '@/components/sheets/Details';
import { FailurePage } from '@/components/sheets/FailurePage';
import { SHEET, SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { finishDemo, SuccessPage } from '@/components/sheets/SuccessPage';
import { FlowTray, InlineTray } from '@/components/sheets/Tray';
import {
  applyKey,
  Keypad,
  PercentChips,
  TypedAmount,
  trimNumber,
} from '@/components/wallet/Keypad';
import { LiveProposedPage } from '@/components/wallet/MultisigParts';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { useCopy } from '@/lib/copy';
import { success, tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import {
  type Chain,
  chainSymbol,
  formatBalance,
  formatUsd,
  HOLDINGS,
  RECENT_RECIPIENTS,
  shortAddress,
} from '@/lib/mock-wallet';
import { type ProposalAction, propose, useSigner } from '@/lib/multisig';
import { followFix, useFailure } from '@/lib/outcomes';
import { refreshAfterChange } from '@/lib/portfolio';
import {
  prepareSend,
  recipientChains,
  type SendPlan,
  type SendResult,
  type SendToken,
} from '@/lib/send';
import { addMoneyHref } from '@/lib/surface';
import { showErrorToast } from '@/lib/toast';
import { txReceipt } from '@/lib/tx-receipt';
import { useWalletView } from '@/lib/wallet-view';
import { useActiveWallet, wallets } from '@/lib/wallets';
import { warningOn } from '@/lib/warnings';
import { makeStyles, radius, useTheme } from '@/theme';

type Page = 'pick' | 'amount' | 'review' | 'sent' | 'failed';
/** In slide order: the token list sits to the left of the amount, so it opens from there. */
const PAGES: Page[] = ['pick', 'amount', 'review', 'sent', 'failed'];
type Unit = 'usd' | 'token';
/** What you can send: one choice per token per network you hold it on, largest first. */
const SENDABLE = HOLDINGS.filter((h) => h.amount > 0);

/** Who a send goes to: a saved label, or a shortened address, plus the full address to copy. */
function describeRecipient(to: string) {
  const known = RECENT_RECIPIENTS.find(
    (r) => r.label === to || r.address.toLowerCase() === to.toLowerCase(),
  );
  if (known?.label) {
    return {
      title: known.label,
      subtitle: shortAddress(known.address, 8, 6),
      address: known.address,
    };
  }
  const long = to.length > 18;
  return { title: long ? shortAddress(to, 8, 6) : to || 'Unknown', subtitle: null, address: to };
}

/** Send, step two: how much of which token, then a review before sending. */
export default function SendAmountSheet() {
  const { to = '', symbol: initial = 'USDC' } = useLocalSearchParams<{
    to?: string;
    symbol?: string;
  }>();
  const styles = useStyles();
  const c = useTheme();
  // A shared wallet sends from its own balances, and proposes rather than sends.
  const signer = useSigner();
  // A new wallet holds nothing until its first deposit.
  const view = useWalletView();
  const { empty } = view;
  // A real wallet sends for real (lib/send): its live balances, on networks the
  // recipient's address works on. Sample wallets keep the fixture flow.
  const real = !signer.multisig && 'live' in view;
  const wallet = useActiveWallet();
  const toChains = recipientChains(to);
  const sendable = signer.multisig
    ? signer.multisig.holdings.filter((h) => h.amount > 0)
    : real
      ? (view.holdings ?? []).filter((h) => toChains.includes(h.chain))
      : empty
        ? []
        : SENDABLE;
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const [sent, setSent] = useState<SendResult | null>(null);
  const [busy, setBusy] = useState(false);
  const loading = useFirstLoad(LOADS.balances(signer.walletId));
  // The largest holding of the requested token, so its network is the sensible default.
  const [picked, setPicked] = useState(() => {
    const first = sendable.find((h) => h.symbol === initial) ?? sendable[0] ?? SENDABLE[0];
    return { symbol: first.symbol, chain: first.chain };
  });
  const [proposalId, setProposalId] = useState<string | null>(null);
  const { symbol, chain } = picked;
  const [unit, setUnit] = useState<Unit>('usd');
  const [amount, setAmount] = useState('');
  const [page, setPage] = useState<Page>('amount');

  const token =
    sendable.find((h) => h.symbol === symbol && h.chain === chain) ?? sendable[0] ?? SENDABLE[0];
  // Live NEAR tokens beyond NEAR and USDC carry their contract (lib/portfolio toHoldings).
  const sendToken = (token as { token?: SendToken }).token;
  const price = token.usd / token.amount;
  const value = Number(amount) || 0;
  // Dollars are rounded to cents, so "$0.01" of USDC at $0.9995 is 0.010005, a hair over a
  // 0.01 balance. Within half a cent over the whole balance, it means all of it.
  const typed = unit === 'usd' ? value / price : value;
  const tokenValue =
    unit === 'usd' && typed > token.amount && (typed - token.amount) * price < 0.005
      ? token.amount
      : typed;
  const usdValue = unit === 'usd' ? value : value * price;
  const insufficient = tokenValue > token.amount * (1 + 1e-9);
  const ready = value > 0 && !insufficient;
  const label = !value ? 'Enter an amount' : insufficient ? 'Insufficient balance' : 'Continue';

  const recipient = describeRecipient(to);
  // The sent transaction's id and explorer link, for the receipt: the real one for a real
  // send, a placeholder in the sample flow.
  const tx = sent
    ? { hash: sent.hash, explorer: { name: 'explorer', url: sent.explorerUrl } }
    : txReceipt(chain, `${recipient.address}:${tokenValue}`);
  const { copied, copy } = useCopy(recipient.address);

  const go = (next: Page) => {
    tap();
    setPage(next);
  };

  const flipUnit = () => {
    tap();
    if (value) setAmount(unit === 'usd' ? trimNumber(tokenValue, 8) : trimNumber(usdValue, 2));
    setUnit(unit === 'usd' ? 'token' : 'usd');
  };

  // The token list is a page of this sheet rather than a sheet over it: a sheet
  // stacked on a full-height sheet leaves it stretched under the status bar on iOS 26.
  const [query, setQuery] = useState('');
  const choose = (next: { symbol: string; chain: Chain }) => {
    tap();
    setPicked(next);
    setAmount('');
    setQuery('');
    setPage('amount');
  };

  const action: ProposalAction = {
    type: 'send',
    symbol,
    chain,
    amount: Number(trimNumber(tokenValue, 8)),
    usd: usdValue,
    to: recipient.address,
  };
  const outcome = useFailure('send');
  // Real wallets: read fees and check the balance before the review shows.
  const review = async () => {
    if (!real) return go('review');
    tap();
    setBusy(true);
    try {
      setPlan(
        await prepareSend(wallet, {
          chain,
          symbol,
          to: recipient.address,
          amount: trimNumber(
            tokenValue,
            symbol === 'USDC' ? 6 : Math.min(8, sendToken?.decimals ?? 8),
          ),
          // A NEAR token (RHEA, wNEAR…): paid by its contract, from the balance read.
          token: sendToken,
        }),
      );
      setPage('review');
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : 'Couldn’t prepare the send');
    } finally {
      setBusy(false);
    }
  };
  const sendReal = async () => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      const walletId = wallet.id;
      setSent(await plan.execute(() => wallets.get().activeId === walletId));
      success();
      // The balance and Activity show the send as soon as the chain does.
      refreshAfterChange(wallet);
      setPage('sent');
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : 'Send failed');
      // Signed or handed to Honey: its outcome may be unknown, so never offer this plan
      // again. Back to the amount, where Review reads the chain afresh.
      if (plan.spent?.()) {
        refreshAfterChange(wallet);
        setPlan(null);
        setPage('amount');
      }
    } finally {
      setBusy(false);
    }
  };
  const send = () => {
    if (real) return void sendReal();
    // A failed send lands on its own page; nothing leaves the wallet.
    if (outcome.attempt()) {
      setPage('failed');
      return;
    }
    success();
    if (signer.multisig) {
      const { proposal, executed } = propose(signer.walletId, action);
      if (!executed) setProposalId(proposal.id);
    }
    setPage('sent');
  };

  const finish = () => (real ? router.dismissAll() : finishDemo('nothing was sent', { all: true }));

  if (real && !empty && sendable.length === 0) {
    return (
      <SheetScreen title="Send" size="fill">
        <EmptyState
          icon="send"
          title="Nothing to send there"
          hint={
            toChains.length
              ? `You don’t hold anything on ${toChains.join(' or ')}, where this address works.`
              : 'That address isn’t one Honey can send to.'
          }
          action={{ label: 'Change recipient', onPress: () => router.back() }}
        />
      </SheetScreen>
    );
  }

  // A new wallet has nothing to send until it's funded.
  if (sendable.length === 0) {
    return (
      <SheetScreen
        title="Send"
        size="fill"
        footer={
          <PillButton
            label="Receive"
            onPress={() => {
              tap();
              router.replace('/receive');
            }}
          />
        }
      >
        <EmptyState
          icon="send"
          title="Nothing to send yet"
          hint={
            signer.multisig
              ? `Send tokens to it on ${signer.multisig.network.name} first.`
              : 'Add money or receive tokens first.'
          }
          action={
            signer.multisig
              ? undefined
              : { label: 'Add money', onPress: () => router.replace(addMoneyHref()) }
          }
        />
      </SheetScreen>
    );
  }

  // Family's pattern: the amount is entered on the page; the review, and then the
  // result, rise over it in one tray that fits its content.
  const trayPage = page === 'review' || page === 'sent' || page === 'failed' ? page : null;
  const closeTray = () => {
    if (page === 'sent') finish();
    else go('amount');
  };
  return (
    <FlowTray>
      <SheetScreen
        title={page === 'pick' ? 'Choose token' : 'Send'}
        size="fill"
        onBack={page === 'pick' ? () => go('amount') : undefined}
      >
        <View style={styles.flex}>
          <ContentSwap
            id={page === 'pick' ? 'pick' : 'amount'}
            index={page === 'pick' ? 0 : 1}
            fill
          >
            <View style={styles.flex}>
              {page === 'pick' ? (
                <>
                  <SearchField
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Search your tokens"
                    style={styles.pickSearch}
                  />
                  <ScrollView
                    style={styles.pickList}
                    alwaysBounceVertical={false}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                  >
                    <TokenList
                      query={query}
                      sending
                      holdings={signer.multisig?.holdings}
                      onChoose={choose}
                    />
                  </ScrollView>
                </>
              ) : (
                <>
                  <View style={styles.toCard}>
                    <Text style={styles.toLabel}>To</Text>
                    <Avatar name={recipient.title} size={32} seed={to} />
                    <View style={styles.flex}>
                      <Text style={styles.toTitle} numberOfLines={1}>
                        {recipient.title}
                      </Text>
                      {/* Swaps to a confirmation for a moment after copying. */}
                      {recipient.subtitle || copied ? (
                        <View style={styles.toSubtitleLine}>
                          <TextSwap
                            text={copied ? 'Address copied' : (recipient.subtitle ?? '')}
                            style={[styles.toSubtitle, copied && styles.toCopied]}
                          />
                        </View>
                      ) : null}
                    </View>
                    {recipient.address ? (
                      <PressableScale
                        accessibilityRole="button"
                        accessibilityLabel={copied ? 'Address copied' : 'Copy address'}
                        hitSlop={8}
                        onPress={copy}
                        style={styles.copy}
                      >
                        <IconSwap
                          name={copied ? 'check' : 'copy'}
                          size={15}
                          color={copied ? c.success : c.textSecondary}
                        />
                      </PressableScale>
                    ) : null}
                  </View>

                  <View style={styles.tokenBar}>
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel={`Sending ${symbol} on ${chain}. Change token or network`}
                      onPress={() => {
                        tap();
                        setPage('pick');
                      }}
                      style={styles.pill}
                    >
                      <TokenIcon symbol={symbol} chain={chain} size={26} ring={c.card} />
                      <View>
                        <Text style={styles.pillLabel}>{symbol}</Text>
                        <Text style={styles.pillChain}>{chain}</Text>
                      </View>
                      <Icon name="chevronDown" size={12} color={c.textSecondary} />
                    </PressableScale>
                    {/* Tapping the balance sends all of it, like Max. */}
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel={`Balance ${formatBalance(token.amount)} ${symbol}`}
                      accessibilityHint="Enters your whole balance"
                      hitSlop={10}
                      onPress={() => {
                        tap();
                        setAmount(
                          unit === 'usd' ? trimNumber(token.usd, 2) : trimNumber(token.amount, 8),
                        );
                      }}
                    >
                      {loading ? (
                        <SkeletonBar width={120} height={12} />
                      ) : (
                        <TextSwap
                          text={`Balance: ${formatBalance(token.amount)} ${symbol}`}
                          style={styles.balance}
                        />
                      )}
                    </PressableScale>
                  </View>

                  <View style={styles.amountArea}>
                    <View style={styles.amountRow}>
                      <TypedAmount
                        value={amount}
                        prefix={unit === 'usd' ? '$' : ''}
                        size={amount.length > 9 ? 40 : 56}
                      />
                      {unit === 'token' ? <Text style={styles.unit}>{symbol}</Text> : null}
                    </View>
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel="Switch between dollars and token"
                      hitSlop={10}
                      onPress={flipUnit}
                      style={styles.convert}
                    >
                      <Icon name="expand" size={13} color={c.textSecondary} />
                      <Text style={styles.convertLabel}>
                        {unit === 'usd'
                          ? `${formatBalance(tokenValue)} ${symbol}`
                          : formatUsd(usdValue)}
                      </Text>
                    </PressableScale>
                  </View>

                  <PercentChips
                    balance={unit === 'usd' ? token.usd : token.amount}
                    decimals={unit === 'usd' ? 2 : 8}
                    onPick={setAmount}
                    style={styles.shares}
                  />
                  <Keypad
                    onKey={(key) => setAmount((a) => applyKey(a, key, unit === 'usd' ? 2 : 8))}
                  />
                </>
              )}
            </View>
          </ContentSwap>
        </View>
        {page !== 'pick' ? (
          <PillButton
            label={busy && page === 'amount' ? 'Checking…' : label}
            disabled={!ready || busy}
            onPress={() => void review()}
            style={styles.cta}
          />
        ) : null}
      </SheetScreen>
      <InlineTray onClose={closeTray}>
        {trayPage ? (
          <ContentSwap id={trayPage} index={PAGES.indexOf(trayPage)}>
            {trayPage === 'review' ? (
              <SheetScreen title="Review send" onBack={() => go('amount')}>
                <View style={styles.summary}>
                  <Text style={styles.summaryLabel}>You're sending</Text>
                  <Text style={styles.summaryAmount} adjustsFontSizeToFit numberOfLines={1}>
                    {formatBalance(tokenValue)} {symbol}
                  </Text>
                  <View style={styles.summaryUsd}>
                    <TokenIcon symbol={symbol} chain={chain} size={20} ring={c.sheet} />
                    <Text style={styles.summaryUsdLabel}>{formatUsd(usdValue)}</Text>
                  </View>
                </View>
                <View style={styles.rule} />
                <View style={styles.rows}>
                  <StatRow
                    label="To"
                    value={
                      <View style={styles.inline}>
                        <Avatar name={recipient.title} size={20} seed={to} />
                        <View style={styles.toValue}>
                          <Text style={styles.rowValue}>{recipient.title}</Text>
                          {/* The address too, so it can be checked before sending. */}
                          {recipient.subtitle ? (
                            <Text style={styles.rowAddress}>{recipient.subtitle}</Text>
                          ) : null}
                        </View>
                      </View>
                    }
                  />
                  <StatRow
                    label="Network"
                    value={
                      <View style={styles.inline}>
                        <TokenIcon symbol={chainSymbol(chain)} size={18} />
                        <Text style={styles.rowValue}>{chain}</Text>
                      </View>
                    }
                  />
                  {plan ? (
                    <>
                      {/* The whole address, so it can be checked character by character. */}
                      <StatRow
                        label="Address"
                        value={<Text style={styles.rowAddress}>{plan.to}</Text>}
                      />
                      <StatRow label="Network cost" value={plan.fee} />
                      {plan.setup ? <StatRow label="Setup" value={plan.setup} /> : null}
                    </>
                  ) : (
                    <StatRow label="Network cost" value="<$0.01" />
                  )}
                  {signer.rule(action) ? (
                    <StatRow label="Shared wallet" value={signer.rule(action)} />
                  ) : null}
                  <StatRow
                    label="Total"
                    value={<Text style={styles.total}>{formatUsd(usdValue)}</Text>}
                  />
                </View>
                {plan?.note || warningOn('sendIrreversible') ? (
                  <Text style={[styles.note, styles.noteInTray]}>
                    {plan?.note ? `${plan.note} ` : ''}
                    {warningOn('sendIrreversible')
                      ? "Sends can't be undone. Check the address before you send."
                      : ''}
                  </Text>
                ) : null}
                <PillButton
                  label={busy ? 'Sending…' : signer.cta('Confirm send', action)}
                  disabled={busy}
                  onPress={send}
                  style={styles.cta}
                />
              </SheetScreen>
            ) : trayPage === 'failed' && outcome.failure ? (
              <SheetScreen>
                <FailurePage
                  compact
                  failure={outcome.failure}
                  rows={[
                    { label: 'Amount', value: `${formatBalance(tokenValue)} ${symbol}` },
                    { label: 'To', value: recipient.title },
                  ]}
                  onRetry={() => {
                    tap();
                    if (outcome.failure && followFix(outcome.failure)) return;
                    go('review');
                  }}
                  onClose={() => {
                    tap();
                    router.dismissAll();
                  }}
                />
              </SheetScreen>
            ) : proposalId ? (
              <SheetScreen>
                <LiveProposedPage proposalId={proposalId} onDone={finish} compact />
              </SheetScreen>
            ) : (
              <SheetScreen>
                <SuccessPage
                  compact
                  title="Sent"
                  amount={{
                    symbol,
                    chain,
                    text: `${formatBalance(tokenValue)} ${symbol}`,
                    usd: formatUsd(usdValue),
                  }}
                  rows={[
                    // A saved name first, then the address itself, so it can be checked.
                    ...(recipient.subtitle ? [{ label: 'To', value: recipient.title }] : []),
                    {
                      label: recipient.subtitle ? 'Address' : 'To',
                      value: <Copyable value={recipient.address} toast="Address copied" />,
                    },
                    {
                      label: 'Transaction',
                      value: (
                        <View style={styles.inline}>
                          <Copyable value={tx.hash} toast="Transaction ID copied" />
                          <ExplorerLink name={tx.explorer.name} url={tx.explorer.url} />
                        </View>
                      ),
                    },
                    { label: 'Network', value: chain },
                    { label: 'Network cost', value: plan?.fee ?? '<$0.01' },
                    {
                      label: 'Sent',
                      value: sent?.state === 'pending' ? 'Confirming…' : 'Just now',
                    },
                  ]}
                  onDone={finish}
                />
              </SheetScreen>
            )}
          </ContentSwap>
        ) : null}
      </InlineTray>
    </FlowTray>
  );
}

const useStyles = makeStyles((c) => ({
  // The token list fills the sheet.
  pickList: {
    flex: 1,
  },
  noteInTray: {
    marginTop: 16,
  },
  flex: {
    flex: 1,
  },
  toValue: {
    alignItems: 'flex-end',
  },
  rowAddress: {
    marginTop: 1,
    color: c.textSecondary,
    fontSize: 13,
  },
  pickSearch: {
    marginBottom: 12,
  },
  toCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...radius(20),
    backgroundColor: c.card,
  },
  toLabel: {
    color: c.textSecondary,
    fontSize: 16,
  },
  toTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  // Fixed height, so the outgoing and incoming text overlap rather than stack.
  toSubtitleLine: {
    marginTop: 1,
    height: 18,
  },
  toCopied: {
    color: c.success,
  },
  copy: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  toSubtitle: {
    position: 'absolute',
    left: 0,
    top: 0,
    color: c.textSecondary,
    fontSize: 13,
  },
  tokenBar: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    // Two lines: the token, and the network it's sent from.
    height: 46,
    paddingLeft: 8,
    paddingRight: 12,
    borderRadius: 23,
    backgroundColor: c.card,
  },
  pillLabel: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  pillChain: {
    color: c.textSecondary,
    fontSize: 12,
  },
  balance: {
    color: c.textSecondary,
    fontSize: 14,
  },
  amountArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  unit: {
    color: c.textSecondary,
    fontSize: 28,
    fontWeight: '500',
  },
  convert: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  convertLabel: {
    color: c.textSecondary,
    fontSize: 16,
  },
  shares: {
    marginBottom: 6,
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
  summary: {
    alignItems: 'center',
    paddingTop: 28,
    paddingBottom: 26,
    gap: 6,
  },
  summaryLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  summaryAmount: {
    color: c.text,
    fontSize: 44,
    fontWeight: '500',
    letterSpacing: -1,
  },
  summaryUsd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  summaryUsdLabel: {
    color: c.textSecondary,
    fontSize: 17,
  },
  rule: {
    height: 1,
    backgroundColor: c.divider,
  },
  rows: {
    paddingTop: 12,
    gap: 4,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowValue: {
    color: c.text,
    fontSize: 16,
  },
  total: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  note: {
    marginBottom: 6,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
}));
