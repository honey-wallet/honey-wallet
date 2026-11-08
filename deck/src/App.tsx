import AgentRun from './components/AgentRun';
import ChartSlide, { AsideStat, BigStats } from './components/ChartSlide';
import { cite } from './components/Cite';
import Clip from './components/Clip';
import { ApproveFigure, CheckFigure, ReadFigure, SettleFigure } from './components/HoneyFigures';
import Journey from './components/Journey';
import Logo, { Brand, LogoStack } from './components/Logo';
import Process from './components/Process';
import RoutePlan from './components/RoutePlan';
import Timeline from './components/Timeline';
import TryIt from './components/TryIt';
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
          <h1 className="display" style={{ marginTop: 28, maxWidth: '13ch', marginInline: 'auto' }}>
            Invest in what you <span className="accent-text">believe</span>, with friends.
          </h1>
        </Reveal>
        <Reveal delay={0.16}>
          <p className="tagline">One idea becomes one cross-chain purchase.</p>
          <p className="byline">Honey Wallet · NEAR Hackathon · November 2026</p>
        </Reveal>
        <Reveal delay={0.24}>
          <div className="cv-chains">
            <Brand id="ethereum" size="28px" />
            <Brand id="base" size="28px" />
            <Brand id="solana" size="28px" />
            <Brand id="near" size="28px" />
          </div>
        </Reveal>
      </Slide>

      <ChartSlide
        nav="The problem"
        notes="Click once for the Honey row. Today a market view means researching tokens one by one, finding the chain each trades on, bridging and placing several swaps with different slippage. Most people give up, or buy one token and hope."
        title="1. Acting on an idea takes eight steps."
        source={
          <>
            <b>Figure 1.</b> Buying a basket for one market view, today and with Honey {cite(4)}.
          </>
        }
      >
        <Journey
          today={[
            'Have an idea',
            'Research tokens one by one',
            'Find the chain each trades on',
            'Set up a wallet per chain',
            'Bridge funds',
            'Get gas on each chain',
            'Swap, one token at a time',
            'Track it all',
          ]}
          honey={['Write the idea', 'Review the basket', 'Approve once']}
        />
      </ChartSlide>

      <ChartSlide
        nav="The market"
        notes="Crypto.com estimates 741 million owners at the end of 2025, up from 659 million. Reown and Nansen surveyed 1,038 active users in the US and UK: 62% use two or more wallets, and the top reason, at 48%, is reaching different chains. NEAR Intents is the rail that already moves this money across chains."
        title="2. 741 million own crypto, spread across chains."
        source={
          <>
            <b>Figure 2.</b> Owners worldwide, end of 2025 {cite(1)}. Survey of 1,038 active users{' '}
            {cite(2)}. NEAR Intents dashboard, 9 Nov 2026 {cite(3)}.
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
              label: 'juggle two or more wallets',
              source: cite(2),
            },
            {
              brand: (
                <Brand id="near" size="30px">
                  NEAR Intents
                </Brand>
              ),
              value: '$33B+',
              label: 'moved through NEAR Intents',
              source: cite(3),
            },
          ]}
        />
      </ChartSlide>

      <ChartSlide
        nav="Jars"
        notes="The real app, in test mode. Write an idea, or paste a post. The agent returns a basket with picks, weights and fees, ready to edit. One approval buys every pick on every chain, and the jar appears."
        title="3. Jars: one idea, one basket, one approval."
        source={
          <>
            <b>Figure 3.</b> The Honey app in test mode, with sample prices.
          </>
        }
      >
        <Clip name="flow" label="The Honey app: write an idea, review the basket, approve once" />
      </ChartSlide>

      <ChartSlide
        nav="The agent"
        notes="These are the six steps the app shows while the agent works on NEAR AI Cloud. The proposal names each pick, its chain, its weight and why. A critic agent writes the strongest objection, so the user sees the case against before buying."
        title="4. The agent shows its work."
        source={
          <>
            <b>Figure 4.</b> The agent’s steps, word for word from the app, and its proposal in test
            mode for $500 at medium risk.
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
            <b>Figure 5.</b> The route planner on a $5,000 jar, test-mode prices. Pools under $50k
            are skipped.
          </>
        }
        aside={
          <>
            <AsideStat
              value="4 chains"
              label={
                <>
                  one approval, through <Brand id="near">NEAR Intents</Brand>
                </>
              }
            />
            <AsideStat value="1%" label="max slippage; worse fills are refused" />
          </>
        }
      >
        <RoutePlan
          routes={sampleRoutes}
          from={
            <>
              <LogoStack ids={['usdc', 'base']} size="24px" />
              USDC on Base · $5,000
            </>
          }
        />
      </ChartSlide>

      <ChartSlide
        nav="NEAR"
        notes="NEAR AI Cloud runs the agent (apps/server/src/thesis/near_ai.rs). NEAR Intents 1Click quotes and settles every buy and bridge (providers/near_intents.rs, api-client/src/near-intents.ts); its token list is the only place a token address can come from (thesis/registry.rs). Native NEAR accounts live in packages/keyring. Quotes use dry runs until the user confirms."
        title="6. What NEAR does here."
        source={
          <>
            <b>Figure 6.</b> NEAR AI Cloud builds the basket; NEAR Intents fills it on every chain.
            Amounts from the route planner, test-mode prices {cite(4)}.
          </>
        }
      >
        <Clip
          name="near"
          label="An idea goes through NEAR AI Cloud into a basket, then NEAR Intents fills it on four chains"
        />
      </ChartSlide>

      <ChartSlide
        nav="Safety"
        notes="Giving an agent money is the risk. Honey's agent never gets it. Links are wrapped as quoted material the model is told not to obey. Every answer is checked against a strict schema and retried once if wrong. Tokens come only from the NEAR Intents list. The user approves once, with a max slippage, and Intents fills within it."
        title="7. The agent suggests. You sign."
        source={
          <>
            <b>Figure 7.</b> From idea to purchase, without giving the agent your money {cite(4)}.
          </>
        }
      >
        <Process
          privateLabel={
            <>
              <b>The agent</b> only suggests. It holds no keys.
            </>
          }
          sharedLabel={
            <>
              <b>You</b> approve once, with limits you set.
            </>
          }
          steps={[
            { figure: ReadFigure, title: 'Read', body: 'Links are quotes, not orders.' },
            {
              figure: CheckFigure,
              title: 'Check',
              body: (
                <>
                  Strict schema. <Brand id="near">NEAR Intents</Brand> tokens only.
                </>
              ),
            },
            { figure: ApproveFigure, title: 'Approve', body: 'Set your limits. Approve once.' },
            {
              figure: SettleFigure,
              title: 'Settle',
              body: (
                <>
                  <Brand id="near">NEAR Intents</Brand> fills within them.
                </>
              ),
            },
          ]}
        />
      </ChartSlide>

      <ChartSlide
        nav="Friends"
        notes="The real launch screen. Each friend gets an invite to put in their share, and trades need a majority to sign. A jar can be private, show only its returns, or be fully public. Creators pick their cut of copiers' profit, never of a loss; Honey keeps 1.5%."
        title="8. Better with friends."
        source={
          <>
            <b>Figure 8.</b> The Honey app’s launch screen, in test mode.
          </>
        }
      >
        <Clip
          name="friends"
          label="Launching a jar with a friend: who's in, who can see it, and the creator's cut"
        />
      </ChartSlide>

      <ChartSlide
        nav="Built"
        notes="Development started on 20 October. Everything shown was built in the hackathon window. Be plain about status: no users, no mainnet use by real users, not launched."
        title="9. What we built for the hackathon."
        source={
          <>
            <b>Figure 9.</b> Built during the hackathon window, from the README. No users yet; not
            launched {cite(4)}.
          </>
        }
      >
        <Timeline
          from={0}
          to={32}
          marks={[
            { at: 0, date: '20 Oct', label: 'Work starts', honey: true },
            { at: 32, date: '14 Nov', label: 'Submission', honey: true },
          ]}
          before={[]}
          built={[
            'Wallet app',
            'Keyring',
            'API server',
            'Jars',
            <>
              <Brand id="near">NEAR AI Cloud</Brand> agent
            </>,
            <>
              <Brand id="near">NEAR Intents</Brand>
            </>,
            <>
              <Brand id="near">NEAR</Brand> accounts
            </>,
            'Route planner',
            'Copy and creator fee',
            'Sign-in and landing page',
          ]}
        />
      </ChartSlide>

      <ChartSlide
        nav="Try it"
        notes="Judges can run all of this in five minutes with no keys: test mode uses sample prices and fake money."
        title="10. Try it in five minutes, with no keys."
        source={
          <>
            <b>Steps</b> from the README {cite(4)}. Live mode needs NEAR AI Cloud, 1Click, Tavily
            and CoinGecko keys.
          </>
        }
      >
        <TryIt
          commands={[
            'git clone https://github.com/honey-wallet/honey-wallet.git',
            'cd honey-wallet && corepack enable && pnpm install',
            'cd apps/mobile',
            'EXPO_PUBLIC_TEST_MODE=1 pnpm exec expo start --web',
          ]}
          steps={[
            { action: 'Tap the honey button' },
            { action: 'Ask Honey an idea' },
            { action: 'Edit the basket' },
            { action: 'Buy $500 and launch' },
            { action: 'Copy a jar with $100' },
          ]}
        />
      </ChartSlide>

      <Slide center nav="Close" notes="Close on the line, then the repo.">
        <Reveal>
          <Lockup big />
        </Reveal>
        <Reveal delay={0.08}>
          <h2 className="display" style={{ marginTop: 28, maxWidth: '14ch', marginInline: 'auto' }}>
            One idea. One basket. <span className="accent-text">One approval.</span>
          </h2>
        </Reveal>
        <Reveal delay={0.16}>
          <p className="tagline">
            Built on <Brand id="near">NEAR AI Cloud</Brand> and NEAR Intents · DeFi and Agent
            Economy tracks
          </p>
          <p className="byline">
            <a href={REPO} target="_blank" rel="noopener" style={{ color: 'var(--honey-text)' }}>
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
