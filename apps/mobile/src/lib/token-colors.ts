/**
 * Each token's own colour, taken from its logo, so a strategy's ring, bar and donut
 * match the logos in their keys (AAVE lavender, UNI pink, LINK blue). The one table for
 * any token colour; tokens not listed fall back to a fixed palette by position.
 */
const BRAND: Record<string, string> = {
  AAVE: '#9896FF',
  ARB: '#28A0F0',
  AURORA: '#70D44B',
  AVAX: '#E84142',
  BNB: '#F3BA2F',
  BONK: '#F2A900',
  BTC: '#F7931A',
  CBBTC: '#F7931A',
  DAI: '#F5AC37',
  DOGE: '#C2A633',
  ETH: '#627EEA',
  GRT: '#6747ED',
  HYPE: '#50D2C1',
  // Jupiter's logo is a lime-to-cyan gradient: its middle.
  JUP: '#2BD9A1',
  LDO: '#F69988',
  LINK: '#2A5ADA',
  MKR: '#1AAB9B',
  NEAR: '#00C08B',
  OP: '#FF0420',
  PAXG: '#E4CE4D',
  PEPE: '#3D9970',
  POL: '#8247E5',
  RENDER: '#E5484D',
  SOL: '#9945FF',
  STETH: '#00A3FF',
  SUI: '#4DA2FF',
  TAO: '#8C96A3',
  TON: '#0098EA',
  TRX: '#EB0029',
  UNI: '#FF007A',
  USDC: '#2775CA',
  USDT: '#26A17B',
  WBTC: '#F09242',
  WETH: '#627EEA',
  WIF: '#B07D53',
  // XRP's logo is near-black, which vanishes on a dark card: its grey keeps the slice seen.
  XRP: '#8C96A3',
  XAUT: '#D4A72C',
  XMR: '#FF6600',
  ZEC: '#F4B728',
};

const FALLBACK = ['#76B900', '#00A4EF', '#E5484D', '#9945FF', '#F5A524', '#00C08B'];

/** A token's colour for charts of a strategy; `index` picks a fallback for unknown ones. */
export const tokenColor = (symbol: string, index = 0) =>
  BRAND[symbol.toUpperCase()] ?? (FALLBACK[index % FALLBACK.length] as string);
