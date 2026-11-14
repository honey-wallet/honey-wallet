import type { CSSProperties } from 'react';
import { JoinWaitlist } from './app-link';
import { Friends } from './friends';
import styles from './hero.module.css';
import { JarGlyph } from './jar';
import { ProductPhone } from './product-phone';
import { Display } from './type';

/*
 * The hero arrives with a CSS intro (`.intro`, globals.css) rather than a scroll reveal: it is on
 * screen at load, so it plays on first paint instead of waiting for React to hydrate.
 */
const at = (i: number) => ({ '--i': i }) as CSSProperties;

/** A full-width illustrated introduction, and the way onto the waitlist. */
export function Hero() {
  return (
    <section aria-labelledby="hero-title" className={styles.stage} id="top">
      <div className={styles.content}>
        <div className="intro" style={at(0)}>
          <Display className={styles.headline} id="hero-title">
            <span className="block whitespace-nowrap">
              Invest in what <br className="md:hidden" />
              you <span className="text-brand-deep">believe</span>,
            </span>
            <span className="block whitespace-nowrap">
              with <Friends /> friends.
            </span>
          </Display>
        </div>

        <div className="intro mt-8 flex justify-center" style={at(1)}>
          <JoinWaitlist className="text-[0.9375rem] [--liquid-button-height:48px] [--liquid-button-padding:24px]">
            <JarGlyph className="-my-1 size-8!" />
          </JoinWaitlist>
        </div>
      </div>
      {/* 14 Nov: the two phones flank the headline, tilted outward (the owner's sketch):
          Following on the left, everyone's jars on the right. Was below it, with captions:
      <div className={styles.product}>
        <div aria-hidden="true" className={styles.halo} />
        <figure className={styles.feedPhone}>
          <ProductPhone eager screen="feed" />
          <figcaption>The feed. Find your next idea.</figcaption>
        </figure>
        <figure className={styles.walletPhone}>
          <ProductPhone eager screen="wallet" />
          <figcaption>Your wallet. Always in your hands.</figcaption>
        </figure>
      </div> */}
      <div aria-hidden="true" className={styles.halo} />
      <div className={`${styles.side} ${styles.left}`}>
        <ProductPhone eager screen="feed" />
      </div>
      <div className={`${styles.side} ${styles.right}`}>
        <ProductPhone eager screen="everyone" />
      </div>
    </section>
  );
}
