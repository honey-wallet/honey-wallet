import { Avatar as DiceBearAvatar, Style } from '@dicebear/core';
import dylan from '@dicebear/styles/dylan.json';
import { useMemo, useState } from 'react';
import { Image, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useTheme } from '@/theme';

// "Dylan" by Natalia Spivak, CC BY 4.0 (credited in Settings > About).
const style = new Style(dylan);

/** A new random seed; each seed always draws the same face. */
export function randomAvatarSeed() {
  return Math.random().toString(36).slice(2, 10);
}

type Props = {
  name: string;
  size: number;
  /** A photo URI; when absent, the generated avatar for `seed` is shown. */
  uri?: string | null;
  seed: string;
};

const colors = new Map<string, string | null>();

/** The colour a seed's face is drawn on (e.g. `#619eff`), for halos behind it. */
export function avatarColor(seed: string): string | null {
  const known = colors.get(seed);
  if (known !== undefined) return known;
  const xml = new DiceBearAvatar(style, { seed }).toString();
  const color = /<rect width="80" height="80" fill="(#[0-9a-fA-F]{6})"/.exec(xml)?.[1] ?? null;
  colors.set(seed, color);
  return color;
}

export function Avatar({ name, size, uri, seed }: Props) {
  const c = useTheme();
  // A photo that can't be read (deleted from the library, say) falls back to the face.
  const [failed, setFailed] = useState<string | null>(null);
  // react-native-svg can't parse DiceBear's RDF <metadata> block, and doesn't need it.
  const xml = useMemo(
    () => new DiceBearAvatar(style, { seed }).toString().replace(/<metadata>.*?<\/metadata>/s, ''),
    [seed],
  );

  if (uri && uri !== failed) {
    return (
      // The grey well shows while the photo decodes, so the spot never flashes empty.
      <Image
        source={{ uri }}
        onError={() => setFailed(uri)}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.raised }}
        accessibilityLabel="Profile photo"
      />
    );
  }

  return (
    <View
      accessibilityLabel={`Avatar for ${name}`}
      style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }}
    >
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  );
}
