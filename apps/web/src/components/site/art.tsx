import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import styles from './art.module.css';
import { JAR_BODY, JAR_CLOTH, JAR_LID, JAR_OUTLINE, JarShade } from './jar';
import { EYES_PATH, MARK_ORIGIN, RING_PATH } from './mark-paths';

/*
 * The illustration layer, drawn in the page's own SVG rather than shipped as artwork.
 *
 * The cast is the Honey mark itself, given arms and legs in the brand's eye colour, with the
 * tokens a jar buys as coins (their real marks, from deck/public/logos). No confetti: everything
 * drawn is Honey, an idea, a jar or a token. Everything here is decoration: each scene is
 * aria-hidden and says nothing the text beside it does not.
 */

/* Every ink is a theme token (globals.css, --art-*), so the scenes repaint in dark mode. */
const INK = 'var(--art-limb)'; // arms and legs
const EYES = 'var(--art-eyes)'; // brandEyes, on the honey
const PAPER = 'var(--art-paper)';
const EDGE = 'var(--art-paper-edge)';
const HONEY = '#febe2b'; // brandYellow
const HONEY_SOFT = '#ffcf7b';
const AMBER = '#b5730a'; // the app's jar amber
const TINT = 'var(--art-tint)'; // primaryTint
const CLOUD = 'var(--art-cloud)';
const GREY = 'var(--art-grey)';

/* ---------- The cast ---------- */

type ArmPose = 'down' | 'wave' | 'out' | 'hold' | 'up';
type LegPose = 'stand' | 'walk' | 'sit';

/* Each arm as a quadratic curve from the shoulder, in units of the body's width (x) and
   height (y). The left arm is written out; the right one mirrors it. */
const ARM: Record<ArmPose, [number, number][]> = {
  down: [
    [0.06, 0.56],
    [-0.1, 0.66],
    [-0.12, 0.88],
  ],
  wave: [
    [0.06, 0.52],
    [-0.22, 0.42],
    [-0.18, 0.06],
  ],
  out: [
    [0.06, 0.55],
    [-0.16, 0.52],
    [-0.32, 0.4],
  ],
  hold: [
    [0.06, 0.58],
    [-0.12, 0.74],
    [-0.02, 0.94],
  ],
  up: [
    [0.06, 0.5],
    [-0.12, 0.3],
    [-0.06, -0.06],
  ],
};

const LEGS: Record<
  LegPose,
  { l: [number, number][]; r: [number, number][]; feet: [number, number, number][] }
> = {
  stand: {
    l: [
      [0.39, 0.97],
      [0.37, 1.1],
      [0.34, 1.24],
    ],
    r: [
      [0.61, 0.97],
      [0.63, 1.1],
      [0.66, 1.24],
    ],
    feet: [
      [0.3, 1.26, 0],
      [0.7, 1.26, 0],
    ],
  },
  walk: {
    l: [
      [0.39, 0.97],
      [0.33, 1.1],
      [0.24, 1.2],
    ],
    r: [
      [0.61, 0.97],
      [0.66, 1.12],
      [0.7, 1.25],
    ],
    feet: [
      [0.2, 1.22, -18],
      [0.75, 1.27, 0],
    ],
  },
  sit: {
    l: [
      [0.4, 0.97],
      [0.36, 1.06],
      [0.3, 1.14],
    ],
    r: [
      [0.6, 0.97],
      [0.65, 1.07],
      [0.72, 1.12],
    ],
    feet: [
      [0.26, 1.16, -24],
      [0.77, 1.13, 14],
    ],
  },
};

