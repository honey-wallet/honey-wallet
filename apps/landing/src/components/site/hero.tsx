import { JoinWaitlist } from './app-link';
import { HeroScene } from './art';
import { Friends } from './friends';
import styles from './hero.module.css';
import { Reveal } from './motion';
import { Display } from './type';

/** The jar, as a glyph: a lid over a rounded body, half full. */
function JarGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
      viewBox="0 0 20 20"
    >
      <path d="M6 3.2h8M6.8 5.6h6.4" />
      <path d="M6.6 5.6C4.6 6.2 3.9 7.6 3.9 9.4v4.7c0 1.7 1.2 2.7 2.8 2.7h6.6c1.6 0 2.8-1 2.8-2.7V9.4c0-1.8-.7-3.2-2.7-3.8" />
      <path d="M4 11.6c2 .9 4 .9 6 0s4-.9 6 0" />
    </svg>
  );
}

/** A full-width illustrated introduction, and the way onto the waitlist. */
export function Hero() {
  return (
    <section aria-labelledby="hero-title" className={styles.stage} id="top">
      <HeroScene />

      <div className={styles.content}>
        <Reveal index={1}>
          <Display className={styles.headline} id="hero-title">
            <span className="block">Invest in what</span>
            <span className="block">
              you <span className="text-brand-deep">believe</span>,
            </span>
            <span className="block whitespace-nowrap">
              with <Friends /> friends.
            </span>
          </Display>
        </Reveal>

        <Reveal index={2}>
          <div className="mt-8 flex justify-center">
            <JoinWaitlist className="text-[0.9375rem] [--liquid-button-height:48px] [--liquid-button-padding:24px]">
              <JarGlyph className="size-5" />
            </JoinWaitlist>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
