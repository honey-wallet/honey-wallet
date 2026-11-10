import styles from './friends.module.css';

/* Three friends' faces inline in the hero headline, as on the deck's cover (deck/src/components/
   Friends.tsx). Hover, focus or tap a face to see its name in a honey tag. The faces are the app's
   own DiceBear "Dylan" avatars (deck/public/avatars/SOURCES.md). */
const FRIENDS = [
  { name: 'Swayam', src: '/avatars/friend-1.svg' },
  { name: 'Vivek', src: '/avatars/friend-2.svg' },
  { name: 'Abhishek', src: '/avatars/friend-3.svg' },
];

export function Friends() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the faces sit inside the hero headline, where a <ul> is not allowed
    <span aria-label="Friends" className={styles.fr} role="list">
      {FRIENDS.map((f) => (
        // biome-ignore lint/a11y/useSemanticElements: inline list item inside the headline
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard and touch users can reveal each name tag
        <span aria-label={f.name} className={styles.face} key={f.name} role="listitem" tabIndex={0}>
          {/* eslint-disable-next-line @next/next/no-img-element -- small local SVG avatars */}
          <img alt="" draggable={false} src={f.src} />
          <span aria-hidden="true" className={styles.tag}>
            {f.name}
          </span>
        </span>
      ))}
    </span>
  );
}
