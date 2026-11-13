import { Redirect } from 'expo-router';
import { WALLET } from '@/lib/surface';

/**
 * Activity moved into the Wallet screen (2026-11-12): transaction history is a section
 * there, beside Tokens. Old links, notification taps and saved routes land on it.
 * Activity details (/activity/[id]) are unchanged.
 */
export default function ActivityRedirect() {
  return <Redirect href={{ pathname: WALLET, params: { section: 'Activity' } }} />;
}
