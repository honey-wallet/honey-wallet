// Honey × Inco film kit: the Inco films' grammar (fog low in frame, hairline grid, one light sentence on top,
// crisp dark product cards, pill chips, words that rise and fade in) in Honey's colours. Flat: no glow, no blur, no drop shadows.
// Every function is a pure function of t. Canvas 2000×800; edges feather to the deck's #131313.
const W = 2000,
  H = 800,
  BG = '#131313';
const HC = {
  honey: '#F3C969',
  amber: '#F0B347',
  deep: '#B5730A',
  text: '#F6F3EB',
  muted: '#A3A3A3',
  faint: '#6F6F6F',
  card1: '#232323',
  card2: '#1C1C1C',
  border: '#2E2E2E',
  line: '#2C2C2C',
  ok: '#3FD07E',
};
const HEAD = 'Urbanist, system-ui, sans-serif',
  UI = 'Inter, system-ui, sans-serif',
  MONO = '"Geist Mono", ui-monospace, monospace';
const c01 = (x) => Math.min(1, Math.max(0, x));
const mix = (a, b, u) => a + (b - a) * u;
const sp = (t, f = FEEL.default) => spring(t, f[0], f[1]);
const eo = (x) => 1 - (1 - c01(x)) ** 3;
const win = (t, a, b, fi = 0.35, fo = 0.35) => Math.min(c01((t - a) / fi), c01((b - t) / fo)); // in/out window

let g;
function setupFilm(DUR) {
  const cv = document.getElementById('c');
  cv.width = W;
  cv.height = H;
  g = cv.getContext('2d');
  window.DURATION = DUR;
  window.SIZE = [W, H];
  return g;
}
async function loadKit(images) {
  const K = 'fonts/';
  const faces = [
    new FontFace('Urbanist', `url(${K}Urbanist-Variable.woff2)`, { weight: '100 900' }),
    new FontFace('Inter', `url(${K}Inter-Variable.woff2)`, { weight: '100 900' }),
    new FontFace('Geist Mono', `url(${K}GeistMono-Variable.woff2)`, { weight: '100 900' }),
  ];
  for (const f of faces) {
    await f.load();
    document.fonts.add(f);
  }
  const I = {};
  await Promise.all(
    Object.entries(images).map(async ([k, src]) => {
      const im = new Image();
      im.src = src;
      await im.decode();
      I[k] = im;
    }),
  );
  return I;
}
function live(draw, DUR) {
  window.seek = (t) => {
    draw(t);
    return true;
  };
  if (navigator.webdriver || location.search.includes('render')) return;
  const t0 = performance.now();
  (function loop() {
    draw(((performance.now() - t0) / 1000) % DUR);
    requestAnimationFrame(loop);
  })();
}

// ---------- background ----------
function blob(x, y, r, rgb, a) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  for (let i = 0; i <= 10; i++) {
    const u = i / 10,
      f = (1 - u) * (1 - u) * (1 + 2 * u);
    gr.addColorStop(u, `rgba(${rgb},${(a * f).toFixed(4)})`);
  }
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
}
// Background: flat slide colour. (It used to be a honey fog; the deck is now glow-free.)
function fog() {
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);
}
// 1 px hairline grid, faint, with small honey dots at a few crossings.
function grid(a = 1, step = 100) {
  g.save();
  g.globalAlpha = a;
  g.strokeStyle = 'rgba(246,243,235,0.045)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = step / 2; x < W; x += step) {
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, H);
  }
  for (let y = step / 2; y < H; y += step) {
    g.moveTo(0, y + 0.5);
    g.lineTo(W, y + 0.5);
  }
  g.stroke();
  g.restore();
}
// Feather every edge into the slide colour so the film sits on the deck with no frame.
function feather(px = 140) {
  const sides = [
    [0, 0, px, 0, 0, 0, px, H],
    [W, 0, W - px, 0, W - px, 0, px, H],
    [0, 0, 0, px, 0, 0, W, px],
    [0, H, 0, H - px, 0, H - px, W, px],
  ];
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of sides) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, BG);
    gr.addColorStop(1, 'rgba(19,19,19,0)');
    g.fillStyle = gr;
    g.fillRect(rx, ry, rw, rh);
  }
}

