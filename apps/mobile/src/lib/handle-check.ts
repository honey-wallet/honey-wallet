import { useEffect, useRef, useState } from 'react';
import { handleStatus } from '@/lib/social';

export type HandleCheck = 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'offline';

/** A first guess from the profile name: "Swayam K" → "swayamk" (none when too short). */
export function suggestHandle(name: string) {
  const guess = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20);
  return guess.length >= 3 && guess !== 'honey' ? guess : '';
}

/** Keeps what people type to a handle's alphabet. */
export const cleanHandle = (t: string) => t.toLowerCase().replace(/[^a-z0-9_]/g, '');

/** One line under the field for each state. */
export function handleLine(check: HandleCheck, handle: string) {
  const lines: Record<HandleCheck, { text: string; tone: 'muted' | 'good' | 'bad' }> = {
    idle: { text: '3 to 20 letters, numbers or _', tone: 'muted' },
    checking: { text: 'Checking…', tone: 'muted' },
    available: { text: `@${handle} is yours to claim`, tone: 'good' },
    taken: { text: `@${handle} is taken`, tone: 'bad' },
    invalid: { text: 'Use 3 to 20 lowercase letters, numbers or _', tone: 'bad' },
    offline: { text: 'Couldn’t check. Try again in a moment.', tone: 'bad' },
  };
  return lines[check];
}

/** Checks availability 300ms after typing stops; only the latest answer counts. */
export function useHandleCheck(handle: string): HandleCheck {
  const [check, setCheck] = useState<HandleCheck>('idle');
  const latest = useRef(0);
  useEffect(() => {
    const value = handle.trim();
    if (!value) {
      setCheck('idle');
      return;
    }
    if (!/^[a-z0-9_]{3,20}$/.test(value)) {
      setCheck('invalid');
      return;
    }
    setCheck('checking');
    const id = ++latest.current;
    const timer = setTimeout(() => {
      handleStatus(value)
        .then((s) => {
          if (id === latest.current) setCheck(s.available ? 'available' : 'taken');
        })
        .catch(() => {
          if (id === latest.current) setCheck('offline');
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [handle]);
  return check;
}
