import { AgentRun } from './agent-run';
import { SectionScene } from './art';
import story from './story.module.css';
import styles from './worked-example.module.css';

export function WorkedExample() {
  return (
    <section
      aria-labelledby="worked-example-title"
      className={story.chapter}
      data-story-section=""
      id="worked-example"
    >
      <div className={styles.card} data-story-card="">
        <div className={styles.heading}>
          <div>
            <h2 id="worked-example-title">The agent shows its work.</h2>
            <p>
              Say you think AI spending keeps growing. The agent researches it and proposes a jar;
              you make the call.
            </p>
          </div>
          <SectionScene className={styles.art} name="example" />
        </div>
        <div className={styles.demo}>
          <AgentRun />
        </div>
      </div>
    </section>
  );
}
