import {
  type ApiClient,
  type ConfidentialQuoteRequest,
  checkQuoteStatus,
  type createConfidentialIntents,
  type StealthJarInvite,
  validateGeneratedIntent,
} from '@honey-wallet/api-client';
import {
  type ApprovedIntent,
  authPayload,
  checkIntentAgainstApproval,
  jarBox,
  type MemberSigner,
  openLedger,
  openRequest,
  type Poll,
  type Random,
  type RelayTransport,
  rawEd25519SignedData,
  runDkgSession,
  runSigningSession,
  type SigningRequest,
  type StealthJar,
  type StealthLedger,
  sealLedger,
  sealRequest,
  type Threshold,
} from '@honey-wallet/keyring';
import { base64urlnopad } from '@scure/base';

/**
 * Stealth-jar orchestration with every dependency injected, so the whole flow runs in
 * tests against an in-memory relay and a mocked 1Click. `lib/stealth-jar.ts` wires the
 * real API, keychain and RNG. Nothing here broadcasts a NEAR transaction; spends go
 * through 1Click's signed-intent path only after k members approve.
 */

type StealthApi = Pick<
  ApiClient,
  | 'stealthJarCreate'
  | 'stealthJarJoin'
  | 'stealthJarSend'
  | 'stealthJarReceive'
  | 'stealthJarLedger'
  | 'stealthJarWriteLedger'
  | 'stealthJarRequests'
  | 'stealthJarPostRequest'
>;
type OneClick = Pick<
  ReturnType<typeof createConfidentialIntents>,
  'quote' | 'generateIntent' | 'submitIntent' | 'status' | 'authenticate' | 'balances'
>;

export type FlowDeps = {
  api: StealthApi;
  oneClick: OneClick;
  /** Honey bearer session (rate limiting and relay membership only). */
  token: () => string;
  random: Random;
  now: () => number;
  poll: Poll;
};

/** How long a posted signing request stays actionable. */
export const REQUEST_TTL_MS = 15 * 60 * 1000;

// ---------- invites ----------

export type JarInvite = StealthJarInvite & { threshold: Threshold };
const INVITE_PREFIX = 'honeyjar1.';

export function encodeInvite(invite: JarInvite): string {
  const json = JSON.stringify({
    s: invite.sessionId,
    t: invite.inviteToken,
    k: invite.threshold.min,
    n: invite.threshold.max,
  });
  return INVITE_PREFIX + base64urlnopad.encode(new TextEncoder().encode(json));
}

export function decodeInvite(code: string): JarInvite {
  const trimmed = code.trim();
  if (!trimmed.startsWith(INVITE_PREFIX)) throw new Error('Not a Honey private-jar invite');
  const value = JSON.parse(
    new TextDecoder().decode(base64urlnopad.decode(trimmed.slice(INVITE_PREFIX.length))),
  ) as { s?: unknown; t?: unknown; k?: unknown; n?: unknown };
  if (
    typeof value.s !== 'string' ||
    !/^[0-9a-f]{32}$/.test(value.s) ||
    typeof value.t !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.t) ||
    typeof value.k !== 'number' ||
    typeof value.n !== 'number'
  )
    throw new Error('Invite is damaged');
  return { sessionId: value.s, inviteToken: value.t, threshold: { min: value.k, max: value.n } };
}

export function relayTransport(deps: FlowDeps, invite: StealthJarInvite): RelayTransport {
  return {
    send: (round, to, data) => deps.api.stealthJarSend(deps.token(), invite, round, to, data),
    receive: (round) => deps.api.stealthJarReceive(deps.token(), invite, round),
  };
}

// ---------- creating and joining ----------

/** Creator: opens the DKG session. Share `code` with members, then call `runJarDkg`. */
export async function openJarSession(deps: FlowDeps, threshold: Threshold) {
  if (threshold.min < 2 || threshold.min > threshold.max)
    throw new Error('Choose at least 2 approvers, no more than members');
  const session = await deps.api.stealthJarCreate(deps.token(), threshold.max);
  const invite: JarInvite = {
    sessionId: session.sessionId,
    inviteToken: session.inviteToken,
    threshold,
  };
  return { invite, code: encodeInvite(invite), memberIndex: session.memberIndex };
}