export function Mascot({
  x,
  y,
  w,
  left = 'down',
  right = 'down',
  legs = 'stand',
  look = 0,
  tilt = 0,
  blink = false,
  leftHand,
  rightHand,
}: {
  x: number;
  y: number;
  /** Body width; the body is 0.875 of this tall. */
  w: number;
  left?: ArmPose;
  right?: ArmPose;
  legs?: LegPose;
  /** Eyes glance left (-) or right (+), in body widths. */
  look?: number;
  tilt?: number;
  blink?: boolean;
  /** Drawn at the left or right hand, in the scene's units. */
  leftHand?: ReactNode;
  rightHand?: ReactNode;
}) {
  const h = w * 0.875;
  const at = ([u, v]: [number, number]) => `${x + u * w} ${y + v * h}`;
  const curve = (pts: [number, number][]) => `M${at(pts[0])} Q${at(pts[1])} ${at(pts[2])}`;
  const mirror = (pts: [number, number][]) => pts.map(([u, v]) => [1 - u, v] as [number, number]);
  const lArm = ARM[left];
  const rArm = mirror(ARM[right]);
  const leg = LEGS[legs];
  const stroke = w * 0.06;
  const hand = (pts: [number, number][]) => {
    const [u, v] = pts[2];
    return { cx: x + u * w, cy: y + v * h };
  };
  const lh = hand(lArm);
  const rh = hand(rArm);
  const s = w / MARK_ORIGIN.w;
  return (
    <g transform={tilt ? `rotate(${tilt} ${x + w / 2} ${y + h / 2})` : undefined}>
      <g fill="none" stroke={INK} strokeLinecap="round" strokeWidth={stroke}>
        <path d={curve(lArm)} />
        <path d={curve(rArm)} />
        <path d={curve(leg.l)} />
        <path d={curve(leg.r)} />
      </g>
      {leg.feet.map(([u, v, r]) => (
        <ellipse
          cx={x + u * w}
          cy={y + v * h}
          fill={AMBER}
          key={`${u}-${v}`}
          rx={w * 0.1}
          ry={w * 0.055}
          transform={r ? `rotate(${r} ${x + u * w} ${y + v * h})` : undefined}
        />
      ))}
      <g
        transform={`translate(${x} ${y}) scale(${s}) translate(${-MARK_ORIGIN.x} ${-MARK_ORIGIN.y})`}
      >
        <path d={RING_PATH} fill={HONEY} fillRule="evenodd" />
        <g transform={look ? `translate(${look * MARK_ORIGIN.w} 0)` : undefined}>
          <path className={blink ? styles.blink : undefined} d={EYES_PATH} fill={EYES} />
        </g>
      </g>
      <circle cx={lh.cx} cy={lh.cy} fill={INK} r={w * 0.06} />
      <circle cx={rh.cx} cy={rh.cy} fill={INK} r={w * 0.06} />
      {leftHand}
      {rightHand}
    </g>
  );
}

/* ---------- Props ---------- */

/** A token as a coin: its real mark, clipped round, with a rim underneath for weight. */
export function Coin({
  x,
  y,
  r,
  logo,
  chip,
  square,
}: {
  x: number;
  y: number;
  r: number;
  logo: string;
  chip?: string;
  /** A square mark (Base's blue square) sits whole on a white coin instead of filling it. */
  square?: boolean;
}) {
  const pad = chip ? r * 0.42 : 0;
  const side = r * 1.05;
  return (
    <g>
      <circle cx={x} cy={y + r * 0.14} fill="var(--art-rim)" r={r} />
      <circle cx={x} cy={y} fill={chip ?? '#fff'} r={r} />
      {square ? (
        <image
          height={side}
          href={`/logos/${logo}`}
          width={side}
          x={x - side / 2}
          y={y - side / 2}
        />
      ) : (
        <image
          clipPath="url(#art-coin)"
          height={r * 2 - pad}
          href={`/logos/${logo}`}
          preserveAspectRatio="xMidYMid slice"
          width={r * 2 - pad}
          x={x - r + pad / 2}
          y={y - r + pad / 2}
        />
      )}
    </g>
  );
}