// ---------- type ----------
// A sentence that arrives word by word (rise + fade in) and leaves the same way. *word = honey.
function head(
  text,
  t,
  t0,
  t1,
  { y = 96, size = 64, weight = 400, x = W / 2, align = 'center', color = HC.text } = {},
) {
  if (t < t0 - 0.05 || t > t1 + 0.6) return;
  g.save();
  g.font = `${weight} ${size}px ${HEAD}`;
  g.textBaseline = 'alphabetic';
  const ws = text.split(' ').map((w) => ({ hl: w.startsWith('*'), w: w.replace(/^\*/, '') }));
  const space = g.measureText(' ').width,
    widths = ws.map((w) => g.measureText(w.w).width);
  const total = widths.reduce((a, b) => a + b, 0) + space * (ws.length - 1);
  let cx = align === 'center' ? x - total / 2 : x;
  ws.forEach((w, i) => {
    const p = sp(t - t0 - i * 0.07, [210, 26]),
      q = sp(t - t1 - i * 0.025, FEEL.snappy);
    const o = Math.min(1, p * 1.6) * (1 - q);
    if (o > 0.003) {
      g.globalAlpha = o;
      g.fillStyle = w.hl ? HC.honey : color;
      g.fillText(w.w, cx, y + ((1 - p) * 0.34 - q * 0.22) * size);
    }
    cx += widths[i] + space;
  });
  g.restore();
}
function text(
  s,
  x,
  y,
  { size = 24, weight = 500, color = HC.text, font = UI, align = 'left', a = 1 } = {},
) {
  g.save();
  g.globalAlpha *= a;
  g.font = `${weight} ${size}px ${font}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
  g.restore();
}

// ---------- objects ----------
function rr(x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}
// The product card: soft vertical gradient, hairline border, inner highlight, deep shadow.
function card(x, y, w, h, { r = 26, a = 1, honey = false, black = false } = {}) {
  g.save();
  g.globalAlpha *= a;
  rr(x, y, w, h, r);
  const gr = g.createLinearGradient(0, y, 0, y + h);
  if (honey) {
    gr.addColorStop(0, '#F5CF77');
    gr.addColorStop(1, '#EDBE55');
  } else if (black) {
    gr.addColorStop(0, '#0A0A0A');
    gr.addColorStop(1, '#000');
  } else {
    gr.addColorStop(0, HC.card1);
    gr.addColorStop(1, HC.card2);
  }
  g.fillStyle = gr;
  g.fill();
  g.shadowColor = 'transparent';
  g.lineWidth = black ? 2.5 : 1.5;
  g.strokeStyle = honey ? 'rgba(255,240,200,0.6)' : black ? 'rgba(243,201,105,0.7)' : HC.border;
  g.stroke();
  rr(x + 1, y + 1, w - 2, h - 2, r - 1);
  g.strokeStyle = honey ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.05)';
  g.lineWidth = 1;
  g.stroke();
  g.restore();
}
// A pill chip: [coin | label], dark or honey.
function pill(
  cx,
  cy,
  label,
  { a = 1, honey = false, coins = [], size = 26, mono = false, s = 1 } = {},
) {
  g.save();
  g.globalAlpha *= a;
  g.translate(cx, cy);
  g.scale(s, s);
  g.font = `${mono ? 500 : 600} ${size}px ${mono ? MONO : HEAD}`;
  const tw = g.measureText(label).width,
    cs = size * 1.25,
    pad = size * 0.75;
  const w = tw + pad * 2 + (coins.length ? cs + (coins.length - 1) * cs * 0.72 + size * 0.45 : 0),
    h = size * 2.1;
  rr(-w / 2, -h / 2, w, h, h / 2);
  g.fillStyle = honey ? HC.honey : 'rgba(26,26,26,0.95)';
  g.fill();
  if (!honey) {
    g.strokeStyle = 'rgba(246,243,235,0.16)';
    g.lineWidth = 1.5;
    g.stroke();
  }
  let x = -w / 2 + pad * 0.8;
  coins.forEach((c, i) => {
    coin(c, x + cs / 2 + i * cs * 0.72, 0, cs, honey ? HC.honey : '#1a1a1a');
  });
  if (coins.length) x += cs + (coins.length - 1) * cs * 0.72 + size * 0.45;
  else x = -w / 2 + pad;
  g.fillStyle = honey ? '#131313' : HC.text;
  g.textBaseline = 'middle';
  g.fillText(label, x, 1);
  g.restore();
  return w;
}
// A token or chain coin, the way a wallet lists it: one filled circle, same size, a hairline ring.
// c = { img, chip, pad }.
// c.square: the mark is a rounded square (Base), not a circle.
function coin(c, x, y, d, ringOn = null) {
  const shape = (inset = 0) => {
    g.beginPath();
    if (c.square)
      g.roundRect(x - d / 2 + inset, y - d / 2 + inset, d - 2 * inset, d - 2 * inset, d * 0.14);
    else g.arc(x, y, d / 2 - inset, 0, Math.PI * 2);
    g.closePath();
  };
  g.save();
  shape();
  if (ringOn) {
    g.lineWidth = d * 0.1;
    g.strokeStyle = ringOn;
    g.stroke();
  }
  g.clip();
  if (c.chip) {
    g.fillStyle = c.chip;
    g.fillRect(x - d / 2, y - d / 2, d, d);
  }
  const p = (c.pad ?? 0) * d;
  g.drawImage(c.img, x - d / 2 + p, y - d / 2 + p, d - 2 * p, d - 2 * p);
  g.restore();
  g.save();
  shape(0.5);
  g.strokeStyle = 'rgba(246,243,235,0.16)';
  g.lineWidth = 1.2;
  g.stroke();
  g.restore();
}
// A tap: a ring that grows and fades.
function tap(x, y, t) {
  if (t < 0 || t > 0.65) return;
  const p = eo(t / 0.65);
  g.save();
  g.beginPath();
  g.arc(x, y, 14 + 50 * p, 0, Math.PI * 2);
  g.fillStyle = `rgba(246,243,235,${0.3 * (1 - p)})`;
  g.fill();
  g.beginPath();
  g.arc(x, y, 12 * (1 - p * 0.4), 0, Math.PI * 2);
  g.fillStyle = `rgba(246,243,235,${0.55 * (1 - p)})`;
  g.fill();
  g.restore();
}
function check(x, y, s, color = HC.honey, a = 1) {
  g.save();
  g.globalAlpha *= a;
  g.beginPath();
  g.arc(x, y, s / 2, 0, 7);
  g.fillStyle = color;
  g.fill();
  g.strokeStyle = '#131313';
  g.lineWidth = s * 0.12;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(x - s * 0.2, y);
  g.lineTo(x - s * 0.05, y + s * 0.15);
  g.lineTo(x + s * 0.22, y - s * 0.14);
  g.stroke();
  g.restore();
}
// Logo table, same as the deck's Logo.tsx.
const COINS = (I) => ({
  near: { img: I.near },
  eth: { img: I.eth },
  base: { img: I.base, square: true },
  sol: { img: I.sol, chip: '#000', pad: 0.22 },
  usdc: { img: I.usdc },
  tao: { img: I.tao },
  render: { img: I.render },
  uni: { img: I.uni },
  aero: { img: I.aero, chip: '#0b1233', pad: 0.12 },
  jup: { img: I.jup, chip: '#000', pad: 0.14 },
  ref: { img: I.ref, chip: '#000', pad: 0.16 },
  honey: { img: I.honey, chip: '#000', pad: 0.16 },
  metamask: { img: I.metamask },
  phantom: { img: I.phantom },
  coinbase: { img: I.coinbase },
  sender: { img: I.sender },
  chatgpt: { img: I.chatgpt },
  claude: { img: I.claude },
  google: { img: I.google },
  stargate: { img: I.stargate },
  across: { img: I.across },
  debridge: { img: I.debridge },
  axelar: { img: I.axelar },
});
const COIN_FILES = {
  near: 'assets/near.svg',
  eth: 'assets/ethereum-coin.svg',
  base: 'assets/base-square.svg',
  sol: 'assets/solana.svg',
  usdc: 'assets/usdc.svg',
  tao: 'assets/bittensor-coin.svg',
  render: 'assets/render.svg',
  uni: 'assets/uniswap.svg',
  aero: 'assets/aerodrome.png',
  jup: 'assets/jupiter.svg',
  ref: 'assets/ref.svg',
  honey: 'assets/honey-mark.svg',
  metamask: 'assets/wallet-metamask.svg',
  phantom: 'assets/wallet-phantom.svg',
  coinbase: 'assets/wallet-coinbase.svg',
  sender: 'assets/wallet-sender.svg',
  chatgpt: 'assets/ai-chatgpt.svg',
  claude: 'assets/ai-claude.svg',
  google: 'assets/ai-google.svg',
  stargate: 'assets/bridge-stargate.svg',
  across: 'assets/bridge-across.svg',
  debridge: 'assets/bridge-debridge.svg',
  axelar: 'assets/bridge-axelar.svg',
};

// ---------- line icons (24-unit, stroked) ----------
function icon(name, x, y, s, color = HC.muted) {
  g.save();
  g.translate(x - s / 2, y - s / 2);
  g.scale(s / 24, s / 24);
  g.strokeStyle = color;
  g.lineWidth = 1.8;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.fillStyle = 'none';
  const P = (d) => g.stroke(new Path2D(d));
  ({
    search: () => {
      P('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z');
      P('M21 21l-4.3-4.3');
    },
    wallet: () => {
      P(
        'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1',
      );
      P('M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4');
    },
    bridge: () => {
      P('M8 3L4 7l4 4');
      P('M4 7h16');
      P('M16 21l4-4-4-4');
      P('M20 17H4');
    },
    fuel: () => {
      P('M3 22h12');
      P('M4 9h10');
      P('M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18');
      P('M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2 2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5');
    },
    chart: () => {
      P('M3 3v18h18');
      P('M7 15l4-4 3 3 5-6');
    },
    lock: () => {
      P('M5 11h14v10H5z');
      P('M7 11V7a5 5 0 0 1 10 0v4');
    },
    key: () => {
      P(
        'M2.6 18.4A2 2 0 0 0 2 19.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4z',
      );
      P('M16.5 7.5h.01');
    },
    users: () => {
      P('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2');
      P('M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z');
      P('M22 21v-2a4 4 0 0 0-3-3.87');
      P('M16 3.13a4 4 0 0 1 0 7.75');
    },
    x: () => {
      P('M18 6L6 18');
      P('M6 6l12 12');
    },
    bulb: () => {
      P('M9 18h6');
      P('M10 22h4');
      P('M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z');
    },
  })[name]();
  g.restore();
}
