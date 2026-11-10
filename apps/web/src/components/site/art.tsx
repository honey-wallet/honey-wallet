import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import styles from './art.module.css';
import { EYES_PATH } from './mark-paths';

/*
 * The illustration layer: Honey (the mark with arms and legs) with an idea, a jar, a checklist,
 * a magnifier and two questions. The artwork is in public/illustrations/honey, written by the
 * scripts in scripts/generate-honey-*.mjs; each scene has a light and a dark file, and CSS shows
 * the one for the current theme.
 *
 * Over each picture sit the two things a static file cannot do: Honey's eyes blink, and the
 * tokens are their real protocol marks (in the jar's honey, on the route's chain holders, beside
 * the idea). Besides the blink, only the coins in a jar move; everything else stays still.
 * Everything here is decoration: each scene is aria-hidden and says nothing the text beside it
 * does not.
 */

const DIR = '/illustrations/honey';
const HONEY = '#FEBE2B';
const EYES = '#4B2817';

type Coin = {
  logo: string;
  x: number;
  y: number;
  /** A disc behind a logo that does not fill its own circle. */
  chip?: string;
  /** A square mark (Base): drawn as a rounded square on a white coin, not cropped to a dot. */
  square?: boolean;
  /** In a jar's honey: the only coins that move, bobbing a little as if afloat. */
  inJar?: boolean;
};

type SceneSpec = {
  w: number;
  h: number;
  /** Where the scene draws the Honey mark: the same transform as its <g> in the SVG file. */
  honey: string;
  coins?: Coin[];
};

/* Each `honey` transform is copied from the scene's SVG; if a generator moves Honey, update it here. */
const SCENES = {
  'honey-ai-idea-wave': {
    w: 1536,
    h: 1024,
    honey: 'translate(170 380) scale(1.15) translate(-244 -203)',
    coins: [{ logo: 'near.svg', x: 820, y: 540 }],
  },
  'honey-jar-sit-wave': {
    w: 1536,
    h: 1024,
    honey: 'translate(820 45) scale(1.15) translate(-244 -203)',
    coins: [
      { logo: 'near.svg', x: 900, y: 830, inJar: true },
      { logo: 'usdc.svg', x: 1075, y: 880, inJar: true },
      { logo: 'ethereum-coin.svg', x: 1215, y: 815, inJar: true },
      { logo: 'bittensor-coin.svg', x: 640, y: 250 },
    ],
  },
  'honey-idea-to-jar-compact': {
    w: 1536,
    h: 1024,
    honey: 'rotate(-3 360 610) translate(130 350) scale(1.15) translate(-244 -203)',
    coins: [
      { logo: 'near.svg', x: 985, y: 830, inJar: true },
      { logo: 'usdc.svg', x: 1160, y: 880, inJar: true },
      { logo: 'bittensor-coin.svg', x: 1295, y: 815, inJar: true },
      { logo: 'render.svg', x: 830, y: 330 },
    ],
  },
  'honey-clipboard-checklist': {
    w: 1024,
    h: 1024,
    honey: 'translate(100 330) scale(1.15) translate(-244 -203)',
  },
  'honey-magnifying-note': {
    w: 1024,
    h: 1024,
    // The eyes look down-right at the note, 10 and 8 units off the mark's own.
    honey: 'translate(120 310) scale(1.15) translate(-234 -195)',
    coins: [
      { logo: 'bittensor-coin.svg', x: 860, y: 320 },
      { logo: 'render.svg', x: 250, y: 220 },
    ],
  },
  'honey-question-bubbles': {
    w: 1024,
    h: 1024,
    honey: 'translate(282 400) scale(1.15) translate(-244 -203)',
  },
  'honey-carry-jar-across-chains': {
    w: 1536,
    h: 1024,
    honey: 'translate(660 180) scale(1.35) translate(-244 -203)',
    coins: [
      // The route's four chain holders.
      { logo: 'ethereum-coin.svg', x: 180, y: 190 },
      { logo: 'base-square.svg', x: 560, y: 158, square: true },
      { logo: 'solana.svg', x: 940, y: 80, chip: '#000' },
      { logo: 'near.svg', x: 1320, y: 50 },
      // In the jar's honey.
      { logo: 'near.svg', x: 845, y: 724, inJar: true },
      { logo: 'usdc.svg', x: 1015, y: 730, inJar: true },
    ],
  },
} satisfies Record<string, SceneSpec>;

type SceneName = keyof typeof SCENES;
type Crop = 'full' | 'left' | 'right';

/** A token as a coin: its real mark on a white disc with a rim, placed at (x, y) in the scene's
    units. Its size is the same for every coin on the page, a share of the picture's width
    (art.module.css, --coin), so it reads at any size the picture is drawn. */
