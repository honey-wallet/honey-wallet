'use client';

import { SendIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { JoinWaitlist } from './app-link';
import { FOUNDER, founderChat } from './founders';
import { LogoLink } from './logo';
import { ThemeToggle } from './theme-toggle';

/**
 * The topbar, fixed at the top and see-through: the page shows under it,
 * blurred, so it floats over the illustrations instead of cutting them off.
 * The wordmark on the left, and on the right a person (a founder, on
 * Telegram) and the way in. On a desk, hovering the face opens a card
 * first; on a phone a tap goes straight to the chat. A hairline marks the bar's edge once the page is under it.
 */
export function SiteNav() {
  const [scrolled, setScrolled] = useState(false);
  // The hero has its own call to action; the nav's appears once the hero has scrolled away.
  const [pastHero, setPastHero] = useState(false);
  useEffect(() => {
    const look = () => {
      setScrolled(window.scrollY > 8);
      const hero = document.getElementById('top');
      setPastHero(hero ? hero.getBoundingClientRect().bottom < 96 : window.scrollY > 400);
    };
    look();
    window.addEventListener('scroll', look, { passive: true });
    return () => window.removeEventListener('scroll', look);
  }, []);
  return (
    <header
      className={cn(
        'sticky top-0 z-50 border-b border-transparent bg-background/55 backdrop-blur-xl backdrop-saturate-150 transition-[border-color,background-color] duration-fast',
        scrolled && 'border-border/70 bg-background/70',
      )}
    >
      <div className="container-x flex items-center gap-2 px-3.5 py-2.5 sm:gap-3 sm:px-6 md:py-3.5 lg:px-8">
        <LogoLink
          className="motion-safe:hover:[&_svg]:animate-[logo-wiggle_420ms_ease-in-out_infinite]"
          large
        />

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {/* On a phone there's room for one: the face, then the button once past the hero.
              Below 375px there is no room for the face beside the switch at all. */}
          <div
            className={cn(
              'group relative shrink-0 max-[374px]:hidden',
              pastHero && 'max-sm:hidden',
            )}
          >
            <a
              aria-label={`Talk to ${FOUNDER.name}, a founder, on Telegram`}
              className="pressable relative block rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
              href={founderChat}
              rel="noopener noreferrer"
              target="_blank"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a 19 KB local photo; the optimiser adds nothing here */}
              <img
                alt=""
                className="size-10 rounded-full object-cover ring-2 ring-background"
                height={40}
                src={FOUNDER.photo}
                width={40}
              />
              <span
                aria-hidden="true"
                className="absolute -right-1 -bottom-1 grid size-[18px] place-items-center rounded-full bg-[#2AABEE] text-white ring-2 ring-background"
              >
                <SendIcon className="-ml-px size-2.5" strokeWidth={2.6} />
              </span>
            </a>
            {/* On a desk: who is behind the face, before the chat opens. Grows from the face, as a sticker peels off. */}
            <div className="pointer-events-none absolute top-full right-0 w-72 origin-top-right scale-90 pt-3 opacity-0 transition-[opacity,transform] duration-300 ease-smooth-out group-focus-within:pointer-events-auto group-focus-within:scale-100 group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:pointer-events-auto [@media(hover:hover)]:group-hover:scale-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:hidden">
              <div className="rounded-3xl border border-border bg-background p-4 shadow-lg">
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- as above */}
                  <img
                    alt={FOUNDER.name}
                    className="size-12 rounded-full object-cover"
                    height={48}
                    src={FOUNDER.photo}
                    width={48}
                  />
                  <div className="min-w-0">
                    <p className="font-semibold text-[0.9375rem] leading-tight">
                      Talk to the founders
                    </p>
                    <p className="mt-0.5 text-fg-muted text-sm leading-snug">
                      {FOUNDER.name} sets you up in a few minutes.
                    </p>
                  </div>
                </div>
                <a
                  className="pressable mt-3.5 flex h-10 items-center justify-center gap-2 rounded-full bg-[#2AABEE] font-medium text-[0.9375rem] text-white hover:brightness-105"
                  href={founderChat}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <SendIcon className="size-4" strokeWidth={2.2} />
                  Message on Telegram
                </a>
              </div>
            </div>
          </div>
          {/* Opens its own width as it fades in, so nothing jumps; out of the tab order while hidden. */}
          <div
            aria-hidden={!pastHero}
            className={cn(
              'grid transition-[grid-template-columns,opacity,translate] duration-500 ease-smooth-out motion-reduce:transition-none',
              pastHero
                ? 'grid-cols-[1fr] opacity-100'
                : 'pointer-events-none -ml-3 grid-cols-[0fr] translate-y-1 opacity-0 max-sm:hidden',
            )}
            inert={!pastHero}
          >
            <div className="-m-1 min-w-0 overflow-hidden p-1">
              <JoinWaitlist className="shrink-0 whitespace-nowrap text-[0.9375rem] [--liquid-button-height:40px] [--liquid-button-padding:20px] max-sm:text-[0.875rem] max-sm:[--liquid-button-padding:14px]" />
            </div>
          </div>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
