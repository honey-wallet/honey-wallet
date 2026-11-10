import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SectionScene } from './art';
import styles from './story.module.css';
import { Body } from './type';

export function StorySection({
  children,
  id,
  titleId,
  title,
  lead,
  scene,
  overview = false,
}: {
  children: ReactNode;
  id: string;
  titleId: string;
  title: string;
  lead: string;
  scene: 'steps' | 'example';
  overview?: boolean;
}) {
  return (
    <section aria-labelledby={titleId} className={styles.chapter} data-story-section="" id={id}>
      <div
        className={cn(styles.card, styles[scene], overview && styles.overview)}
        data-story-card=""
      >
        <div className={styles.intro}>
          <div>
            <h2 className={styles.title} id={titleId}>
              {title}
            </h2>
            <Body className={styles.lead}>{lead}</Body>
          </div>
          <SectionScene className={overview ? styles.art : styles.companion} name={scene} />
        </div>
        <div className={styles.demo}>{children}</div>
      </div>
    </section>
  );
}