/** Any member (creator included): runs the DKG; member 1 then claims the ledger box. */
export async function runJarDkg(
  deps: FlowDeps,
  invite: JarInvite,
  signer: MemberSigner,
  memberIndex?: number,
): Promise<StealthJar> {
  const index = memberIndex ?? (await deps.api.stealthJarJoin(deps.token(), invite)).memberIndex;
  const jar = await runDkgSession({
    transport: relayTransport(deps, invite),
    sessionId: invite.sessionId,
    inviteToken: invite.inviteToken,
    memberIndex: index,
    threshold: invite.threshold,
    signer,
    random: deps.random,
    poll: deps.poll,
  });
  if (jar.index === 1) {
    const units = Object.fromEntries(Object.keys(jar.members).map((m) => [m, '0']));
    await writeLedger(deps, jar, signer, { version: 1, units });
  }
  return jar;
}

// ---------- ledger ----------

export async function readLedger(deps: FlowDeps, jar: StealthJar, minVersion = 0) {
  const row = await deps.api.stealthJarLedger(deps.token(), jarBox(jar));
  if (!row) return null;
  return openLedger(jar, row.data, row.version, minVersion);
}

export async function writeLedger(
  deps: FlowDeps,
  jar: StealthJar,
  signer: MemberSigner,
  ledger: StealthLedger,
) {
  const data = sealLedger(jar, ledger, signer, deps.random);
  await deps.api.stealthJarWriteLedger(deps.token(), jarBox(jar), {
    version: ledger.version,
    data,
  });
}

// ---------- deposits ----------

/** Quote a deposit into the jar's confidential balance. The member pays `depositAddress`. */
export async function depositQuote(deps: FlowDeps, quote: ConfidentialQuoteRequest) {
  if (quote.recipientType !== 'CONFIDENTIAL_INTENTS' || quote.depositType !== 'ORIGIN_CHAIN')
    throw new Error('Not a confidential deposit quote');
  const { quote: result } = await deps.oneClick.quote(quote);
  return { depositAddress: result.depositAddress, depositMemo: result.depositMemo };
}

// ---------- signing requests ----------

async function startSigning(
  deps: FlowDeps,
  jar: StealthJar,
  signer: MemberSigner,
  request: Omit<SigningRequest, 'sessionId' | 'inviteToken' | 'initiator' | 'createdAt'>,
) {
  checkIntentAgainstApproval(jar, request.payload, request.approved, deps.now());
  const session = await deps.api.stealthJarCreate(deps.token(), jar.threshold.max);
  const full: SigningRequest = {
    ...request,
    sessionId: session.sessionId,
    inviteToken: session.inviteToken,
    initiator: jar.index,
    createdAt: deps.now(),
  };
  await deps.api.stealthJarPostRequest(
    deps.token(),
    jarBox(jar),
    sealRequest(jar, full, signer, deps.random),
  );
  const signature = await runSigningSession({
    jar,
    transport: relayTransport(deps, full),
    request: full,
    signer,
    random: deps.random,
    poll: deps.poll,
  });
  if (!signature) throw new Error('Initiator produced no signature');
  return rawEd25519SignedData(jar, full.payload, signature);
}

/**
 * Spend from the jar's confidential balance (transfer or withdrawal quote). Needs
 * k-1 other members to approve on their devices.
 */
