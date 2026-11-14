import AgentRun from './components/AgentRun';
import ChartSlide, { AsideStat, BigStats } from './components/ChartSlide';
import { cite } from './components/Cite';
import Clip from './components/Clip';
import Contacts from './components/Contacts';
import Friends from './components/Friends';
import { Brand, LogoStack, OnChain } from './components/Logo';
import ProductShowcase from './components/ProductShowcase';
import RoutePlan, { ChainMarks } from './components/RoutePlan';
import Together from './components/Together';
import { agentStages, samplePicks, sampleRoutes, sources } from './data/sources';
import Deck from './deck/Deck';
import Reveal from './deck/Reveal';
import Slide from './deck/Slide';
import './components/honey.css';
import { asset } from './asset';

/* Honey Wallet: Jars, for the NEAR Hackathon judges. Every outside number is cited;
   product facts come from the honey-wallet repository and its test mode. */

const REPO = 'https://github.com/honey-wallet/honey-wallet';
/* Every chain Honey holds and buys on: the EVM networks (one address on all of them), Solana and NEAR. */
const CHAINS = [
  'Ethereum',
  'Base',
  'Arbitrum',
  'Optimism',
  'Polygon',
  'BNB',
  'Avalanche',
  'Gnosis',
  'Linea',
  'Scroll',
  'Solana',
  'NEAR',
];

const Lockup = ({ big }: { big?: boolean }) => (
  <div className={`hl${big ? ' big' : ''}`}>
    <img src={asset('honey-mark.svg')} alt="" />
    Honey
  </div>
);

