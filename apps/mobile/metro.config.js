// Expo's default Metro config, plus one bundle-size trim (JS only; the native build and
// its fingerprint are unaffected).
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// viem's `viem/accounts` barrel and ox's root barrel (pulled in by WalletConnect's utils)
// each re-export every BIP-39 wordlist from @scure/bip39, about 270 KB of words in ten
// languages. Nothing in the app reads those re-exports: the keyring imports the English
// list from @scure/bip39 directly, which this leaves alone. Only imports made by those two
// re-export modules resolve to an empty module.
const WORDLIST_REEXPORT = /[\\/]node_modules[\\/](viem|ox)[\\/]_(cjs|esm)[\\/].*wordlists\.js$/;
const BIP39_WORDLIST = /^@scure\/bip39\/wordlists\/[a-z-]+(\.js)?$/;

const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (BIP39_WORDLIST.test(moduleName) && WORDLIST_REEXPORT.test(context.originModulePath))
    return { type: 'empty' };
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
