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
export function CitationPill({ source }: { source: Citation }) {
  const styles = useStyles();
  return (
    <PressableScale
      accessibilityRole="link"
      accessibilityLabel={`Source ${source.n}: ${source.title}, ${hostName(source.url) || source.domain}`}
      hitSlop={6}
      scaleTo={0.94}
      onPress={() => open(source.url)}
      style={styles.pill}
    >
      <Favicon source={source} size={12} />
      <Text style={styles.pillText} numberOfLines={1}>
        {/* {source.domain} */}
        {hostName(source.url) || source.domain}
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
  const parts = citationParts(text, sources);
  return (
    <Text style={style}>
      {parts.map((p, i) =>
        'text' in p ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed text, in order.
          <Text key={i}>{p.text}</Text>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a source may be cited twice.
          <Text key={i}>
            {' '}
            <View style={styles.inline}>
              <CitationPill source={p.source} />
            </View>
          </Text>
        ),
      )}
    </Text>
  );
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
  inline: { transform: [{ translateY: 4 }] },
  pillText: { flexShrink: 1, color: c.textSecondary, fontSize: 11, fontWeight: '500' },
  letter: { alignItems: 'center', justifyContent: 'center', backgroundColor: c.divider },
  letterText: { color: c.textSecondary, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  label: { color: c.textSecondary, fontSize: 12, marginRight: 2 },
}));
