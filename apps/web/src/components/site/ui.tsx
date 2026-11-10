import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Reveal } from './motion';
import { Body, Heading } from './type';

/**
 * The page grid.
 *
 * Sections are open runs of the page column with generous vertical room, not
 * bands closed by rules. Structure comes from the surfaces inside them: content
 * sits on rounded cards that float over the ground with their own light, and
 * the space between cards does the separating that hairlines used to do.
 *
 * Nothing here draws a border. If two things need to read as separate, they get
 * separate surfaces.
 */
export function Section({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className="scroll-mt-28" id={id}>
      <div className={cn('container-x px-4 py-14 sm:px-6 md:py-20 lg:px-8 lg:py-28', className)}>
        {children}
      </div>
    </section>
  );
}

/**
 * The base material: a rounded surface with an edge, a shadow, and a hairline
 * of light along the top.
 *
 * `raised` is the next step up and adds a top-to-bottom gradient, so a card on
 * a card still reads as two objects. Don't nest two raised surfaces.
 */
export function Panel({
  children,
  className,
  raised = false,
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  raised?: boolean;
  /** Rises toward the pointer on hover. For cards that are worth exploring. */
  interactive?: boolean;
}) {
  return (
    <div
      className={cn(
        raised ? 'surface-raised' : 'surface',
        // Radius lives here, not in the utility, so a caller can pass a
        // different `rounded-*` and have tailwind-merge honour it.
        'sheen-top overflow-hidden rounded-2xl',
        interactive && 'liftable',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Headline and an optional lead. Opens most sections.
 *
 * Centred by default: with sections now reading as floating cards rather than
 * as a ruled sheet, a left-aligned header leaves the right half of the column
 * empty above a full-width card and the page looks like it lost something.
 */
export function SectionHead({
  children,
  lead,
  className,
  id,
  align = 'center',
}: {
  children: ReactNode;
  lead?: ReactNode;
  className?: string;
  id?: string;
  align?: 'center' | 'left';
}) {
  const centred = align === 'center';

  return (
    <Reveal
      className={cn(
        'mb-10 flex flex-col md:mb-14',
        centred ? 'items-center text-center' : 'items-start',
        className,
      )}
    >
      <Heading className={cn('max-w-[20ch]', !centred && 'mt-0')} id={id}>
        {children}
      </Heading>
      {lead ? (
        <Body className={cn('mt-5', centred ? 'max-w-[54ch]' : 'max-w-[56ch]')}>{lead}</Body>
      ) : null}
    </Reveal>
  );
}
