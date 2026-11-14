import { asset } from '../asset';
import './product-showcase.css';

type Screen = 'feed' | 'wallet' | 'jar' | 'group';
const CONTENT = {
  group: {
    eyebrow: 'GROUP JARS',
    title: 'Same idea. Everyone has a say.',
    body: 'Invite friends, put in equal shares, and see exactly what belongs to you.',
    points: [
      'Your slice, visible at a glance',
      'Equal contributions from each member',
      'Changes need a majority approval',
    ],
    second: 'feed',
  },
  feed: {
    eyebrow: 'THE SOCIAL FEED',
    title: 'An idea is better when it’s shared.',
    body: 'Follow people, see what they’re buying, and explore the thinking behind a jar.',
    points: [
      'Everyone, Following and Leaderboard',
      'Ideas with their holdings in view',
      'Copy a jar into your own wallet',
    ],
    second: 'jar',
  },
  jar: {
    eyebrow: 'YOUR IDEA, MADE TANGIBLE',
    title: 'One place to follow your conviction.',
    body: 'Review the idea. See the allocation. Keep track of the jar and everything it holds.',
    points: [
      'A proposal you can review and edit',
      'Holdings and performance together',
      'Your jar, on your terms',
    ],
    second: 'feed',
  },
  wallet: {
    eyebrow: 'THE WALLET',
    title: 'Everything you hold. One familiar home.',
    body: null,
    points: [
      'Tokens, Jars, NFTs and Activity',
      'Send, receive, buy and sell',
      'Keys stay on your device',
    ],
    second: 'feed',
  },
} as const;

function Phone({ screen, back = false }: { screen: Screen; back?: boolean }) {
  return (
    <div className={`ps-phone ${back ? 'ps-back' : 'ps-front'}`}>
      <div className="ps-display">
        <img
          src={asset(`screens/current/${screen}-dark.png`)}
          alt={`Honey ${screen} screen, captured from the current native app with sample data`}
          width={1206}
          height={2622}
          draggable={false}
        />
      </div>
    </div>
  );
}

export default function ProductShowcase({ screen }: { screen: Screen }) {
  const copy = CONTENT[screen];
  return (
    <div className={`ps-showcase ps-${screen}`}>
      <div className="ps-copy">
        <span className="ps-eyebrow">{copy.eyebrow}</span>
        <h3>{copy.title}</h3>
        {copy.body && <p>{copy.body}</p>}
        <ul>
          {copy.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </div>
      <div className="ps-devices">
        <Phone screen={copy.second} back />
        <Phone screen={screen} />
      </div>
    </div>
  );
}
