import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';

/** Space between footer buttons and the top of the keyboard. */
export const KEYBOARD_GAP = 12;

/**
 * Footer buttons that ride just above the keyboard, the same on iOS and Android
 * (KeyboardAvoidingView doesn't lift anything on Android edge-to-edge). The screen pins
 * the footer to its bottom edge; while the keyboard is up this lifts it by the part of
 * the keyboard that covers it. `under` is the space the screen already leaves below the
 * footer (safe area plus padding), which the keyboard covers first.
 */
export function KeyboardFooter({
  under,
  style,
  children,
}: {
  under: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const keyboard = useAnimatedKeyboard();
  const lift = useAnimatedStyle(() => ({
    paddingBottom:
      keyboard.height.value > 0 ? Math.max(0, keyboard.height.value - under + KEYBOARD_GAP) : 0,
  }));
  return <Animated.View style={[style, lift]}>{children}</Animated.View>;
}
