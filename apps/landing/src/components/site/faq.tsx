import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionScene } from './art';
import { Reveal } from './motion';
import styles from './story.module.css';

const FAQS = [
  {
    q: 'What is a jar?',
    a: 'A basket of tokens built around one idea. You write the idea, Honey’s agent proposes the tokens and how much of each, and you can change any of it before you buy.',
  },
  {
    q: 'Who holds my money?',
    a: 'You do. Honey is a self-custody wallet: your recovery phrase is made and kept on your phone, and nothing is bought or sent without your approval.',
  },
  {
    q: 'Which chains does it buy on?',
    a: 'Ethereum, Base, Solana and NEAR. NEAR Intents quotes and settles each buy and bridge, so one approval fills picks on all of them.',
  },
  {
    q: 'Can the agent get it wrong?',
    a: 'Yes. That is why every proposal shows its sources and a critic’s case against it, and why nothing is bought until you review it and sign.',
  },
  {
    q: 'What does it cost?',
    a: 'You see the network and route fees before you approve. If you copy someone’s jar, its creator takes the cut they chose of your profit, never of a loss.',
  },
  {
    q: 'When can I use it?',
    a: 'Honey hasn’t launched yet. Join the waitlist and we’ll email you when it’s ready on iPhone, Android and Chrome.',
  },
] as const;

/**
 * The first answer is open so the questions read as part of the page.
 *
 * Plain <details>, one open at a time through their shared `name`: the browser
 * does what an accordion would, with no script to load or hydrate.
 */
export function Faq() {
  return (
    <section aria-labelledby="faq-title" className={styles.faq} id="faq">
      <Reveal>
        <h2 className={styles.title} id="faq-title">
          Questions, answered.
        </h2>
        <SectionScene className={styles.faqArt} name="faq" />
      </Reveal>

      <div className={styles.questions}>
        {FAQS.map((item, i) => (
          <details
            className={cn('group border-b last:border-b-0', styles.question)}
            key={item.q}
            name="faq"
            open={i === 0}
          >
            <summary className="flex flex-1 cursor-pointer list-none items-start justify-between gap-4 rounded-md py-5 text-left font-medium text-body text-foreground outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              {item.q}
              <ChevronDownIcon
                aria-hidden="true"
                className="pointer-events-none size-4 shrink-0 translate-y-0.5 opacity-80 transition-transform duration-200 ease-in-out group-open:rotate-180"
              />
            </summary>
            <div className="measure pt-0 pb-6 text-fg-muted text-sm leading-[1.75]">{item.a}</div>
          </details>
        ))}
      </div>
    </section>
  );
}
