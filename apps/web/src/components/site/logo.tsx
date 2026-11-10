import Link from 'next/link';
import { cn } from '@/lib/utils';
import { EYES_PATH, MARK_VIEWBOX, RING_PATH } from './mark-paths';

/**
 * The Honey mark: the honey hexagon ring and its eyes, in the brand's own colours
 * (brandYellow and brandEyes in apps/mobile/src/theme). The eyes blink now and then.
 */
export function LogoMark({ className, blink = false }: { className?: string; blink?: boolean }) {
  return (
    <svg aria-hidden="true" className={cn('block shrink-0', className)} viewBox={MARK_VIEWBOX}>
      <path d={RING_PATH} fill="var(--honey-yellow)" fillRule="evenodd" />
      <path className={blink ? 'honey-blink' : undefined} d={EYES_PATH} fill="var(--honey-ink)" />
    </svg>
  );
}

/**
 * The mark and the wordmark, linking home. Used by the nav and the footer. The wordmark
 * is lowercase, as on the app icon and the store listing.
 */
export function LogoLink({ className, large = false }: { className?: string; large?: boolean }) {
  return (
    <Link
      aria-label="Honey Wallet home"
      className={cn(
        'pressable flex items-center text-foreground',
        large ? 'gap-2.5' : 'gap-2',
        className,
      )}
      href="/"
    >
      {/* Large (the nav): the mark as tall as the bar's buttons, 40px. */}
      <LogoMark blink className={large ? 'h-8 w-9 sm:h-10 sm:w-[45px]' : 'h-[22px] w-[25px]'} />
      <span
        className={cn(
          'font-semibold tracking-[-0.025em]',
          large ? 'text-[1.375rem] sm:text-[1.625rem]' : 'text-[1.0625rem]',
        )}
      >
        honey
      </span>
    </Link>
  );
}
