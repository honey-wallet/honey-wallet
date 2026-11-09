import AgentRun from './components/AgentRun';
import ChartSlide, { AsideStat, BigStats } from './components/ChartSlide';
import { cite } from './components/Cite';
import Clip from './components/Clip';
import Friends from './components/Friends';
import Logo, { Brand, LogoStack } from './components/Logo';
import RoutePlan, { ChainMarks } from './components/RoutePlan';
import Together from './components/Together';
import { agentStages, samplePicks, sampleRoutes, sources } from './data/sources';
import Deck from './deck/Deck';
import Reveal from './deck/Reveal';
import Slide from './deck/Slide';
import './components/honey.css';

/* Honey Wallet: Jars, for the NEAR Hackathon judges. Every outside number is cited;
   product facts come from the honey-wallet repository and its test mode. */

const REPO = 'https://github.com/honey-wallet/honey-wallet';

const Lockup = ({ big }: { big?: boolean }) => (
  <div className={`hl${big ? ' big' : ''}`}>
    <img src="/honey-mark.svg" alt="" />
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
        title="1. One idea, eight steps."
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
        title="2. 741M own crypto, across chains."
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
        title="3. Meet Jars."
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
        title="4. The agent shows its work."
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
        title="5. One approval, every chain."
        source={
          <>
            <b>Figure 5.</b> Route planner, $5,000 jar, test-mode prices.
          </>
        }
        aside={
          <>
            <AsideStat
              value="4 chains"
              label={<ChainMarks chains={['Ethereum', 'Base', 'Solana', 'NEAR']} />}
            />
            <AsideStat value="1%" label="max slippage" />
          </>
        }
      >
        <RoutePlan
          routes={sampleRoutes}
          from={
            <>
              <LogoStack ids={['base', 'usdc']} size="24px" />
              USDC on Base · $5,000
            </>
          }
        />
      </ChartSlide>

      <ChartSlide
        nav="NEAR"
        notes="NEAR AI Cloud runs the agent (apps/server/src/thesis/near_ai.rs). NEAR Intents 1Click quotes and settles every buy and bridge (providers/near_intents.rs, api-client/src/near-intents.ts); its token list is the only place a token address can come from (thesis/registry.rs). Native NEAR accounts live in packages/keyring. Quotes use dry runs until the user confirms."
        title="6. What NEAR does."
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
        nav="Safety"
        notes="Giving an agent money is the risk. Honey's agent never gets it. Links are wrapped as quoted material the model is told not to obey. Every answer is checked against a strict schema and retried once if wrong. Tokens come only from the NEAR Intents list. The user approves once, with a max slippage, and Intents fills within it."
        title="7. The agent suggests. You sign."
        source={
          <>
            <b>Figure 7.</b> Safeguards in the server code {cite(4)}.
          </>
        }
      >
        <Clip
          name="safety"
          label="Paste any post; hidden commands are ignored; the answer is checked; only real tokens; only you sign, because the agent holds no keys"
        />
      </ChartSlide>

      <ChartSlide
        nav="Friends"
        notes="The real launch screen. Each friend gets an invite to put in their share, and trades need a majority to sign. A jar can be private, show only its returns, or be fully public. Creators pick their cut of copiers' profit, never of a loss; Honey keeps 1.5%."
        title="8. Better with friends."
        source={
          <>
            <b>Figure 8.</b> Honey app, test mode.
          </>
        }
      >
        <Together />
      </ChartSlide>

      <Slide center nav="Close" notes="Close on the line, then the repo.">
        <Reveal>
          <Lockup big />
        </Reveal>
        <Reveal delay={0.08}>
          <h2 className="display" style={{ marginTop: 28, maxWidth: '14ch', marginInline: 'auto' }}>
            One idea. One jar.
          </h2>
        </Reveal>
        <Reveal delay={0.16}>
          <p className="byline">
            <a href={REPO} target="_blank" rel="noopener" className="cl-repo">
              <Logo id="github" size="1.4em" />
              github.com/honey-wallet/honey-wallet
            </a>
          </p>
        </Reveal>
      </Slide>

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
    </Deck>
  );
}
