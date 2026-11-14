// Shared mockup for every native screen crop. Keep the outside height fixed so
// the original composition and movement stay in place; fit the screenshot inside.
function screenFrame(sw, sh, h) {
  const inset = Math.max(16, Math.min(32, h * 0.035));
  const contentHeight = h - inset * 2;
  const contentWidth = (contentHeight * sw) / sh;
  return { inset, contentHeight, contentWidth, width: contentWidth + inset * 2 };
}

function shot(img, sx, sy, sw, sh, cx, cy, h, { a = 1, s = 1, r = 26 } = {}) {
  const { inset, contentHeight, contentWidth, width } = screenFrame(sw, sh, h);
  g.save();
  g.globalAlpha *= a;
  g.translate(cx, cy);
  g.scale(s, s);

  // The mat matches the app's own ground, with enough room to keep native cards,
  // avatars and action icons clear of the outside corners and border.
  rr(-width / 2, -h / 2, width, h, r);
  g.fillStyle = BG;
  g.fill();
  g.drawImage(img, sx, sy, sw, sh, -contentWidth / 2, -h / 2 + inset, contentWidth, contentHeight);

  rr(-width / 2, -h / 2, width, h, r);
  g.strokeStyle = HC.border;
  g.lineWidth = 1.5;
  g.stroke();
  g.restore();
  return width;
}
