import { InfoIcon } from 'lucide-react';
import { siAndroid, siApple } from 'simple-icons';
import { CtaScene } from './art';
import { Reveal } from './motion';
import styles from './story.module.css';
import { Display } from './type';
import { WaitlistForm } from './waitlist-form';

/* Where Honey is coming, with each platform's mark (Simple Icons, CC0) so it reads at a glance.
   Apple's mark takes the text colour, so it is black on paper and white in dark mode. */
const PLATFORMS = [
  { name: 'iPhone', icon: siApple, color: 'var(--fg)' },
  { name: 'Android', icon: siAndroid, color: `#${siAndroid.hex}` },
];

/** The close: one headline and the waitlist. Every "Join the waitlist" on the page lands here. */
export function Cta() {
  return (
    <section aria-labelledby="cta-title" className={styles.cta} id="start">
      <Reveal className={styles.ctaCard}>
        <div>
          <Display as="h2" className="whitespace-nowrap max-sm:text-[2.125rem]" id="cta-title">
            One idea. One jar.
          </Display>
          <p className={styles.platforms}>
            <span>Coming to</span>
            {PLATFORMS.map((p) => (
              <span className={styles.platform} key={p.name}>
                <svg aria-hidden="true" fill={p.color} viewBox="0 0 24 24">
                  <path d={p.icon.path} />
                </svg>
                {p.name}
              </span>
            ))}
          </p>
          <WaitlistForm className="mt-7" />
          {/* Fine print where the reader commits: what the examples are, and the risk. */}
          <p className={styles.fine}>
            <InfoIcon aria-hidden="true" />
            {/* <span>
              Examples on this page use sample prices. Crypto prices go down as well as up; never
              put in more than you&rsquo;d be fine losing.
            </span> */}
            {/* The risk line is off (14 Nov, owner); the sample-prices note stays. */}
            {/* <span>Examples on this page use sample prices.</span> (off 14 Nov, owner) */}
          </p>
        </div>
        <CtaScene className={styles.ctaArt} />
      </Reveal>
    </section>
  );
}
