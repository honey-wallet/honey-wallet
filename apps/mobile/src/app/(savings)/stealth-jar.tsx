import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import {
  SheetField,
  SheetRow,
  SheetScreen,
  SheetSection,
  SheetText,
} from '@/components/sheets/Sheet';
import { OptionChips } from '@/components/trade/TradeForm';
import { copyText } from '@/lib/copy';
import { isWeb } from '@/lib/platform';
import {
  flowDeps,
  listStealthJars,
  type StoredJarRef,
  saveStealthJar,
  stealthJarsEnabled,
  withMemberSigner,
} from '@/lib/stealth-jar';
import { decodeInvite, type JarInvite, openJarSession, runJarDkg } from '@/lib/stealth-jar-flow';
import { showErrorToast, showToast } from '@/lib/toast';
import { wallets } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';

const SIZES = ['2', '3', '4', '5'] as const;
const short = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;

/**
 * Private (stealth) jar: create or join a k-of-n jar whose account has no on-chain
 * link to its members. Behind EXPO_PUBLIC_STEALTH_JARS; reached from New Honey Jar.
 */
export default function StealthJarScreen() {
  if (isWeb || !stealthJarsEnabled) return <Redirect href="/home" />;
  return <StealthJarContent />;
}

function StealthJarContent() {
  const styles = useStyles();
  const c = useTheme();
  const [members, setMembers] = useState<(typeof SIZES)[number]>('3');
  const [approvals, setApprovals] = useState<(typeof SIZES)[number]>('2');
  const [label, setLabel] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [jars, setJars] = useState<StoredJarRef[]>([]);

  useEffect(() => {
    listStealthJars().then(setJars, () => {});
  }, []);

  const approvalOptions = SIZES.filter((s) => Number(s) <= Number(members));
  const walletId = wallets.get().activeId;

  async function dkg(
    run: (deps: ReturnType<typeof flowDeps>) => Promise<{ inv: JarInvite; index?: number }>,
  ) {
    const deps = flowDeps();
    try {
      await withMemberSigner(walletId, 'Create private jar key', async (signer) => {
        const { inv, index } = await run(deps);
        setBusy(`Waiting for ${inv.threshold.max} members…`);
        const jar = await runJarDkg(deps, inv, signer, index);
        await saveStealthJar(jar, label.trim() || 'Private jar', walletId);
        setJars(await listStealthJars());
        showToast('Private jar ready');
      });
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : 'Could not set up the jar');
    } finally {
      setBusy(null);
      setInvite(null);
    }
  }

  const create = () =>
    dkg(async (deps) => {
      setBusy('Opening session…');
      const session = await openJarSession(deps, {
        min: Number(approvals),
        max: Number(members),
      });
      setInvite(session.code);
      return { inv: session.invite, index: session.memberIndex };
    });

  const join = () =>
    dkg(async () => {
      setBusy('Joining…');
      return { inv: decodeInvite(joinCode) };
    });

  return (
    <SheetScreen title="Private jar" size="fill" scroll>
      <SheetText>
        A private jar gets a fresh account with no link to its members. Spending needs the number of
        approvals you choose, and deposits go through NEAR Confidential Intents.
      </SheetText>

      <SheetSection title="Create" />
      <View style={styles.field}>
        <TextInput
          value={label}
          onChangeText={setLabel}
          placeholder="Name (only on your phone)"
          placeholderTextColor={c.placeholder}
          maxLength={32}
          style={styles.input}
        />
      </View>
      <SheetField label="Members">
        <OptionChips
          options={SIZES}
          value={members}
          onChange={(v) => {
            setMembers(v);
            if (Number(approvals) > Number(v)) setApprovals(v);
          }}
        />
      </SheetField>
      <SheetField label="Approvals to spend" hint="Any of this many members can approve together.">
        <OptionChips options={approvalOptions} value={approvals} onChange={setApprovals} />
      </SheetField>
      {invite ? (
        <SheetRow
          title="Invite code"
          subtitle="Send it privately to each member"
          value="Copy"
          onPress={() => copyText(invite, 'Invite copied')}
        />
      ) : null}
      <PillButton label={busy ?? 'Create private jar'} disabled={!!busy} onPress={create} />

      <SheetSection title="Join" />
      <View style={styles.field}>
        <TextInput
          value={joinCode}
          onChangeText={setJoinCode}
          placeholder="Paste invite code"
          placeholderTextColor={c.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
      </View>
      <PillButton
        label="Join private jar"
        variant="secondary"
        disabled={!!busy || !joinCode.trim()}
        onPress={join}
      />

      {jars.length ? <SheetSection title="Your private jars" /> : null}
      {jars.map((jar) => (
        <SheetRow
          key={jar.accountId}
          title={jar.label}
          subtitle={short(jar.accountId)}
          accessory="chevron"
          onPress={() =>
            router.push({ pathname: '/stealth-jar-approve', params: { accountId: jar.accountId } })
          }
        />
      ))}
      {busy ? <Text style={styles.busy}>{busy}</Text> : null}
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  field: {
    height: 52,
    justifyContent: 'center',
    paddingHorizontal: 14,
    marginBottom: 12,
    ...radius(14),
    backgroundColor: c.card,
  },
  input: { color: c.text, fontSize: 17 },
  busy: { color: c.textSecondary, fontSize: 14, textAlign: 'center', marginTop: 12 },
}));