export async function requestSpend(
  deps: FlowDeps,
  jar: StealthJar,
  signer: MemberSigner,
  quote: ConfidentialQuoteRequest,
  summary: string,
) {
  if (quote.depositType !== 'CONFIDENTIAL_INTENTS' || quote.refundTo !== jar.accountId)
    throw new Error('Spend quotes must draw on this jar');
  const { quote: result } = await deps.oneClick.quote(quote);
  const depositAddress = result.depositAddress;
  const { intent } = await deps.oneClick.generateIntent(depositAddress, jar.accountId);
  const { payload } = validateGeneratedIntent(intent, jar.accountId);
  const approved: ApprovedIntent = {
    kind: 'spend',
    receiver: depositAddress,
    tokens: { [quote.originAsset]: quote.amount },
    notAfter: deps.now() + REQUEST_TTL_MS,
  };
  const signedData = await startSigning(deps, jar, signer, {
    kind: 'intent',
    payload,
    approved,
    quote,
    summary,
  });
  const { intentHash } = await deps.oneClick.submitIntent(signedData);
  return { intentHash, depositAddress };
}

/** Sign in to 1Click as the jar (empty intent, k approvals) and read private balances. */
export async function requestBalances(deps: FlowDeps, jar: StealthJar, signer: MemberSigner) {
  const payload = authPayload(jar.accountId, new Date(deps.now()), deps.random);
  const signedData = await startSigning(deps, jar, signer, {
    kind: 'auth',
    payload,
    approved: { kind: 'auth' },
    summary: 'Read the private jar balance',
  });
  const { accessToken } = await deps.oneClick.authenticate(signedData);
  return (await deps.oneClick.balances(accessToken)).balances;
}

/** Requests other members posted that this device can still approve. */
export async function pendingRequests(deps: FlowDeps, jar: StealthJar) {
  const rows = await deps.api.stealthJarRequests(deps.token(), jarBox(jar));
  const now = deps.now();
  const out: (SigningRequest & { id: string })[] = [];
  for (const row of rows) {
    try {
      const request = openRequest(jar, row.data);
      if (request.initiator === jar.index) continue;
      if (now - request.createdAt > REQUEST_TTL_MS || request.createdAt > now + 60_000) continue;
      out.push({ ...request, id: row.id });
    } catch {
      // Not from a rostered member, or not for this jar: never shown.
    }
  }
  return out;
}

/**
 * The checks an approver runs before contributing anything: the payload must match the
 * structured approval (receiver, token, amount, deadline), and for spends 1Click's own
 * record for the receiver must match the quote being approved.
 */
export async function verifyRequest(deps: FlowDeps, jar: StealthJar, request: SigningRequest) {
  checkIntentAgainstApproval(jar, request.payload, request.approved, deps.now());
  if (request.approved.kind === 'spend') {
    const quote = request.quote as ConfidentialQuoteRequest | undefined;
    if (!quote) throw new Error('Spend request has no quote');
    if (quote.refundTo !== jar.accountId || quote.depositType !== 'CONFIDENTIAL_INTENTS')
      throw new Error('Quote does not draw on this jar');
    if (request.approved.tokens[quote.originAsset] !== quote.amount)
      throw new Error('Approval amount differs from the quote');
    const status = await deps.oneClick.status(request.approved.receiver);
    checkQuoteStatus(status, quote, request.approved.receiver);
  }
}

export async function approveRequest(
  deps: FlowDeps,
  jar: StealthJar,
  signer: MemberSigner,
  request: SigningRequest,
) {
  await verifyRequest(deps, jar, request);
  await deps.api.stealthJarJoin(deps.token(), request);
  await runSigningSession({
    jar,
    transport: relayTransport(deps, request),
    request,
    signer,
    random: deps.random,
    poll: deps.poll,
  });
}

const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

/**
 * Lines for the approval prompt, built from the structured approval and quote that
 * `verifyRequest` checks, never from the initiator's free-text summary.
 */
export function describeRequest(request: SigningRequest): string[] {
  if (request.approved.kind === 'auth')
    return ['Sign in to read the private balance', 'Moves no funds'];
  const lines = Object.entries(request.approved.tokens).map(
    ([token, amount]) => `${amount} of ${token.replace(/^nep141:/, '')}`,
  );
  const quote = request.quote as ConfidentialQuoteRequest | undefined;
  if (quote?.recipient) lines.push(`To ${shortId(quote.recipient)}`);
  lines.push(`Expires ${new Date(request.approved.notAfter).toISOString().slice(11, 16)} UTC`);
  return lines;
}
