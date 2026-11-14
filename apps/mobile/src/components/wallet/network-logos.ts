/**
 * Logos for networks that aren't also a coin (so they aren't in the generated
 * `token-logos.ts`), keyed by the network's symbol in `CHAINS`.
 */
export const NETWORK_LOGOS: Record<string, string> = {
  // Simplified marks in each network's colours, for the small "Available on" row.
  ARB: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#213147"/><path fill="none" stroke="#12AAFF" stroke-width="2.6" stroke-linejoin="round" d="M16 7.5 8.6 20.4h14.8Z"/><path fill="#fff" d="m16 12.6 4 7h-8Z"/></svg>',
  // Replaced (14 Nov): Optimism's own mark, from its Superchain token list repo
  // (github.com/ethereum-optimism/ethereum-optimism.github.io, optimism.svg).
  // OP: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#FF0420"/><path fill="none" stroke="#fff" stroke-width="2.4" d="M10.6 12.3c-1.8 0-2.9 1.6-2.9 3.7s1.1 3.7 2.9 3.7 2.9-1.6 2.9-3.7-1.1-3.7-2.9-3.7ZM16.4 20.2v-7.9h3c1.6 0 2.6.9 2.6 2.3s-1 2.3-2.6 2.3h-3"/></svg>',
  OP: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1037 1037" fill="none"><circle cx="518.5" cy="518.5" r="518.5" fill="#FF0421"/><path fill="#FAFAF9" d="M761.806 365.281H576.288L532.635 674.89h88.817L632 599.904h101.004c91.242 0 136.711-36.584 147.018-114.893 10.612-80.727-27.583-119.73-118.223-119.73h.007Zm28.192 114.292c-3.636 33.261-22.734 47.77-60.929 47.77h-86.856l12.592-89.495h90.937c34.559 0 47.595 11.794 44.256 41.725ZM357.424 358.028c-120.945 0-184.3 50.796-199.157 159.644-15.157 111.266 36.983 164.48 160.961 164.48 123.979 0 184.001-50.796 198.853-159.644 15.163-111.266-36.672-164.48-160.657-164.48Zm70.329 159.644c-8.188 61.381-39.103 88.893-103.669 88.893-60.625 0-83.359-24.189-75.483-84.057 8.187-61.678 39.712-88.894 103.669-88.894 63.957 0 83.359 24.493 75.483 84.058Z"/></svg>',
  POL: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path fill="#fff" d="m19.9 12.4-3.1-1.8a1.3 1.3 0 0 0-1.3 0l-3.1 1.8c-.4.2-.6.7-.6 1.1v3.6l-1.8 1v-2.2l-1.8-1v3.6c0 .5.2.9.6 1.1l3.1 1.8c.4.2.9.2 1.3 0l3.1-1.8c.4-.2.6-.7.6-1.1v-3.6l1.8-1v2.2l1.8 1v-3.6c0-.5-.2-.9-.6-1.1Z"/></svg>',
  BNB: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#F3BA2F"/><path fill="#fff" d="m16 8.5 2.4 2.4-4.8 4.8-2.4-2.4Zm0 0-2.4 2.4 4.8 4.8 2.4-2.4ZM10.9 13.6l2.4 2.4-2.4 2.4L8.5 16Zm10.2 0 2.4 2.4-2.4 2.4-2.4-2.4ZM16 13.6l2.4 2.4-2.4 2.4-2.4-2.4Zm0 9.9-2.4-2.4 4.8-4.8 2.4 2.4Zm0 0 2.4-2.4-4.8-4.8-2.4 2.4Z"/></svg>',
  AVAX: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#E84142"/><path fill="#fff" d="M15.1 9.2c.4-.7 1.4-.7 1.8 0l6.3 11.1c.4.7-.1 1.5-.9 1.5h-3.3l-3-5.3-3 5.3H9.7c-.8 0-1.3-.8-.9-1.5Z"/></svg>',
  GNO: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#133629"/><circle cx="16" cy="16" r="7" fill="none" stroke="#F0EBDE" stroke-width="2.4"/><circle cx="16" cy="16" r="2.4" fill="#F0EBDE"/></svg>',
  LINEA:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#121212"/><path fill="#fff" d="M10.5 9h2.6v11.4h8.4V23h-11Z"/><path fill="#61DFFF" d="M21.5 9h2.6v2.6h-2.6Z"/></svg>',
  SCROLL:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#FFEEDA"/><path fill="none" stroke="#101010" stroke-width="2" stroke-linecap="round" d="M11 9.5h9.5c1.4 0 2.5 1.1 2.5 2.5v8.5M11 9.5c-1.4 0-2.5 1.1-2.5 2.5s1.1 2.5 2.5 2.5h1.5v6c0 1.4 1.1 2.5 2.5 2.5h8.5c1.4 0 2.5-1.1 2.5-2.5h-9"/></svg>',
  BASE: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#0052FF"/><path fill="#FFF" d="M15.98 25.5c5.25 0 9.52-4.25 9.52-9.5s-4.27-9.5-9.52-9.5c-4.98 0-9.07 3.82-9.48 8.69h12.6v1.62H6.5c.41 4.87 4.5 8.69 9.48 8.69z"/></svg>',
};