export default function App() {
  return (
    <Deck>
      <Slide
        center
        nav="Honey"
        notes="Honey is a multichain wallet. Jars is what we built for the NEAR Hackathon: one sentence about the market becomes one cross-chain purchase."
      >
        <Reveal>
          <Lockup big />
        </Reveal>
        <Reveal delay={0.08}>
          <h1
            className="display"
            style={{
              marginTop: 28,
              maxWidth: 'none',
              fontSize: 'clamp(30px, 6.4vw, 104px)',
              whiteSpace: 'nowrap',
            }}
          >
            Invest in what you <span className="accent-text">believe</span>,<br />
            with <Friends /> friends.
          </h1>
        </Reveal>
      </Slide>

      <ChartSlide
        nav="The problem"
        notes="Today a market view means researching tokens one by one, finding the chain each trades on, bridging and placing several swaps with different slippage. Most people give up, or buy one token and hope."
        title="One idea, eight steps."
        source={
          <>
            <b>Figure 1.</b> Today vs Honey {cite(4)}.
          </>
        }
      >
        <Clip
          name="problem"
          label="Eight steps today: research, find chains, wallets, bridges, gas, three swaps. With Honey: approve once."
        />
      </ChartSlide>

      <ChartSlide
        nav="The market"
        notes="Crypto.com estimates 741 million owners at the end of 2025, up from 659 million. Reown and Nansen surveyed 1,038 active users in the US and UK: 62% use two or more wallets, and the top reason, at 48%, is reaching different chains. NEAR Intents is the rail that already moves this money across chains."
        title="741M own crypto on many chains. They need one easy app."
        source={
          <>
            <b>Figure 2.</b> End of 2025 {cite(1)} · 1,038 active users {cite(2)} · 9 Nov 2026{' '}
            {cite(3)}.
          </>
        }
      >
        <BigStats
          items={[
            {
              brand: <Brand id="cryptocom" size="30px" />,
              value: '741M',
              label: 'people own crypto',
              source: cite(1),
            },
            {
              brand: (
                <>
                  <Brand id="reown" size="30px" />
                  <Brand id="nansen" size="30px" />
                </>
              ),
              value: '62%',
              label: (
                <>
                  <LogoStack
                    ids={['metamask', 'phantom', 'coinbasewallet', 'sender']}
                    size="1.3em"
                  />{' '}
                  juggle 2+ wallets
                </>
              ),
              source: cite(2),
            },
            {
              brand: (
                <Brand id="near" size="30px">
                  NEAR Intents
                </Brand>
              ),
              value: '$33B+',
              label: 'moved cross-chain',
              source: cite(3),
            },
          ]}
        />
      </ChartSlide>

      <ChartSlide
        nav="Jars"
        notes="The real app, in test mode. Write an idea, or paste a post. The agent proposes a jar with picks, weights and fees, ready to edit. One approval buys every pick on every chain, and the jar goes live."
        title="Meet Jars."
        source={
          <>
            <b>Figure 3.</b> Honey app, test mode.
          </>
        }
      >
        <Clip name="flow2" label="The Honey app: write an idea, review the jar, approve once" />
      </ChartSlide>

      <ChartSlide
        nav="The agent"
        notes="These are the six steps the app shows while the agent works on NEAR AI Cloud. The proposal names each pick, its chain, its weight and why. A critic agent writes the strongest objection, so the user sees the case against before buying."
        title="The agent picks tokens from your thesis."
        source={
          <>
            <b>Figure 4.</b> Honey app, test mode, $500.
          </>
        }
      >
        <AgentRun
          stages={agentStages}
          thesis="Big tech keeps spending on AI data centres; chips and power win first."
          picks={samplePicks}
          caution="News this widely shared is often already in the price."
          fee="$3.00"
        />
      </ChartSlide>

      <ChartSlide
        nav="Routes"
        notes="The route planner spreads each buy across the venues and chains where it trades, cheapest first, within the user's max slippage. Here a $5,000 jar starting as USDC on Base fills on four chains: TAO splits across Uniswap on Ethereum and Aerodrome on Base. These are the planner's real outputs on test-mode prices and pool depths."
        title="One approval, every chain. Easy to use."
        source={
          <>
            <b>Figure 5.</b> Route planner, $5,000 jar, test-mode prices.
          </>
        }
        aside={
          <>
            <AsideStat
              value={`${CHAINS.length} chains`}
              label={<ChainMarks dense chains={CHAINS} />}
            />
            <AsideStat value="1%" label="max slippage" />
          </>
        }
      >
        <RoutePlan
          routes={sampleRoutes}
          from={
            <>
              <OnChain id="USDC" chain="Base" ring="var(--surface-2)" size="30px" />
              USDC on Base · $5,000
            </>
          }
        />
      </ChartSlide>

      <ChartSlide
        nav="NEAR"
        notes="NEAR AI Cloud runs the agent (apps/server/src/thesis/near_ai.rs). NEAR Intents 1Click quotes and settles every buy and bridge (providers/near_intents.rs, api-client/src/near-intents.ts); its token list is the only place a token address can come from (thesis/registry.rs). Native NEAR accounts live in packages/keyring. Quotes use dry runs until the user confirms."
        title="How it works."
        source={
          <>
            <b>Figure 6.</b> Route planner amounts, test-mode prices {cite(4)}.
          </>
        }
      >
        <Clip
          name="near2"
          label="An idea goes through NEAR AI Cloud into a jar, then NEAR Intents fills it on four chains"
        />
      </ChartSlide>

      <ChartSlide
        nav="Friends"
        notes="The real launch screen. Each friend gets an invite to put in their share, and trades need a majority to sign. A jar can be private, show only its returns, or be fully public. Creator copy-fee controls are part of the prototype; this slide does not claim collected revenue."
        title="Better with friends."
        source={
          <>
            <b>Figure 7.</b> Honey app, test mode.
          </>
        }
      >
        <Together />
      </ChartSlide>

      <ChartSlide
        nav="The wallet"
        notes="The current Wallet screen lives beside Feed. Tokens, jars, NFTs and activity share one home. These are sample balances from the native app."
        title="A social app. A wallet that’s yours."
        source={
          <>
            <b>Product preview.</b> Current native wallet · sample balances.
          </>
        }
      >
        <ProductShowcase screen="wallet" />
      </ChartSlide>

      <Slide nav="References" notes="Every outside number in this deck links here.">
        <Reveal>
          <div className="kicker" style={{ marginBottom: 18, textAlign: 'center' }}>
            References
          </div>
          <ol className="src-list">
            {sources.map((s) => (
              <li key={s.n}>
                <a href={s.url} target="_blank" rel="noopener">
                  {s.logos && <LogoStack ids={s.logos} size="28px" />}
                  <span>
                    [{s.n}] {s.label}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </Reveal>
      </Slide>

      <Slide center nav="Thank you" notes="Thank the judges; leave the contacts up for questions.">
        <Reveal>
          <Lockup big />
        </Reveal>
        <Reveal delay={0.08}>
          <h2 className="display" style={{ marginTop: 28 }}>
            Thank you.
          </h2>
        </Reveal>
        <Reveal delay={0.16}>
          <Contacts compact />
        </Reveal>
      </Slide>
    </Deck>
  );
}
