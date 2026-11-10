import { useDeck } from '../deck/DeckContext';
import Reveal from '../deck/Reveal';
import './honey.css';
import { asset } from '../asset';

// Bump after re-rendering a film so browsers fetch the new file instead of a cached one.
const V = '2026-11-10a';

/* A looping, silent film made in ~/video-harness (films/honey-deck). Its background is the
   deck's #131313, so it sits on the slide with no frame. Thumbnails show the poster. */
export default function Clip({ name, label }: { name: string; label: string }) {
  const { isStatic } = useDeck();
  return (
    <Reveal className="clip-wrap">
      {isStatic ? (
        <img className="clip" src={asset(`video/${name}.jpg?v=${V}`)} alt={label} />
      ) : (
        <video
          className="clip"
          src={asset(`video/${name}.mp4?v=${V}`)}
          poster={asset(`video/${name}.jpg?v=${V}`)}
          autoPlay
          muted
          loop
          playsInline
          aria-label={label}
        />
      )}
    </Reveal>
  );
}
