import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { StrategyCard } from '@/components/jars/JarParts';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/sheets/Sheet';
import { PersonByline } from '@/components/social/parts';
import { success, tap } from '@/lib/haptics';
import { publishJar, socialError, useSocialMe } from '@/lib/social';
import { TEST_MODE } from '@/lib/test-mode';
import { thesisJars, useThesisJars } from '@/lib/thesis';
import { showErrorToast, showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

/**
 * Right after a jar others can see is bought: the post it makes. Your face and handle,
 * the words it leads with, and the jar's card, as the Feed will show it. Post saves the
 * words on the jar and (re)publishes it; Not now leaves the jar's own summary.
 */
export default function JarPostSheet() {
  const { id = '' } = useLocalSearchParams<{ id?: string }>();
  const jar = useThesisJars().find((j) => j.id === id);
  const { me } = useSocialMe();
  const styles = useStyles();
  const c = useTheme();
  const [why, setWhy] = useState('');
  const [posting, setPosting] = useState(false);
  if (!jar) return null;
  const text = why.trim();

  const post = async () => {
    if (!text || posting) return;
    tap();
    setPosting(true);
    // Posting puts it on the Feed, so it's Everyone's from now on.
    const next = { ...jar, thesis: text, visibility: 'public' as const };
    thesisJars.set((list) => list.map((j) => (j.id === jar.id ? next : j)));
    try {
      if (!TEST_MODE && !(await publishJar(next))) throw new Error('Couldn’t post it. Try again.');
      success();
      showToast('Posted to the Feed');
      router.back();
    } catch (error) {
      setPosting(false);
      showErrorToast(error instanceof Error ? error.message : socialError(error));
    }
  };

  return (
    <SheetScreen
      title="Post your jar"
      footer={
        <View style={styles.footer}>
          <PillButton
            label="Not now"
            variant="secondary"
            disabled={posting}
            onPress={() => {
              tap();
              router.back();
            }}
          />
          <PillButton
            label={posting ? 'Posting…' : 'Post'}
            disabled={!text || posting}
            onPress={() => void post()}
          />
        </View>
      }
    >
      <View style={styles.body}>
        {me ? <PersonByline who={me} /> : null}
        <TextInput
          value={why}
          onChangeText={setWhy}
          autoFocus
          multiline
          maxLength={280}
          placeholder="Why this jar?"
          placeholderTextColor={c.placeholder}
          selectionColor={c.accentText}
          style={styles.input}
          accessibilityLabel="Why this jar"
        />
        <StrategyCard split jar={jar} picks={jar.picks} name={jar.name} />
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  body: { gap: 14 },
  input: { color: c.text, fontSize: 17, lineHeight: 24, minHeight: 72, padding: 0 },
  footer: { gap: 10 },
}));
