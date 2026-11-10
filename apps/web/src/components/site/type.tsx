import type { ElementType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The type scale, as components.
 *
 * The scale itself lives in globals.css as `--text-display` through
 * `--text-kicker`, each step carrying its own size, line height, tracking and
 * weight. These are the handles on it. Edit the two together.
 *
 * Why components rather than just the `text-*` utilities they wrap: a step is
 * never only a size. Every heading on the page also wanted a colour, and every
 * caption wanted a different one, so call sites were spelling out
 * `text-body text-fg-muted` or `font-mono text-fg-subtle text-kicker` by hand.
 * Those strings drifted. `text-caption` was being used in two places and
 * defined in none, a heading was tracked by hand to cancel out a family that
 * is no longer there, and the same grey was spelled three ways on text doing
 * one job.
 *
 * So the pairing is the thing worth naming. `<Body tone="muted">` is one
 * decision with one place to change it; `text-body text-fg-muted` is two
 * decisions that happen to agree today.
 *
 * Sizes are not overridable through a prop on purpose. A step is a step: if a
 * design needs something between title and body, that is a new step in the
 * scale, declared in globals.css and registered in the tailwind-merge config
 * in `lib/utils.ts`, not a one-off `text-[15px]` at a call site. Passing
 * `className` still works for layout, margins and the odd deliberate
 * exception.
 */

/**
 * The colour roles text may take.
 *
 * A closed set rather than free `text-*` classes, because the greys are the
 * part that drifted. `subtle` is quieter than `muted`: muted is for prose you
 * are meant to read, subtle for labels you are meant to skim past.
 */
export type Tone = 'default' | 'muted' | 'subtle' | 'brand' | 'up' | 'down';

const TONE: Record<Tone, string> = {
  default: 'text-foreground',
  muted: 'text-fg-muted',
  subtle: 'text-fg-subtle',
  brand: 'text-brand',
  up: 'text-up',
  down: 'text-down',
};

type TextProps = {
  children: ReactNode;
  className?: string;
  tone?: Tone;
  /** The element to render. Each step has a sensible default. */
  as?: ElementType;
  id?: string;
  /**
   * For text that has to announce itself: a form error, a figure that updates
   * in place. Deliberately just these two rather than a full attribute
   * spread — the point of the component is that a call site chooses a step and
   * a tone, not that it can reach past them and restyle the text.
   */
  role?: string;
  'aria-live'?: 'off' | 'polite' | 'assertive';
};

function Text({
  step,
  as,
  tone,
  className,
  children,
  id,
  role,
  'aria-live': ariaLive,
}: TextProps & { step: string; as: ElementType; tone: Tone }) {
  const Tag = as;
  return (
    <Tag aria-live={ariaLive} className={cn(step, TONE[tone], className)} id={id} role={role}>
      {children}
    </Tag>
  );
}

/** The page's one big statement. The hero, and nothing else. */
export function Display({ as = 'h1', tone = 'default', ...rest }: TextProps) {
  return <Text as={as} step="text-display" tone={tone} {...rest} />;
}

/** Opens a section. Reads as a heading through weight and tracking. */
export function Heading({ as = 'h2', tone = 'default', ...rest }: TextProps) {
  return <Text as={as} step="text-heading" tone={tone} {...rest} />;
}

/** Names a card or a slide, inside a section that already has a heading. */
export function Title({ as = 'h3', tone = 'default', ...rest }: TextProps) {
  return <Text as={as} step="text-title" tone={tone} {...rest} />;
}

/**
 * Prose. Defaults to muted, because body copy on this page is almost always
 * support for a heading rather than the thing being announced.
 */
export function Body({ as = 'p', tone = 'muted', ...rest }: TextProps) {
  return <Text as={as} step="text-body" tone={tone} {...rest} />;
}

/**
 * Fine print: the line under a form, a disclaimer, an error.
 *
 * Same size as Kicker and a different job. This one is meant to be read, so it
 * takes the body weight and leading to match; Kicker is a label at 600 that
 * you skim past.
 */
export function Caption({ as = 'p', tone = 'subtle', ...rest }: TextProps) {
  return <Text as={as} step="text-caption" tone={tone} {...rest} />;
}

/**
 * The small label above or beside a figure. Sentence case, never caps.
 *
 * This was the one step set in the monospace face. It is Inter now: at 13px
 * the two were nearly indistinguishable in shape and clearly different in
 * colour and width, which is the worst of both.
 */
export function Kicker({ as = 'p', tone = 'subtle', ...rest }: TextProps) {
  return <Text as={as} step="text-kicker" tone={tone} {...rest} />;
}

/**
 * A number: a price, a size, a P&L.
 *
 * Carries the numeric treatment and nothing else, so it composes with any step
 * or size the caller needs. That is deliberate: figures on this page run from
 * 12px in a chart label to 48px in a hero readout, and they all need the same
 * tabular, flat-tracked digits underneath.
 *
 * For a figure inside an `<svg>`, use the `figures` utility directly on the
 * `<text>` element. A component cannot help there.
 */
export function Figure({ as = 'span', tone = 'default', ...rest }: TextProps) {
  return <Text as={as} step="figures" tone={tone} {...rest} />;
}
