'use client';

import { motion, useReducedMotion } from 'framer-motion';
import Image from 'next/image';
import styles from './wallet.module.css';

/*
 * And a wallet for everything else: what Honey is besides jars, beside the app's real home screen
 * (test mode, light and dark captures; CSS shows the one for the theme). The phone rises out of the
 * card the first time it comes into view.
 */
const EASE = [0.16, 1, 0.3, 1] as const;

const POINTS = [
  'Send, receive, buy and sell.',
  'Ten EVM chains, from Ethereum and Base to Arbitrum and Polygon, plus Solana and NEAR.',
  'Your recovery phrase is made and kept on your phone. No account needed.',
];

export function Wallet() {
  const reduce = useReducedMotion() ?? false;
  const view = { once: true, margin: '0px 0px -15% 0px' } as const;
  const rise = (delay: number, y = 18) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y },
          whileInView: { opacity: 1, y: 0 },
          viewport: view,
          transition: { delay, duration: 0.7, ease: EASE },
        };

  return (
    <section aria-labelledby="wallet-title" className={styles.section} id="wallet">
      <div className={styles.card}>
        <div className={styles.copy}>
          <motion.h2 className={styles.title} id="wallet-title" {...rise(0)}>
            And a wallet for everything else.
          </motion.h2>
          <motion.p className={styles.lead} {...rise(0.08)}>
            Everything you’d expect from a wallet, on every chain a jar buys on.
          </motion.p>
          <ul className={styles.list}>
            {POINTS.map((point, i) => (
              <motion.li key={point} {...rise(0.14 + i * 0.07, 10)}>
                <span aria-hidden="true" className={styles.check}>
                  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
                    <path
                      d="M4 8.4l2.7 2.6L12 5.6"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                  </svg>
                </span>
                {point}
              </motion.li>
            ))}
          </ul>
        </div>

        <div className={styles.stage}>
          <motion.figure
            className={styles.device}
            {...(reduce
              ? {}
              : {
                  initial: { opacity: 0, y: 80, rotate: -1 },
                  whileInView: { opacity: 1, y: 0, rotate: 1 },
                  viewport: view,
                  transition: { delay: 0.1, duration: 1, ease: EASE },
                })}
          >
            <span className={styles.screen}>
              <Image
                alt="The Honey app's home: a $25.25 balance, Send, Receive, Buy and Sell, and Ethereum, Solana, NEAR and USD Coin."
                className={styles.light}
                height={1564}
                loading="lazy"
                quality={96}
                src="/screens/screen-home-light.jpg"
                width={739}
              />
              <Image
                alt=""
                aria-hidden="true"
                className={styles.dark}
                height={1564}
                loading="lazy"
                quality={96}
                src="/screens/screen-home-dark.jpg"
                width={739}
              />
            </span>
            <Image
              alt=""
              aria-hidden="true"
              className={styles.mockup}
              height={1448}
              loading="lazy"
              src="/mockups/honey-phone-hand.webp"
              unoptimized
              width={1086}
            />
            <svg
              aria-hidden="true"
              className={styles.frame}
              focusable="false"
              viewBox="0 0 1086 1448"
            >
              <defs>
                <mask
                  height="1448"
                  id="wallet-phone-frame-mask"
                  maskUnits="userSpaceOnUse"
                  width="1086"
                  x="0"
                  y="0"
                >
                  <rect fill="white" height="1448" width="1086" />
                  <rect fill="black" height="1107" rx="79" width="523" x="217" y="85" />
                </mask>
              </defs>
              <image
                height="1448"
                href="/mockups/honey-phone-hand.webp"
                mask="url(#wallet-phone-frame-mask)"
                width="1086"
              />
            </svg>
          </motion.figure>
        </div>
      </div>
    </section>
  );
}
