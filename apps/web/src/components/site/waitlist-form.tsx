'use client';

import { type FormEvent, useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { LiquidButton } from '../liquid/components/ui/liquid-button';
import { HONEY_BUTTON } from './app-link';

/*
 * The waitlist, on Honey's own API (POST /api/v1/waitlist, the same call apps/web makes).
 * NEXT_PUBLIC_API_URL points it elsewhere; an explicitly empty value closes the form.
 */
const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'https://api.honeywallet.org')
  .trim()
  .replace(/\/+$/, '');
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A cold server or a dropped connection fails the first try; joining is idempotent, so
// retry those (never a 4xx such as 429) twice with a short pause.
const RETRY_DELAYS_MS = [800, 2000];

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'joined' }
  | { kind: 'error'; message: string };

async function post(email: string) {
  const response = await fetch(`${API_URL}/api/v1/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ email, source: 'web' }),
  });
  if (!response.ok) throw response.status;
}

async function join(email: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await post(email);
    } catch (error) {
      const retryable = typeof error !== 'number' || error >= 500;
      const delay = RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function message(status: unknown) {
  if (status === 429) return 'Too many tries. Wait a minute and try again.';
  if (status === 400) return 'That email doesn’t look right.';
  return 'Something went wrong. Please try again.';
}

export function WaitlistForm({ className }: { className?: string }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const inputId = useId();
  const noteId = useId();
  const closed = API_URL === '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (closed || state.kind === 'sending') return;
    const value = email.trim();
    if (!EMAIL_SHAPE.test(value)) {
      setState({ kind: 'error', message: 'Enter a valid email address.' });
      return;
    }
    setState({ kind: 'sending' });
    try {
      await join(value);
      setState({ kind: 'joined' });
    } catch (error) {
      setState({ kind: 'error', message: message(error) });
    }
  }

  if (state.kind === 'joined') {
    return (
      <p
        className={cn(
          'inline-flex items-center gap-2.5 rounded-full bg-honey-tint px-5 py-3 font-medium text-brand',
          className,
        )}
        role="status"
      >
        <span aria-hidden="true">✓</span> You&rsquo;re on the list. We&rsquo;ll email you.
      </p>
    );
  }

  return (
    <form className={cn('w-full max-w-[28rem]', className)} noValidate onSubmit={submit}>
      <label className="sr-only" htmlFor={inputId}>
        Email address
      </label>
      <div className="flex flex-col gap-2 rounded-[1.75rem] sm:flex-row sm:rounded-full sm:border sm:border-hairline sm:bg-background sm:p-1.5 sm:focus-within:border-brand-soft">
        <input
          aria-describedby={noteId}
          aria-invalid={state.kind === 'error'}
          autoComplete="email"
          className="h-12 w-full min-w-0 rounded-full sm:w-auto sm:flex-1 border border-hairline bg-background px-5 text-[0.9375rem] text-foreground outline-none placeholder:text-fg-subtle focus:border-brand-soft sm:h-11 sm:border-0 sm:px-4"
          disabled={closed}
          id={inputId}
          inputMode="email"
          name="email"
          onChange={(event) => {
            setEmail(event.target.value);
            if (state.kind === 'error') setState({ kind: 'idle' });
          }}
          placeholder="Your email"
          required
          type="email"
          value={email}
        />
        <LiquidButton
          className={`${HONEY_BUTTON} shrink-0 text-[0.9375rem] [--liquid-button-height:48px] [--liquid-button-padding:24px] sm:[--liquid-button-height:44px]`}
          disabled={closed || state.kind === 'sending'}
          tint="var(--honey)"
          type="submit"
          variant="primary"
        >
          {state.kind === 'sending' ? 'Joining…' : 'Join the waitlist'}
        </LiquidButton>
      </div>
      <p className="mt-2 min-h-5 pl-5 text-down text-sm" id={noteId} role="alert">
        {state.kind === 'error' ? state.message : null}
      </p>
    </form>
  );
}
