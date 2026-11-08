import {
  type ConfidentialQuoteRequest,
  confidentialDepositQuote,
  confidentialWithdrawQuote,
  type RawEd25519SignedData,
} from '@honey-wallet/api-client';
import {
  type MemberSigner,
  rawEd25519SignedData,
  type StealthJar,
  signerFromSecretKey,
  versionedNonce,
} from '@honey-wallet/keyring';
import { base58 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import {
  approveRequest,
  decodeInvite,
  depositQuote,
  describeRequest,
  encodeInvite,
  type FlowDeps,
  openJarSession,
  pendingRequests,
  readLedger,
  requestBalances,
  requestSpend,
  runJarDkg,
  verifyRequest,
  writeLedger,
} from '@/lib/stealth-jar-flow';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (n: number) => Array.from(random(n), (b) => b.toString(16).padStart(2, '0')).join('');
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

/** In-memory Honey server: relay sessions and boxes with the real routing rules. */
function fakeServer() {
  const sessions = new Map<
    string,
    { invite: string; max: number; members: Map<string, number>; slots: Map<string, string> }
  >();
  const ledgers = new Map<string, { token: string; version: number; data: string }>();
  const requests = new Map<string, { id: string; data: string }[]>();
  const member = (token: string, invite: { sessionId: string; inviteToken: string }) => {
    const s = sessions.get(invite.sessionId);
    if (!s || s.invite !== invite.inviteToken) throw new Error('403');
    const index = s.members.get(token);
    if (!index) throw new Error('403');
    return { s, index };
  };
  const box = (b: { boxId: string; boxToken: string }) => {
    const row = ledgers.get(b.boxId);
    return row && row.token === b.boxToken ? row : null;
  };
  return {
    sessions,
    ledgers,
    api: {
      async stealthJarCreate(token: string, members: number) {
        const sessionId = hex(16);
        const inviteToken = hex(32);
        sessions.set(sessionId, {
          invite: inviteToken,
          max: members,
          members: new Map([[token, 1]]),
          slots: new Map(),
        });
        return { sessionId, inviteToken, memberIndex: 1, expiresIn: 900 };
      },
      async stealthJarJoin(token: string, invite: { sessionId: string; inviteToken: string }) {
        const s = sessions.get(invite.sessionId);
        if (!s || s.invite !== invite.inviteToken) throw new Error('403');
        if (!s.members.has(token)) {
          if (s.members.size >= s.max) throw new Error('409 full');
          s.members.set(token, s.members.size + 1);
        }
        return { memberIndex: s.members.get(token) as number, members: s.max };
      },
      async stealthJarSend(token: string, invite: never, round: number, to: number, data: string) {
        const { s, index } = member(token, invite);
        const key = `${round}:${index}:${to}`;
        if (s.slots.has(key)) throw new Error('409');
        s.slots.set(key, data);
      },
      async stealthJarReceive(token: string, invite: never, round: number) {
        const { s, index } = member(token, invite);
        return [...s.slots.entries()]
          .map(([k, data]) => {
            const [r, from, to] = k.split(':').map(Number);
            return { r, from: from as number, to: to as number, data };
          })
          .filter((m) => m.r === round && (m.to === 0 || m.to === index))
          .map(({ from, to, data }) => ({ from, to, data }));
      },
      async stealthJarLedger(_t: string, b: { boxId: string; boxToken: string }) {
        const row = box(b);
        return row ? { version: row.version, data: row.data } : null;
      },
      async stealthJarWriteLedger(
        _t: string,
        b: { boxId: string; boxToken: string },
        ledger: { version: number; data: string },
      ) {
        const row = ledgers.get(b.boxId);
        if (!row && ledger.version === 1) {
          ledgers.set(b.boxId, { token: b.boxToken, ...ledger });
          return ledger;
        }
        if (!row || row.token !== b.boxToken) throw new Error('403');
        if (ledger.version !== row.version + 1) throw new Error('409');
        Object.assign(row, ledger);
        return ledger;
      },
      async stealthJarRequests(_t: string, b: { boxId: string; boxToken: string }) {
        if (!box(b)) throw new Error('404');
        return requests.get(b.boxId) ?? [];
      },
      async stealthJarPostRequest(
        _t: string,
        b: { boxId: string; boxToken: string },
        data: string,
      ) {
        if (!box(b)) throw new Error('403');
        const entry = { id: hex(6), data };
        requests.set(b.boxId, [...(requests.get(b.boxId) ?? []), entry]);
        return entry;
      },
    },
  };
}

/** Fake 1Click: records quotes and generates a raw_ed25519 transfer payload for them. */
function fakeOneClick(opts: { tamper?: (payload: Record<string, unknown>) => void } = {}) {
  const quotes = new Map<string, ConfidentialQuoteRequest>();
  const submitted: RawEd25519SignedData[] = [];
  const api = {
    submitted,
    quotes,
    quote: vi.fn(async (q: ConfidentialQuoteRequest) => {
      const depositAddress = hex(32);
      quotes.set(depositAddress, q);
      return { quote: { depositAddress } };
    }),
    generateIntent: vi.fn(async (depositAddress: string, signerId: string) => {
      const q = quotes.get(depositAddress) as ConfidentialQuoteRequest;
      const now = new Date();
      const deadline = new Date(now.getTime() + 5 * 60_000);
      const payload: Record<string, unknown> = {
        signer_id: signerId,
        verifying_contract: 'intents.near',
        deadline: deadline.toISOString(),
        nonce: versionedNonce(now, deadline, random),
        intents: [
          {
            intent: 'transfer',
            receiver_id: depositAddress,
            tokens: { [q.originAsset]: q.amount },
          },
        ],
      };
      opts.tamper?.(payload);
      return {
        intent: { standard: 'raw_ed25519', payload: JSON.stringify(payload) },
        correlationId: 'c',
      };
    }),
    submitIntent: vi.fn(async (signed: RawEd25519SignedData) => {
      submitted.push(signed);
      return { intentHash: 'hash', correlationId: 'c' };
    }),
    status: vi.fn(async (depositAddress: string) => ({
      status: 'PENDING_DEPOSIT',
      quoteResponse: { quoteRequest: quotes.get(depositAddress), quote: { depositAddress } },
    })),
    authenticate: vi.fn(async (signed: RawEd25519SignedData) => {
      submitted.push(signed);
      return { accessToken: 'session', refreshToken: 'r', expiresIn: 3600 };
    }),
    balances: vi.fn(async () => ({
      balances: [{ tokenId: USDC, available: '5000000', source: 'private' as const }],
    })),
  };
  return api;
}

type Member = { deps: FlowDeps; signer: MemberSigner };
function members(n: number, server = fakeServer(), oneClick = fakeOneClick()) {
  const list: Member[] = Array.from({ length: n }, (_, i) => ({
    signer: signerFromSecretKey(random(32)),
    deps: {
      api: server.api as never,
      oneClick: oneClick as never,
      token: () => `bearer-${i}`,
      random,
      now: Date.now,
      poll: { intervalMs: 1, timeoutMs: 3000 },
    },
  }));
  return { list, server, oneClick };
}

async function makeJar(n = 3, k = 2, oneClick = fakeOneClick()) {
  const { list, server } = members(n, fakeServer(), oneClick);
  const [creator, ...rest] = list as [Member, ...Member[]];
  const { code, invite, memberIndex } = await openJarSession(creator.deps, { min: k, max: n });
  const decoded = decodeInvite(code);
  expect(decoded).toEqual(invite);
  const jars = await Promise.all([
    runJarDkg(creator.deps, invite, creator.signer, memberIndex),
    ...rest.map((m) => runJarDkg(m.deps, decodeInvite(code), m.signer)),
  ]);
  return { jars, list, server, oneClick };
}

/** Throws unless the signature is a valid ed25519 signature by the jar's group key. */
const verifyRaw = (jar: StealthJar, signed: RawEd25519SignedData) => {
  rawEd25519SignedData(jar, signed.payload, base58.decode(signed.signature.slice(8)));
  return true;
};

describe('private jar flow', () => {
  it('creates a 2-of-3 jar from an invite and claims an empty signed ledger', async () => {
    const { jars, list, server } = await makeJar();
    expect(new Set(jars.map((j) => j.accountId)).size).toBe(1);
    const ledger = await readLedger(list[1]!.deps, jars[1]!);
    expect(ledger).toMatchObject({ version: 1, writer: 1, units: { 1: '0', 2: '0', 3: '0' } });
    // The server holds ciphertext only.
    const row = [...server.ledgers.values()][0]!;
    expect(row.data).not.toContain('units');
    expect(
      JSON.stringify([...server.sessions.values()].map((s) => [...s.slots.values()])),
    ).not.toContain(jars[0]!.accountId);
  });

  it('updates the ledger with compare-and-swap and rollback protection', async () => {
    const { jars, list } = await makeJar();
    await writeLedger(list[1]!.deps, jars[1]!, list[1]!.signer, {
      version: 2,
      units: { 1: '100', 2: '50', 3: '0' },
    });
    expect((await readLedger(list[2]!.deps, jars[2]!, 2))?.units['1']).toBe('100');
    await expect(readLedger(list[2]!.deps, jars[2]!, 3)).rejects.toThrow(/rolled back/);
    await expect(
      writeLedger(list[0]!.deps, jars[0]!, list[0]!.signer, { version: 2, units: { 1: '1' } }),
    ).rejects.toThrow(/409/);
  });

  it('quotes a confidential deposit into the jar', async () => {
    const { jars, list, oneClick } = await makeJar();
    const quote = confidentialDepositQuote({
      asset: USDC,
      originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      amount: '5000000',
      jarAccount: jars[0]!.accountId,
      refundTo: '0x1111111111111111111111111111111111111111',
    });
    const { depositAddress } = await depositQuote(list[0]!.deps, quote);
    expect(oneClick.quotes.get(depositAddress)?.recipient).toBe(jars[0]!.accountId);
  });

  it('spends with one approval: approver verifies independently, initiator submits a valid signature', async () => {
    const { jars, list, oneClick } = await makeJar();
    const quote = confidentialWithdrawQuote({
      asset: USDC,
      destinationAsset: USDC,
      amount: '1000000',
      jarAccount: jars[0]!.accountId,
      recipient: 'alice.near',
    });
    const spend = requestSpend(list[0]!.deps, jars[0]!, list[0]!.signer, quote, 'Pay Alice 1 USDC');
    // Member 3 sees the request, verifies it, approves. Member 2 stays offline.
    let pending: Awaited<ReturnType<typeof pendingRequests>> = [];
    for (let i = 0; i < 200 && pending.length === 0; i++) {
      pending = await pendingRequests(list[2]!.deps, jars[2]!);
      if (!pending.length) await new Promise((r) => setTimeout(r, 2));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]!.summary).toBe('Pay Alice 1 USDC');
    const lines = describeRequest(pending[0]!);
    expect(lines[0]).toBe(`1000000 of ${USDC.slice(7)}`);
    expect(lines[1]).toBe('To alice.near');
    await approveRequest(list[2]!.deps, jars[2]!, list[2]!.signer, pending[0]!);
    const result = await spend;
    expect(result.intentHash).toBe('hash');
    const signed = oneClick.submitted[0]!;
    expect(signed.standard).toBe('raw_ed25519');
    expect(signed.public_key).toBe(jars[0]!.nearPublicKey);
    expect(verifyRaw(jars[0]!, signed)).toBe(true);
    expect(oneClick.status).toHaveBeenCalledWith(result.depositAddress);
  });

  it('initiator refuses a 1Click payload that pays someone else', async () => {
    const tampered = fakeOneClick({
      tamper: (p) => {
        (p.intents as Record<string, unknown>[])[0]!.receiver_id = 'evil.near';
      },
    });
    const { jars, list } = await makeJar(3, 2, tampered);
    const quote = confidentialWithdrawQuote({
      asset: USDC,
      destinationAsset: USDC,
      amount: '1000000',
      jarAccount: jars[0]!.accountId,
      recipient: 'alice.near',
    });
    await expect(
      requestSpend(list[0]!.deps, jars[0]!, list[0]!.signer, quote, 'x'),
    ).rejects.toThrow(/different receiver/);
    expect(tampered.submitIntent).not.toHaveBeenCalled();
  });

  it('approver rejects a request whose quote differs from 1Click’s record', async () => {
    const { jars, list, oneClick } = await makeJar();
    const quote = confidentialWithdrawQuote({
      asset: USDC,
      destinationAsset: USDC,
      amount: '1000000',
      jarAccount: jars[0]!.accountId,
      recipient: 'alice.near',
    });
    const spend = requestSpend(list[0]!.deps, jars[0]!, list[0]!.signer, quote, 'x');
    spend.catch(() => {});
    let pending: Awaited<ReturnType<typeof pendingRequests>> = [];
    for (let i = 0; i < 200 && pending.length === 0; i++) {
      pending = await pendingRequests(list[1]!.deps, jars[1]!);
      if (!pending.length) await new Promise((r) => setTimeout(r, 2));
    }
    // The initiator lied: the 1Click record actually sends to another recipient.
    const record = oneClick.quotes.get(
      pending[0]!.approved.kind === 'spend' ? pending[0]!.approved.receiver : '',
    );
    record!.recipient = 'evil.near';
    await expect(verifyRequest(list[1]!.deps, jars[1]!, pending[0]!)).rejects.toThrow(/recipient/);
    await expect(
      approveRequest(list[1]!.deps, jars[1]!, list[1]!.signer, pending[0]!),
    ).rejects.toThrow();
  });

  it('reads private balances after a k-of-n signed sign-in', async () => {
    const { jars, list, oneClick } = await makeJar();
    const balances = requestBalances(list[1]!.deps, jars[1]!, list[1]!.signer);
    let pending: Awaited<ReturnType<typeof pendingRequests>> = [];
    for (let i = 0; i < 200 && pending.length === 0; i++) {
      pending = await pendingRequests(list[0]!.deps, jars[0]!);
      if (!pending.length) await new Promise((r) => setTimeout(r, 2));
    }
    expect(pending[0]!.kind).toBe('auth');
    expect(describeRequest(pending[0]!)).toContain('Moves no funds');
    await approveRequest(list[0]!.deps, jars[0]!, list[0]!.signer, pending[0]!);
    expect(await balances).toEqual([{ tokenId: USDC, available: '5000000', source: 'private' }]);
    const signed = oneClick.submitted[0]!;
    expect(JSON.parse(signed.payload).intents).toEqual([]);
    expect(verifyRaw(jars[0]!, signed)).toBe(true);
  });

  it('rejects malformed invites', () => {
    expect(() => decodeInvite('hello')).toThrow(/Not a Honey/);
    const good = encodeInvite({
      sessionId: 'a'.repeat(32),
      inviteToken: 'b'.repeat(64),
      threshold: { min: 2, max: 3 },
    });
    expect(() => decodeInvite(`${good.slice(0, -4)}AAAA`)).toThrow();
  });
});
