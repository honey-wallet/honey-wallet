import { createElement, Fragment, type ReactNode } from 'react';

/*
 * Every warning, disclaimer and caution line in the app, each behind its own flag. All
 * are off until approved one by one (2026-11-13); turning a flag on brings its copy back
 * exactly where it was. Only copy is gated here: confirmation steps, checkboxes and
 * validation that block an action are never behind a flag.
 */

/** Risk, fee and other cautions. */
export const WARNINGS = {
  // Risk
  jarRiskDisclaimer: false,
  assistantDisclaimer: false,
  projectionFootnote: false,
  proposalCaution: false,
  earnRateDisclaimer: false,
  perpsRiskDisclaimer: false,
  perpsGuideRiskNote: false,
  futuresRiskNote: false,
  optionsRiskNote: false,
  disclosuresRisk: false,
  disclosuresNotAdvice: false,
  disclosuresThirdParty: false,
  disclosuresJarsYield: false,
  helpYieldCaveat: false,
  morphoPayoutNote: false,
  // Launch your jar: "You sign every order. Honey never holds your keys." (removed 2026-11-13)
  jarLaunchKeysNote: false,
  // Fees
  strategyFeesWarning: false,
  routeWarningTint: false,
  jarGuideSmallBuys: false,
  // Other (beta and test-network notes)
  earnMarketsNote: false,
  perpsUnavailableNote: false,
  predictUnavailableNote: false,
  predictFeedUnavailableNote: false,
  testNetworkNote: false,
} as const;

/** Security warnings: kept apart so they can be reviewed first. Also off, as asked. */
export const SECURITY_WARNINGS = {
  recoveryNeverShare: false,
  recoveryPeekWarning: false,
  importNeverShare: false,
  contactNeverShare: false,
  helpScammerNote: false,
  sendIrreversible: false,
  signOutRecoveryWarning: false,
  deleteAccountRecoveryWarning: false,
  burnerSmallAmounts: false,
  memoExchangeWarning: false,
  spamTriangle: false,
  browserInsecureIcon: false,
  siteInsecureIcon: false,
  siteUnverified: false,
  scamSiteWarning: false,
  siweDomainMismatch: false,
  unreadableMessage: false,
  typedDataMalformed: false,
  typedDataIncomplete: false,
  typedDataNoChain: false,
  permitAllowance: false,
  typedDataWrongChain: false,
  contractUndecodable: false,
  contractCallNote: false,
  txWillFail: false,
  solanaUnreadable: false,
  solanaBlocked: false,
  solanaReviewNote: false,
} as const;

export type WarningId = keyof typeof WARNINGS | keyof typeof SECURITY_WARNINGS;

const ALL: Record<WarningId, boolean> = { ...WARNINGS, ...SECURITY_WARNINGS };

/** Whether a warning is approved to show. */
export const warningOn = (id: WarningId): boolean => ALL[id];

/** Renders its children only while warning `id` is on. */
export function Gate({ id, children }: { id: WarningId; children: ReactNode }) {
  return warningOn(id) ? createElement(Fragment, null, children) : null;
}