/** The Honey jar, filling with the tokens a jar buys. (x, y) is the top of the lid; w its cloth's width. */
export function Jar({
  id,
  x,
  y,
  w,
  coins = [],
}: {
  id: string;
  x: number;
  y: number;
  w: number;
  coins?: { logo: string; chip?: string; u: number; v: number; r: number }[];
}) {
  const k = w / 48;
  const place = `translate(${x - 7 * k} ${y - 8 * k}) scale(${k})`;
  // The body, in page units: x 10 to 52 and y 21 to 58 of the jar's box.
  const left = x + 3 * k;
  const bw = 42 * k;
  const top = y + 13 * k;
  const bodyH = 37 * k;
  const fill = top + bodyH * 0.5;
  const wave = `M${left - 4} ${fill} Q${left + bw * 0.2} ${fill - bw * 0.07} ${left + bw * 0.42} ${fill} T${left + bw * 0.84} ${fill} T${left + bw + 30} ${fill} V${top + bodyH + 10} H${left - 4} Z`;
  return (
    <g>
      <defs>
        <clipPath id={`art-jar-${id}`}>
          <path d={JAR_BODY} transform={place} />
        </clipPath>
      </defs>
      <ellipse
        cx={left + bw / 2 + 2 * k}
        cy={top + bodyH + w * 0.03}
        fill="var(--art-shadow)"
        rx={w * 0.5}
        ry={w * 0.06}
      />
      <g transform={place}>
        <JarShade />
        <path d={JAR_BODY} fill="var(--jar-body)" />
      </g>
      <g clipPath={`url(#art-jar-${id})`}>
        <path d={wave} fill={HONEY} />
        <path
          d={wave}
          fill={HONEY_SOFT}
          opacity="0.55"
          transform={`translate(${bw * 0.12} ${-bw * 0.02})`}
        />
        {/* The coins in the honey are the only things on the page that drift, each out of step. */}
        {coins.map((c, i) => (
          <g className={styles.bob} key={c.logo} style={{ animationDelay: `${-i * 1.3}s` }}>
            <Coin chip={c.chip} logo={c.logo} r={c.r} x={left + c.u * bw} y={top + c.v * bodyH} />
          </g>
        ))}
      </g>
      <g transform={place}>
        <path d={JAR_BODY} fill="none" {...JAR_OUTLINE} />
        <path d={JAR_CLOTH} fill="var(--jar-cloth)" {...JAR_OUTLINE} />
        <path d={JAR_LID} fill="var(--jar-cloth)" {...JAR_OUTLINE} />
      </g>
    </g>
  );
}

/** The idea, as a note with a tail: what the user types into Honey. */
function IdeaNote({
  x,
  y,
  w,
  lines,
  rot = -5,
  tail = 'left',
}: {
  x: number;
  y: number;
  w: number;
  lines: string[];
  rot?: number;
  tail?: 'left' | 'right';
}) {
  const lh = w * 0.13;
  const h = w * 0.16 + lines.length * lh + w * 0.1;
  const tx = tail === 'left' ? x + w * 0.14 : x + w * 0.8;
  return (
    <g transform={`rotate(${rot} ${x + w / 2} ${y + h / 2})`}>
      <rect fill="var(--art-shadow)" height={h} rx={w * 0.09} width={w} x={x + 4} y={y + 8} />
      <path
        d={`M${tx} ${y + h - 2} l${tail === 'left' ? -w * 0.08 : w * 0.08} ${w * 0.14} l${tail === 'left' ? w * 0.16 : -w * 0.16} ${-w * 0.14}Z`}
        fill={PAPER}
      />
      <rect
        fill={PAPER}
        height={h}
        rx={w * 0.09}
        stroke={EDGE}
        strokeWidth="3"
        width={w}
        x={x}
        y={y}
      />
      <text
        fill="var(--art-muted)"
        fontFamily="var(--font-sans)"
        fontSize={w * 0.065}
        fontWeight="600"
        letterSpacing="0.02em"
        x={x + w * 0.09}
        y={y + w * 0.14}
      >
        YOUR IDEA
      </text>
      {lines.map((line, i) => (
        <text
          fill="var(--art-text)"
          fontFamily="var(--font-sans)"
          fontSize={w * 0.1}
          fontWeight="650"
          key={line}
          letterSpacing="-0.02em"
          x={x + w * 0.09}
          y={y + w * 0.16 + (i + 1) * lh}
        >
          {line}
        </text>
      ))}
      <rect
        fill={HONEY}
        height={w * 0.11}
        rx="2"
        width="4"
        x={x + w * 0.09 + lines[lines.length - 1].length * w * 0.053}
        y={y + w * 0.16 + lines.length * lh - w * 0.085}
      />
    </g>
  );
}

/**
 * The round clip every coin uses, defined once for the whole page (rendered by app/layout.tsx).
 * It lives in its own always-rendered SVG: a clip-path inside an SVG that CSS hides (the desktop
 * hero flanks on a phone) cannot be referenced, which drew the coins square.
 */
export function ArtDefs() {
  return (
    <svg aria-hidden="true" focusable="false" height="0" style={{ position: 'absolute' }} width="0">
      <defs>
        <clipPath clipPathUnits="objectBoundingBox" id="art-coin">
          <circle cx="0.5" cy="0.5" r="0.5" />
        </clipPath>
      </defs>
    </svg>
  );
}

function Svg({
  viewBox,
  className,
  children,
}: {
  viewBox: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      aria-hidden="true"
      className={cn(styles.svg, className)}
      focusable="false"
      viewBox={viewBox}
    >
      {children}
    </svg>
  );
}

