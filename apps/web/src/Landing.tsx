import type { WaitlistResponse } from '@honey-wallet/api-client';
import { type FormEvent, useId, useState } from 'react';
import './landing.css';
import './home.css';

type FormState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'joined' }
  | { kind: 'error'; message: string };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errorMessage(status: number | null): string {
  if (status === 429) return 'Too many tries. Wait a minute and try again.';
  if (status === 400) return 'That email doesn’t look right.';
  return 'Something went wrong. Please try again.';
}

// Plain fetch keeps the landing bundle small; the shape matches the API client's
// `joinWaitlist` (POST /api/v1/waitlist -> WaitlistResponse).
async function joinWaitlist(baseUrl: string, email: string): Promise<WaitlistResponse> {
  const response = await fetch(`${baseUrl}/api/v1/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ email, source: 'web' }),
  });
  if (!response.ok) throw response.status;
  return (await response.json()) as WaitlistResponse;
}

export default function Landing({ apiUrl = import.meta.env.VITE_API_URL }: { apiUrl?: string }) {
  const baseUrl = apiUrl?.trim().replace(/\/+$/, '') || null;
  const [email, setEmail] = useState('');
  const [state, setState] = useState<FormState>({ kind: 'idle' });
  const inputId = useId();
  const noteId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!baseUrl || state.kind === 'sending') return;
    const value = email.trim();
    if (!EMAIL_SHAPE.test(value)) {
      setState({ kind: 'error', message: 'Enter a valid email address.' });
      return;
    }
    setState({ kind: 'sending' });
    try {
      await joinWaitlist(baseUrl, value);
      setState({ kind: 'joined' });
    } catch (error) {
      setState({
        kind: 'error',
        message: errorMessage(typeof error === 'number' ? error : null),
      });
    }
  }

  const closed = baseUrl === null;

  return (
    <div className="landing home">
      <div className="home-glow" aria-hidden="true">
        <span className="home-beam home-beam-a" />
        <span className="home-beam home-beam-b" />
        <span className="home-beam home-beam-c" />
      </div>

      <header className="home-nav-wrap">
        <nav className="home-nav" aria-label="Main">
          <a className="home-brand" href="/">
            <img src="/honey-mark.svg" alt="" width="30" height="26" />
            Honey
          </a>
          <div className="home-links">
            <a href="#jars">Jars</a>
            <a href="#how">How it works</a>
            <a href="#custody">Self-custody</a>
          </div>
          <a className="home-cta" href="#waitlist">
            Get early access
            <span className="home-cta-arrow" aria-hidden="true">
              →
            </span>
          </a>
        </nav>
      </header>

      <main>
        <section className="home-hero">
          <p className="home-badge">
            <img src="/honey-mark.svg" alt="" width="18" height="16" />
            Multichain · Self-custody · NEAR Intents
          </p>
          <h1 className="home-title">
            Turn an idea into a <span className="home-hl">jar</span>
            <br />
            of tokens, together.
          </h1>
          <p className="home-sub">
            Type a theme like “AI agents” or “Solana DeFi”. Honey fills a jar with the tokens behind
            it across EVM, Solana and NEAR, and you buy the whole jar in one tap. Your keys never
            leave your device.
          </p>
          <div className="home-stores">
            <StoreButton href="#waitlist" small="Download on the" big="App Store" icon="apple" />
            <StoreButton href="#waitlist" small="Get it on" big="Google Play" icon="play" />
            <StoreButton
              href="#waitlist"
              small="Available in the"
              big="Chrome Web Store"
              icon="chrome"
            />
          </div>

          <div className="home-stage">
            <div className="home-orbits" aria-hidden="true">
              <span className="home-orbit home-orbit-1" />
              <span className="home-orbit home-orbit-2" />
              <span className="home-orbit home-orbit-3" />
              <span className="home-bubble home-bubble-1" style={{ background: '#627EEA' }}>
                ETH
              </span>
              <span
                className="home-bubble home-bubble-2"
                style={{ background: '#14F195', color: '#131313' }}
              >
                SOL
              </span>
              <span
                className="home-bubble home-bubble-3"
                style={{ background: '#F6F3EB', color: '#131313' }}
              >
                NEAR
              </span>
              <span className="home-bubble home-bubble-4" style={{ background: '#2775CA' }}>
                USDC
              </span>
              <span
                className="home-bubble home-bubble-5"
                style={{ background: '#F3C969', color: '#131313' }}
              >
                🍯
              </span>
              <span className="home-bubble home-bubble-6" style={{ background: '#0052FF' }}>
                BASE
              </span>
            </div>
            <div className="home-ghost home-ghost-l" aria-hidden="true">
              <p className="home-ghost-k">Solana DeFi</p>
              <p className="home-ghost-v">$2,184.06</p>
              <p className="home-up">+12.4%</p>
              <span className="home-ghost-bar" />
            </div>
            <div className="home-ghost home-ghost-r" aria-hidden="true">
              <p className="home-ghost-k">Routed via NEAR Intents</p>
              <p className="home-ghost-v">6 tokens · 3 chains</p>
              <span className="home-ghost-bar home-ghost-bar-honey" />
            </div>
            <Phone />
          </div>
        </section>

        <section className="home-section" id="how">
          <p className="home-eyebrow">How it works</p>
          <h2 className="home-h2">From a hunch to a portfolio in three steps.</h2>
          <ol className="home-cards">
            <li className="home-card" id="jars">
              <span className="home-step">01</span>
              <h3>Describe an idea</h3>
              <p>Name a theme. Honey picks the tokens behind it and weights them into a jar.</p>
            </li>
            <li className="home-card">
              <span className="home-step">02</span>
              <h3>Pour it in one tap</h3>
              <p>
                NEAR Intents routes every swap across EVM, Solana and NEAR, so you never bridge by
                hand.
              </p>
            </li>
            <li className="home-card" id="custody">
              <span className="home-step">03</span>
              <h3>Keep your keys</h3>
              <p>
                Self-custody from day one: your recovery phrase is made and stored on your device,
                never on our servers.
              </p>
            </li>
          </ol>
        </section>

        <section className="home-section home-join" id="waitlist">
          <h2 className="home-h2">Be first to fill a jar.</h2>
          <p className="home-sub">Join the waitlist and we’ll email you when Honey is ready.</p>
          {state.kind === 'joined' ? (
            <p className="landing-joined" role="status">
              <span aria-hidden="true">✓</span> You’re on the list. We’ll email you when Honey is
              ready.
            </p>
          ) : (
            <form className="landing-form" onSubmit={submit} noValidate>
              <label className="landing-label" htmlFor={inputId}>
                Email address
              </label>
              <div className="landing-row">
                <input
                  id={inputId}
                  className="landing-input"
                  type="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="Your email"
                  required
                  disabled={closed}
                  value={email}
                  aria-invalid={state.kind === 'error'}
                  aria-describedby={noteId}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (state.kind === 'error') setState({ kind: 'idle' });
                  }}
                />
                <button
                  className="landing-button"
                  type="submit"
                  disabled={closed || state.kind === 'sending'}
                >
                  {state.kind === 'sending' ? 'Joining…' : 'Join the waitlist'}
                </button>
              </div>
              <p id={noteId} className="landing-note landing-error" role="alert">
                {state.kind === 'error' ? state.message : null}
              </p>
            </form>
          )}
        </section>
      </main>
      <footer className="landing-foot home-foot">
        <span className="home-foot-brand">
          <img src="/honey-mark.svg" alt="" width="22" height="19" />© 2026 Honey Wallet
        </span>
        <span className="home-foot-links">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/support">Support</a>
          <a href="/delete-account">Delete your data</a>
        </span>
      </footer>
    </div>
  );
}

const STORE_ICONS = {
  apple:
    'M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8s1.9.8 3.2.8c1.3 0 2.1-1.2 2.9-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.4-1-2.4-3.9zM14 5.5c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.6 2.8-1.4z',
  play: 'M4 2.5v19c0 .4.4.6.7.4L15 12 4.7 2.1c-.3-.2-.7 0-.7.4zM16.3 13.3l-2.4-2.4L5.6 21.4l10.7-8.1zm0-2.6L5.6 2.6l8.3 8.4 2.4-.3zm1.2.6L19.9 12l-2.4 1.4-2-1.4 2-.7z',
  chrome:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 6.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM12 4a8 8 0 0 1 6.9 4H12a4 4 0 0 0-3.8 2.7L5.5 6.1A8 8 0 0 1 12 4zM4.3 7.6l3.4 5.9a4 4 0 0 0 4.6 2.5l-2.7 4.7A8 8 0 0 1 4.3 7.6zm7.3 12.4 3.4-5.9a4 4 0 0 0 .3-4.6h5.4A8 8 0 0 1 11.6 20z',
} as const;

function StoreButton({
  href,
  small,
  big,
  icon,
}: {
  href: string;
  small: string;
  big: string;
  icon: keyof typeof STORE_ICONS;
}) {
  return (
    <a className="home-store" href={href}>
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
        <path fill="currentColor" d={STORE_ICONS[icon]} />
      </svg>
      <span>
        <small>{small}</small>
        {big}
      </span>
    </a>
  );
}

const PICKS = [
  { symbol: 'NEAR', name: 'NEAR Protocol · NEAR', weight: 32, color: '#9AD9C4' },
  { symbol: 'FET', name: 'Artificial Superintelligence · ETH', weight: 24, color: '#B9A6F2' },
  { symbol: 'RENDER', name: 'Render · Solana', weight: 18, color: '#F2A97E' },
  { symbol: 'TAO', name: 'Bittensor · Base', weight: 14, color: '#F3C969' },
  { symbol: 'VIRTUAL', name: 'Virtuals Protocol · Base', weight: 12, color: '#8FB8F5' },
];

/** The phone screen mirrors the app's jar detail: value, then holdings as pour slabs. */
function Phone() {
  return (
    <figure className="home-phone" aria-label="Honey app showing an AI agents jar">
      <div className="home-screen">
        <div className="home-status" aria-hidden="true">
          <span>9:41</span>
          <span className="home-island" />
          <span>●●● ▮</span>
        </div>
        <p className="home-jar-label">AI agents jar</p>
        <p className="home-jar-value">
          $4,820<span>.17</span>
        </p>
        <p className="home-up home-jar-ret">+18.6% since you poured</p>
        <div className="home-stripe" aria-hidden="true">
          {PICKS.map((p) => (
            <span key={p.symbol} style={{ flex: p.weight, background: p.color }} />
          ))}
        </div>
        <ul className="home-slabs">
          {PICKS.map((p, i) => (
            <li key={p.symbol} className="home-slab">
              <span
                className="home-slab-fill"
                style={{
                  width: `${p.weight}%`,
                  background: p.color,
                  animationDelay: `${0.5 + i * 0.09}s`,
                }}
              />
              <span className="home-slab-icon" style={{ background: p.color }}>
                {p.symbol[0]}
              </span>
              <span className="home-slab-text">
                <b>{p.symbol}</b>
                <small>{p.name}</small>
              </span>
              <span className="home-slab-pct">
                {p.weight}
                <small>%</small>
              </span>
            </li>
          ))}
        </ul>
        <span className="home-pour">Pour into jar</span>
      </div>
    </figure>
  );
}