function CoinMark({
  coin,
  box,
  index,
}: {
  coin: Coin;
  box: { x: number; w: number; h: number };
  index: number;
}) {
  return (
    <span
      className={cn(
        styles.coin,
        coin.square && styles.coinSquare,
        coin.chip && styles.coinChip,
        coin.inJar && styles.bob,
      )}
      style={
        {
          left: `${((coin.x - box.x) / box.w) * 100}%`,
          top: `${(coin.y / box.h) * 100}%`,
          '--chip': coin.chip,
          // Each coin in a jar bobs out of step with the next.
          animationDelay: coin.inJar ? `${-index * 1.3}s` : undefined,
        } as CSSProperties
      }
    >
      {/* biome-ignore lint/performance/noImgElement: a 24px static SVG mark */}
      <img alt="" decoding="async" loading="lazy" src={`/logos/${coin.logo}`} />
    </span>
  );
}

/** One scene in both themes, with the blink and the coins on top. `crop` keeps the square half
    of a wide scene that has the art in it. `delay` staggers the blink so the Honeys on screen
    do not all blink at once. */
function Scene({
  name,
  crop = 'full',
  eager,
  delay = 0,
}: {
  name: SceneName;
  crop?: Crop;
  eager?: boolean;
  delay?: number;
}) {
  const spec: SceneSpec = SCENES[name];
  const loading = eager ? 'eager' : 'lazy';
  // The part of the scene on screen: a wide scene cropped to a square keeps one half.
  const box =
    crop === 'full'
      ? { x: 0, w: spec.w, h: spec.h }
      : { x: crop === 'left' ? 0 : spec.w - spec.h, w: spec.h, h: spec.h };
  const viewBox = `${box.x} 0 ${box.w} ${box.h}`;
  return (
    <span
      className={cn(styles.frame, crop !== 'full' && styles[crop])}
      style={{ '--blink-delay': `${-delay}s` } as CSSProperties}
    >
      {/* biome-ignore lint/performance/noImgElement: a static SVG; next/image adds nothing here */}
      <img
        alt=""
        className={styles.onLight}
        decoding="async"
        loading={loading}
        src={`${DIR}/${name}.svg`}
      />
      {/* biome-ignore lint/performance/noImgElement: as above */}
      <img
        alt=""
        className={styles.onDark}
        decoding="async"
        loading={loading}
        src={`${DIR}/${name}-dark.svg`}
      />
      <svg aria-hidden="true" className={styles.overlay} focusable="false" viewBox={viewBox}>
        {/* The eyes sit on the solid yellow of the ring: cover the drawn pair, then blink a copy. */}
        <g transform={spec.honey}>
          <path d={EYES_PATH} fill={HONEY} stroke={HONEY} strokeWidth="4" />
          <path className={styles.blink} d={EYES_PATH} fill={EYES} />
        </g>
      </svg>
      {spec.coins?.map((coin, index) => (
        <CoinMark box={box} coin={coin} index={index} key={`${coin.logo}-${coin.x}`} />
      ))}
    </span>
  );
}

/** Hero: the idea on the left, the jar on the right; on a tablet, one scene with both. */
export function HeroScene() {
  return (
    <div aria-hidden="true" className={styles.scene}>
      <span className={cn(styles.flank, styles.flankLeft)}>
        <Scene crop="left" eager name="honey-ai-idea-wave" />
      </span>
      <span className={cn(styles.flank, styles.flankRight)}>
        <Scene crop="right" delay={2.3} eager name="honey-jar-sit-wave" />
      </span>
      <span className={styles.phoneArt}>
        <Scene delay={1.1} name="honey-idea-to-jar-compact" />
      </span>
    </div>
  );
}

const SECTION_SCENES = {
  steps: ['honey-clipboard-checklist', 0.8], // "One idea. One jar.": the three steps, two ticked
  example: ['honey-magnifying-note', 3.1], // the agent at work: looking into the idea
  faq: ['honey-question-bubbles', 1.7], // questions
} as const satisfies Record<string, readonly [SceneName, number]>;

export function SectionScene({
  name,
  className,
}: {
  name: keyof typeof SECTION_SCENES;
  className?: string;
}) {
  const [scene, delay] = SECTION_SCENES[name];
  return (
    <span aria-hidden="true" className={cn(styles.sectionScene, className)}>
      <Scene delay={delay} name={scene} />
    </span>
  );
}

/** The close: Honey carrying a full jar along the route across chains. */
export function CtaScene({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn(styles.sectionScene, className)}>
      <Scene delay={2.6} name="honey-carry-jar-across-chains" />
    </span>
  );
}