/* ---------- Scenes ---------- */

/** Hero, left flank: the idea. Weighted to the outer edge; the inner third stays quiet. */
function HeroLeft() {
  return (
    <Svg viewBox="0 0 800 640">
      <circle cx="250" cy="380" fill={TINT} r="170" />
      <IdeaNote lines={['AI spending', 'keeps growing']} w={250} x={276} y={92} />
      <Mascot blink left="wave" legs="stand" look={0.02} right="out" w={220} x={150} y={278} />
      <Coin logo="near.svg" r={26} x={86} y={330} />
    </Svg>
  );
}

/** Hero, right flank: the jar, with the coins it buys going in. */
function HeroRight() {
  return (
    <Svg viewBox="0 0 800 640">
      <circle cx="560" cy="380" fill={TINT} r="180" />
      <g>
        <Coin logo="bittensor-coin.svg" r={30} x={420} y={150} />
      </g>
      <g>
        <Coin logo="render.svg" r={26} x={735} y={300} />
      </g>
      <path
        d="M455 205 Q480 250 500 268"
        fill="none"
        stroke={EDGE}
        strokeDasharray="2 12"
        strokeLinecap="round"
        strokeWidth="6"
      />
      <Jar
        id="j1"
        coins={[
          { logo: 'near.svg', u: 0.3, v: 0.62, r: 30 },
          { logo: 'usdc.svg', u: 0.66, v: 0.7, r: 26 },
          { logo: 'ethereum-coin.svg', u: 0.48, v: 0.86, r: 24 },
        ]}
        w={230}
        x={455}
        y={250}
      />
      <Mascot blink left="hold" legs="sit" look={-0.03} right="wave" w={120} x={510} y={150} />
    </Svg>
  );
}

/** Both halves at a size a phone can hold. */
function HeroPhone() {
  return (
    <Svg viewBox="0 0 640 400">
      <circle cx="210" cy="250" fill={TINT} r="130" />
      <circle cx="470" cy="250" fill={CLOUD} r="120" />
      <IdeaNote lines={['AI spending', 'keeps growing']} w={190} x={70} y={30} />
      <Mascot blink left="down" legs="stand" right="out" w={150} x={120} y={190} />
      <Jar
        id="j2"
        coins={[
          { logo: 'near.svg', u: 0.3, v: 0.6, r: 22 },
          { logo: 'usdc.svg', u: 0.68, v: 0.68, r: 20 },
          { logo: 'bittensor-coin.svg', u: 0.48, v: 0.86, r: 18 },
        ]}
        w={170}
        x={380}
        y={150}
      />
      <g>
        <Coin logo="render.svg" r={20} x={340} y={150} />
      </g>
    </Svg>
  );
}

export function HeroScene() {
  return (
    <div aria-hidden="true" className={styles.scene}>
      <span className={cn(styles.flank, styles.left)}>
        <HeroLeft />
      </span>
      <span className={cn(styles.flank, styles.right)}>
        <HeroRight />
      </span>
      <span className={styles.phoneArt}>
        <HeroPhone />
      </span>
    </div>
  );
}

/** "One idea, one jar.": the mascot with a checklist of the three steps. */
function StepsScene() {
  const rows = [0, 1, 2];
  return (
    <Svg viewBox="0 0 520 420">
      <circle cx="270" cy="230" fill={TINT} r="150" />
      <g transform="rotate(6 330 190)">
        <rect fill="var(--art-shadow)" height="210" rx="22" width="170" x="254" y="96" />
        <rect
          fill={PAPER}
          height="210"
          rx="22"
          stroke={EDGE}
          strokeWidth="3"
          width="170"
          x="248"
          y="88"
        />
        <rect fill={AMBER} height="22" rx="8" width="70" x="298" y="78" />
        {rows.map((i) => (
          <g key={i}>
            <circle cx="282" cy={142 + i * 52} fill={i < 2 ? HONEY : CLOUD} r="15" />
            {i < 2 && (
              <path
                d={`M274 ${142 + i * 52}l6 6 11-12`}
                fill="none"
                stroke={EYES}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="4"
              />
            )}
            <rect
              fill={i < 2 ? GREY : CLOUD}
              height="10"
              rx="5"
              width={i === 1 ? 70 : 90}
              x="308"
              y={137 + i * 52}
            />
          </g>
        ))}
      </g>
      <Mascot blink left="wave" legs="stand" look={0.03} right="hold" w={170} x={110} y={190} />
    </Svg>
  );
}

