import { router } from 'expo-router';
import { SavedSection } from '@/components/jars/SavedSection';
import { PushedScreen, SCREEN } from '@/components/wallet/parts';

/**
 * Saved, from the heart at the top of Jars: the strategies and tokens you
 * liked from the Feed, each with Buy. With nothing saved, the way to find some is
 * the Feed.
 */
export default function SavedScreen() {
  return (
    <PushedScreen
      title="Saved"
      fallback="/jars"
      contentStyle={{ paddingHorizontal: SCREEN.gutter }}
    >
      <SavedSection onExplore={() => router.navigate('/feed')} />
    </PushedScreen>
  );
}
