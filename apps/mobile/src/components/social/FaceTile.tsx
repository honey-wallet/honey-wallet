import { type ReactNode, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { SHEET } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

/** How wide the fade at the row's right edge is. */
const FADE = 56;

/** A face in a people row: Launch's "Who's in" and the Add friends suggestions. */
export const FACE = 84;

/**
 * One person as a big round face with a short name under it (the "Situations" row of the
 * design sketch). A corner badge says what tapping does: × takes them out, ✓ marks them
 * picked. Without `onPress` it is just shown (you).
 */
export function FaceTile({
  face,
  label,
  sublabel,
  onPress,
  badge,
  accessibilityLabel,
}: {
  /** The face itself, FACE wide: an avatar, or the add well. */
  face: ReactNode;
  /** The name under the face. */
  label: string;
  /** A second, quieter line: the @handle under a person's name. */
  sublabel?: string;
  onPress?: () => void;
  badge?: 'remove' | 'check';
  accessibilityLabel?: string;
}) {
  const styles = useStyles();
  const c = useTheme();
  const body = (
    <>
      <View>
        {face}
        {badge === 'remove' ? (
          <View style={[styles.badge, styles.badgeRemove]}>
            <Icon name="close" size={10} color={c.textSecondary} />
          </View>
        ) : badge === 'check' ? (
          <View style={[styles.badge, styles.badgeCheck]}>
            <Icon name="check" size={11} color={c.onPrimary} />
          </View>
        ) : null}
      </View>
      <View style={styles.names}>
        <Text style={styles.name} numberOfLines={1}>
          {label}
        </Text>
        {sublabel ? (
          <Text style={styles.handle} numberOfLines={1}>
            {sublabel}
          </Text>
        ) : null}
      </View>
    </>
  );
  if (!onPress) return <View style={styles.tile}>{body}</View>;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (sublabel ? `${label}, ${sublabel}` : label)}
      accessibilityState={badge === 'check' ? { selected: true } : undefined}
      scaleTo={0.96}
      onPress={() => {
        tap();
        onPress();
      }}
      style={styles.tile}
    >
      {body}
    </PressableScale>
  );
}

/** The add face: a honey-tinted well with a plus, the size of a face. */
export function AddFace() {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.add}>
      <Icon name="plus" size={28} color={c.accentText} />
    </View>
  );
}

/**
 * Faces in a row that runs to the sheet's edges and scrolls sideways. While more faces
 * wait off the right edge, the row fades out into the sheet there, so it reads as
 * scrollable; the fade goes once you reach the end (or when everything fits).
 */
export function FaceRow({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const c = useTheme();
  const [shown, setShown] = useState(0);
  const [content, setContent] = useState(0);
  const [x, setX] = useState(0);
  const more = content - (x + shown) > 4;
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.row}
        style={styles.scroll}
        onLayout={(e) => setShown(e.nativeEvent.layout.width)}
        onContentSizeChange={(w) => setContent(w)}
        onScroll={(e) => setX(e.nativeEvent.contentOffset.x)}
        scrollEventThrottle={32}
      >
        {children}
      </ScrollView>
      {more ? (
        <Animated.View
          pointerEvents="none"
          entering={FadeIn.duration(DURATION.fast)}
          exiting={FadeOut.duration(DURATION.fast)}
          style={styles.fade}
        >
          <Svg width={FADE} height="100%">
            <Defs>
              <LinearGradient id="faceRowFade" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={c.sheet} stopOpacity={0} />
                <Stop offset="1" stopColor={c.sheet} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect width={FADE} height="100%" fill="url(#faceRowFade)" />
          </Svg>
        </Animated.View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  scroll: { marginHorizontal: -SHEET.gutter },
  // Over the row's right end, at the sheet's edge (the row runs past the gutter).
  fade: { position: 'absolute', top: 0, bottom: 0, right: -SHEET.gutter, width: FADE },
  row: { gap: 16, paddingHorizontal: SHEET.gutter, paddingBottom: 4 },
  tile: { width: FACE, alignItems: 'center', gap: 8 },
  names: { maxWidth: FACE, alignItems: 'center', gap: 1 },
  name: { maxWidth: FACE, color: c.text, fontSize: 14, fontWeight: '600' },
  handle: { maxWidth: FACE, color: c.textSecondary, fontSize: 13 },
  add: {
    width: FACE,
    height: FACE,
    borderRadius: FACE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: c.canvas,
  },
  badgeRemove: { backgroundColor: c.raised },
  badgeCheck: { backgroundColor: c.primary },
}));
