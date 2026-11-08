import type { WaitlistResponse } from '@honey-wallet/api-client';
import { type FormEvent, useId, useState } from 'react';
import { HoneyMark } from './HoneyMark';
import './landing.css';
import './home.css';

type FormState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'joined' }
  | { kind: 'error'; message: string };

// Production API, proxied by Vercel (vercel.json /api rewrite); an explicitly empty VITE_API_URL still closes the form.
const DEFAULT_API_URL = 'https://www.honeywallet.org';

// TODO: replace with Honey's real X profile link.
const X_URL = 'https://x.com/';

const FRIENDS = ['Swayam', 'Abhishek', 'Vivek'] as const;

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

export default function Landing({
  apiUrl = import.meta.env.VITE_API_URL ?? DEFAULT_API_URL,
}: {
  apiUrl?: string;
}) {
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
      <header className="home-nav-wrap">
        <nav className="home-nav" aria-label="Main">
          <a className="home-brand" href="/">
            <HoneyMark width={30} />
            Honey
          </a>
          <a className="home-x" href={X_URL} target="_blank" rel="noopener noreferrer">
            <span className="home-sr">Honey on X</span>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                fill="currentColor"
                d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3zm-1.08 16.2h1.7L7.4 4.73H5.58L16.67 19.2z"
              />
            </svg>
          </a>
        </nav>
      </header>

      <main>
        <section className="home-hero">
          <h1 className="home-title">
            <span className="home-line">Invest in what</span>{' '}
            <span className="home-line">
              you <span className="home-gold">believe</span>,
            </span>{' '}
            <span className="home-line">
              with <Friends /> friends.
            </span>
          </h1>
          <div className="home-waitlist" id="waitlist">
            {state.kind === 'joined' ? (
              <p className="landing-joined" role="status">
                <span aria-hidden="true">✓</span> You’re on the list.
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
          </div>
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

/** The friend avatars in the headline; hover, focus or tap shows each name. */
function Friends() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <span className="home-avatars">
      {FRIENDS.map((name, i) => (
        <button
          key={name}
          type="button"
          className="home-avatar"
          aria-label={name}
          aria-expanded={open === i}
          data-open={open === i ? '' : undefined}
          onClick={() => setOpen(open === i ? null : i)}
          onBlur={() => setOpen((o) => (o === i ? null : o))}
        >
          <img src={`/avatars/friend-${i + 1}.svg`} alt="" />
          <span className="home-avatar-name" aria-hidden="true">
            {name}
          </span>
        </button>
      ))}
    </span>
  );
}
