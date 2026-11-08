import type { ImageSourcePropType } from 'react-native';

/**
 * Raster logos for tokens without an SVG in token-logos.ts, bundled so they work offline
 * and in the extension (96px PNGs from CoinGecko's public images).
 */
export const TOKEN_IMAGES: Record<string, ImageSourcePropType> = {
  JUP: require('../../../assets/tokens/JUP.png'),
  PAXG: require('../../../assets/tokens/PAXG.png'),
  RENDER: require('../../../assets/tokens/RENDER.png'),
  TAO: require('../../../assets/tokens/TAO.png'),
  ZEC: require('../../../assets/tokens/ZEC.png'),
};
