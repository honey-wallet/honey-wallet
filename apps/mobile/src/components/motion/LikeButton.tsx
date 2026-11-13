// Motion: favouriting a token is occasional, so it earns a small moment of delight,
// kept quiet: the heart fills (150ms) and pops (dips to 0.8 in 80ms, springs back to 1
// with a slight overshoot, since a glyph this small needs it to read), and eight
// particles drift 16px out and fade (250ms). The outer button supplies the single
// press response. Turning it on is a completed action, so it gets the success haptic;
// turning it off is a selection tick and only reverses the fill. Under Reduce Motion
// only the fill crossfades.
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { success, tap } from '@/lib/haptics';
import { useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const PARTICLES = 8;
const DISTANCE = 16;

type Props = {
  liked: boolean;
  onToggle: () => void;
  size?: number;
  /** Other glyphs (Save uses the bookmark), with what the button says to VoiceOver. */
  icons?: { off: IconName; on: IconName };
  labels?: { off: string; on: string };
  /** The glyph's colours off and on (the burst takes `on`); grey and honey by default. */
  colors?: { off: string; on: string };
  /** Asked first; false (e.g. signed out, sent to sign in) skips the press and its burst. */
  allow?: () => boolean;
};

const HEART = { off: 'heart', on: 'heartFill' } as const;
const FAVOURITE = { off: 'Add to favourites', on: 'Remove from favourites' };

export function LikeButton({
  liked,
  onToggle,
  size = 24,
  icons = HEART,
  labels = FAVOURITE,
  colors,
  allow,
}: Props) {
  const c = useTheme();
  const off = colors?.off ?? c.textSecondary;
  const on = colors?.on ?? c.primary;
  const reduceMotion = useReducedMotion();
  const fill = useSharedValue(liked ? 1 : 0);
  const burst = useSharedValue(0);
  const pop = useSharedValue(1);

  useEffect(() => {
    fill.value = withTiming(liked ? 1 : 0, { duration: DURATION.quick, easing: EASE.smoothOut });
  }, [liked, fill]);

  const press = () => {
    if (allow && !allow()) return;
    if (liked) tap();
    else success();
    if (!liked && !reduceMotion) {
      burst.value = 0;
      burst.value = withTiming(1, { duration: DURATION.medium, easing: EASE.smoothOut });
      pop.value = withSequence(
        withTiming(0.8, { duration: DURATION.micro, easing: EASE.press }),
        withSpring(1, { duration: 350, dampingRatio: 0.5 }),
      );
    } else burst.value = 0;
    onToggle();
  };

  const filledStyle = useAnimatedStyle(() => ({ opacity: fill.value }));
  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={liked ? labels.on : labels.off}
      accessibilityState={{ selected: liked }}
      hitSlop={10}
      onPress={press}
    >
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        {Array.from({ length: PARTICLES }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed set of particles; the index is the identity.
          <Particle key={i} angle={(i / PARTICLES) * Math.PI * 2} burst={burst} color={on} />
        ))}
        <Animated.View style={popStyle}>
          <Icon name={icons.off} size={size} color={off} />
          <Animated.View style={[{ position: 'absolute' }, filledStyle]}>
            <Icon name={icons.on} size={size} color={on} />
          </Animated.View>
        </Animated.View>
      </View>
    </PressableScale>
  );
}

function Particle({
  angle,
  burst,
  color,
}: {
  angle: number;
  burst: ReturnType<typeof useSharedValue<number>>;
  color: string;
}) {
  const style = useAnimatedStyle(() => {
    const t = burst.value;
    // Fade in over the first 20%, then out; travel the whole way.
    const opacity = t === 0 || t === 1 ? 0 : t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
    return {
      opacity,
      transform: [
        { translateX: Math.cos(angle) * DISTANCE * t },
        { translateY: Math.sin(angle) * DISTANCE * t },
        { scale: 0.4 + Math.min(t / 0.2, 1) * 0.6 - Math.max(t - 0.2, 0) * 0.5 },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', width: 4, height: 4, borderRadius: 2, backgroundColor: color },
        style,
      ]}
    />
  );
}