/** The agent at work: the mascot looking into an idea with a magnifier. */
function ExampleScene() {
  return (
    <Svg viewBox="0 0 420 380">
      <circle cx="210" cy="210" fill={PAPER} r="130" />
      <g>
        <Coin logo="bittensor-coin.svg" r={24} x={330} y={150} />
      </g>
      <Coin logo="render.svg" r={20} x={80} y={280} />
      <Mascot
        blink
        left="down"
        legs="walk"
        look={0.04}
        right="up"
        rightHand={
          <g>
            <line
              stroke={INK}
              strokeLinecap="round"
              strokeWidth="12"
              x1="292"
              x2="268"
              y1="96"
              y2="128"
            />
            <circle cx="304" cy="78" fill="var(--art-lens)" r="30" stroke={INK} strokeWidth="9" />
          </g>
        }
        w={160}
        x={120}
        y={140}
      />
    </Svg>
  );
}

/** Questions: the mascot between two speech bubbles. */
function FaqScene() {
  return (
    <Svg viewBox="0 0 480 440">
      <circle cx="240" cy="250" fill={TINT} r="150" />
      <g transform="rotate(-8 140 110)">
        <rect
          fill={PAPER}
          height="84"
          rx="26"
          stroke={EDGE}
          strokeWidth="3"
          width="120"
          x="80"
          y="68"
        />
        <path d="M120 150l-8 26 30-24z" fill={PAPER} />
        {[0, 1, 2].map((i) => (
          <circle cx={112 + i * 28} cy="110" fill="var(--art-text)" key={i} r="8" />
        ))}
      </g>
      <g transform="rotate(8 340 100)">
        <rect fill={HONEY} height="104" rx="30" width="104" x="290" y="46" />
        <path d="M318 146l-4 26 28-26z" fill={HONEY} />
        <text
          fill={EYES}
          fontFamily="var(--font-sans)"
          fontSize="72"
          fontWeight="700"
          textAnchor="middle"
          x="342"
          y="124"
        >
          ?
        </text>
      </g>
      <Mascot blink left="hold" legs="stand" look={0.04} right="up" w={170} x={155} y={190} />
    </Svg>
  );
}

const SECTION_SCENES = { steps: StepsScene, example: ExampleScene, faq: FaqScene } as const;

export function SectionScene({
  name,
  className,
}: {
  name: keyof typeof SECTION_SCENES;
  className?: string;
}) {
  const Scene = SECTION_SCENES[name];
  return (
    <span aria-hidden="true" className={cn(styles.sectionScene, className)}>
      <Scene />
    </span>
  );
}

/** The close: the mascot carrying a full jar along a path of chains. */
export function CtaScene({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn(styles.sectionScene, className)}>
      <Svg viewBox="0 0 640 400">
        {/* The ground fades out at its ends and foot instead of stopping at the frame. */}
        <defs>
          <radialGradient cx="0.5" cy="0.35" id="cta-ground-fade" r="0.5">
            <stop offset="0.35" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="cta-ground">
            <rect fill="url(#cta-ground-fade)" height="120" width="640" x="0" y="280" />
          </mask>
        </defs>
        <path d="M40 360 Q160 300 300 330 T600 310 V400 H40Z" fill={TINT} mask="url(#cta-ground)" />
        <ellipse cx="470" cy="352" fill={CLOUD} rx="150" ry="30" />
        <path
          d="M80 260 C160 180, 240 260, 320 190 S460 150, 560 120"
          fill="none"
          stroke={HONEY}
          strokeDasharray="1 18"
          strokeLinecap="round"
          strokeWidth="8"
        />
        <Coin logo="ethereum-coin.svg" r={22} x={100} y={240} />
        <Coin logo="base-square.svg" r={20} square x={200} y={232} />
        <Coin chip="#000" logo="solana.svg" r={22} x={318} y={190} />
        <Coin logo="near.svg" r={24} x={556} y={118} />
        <Mascot blink left="hold" legs="walk" look={0.04} right="hold" w={150} x={360} y={190} />
        <Jar
          id="j3"
          coins={[
            { logo: 'near.svg', u: 0.32, v: 0.62, r: 14 },
            { logo: 'usdc.svg', u: 0.66, v: 0.72, r: 12 },
          ]}
          w={88}
          x={392}
          y={250}
        />
      </Svg>
    </span>
  );
}
