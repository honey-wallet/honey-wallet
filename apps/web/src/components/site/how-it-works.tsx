import { Film } from './film';
import styles from './story.module.css';
import { StorySection } from './story-section';

/**
 * The jar, as the deck shows it (slide 3, "Meet Jars"): one film of the real app.
 * Write an idea, review the jar, approve once.
 */
export function HowItWorks() {
  return (
    <StorySection
      id="how-it-works"
      lead="Say what you believe. Honey's agent turns it into a jar of tokens, and you buy it in one go."
      overview
      scene="steps"
      title="One idea, one jar."
      titleId="how-title"
    >
      <figure className={styles.filmFigure}>
        <Film label="The Honey app: write an idea, review the jar, approve once" name="flow" />
      </figure>
    </StorySection>
  );
}
