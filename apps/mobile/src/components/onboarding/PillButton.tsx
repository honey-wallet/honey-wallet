import type { ReactNode } from 'react';
import type { AccessibilityState, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextMorph } from '@/components/motion/TextMorph';
import { TextSwap } from '@/components/motion/TextSwap';
import { isWeb } from '@/lib/platform';
import { makeStyles } from '@/theme';

export type PillVariant = 'primary' | 'secondary' | 'danger';
/**
 * `regular` (50pt) for a screen's or footer's actions; `compact` (40pt, a 15pt label,
 * EmptyState's button) for one sitting in a row or a card: Follow, Edit profile, a
 * post's Copy, a saved row's Buy.
 */
export type PillSize = 'regular' | 'compact';

/** Each size's height, for things drawn beside a pill (a stepper's round − and +). */
export const PILL_HEIGHT: Record<PillSize, number> = { regular: 50, compact: 40 };

type Props = {
  label: string;
  onPress: () => void;
  /** `danger` is for the one irreversible action on a screen (e.g. Sign out). */
  variant?: PillVariant;
  size?: PillSize;
  disabled?: boolean;
  /** Morph between labels that share letters ("Save" → "Saved") instead of swapping. */
  morph?: boolean;
  /** An icon or logo before the label. */
  leading?: ReactNode;
  /**
   * Drawn in place of the label, for content with its own motion (Copy's rolling
   * amount); `label` stays the button's name for VoiceOver. Style its text with
   * `usePillLabel`.
   */
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityState?: AccessibilityState;
  style?: StyleProp<ViewStyle>;
};

export function PillButton({
  label,
  onPress,
  variant = 'primary',
  size = 'regular',
  disabled,
  morph,
  leading,
  children,
  accessibilityLabel,
  accessibilityState,
  style,
}: Props) {
  const Label = morph ? TextMorph : TextSwap;
  const styles = useStyles();
  const labelStyle = usePillLabel(variant, size, disabled);
  const secondary = variant === 'secondary';
  const danger = variant === 'danger';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (children ? label : undefined)}
      accessibilityState={{ disabled, ...accessibilityState }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        size === 'compact' && styles.compact,
        leading || children ? styles.row : null,
        secondary
          ? styles.secondary
          : danger
            ? disabled
              ? styles.dangerDisabled
              : styles.danger
            : disabled
              ? styles.disabled
              : styles.primary,
        style,
      ]}
    >
      {leading}
      {children ?? <Label text={label} style={labelStyle} />}
    </PressableScale>
  );
}

/** A pill's label style (colour, size and weight), for text drawn as `children`. */
export function usePillLabel(
  variant: PillVariant = 'primary',
  size: PillSize = 'regular',
  disabled?: boolean,
): StyleProp<TextStyle> {
  const styles = useStyles();
  const secondary = variant === 'secondary';
  const danger = variant === 'danger';
  return [
    styles.label,
    size === 'compact' && styles.compactLabel,
    secondary && styles.secondaryLabel,
    danger && !disabled && styles.dangerLabel,
    disabled && !secondary && (danger ? styles.dangerDisabledLabel : styles.disabledLabel),
  ];
}

const useStyles = makeStyles((c) => ({
  button: {
    height: PILL_HEIGHT.regular,
    // Never squashed when a caller's flex: 1 lands it in a short column (a footer in a
    // short window).
    minHeight: PILL_HEIGHT.regular,
    // Room either side, so a button sized to its label never crowds it. Less in the
    // browser's 380px popup, where two buttons share a row and labels would wrap.
    paddingHorizontal: isWeb ? 14 : 24,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compact: {
    height: PILL_HEIGHT.compact,
    minHeight: PILL_HEIGHT.compact,
    paddingHorizontal: isWeb ? 14 : 20,
    borderRadius: 20,
  },
  // A leading icon or custom content: laid out in a row beside the label.
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  primary: {
    backgroundColor: c.primary,
  },
  secondary: {
    backgroundColor: c.raised,
  },
  disabled: {
    backgroundColor: c.primaryTint,
  },
  label: {
    color: c.onPrimary,
    fontSize: 19,
    fontWeight: '600',
  },
  compactLabel: {
    fontSize: 15,
  },
  danger: {
    backgroundColor: c.error,
  },
  dangerLabel: {
    color: '#FFFFFF',
  },
  // Faded red rather than the honey tint, which means a disabled honey button.
  dangerDisabled: {
    backgroundColor: `${c.error}2E`,
  },
  dangerDisabledLabel: {
    color: `${c.error}99`,
  },
  secondaryLabel: {
    color: c.text,
  },
  disabledLabel: {
    color: c.disabledText,
  },
}));
