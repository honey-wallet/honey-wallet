'use client';

import { useEffect } from 'react';
import { ToastProvider, toastManager } from '@/components/ui/toast';

/**
 * The "coming soon" notice, loaded on the first tap that asks for one
 * (soon.tsx). The toast carries a stable id so mashing several of them updates
 * one notice instead of stacking a pile.
 */
export default function SoonNotice({ detail, n }: { detail: string; n: number }) {
  // After the provider below is listening: a child's effects run before its parent's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `n` counts taps, so a repeat tap shows the notice again
  useEffect(() => {
    toastManager.add({
      id: 'coming-soon',
      title: 'Coming soon',
      description: detail,
    });
  }, [detail, n]);
  return <ToastProvider position="bottom-right" />;
}
