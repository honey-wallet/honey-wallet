import { useDeck } from '../deck/DeckContext';
import Reveal from '../deck/Reveal';
import './honey.css';

/* A looping, silent film made in ~/video-harness (films/honey-deck). Its background is the
   deck's #131313, so it sits on the slide with no frame. Thumbnails show the poster. */
export default function Clip({ name, label }: { name: string; label: string }) {
  const { isStatic } = useDeck();
  return (
    <Reveal className="clip-wrap">
      {isStatic ? (
        <img className="clip" src={`/video/${name}.jpg`} alt={label} />
      ) : (
        <video
          className="clip"
          src={`/video/${name}.mp4`}
          poster={`/video/${name}.jpg`}
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
