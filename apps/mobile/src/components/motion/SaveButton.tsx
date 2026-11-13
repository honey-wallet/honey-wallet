import { LikeButton } from '@/components/motion/LikeButton';
import { useTheme } from '@/theme';

const HEART = { off: 'heart', on: 'heartFill' } as const;
const LABELS = { off: 'Like', on: 'Liked' };

/**
 * Save (the wishlist for tokens and strategies, lib/saved.ts), shown as a heart: an
 * outline in the text colour, filled red once saved, with the favourites' fill, pop and
 * burst. The toast comes from lib/saved; the button plays the haptic (success on save,
 * a tick on removal).
 */
export function SaveButton({
  saved,
  onToggle,
  size = 22,
  allow,
}: {
  saved: boolean;
  onToggle: () => void;
  size?: number;
  /** Asked before toggling, e.g. `() => requireSignIn('save this')`. */
  allow?: () => boolean;
}) {
  const c = useTheme();
  return (
    <LikeButton
      liked={saved}
      onToggle={onToggle}
      size={size}
      icons={HEART}
      labels={LABELS}
      colors={{ off: c.text, on: c.error }}
      allow={allow}
    />
  );
}
