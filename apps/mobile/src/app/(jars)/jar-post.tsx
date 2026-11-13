import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { StrategyCard } from '@/components/jars/JarParts';
import { PressableScale } from '@/components/motion/PressableScale';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/sheets/Sheet';
import { SocialAvatar } from '@/components/social/parts';
import { success, tap } from '@/lib/haptics';
import { publishJar, shareJar, socialError, useSocialMe } from '@/lib/social';
import { TEST_MODE } from '@/lib/test-mode';
import { thesisJars, useThesisJars } from '@/lib/thesis';
import { showErrorToast, showToast } from '@/lib/toast';
import { requireSignIn } from '@/lib/wallet-gate';
import { makeStyles, useTheme } from '@/theme';

/**
 * Right after a jar others can see is bought: the post it makes. Your face and handle,
 * the words it leads with, and the jar's card, as the Feed will show it. Post saves the
 * words on the jar and (re)publishes it, then opens the share sheet with its link
 * (honeywallet.org/j/…, which chats show as the jar's card); Not now leaves the jar's own
 * summary. Share on a jar only you see comes here first (`share=1`): a link needs it public.
 */
export default function JarPostSheet() {
  const { id = '', share } = useLocalSearchParams<{ id?: string; share?: string }>();
  const jar = useThesisJars().find((j) => j.id === id);
  const { me, loaded } = useSocialMe();
  const styles = useStyles();
  const c = useTheme();
  const [why, setWhy] = useState('');
  const [posting, setPosting] = useState(false);
  if (!jar) return null;
  const text = why.trim();

  const post = async () => {
    if (!text || posting) return;
    // Posting needs a Honey sign-in and a handle; both come back here afterwards.
    if (!TEST_MODE && !requireSignIn('post this jar', `/jar/${jar.id}`)) return;
    if (!TEST_MODE && loaded && !me) {
      router.push('/claim-handle');
      return;
    }
    tap();
    setPosting(true);
    // Posting puts it on the Feed, so it's Everyone's from now on.
    const next = { ...jar, thesis: text, visibility: 'public' as const };
    thesisJars.set((list) => list.map((j) => (j.id === jar.id ? next : j)));
    try {
      const published = TEST_MODE ? null : await publishJar(next);
      if (!TEST_MODE && !published) throw new Error('Couldn’t post it. Try again.');
      success();
      showToast('Posted to the Feed');
      router.back();
      // Its link, once the sheet is down: the native share sheet over the jar.
      if (published) setTimeout(() => void shareJar(published), 350);
    } catch (error) {
      setPosting(false);
      showErrorToast(error instanceof Error ? error.message : socialError(error));
    }
  };

  return (
    <SheetScreen
      title={share ? 'Post to share' : 'Post your jar'}
      // Skipping is a quiet word up top, so Post is the one button (X's composer).
      right={
        <PressableScale
          accessibilityRole="button"
          hitSlop={10}
          scaleTo={0.96}
          disabled={posting}
          onPress={() => {
            tap();
            router.back();
          }}
        >
          <Text style={styles.skip}>Not now</Text>
        </PressableScale>
      }
      footer={
        <PillButton
          label={posting ? 'Posting…' : 'Post'}
          disabled={!text || posting}
          onPress={() => void post()}
        />
      }
    >
      {/* As the post will look: your face, and the words beside it under your name,
          then the jar's card. */}
      <View style={styles.post}>
        {me ? <SocialAvatar who={me} size={40} /> : null}
        <View style={styles.flex}>
          {me ? (
            <View style={styles.nameRow}>
              <Text style={styles.name} numberOfLines={1}>
                {me.displayName}
              </Text>
              <Text style={styles.handle} numberOfLines={1}>
                @{me.handle}
              </Text>
            </View>
          ) : null}
          <TextInput
            value={why}
            onChangeText={setWhy}
            autoFocus
            multiline
            maxLength={MAX}
            placeholder="What’s the idea?"
            placeholderTextColor={c.placeholder}
            selectionColor={c.accentText}
            style={styles.input}
            accessibilityLabel="Why this jar"
          />
          {why.length > MAX - 60 ? <Text style={styles.count}>{MAX - why.length}</Text> : null}
        </View>
      </View>
      <StrategyCard split jar={jar} picks={jar.picks} name={jar.name} />
    </SheetScreen>
  );
}

/** A post's length, as on X. */
const MAX = 280;

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  post: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: c.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  handle: { color: c.textSecondary, fontSize: 15, flexShrink: 2 },
  input: {
    marginTop: 4,
    color: c.text,
    fontSize: 17,
    lineHeight: 24,
    minHeight: 96,
    padding: 0,
    textAlignVertical: 'top',
  },
  count: { alignSelf: 'flex-end', color: c.textSecondary, fontSize: 13 },
  skip: { color: c.textSecondary, fontSize: 16, fontWeight: '600' },
}));
