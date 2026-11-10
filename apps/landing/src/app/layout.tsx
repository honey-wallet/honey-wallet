import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { ArtDefs } from '@/components/site/art';
import { SoonNotices } from '@/components/site/soon';
import './globals.css';

/*
 * One face: Inter, everywhere.
 *
 * It used to be three. Figtree carried the headings as a stand-in for
 * family.co's proprietary display face, Geist Mono carried every price and
 * figure, and Inter carried the prose. Three faces means three sets of metrics
 * to keep in agreement, and they did not stay in agreement: a heading and the
 * paragraph under it were tracked to different rules, and the figures in a
 * card were a different width and a different grey from the words beside them.
 *
 * One family removes the co-ordination problem rather than managing it. What
 * separated the faces now comes from the scale in globals.css, which is what
 * was doing most of the work anyway: size, weight and tracking per step, set
 * once. Headings read as headings because they are 600 at a display size with
 * tight tracking, not because they are a different typeface.
 *
 * Inter carries the figures too. It is a UI face with real tabular figures, so
 * `font-variant-numeric: tabular-nums` holds a column of prices still while it
 * ticks, which is the only thing the monospace was needed for.
 *
 * `--font-pixel` stays. It is the one deliberate accent on the page, in one
 * place, and it is a device rather than a second opinion about body copy. It
 * is loaded by that page (not-found.tsx), not here: from the layout, every page
 * preloaded the face, and the four other Geist Pixel faces its module declares.
 */
const inter = Inter({
  variable: '--font-sans',
  subsets: ['latin'],
  display: 'swap',
  // Inter's optical size axis, so large text gets the tighter, more closely
  // fitted drawing and small text keeps its open apertures. The type scale
  // leans on this: `font-optical-sizing: auto` has nothing to act on without
  // the axis present.
  axes: ['opsz'],
});

const SITE = 'https://honeywallet.org';

const TITLE = 'Honey Wallet | Invest in what you believe';
const DESCRIPTION =
  'Write one idea. Honey turns it into a jar of tokens and buys it across Ethereum, Base, Solana and NEAR in one approval. A self-custody wallet, better with friends.';
const SHORT =
  'Write one idea. Honey turns it into a jar of tokens and buys it on every chain, in one approval.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: 'Honey Wallet',
  keywords: [
    'crypto wallet',
    'self-custody',
    'jars',
    'NEAR',
    'NEAR Intents',
    'Solana',
    'Ethereum',
    'Base',
    'Honey Wallet',
  ],
  openGraph: {
    title: TITLE,
    description: SHORT,
    type: 'website',
    url: '/',
    siteName: 'Honey Wallet',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: SHORT,
  },
  // The icon and Apple touch icon come from src/app/icon.png and apple-icon.png.
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
  colorScheme: 'light dark',
};

/*
 * Applies the stored theme while the browser is still parsing the document, so
 * the right one is painted first. A `useEffect` would run after paint and the
 * reader would watch the page change colour under them.
 *
 * Falls back to the system setting when nothing has been chosen, which is why
 * it cannot simply be rendered server-side: neither value exists there.
 */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem("theme");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d);var m=document.querySelector('meta[name="theme-color"]');if(m)m.content=d?"#131313":"#ffffff"}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`h-full ${inter.variable} antialiased`}
      // The boot script sets a class React did not render.
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string that must run before paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <ArtDefs />
        {children}
        <SoonNotices />
      </body>
    </html>
  );
}
