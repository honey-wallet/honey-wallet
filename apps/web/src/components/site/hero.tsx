import { JoinWaitlist } from './app-link';
import { HeroScene } from './art';
import { Friends } from './friends';
import styles from './hero.module.css';
import { JarGlyph } from './jar';
import { Reveal } from './motion';
import { Display } from './type';

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
              <JarGlyph className="-my-1 size-8!" />
            </JoinWaitlist>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
