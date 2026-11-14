import * as WebBrowser from 'expo-web-browser';
// import { useState } from 'react'; (the favicon fetch is commented out below)
import { Linking, Text, type TextStyle, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { type Citation, citedHost } from '@/lib/thesis';
import { citationParts } from '@/lib/thesis-chat';
import { makeStyles } from '@/theme';

/** Opens a cited page in the in-app browser (http(s) only; the server checks it too). */
function open(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  tap();
  void WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url).catch(() => {}));
}

/** A cited page's host name only (no `user:pass@`, port or `www.`). */
const hostName = citedHost;

/**
 * The site's first letter in a small round well. Not its favicon: fetching
 * `/favicon.ico` from each cited site would tell those sites the user's IP and when
 * they looked (security review, 2026-11-14).
 */
function Favicon({ source, size }: { source: Citation; size: number }) {
  const styles = useStyles();
  // const [failed, setFailed] = useState(false);
  // const origin = source.url.match(/^https?:\/\/[^/?#]+/i)?.[0];
  // if (failed || !origin)
  const letter = (hostName(source.url) || source.domain).charAt(0).toUpperCase();
  return (
    <View style={[styles.letter, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.letterText, { fontSize: size * 0.62 }]}>{letter}</Text>
    </View>
  );
  // return (
  //   <Image
  //     source={{ uri: `${origin}/favicon.ico` }}
  //     onError={() => setFailed(true)}
  //     style={{ width: size, height: size, borderRadius: 3 }}
  //     accessibilityIgnoresInvertColors
  //   />
  // );
}

/**
 * A citation as Claude shows one: the site's icon and its short domain in a small pill
 * ("reuters.com"). A tap opens the page.
 */
export function CitationPill({
  source,
  inline,
  more = 0,
}: {
  source: Citation;
  inline?: boolean;
  /** Further sources cited at the same spot, shown as "+n" (Claude's merged pill). */
  more?: number;
}) {
  const styles = useStyles();
  return (
    <PressableScale
      accessibilityRole="link"
      accessibilityLabel={`Source ${source.n}: ${source.title}, ${hostName(source.url) || source.domain}`}
      hitSlop={6}
      scaleTo={0.94}
      onPress={() => open(source.url)}
      // style={styles.pill}
      style={[styles.pill, inline && styles.pillInline]}
    >
      {/* <Favicon source={source} size={12} /> */}
      <Favicon source={source} size={inline ? 10 : 12} />
      {/* <Text style={styles.pillText} numberOfLines={1}> */}
      <Text style={[styles.pillText, inline && styles.pillTextInline]} numberOfLines={1}>
        {/* {source.domain} */}
        {hostName(source.url) || source.domain}
        {more ? ` +${more}` : ''}
      </Text>
    </PressableScale>
  );
}

/** Text whose `[n]` markers are drawn as citation pills, inline. */
export function CitedText({
  text,
  sources,
  style,
}: {
  text: string;
  sources: readonly Citation[] | undefined;
  style: TextStyle | TextStyle[];
}) {
  const styles = useStyles();
  // const parts = citationParts(text, sources);
  // Citations back to back ("[1][2]") share one pill: the first site, then "+1".
  const parts = mergeAdjacent(citationParts(text, sources));
  return (
    <Text style={style}>
      {parts.map((p, i) =>
        'text' in p ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text, in order.
          <Text key={i}>{p.text}</Text>
        ) : (
          // Was: <Text key={i}>{' '}<View style={styles.inline}><CitationPill source={p.source} /></View></Text>
          // A no-break space keeps the pill on its word's line, never opening the next one,
          // and the smaller pill fits inside the line instead of pushing lines apart.
          // biome-ignore lint/suspicious/noArrayIndexKey: a source may be cited twice.
          <Text key={i}>
            {'\u00A0'}
            <View style={styles.inline}>
              <CitationPill source={p.source} more={p.more} inline />
            </View>
          </Text>
        ),
      )}
    </Text>
  );
}

type Part = ReturnType<typeof citationParts>[number];
type Merged = { text: string } | { source: Citation; more: number };

/** Runs of citations with nothing but spaces between them, as one part with a count. */
function mergeAdjacent(parts: Part[]): Merged[] {
  const out: Merged[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if ('text' in p) {
      out.push(p);
      continue;
    }
    // "[1] [2]": drop the space between, then count the second into the first.
    const prev = last && 'text' in last && !last.text.trim() ? out[out.length - 2] : last;
    if (prev && 'source' in prev) {
      if (prev !== last) out.pop();
      if (prev.source.url !== p.source.url) prev.more += 1;
      continue;
    }
    out.push({ source: p.source, more: 0 });
  }
  return out;
}

/** "Sources": the cited sites under an answer, as pills in a wrapping row. */
export function SourcesRow({ sources }: { sources: readonly Citation[] }) {
  const styles = useStyles();
  const seen = new Set<string>();
  const unique = sources.filter((s) => !seen.has(s.url) && seen.add(s.url));
  if (!unique.length) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.label}>Sources</Text>
      {unique.map((s) => (
        <CitationPill key={s.url} source={s} />
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 20,
    maxWidth: 160,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: c.raised,
  },
  // Sits on the text's baseline, not above it.
  // inline: { transform: [{ translateY: 4 }] },
  // Centred on the text's x-height, within the line's own height.
  // inline: { transform: [{ translateY: 3 }] },
  inline: { transform: [{ translateY: 2 }] },
  // In a sentence: shorter than the line (16/23), so lines keep an even rhythm.
  pillInline: { height: 17, maxWidth: 120, gap: 3, paddingHorizontal: 5, borderRadius: 8.5 },
  pillText: { flexShrink: 1, color: c.textSecondary, fontSize: 11, fontWeight: '500' },
  pillTextInline: { fontSize: 10.5 },
  letter: { alignItems: 'center', justifyContent: 'center', backgroundColor: c.divider },
  letterText: { color: c.textSecondary, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  label: { color: c.textSecondary, fontSize: 12, marginRight: 2 },
}));
