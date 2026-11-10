import './honey.css';
import { asset } from '../asset';

/* Three friends' faces inline in a headline. Hover (or focus) a face to see its name in a honey tag.
   Faces are the app's own DiceBear "Dylan" avatars (public/avatars/SOURCES.md). */
const FRIENDS = [
  { name: 'Swayam', src: asset('avatars/friend-1.svg') },
  { name: 'Vivek', src: asset('avatars/friend-2.svg') },
  { name: 'Abhishek', src: asset('avatars/friend-3.svg') },
];

export default function Friends() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the faces sit inside the cover headline, where a <ul> is not allowed
    <span className="fr" role="list" aria-label="Friends">
      {FRIENDS.map((f) => (
        // biome-ignore lint/a11y/useSemanticElements: inline list item inside the headline
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users can reveal each name tag
        <span key={f.name} className="fr-face" role="listitem" tabIndex={0} aria-label={f.name}>
          <img src={f.src} alt="" draggable={false} />
          <span className="fr-tag" aria-hidden>
            {f.name}
          </span>
        </span>
      ))}
    </span>
  );
}
