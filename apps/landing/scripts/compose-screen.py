# Compose the iPhone screen for the landing page's wallet section from the app captures
# (390x844 @3x): an iOS status bar with a Dynamic Island on top, the app, and room for the
# home indicator under the tab bar, at exactly the phone window's aspect (523 x 1107 on the
# mockup). The blank gap between "Hidden tokens" and the tab bar is shortened to make room.
#   python3 -I compose.py <capture dir> <out dir>
import sys
from PIL import Image, ImageDraw, ImageFont

SRC, OUT = sys.argv[1], sys.argv[2]
W = 1170
H = round(W * 1107 / 523)  # 2477: the mockup's screen window
STATUS = 161  # 54pt status bar on a 393pt-wide iPhone
KEEP_TOP = 2000  # capture rows 0..2000: header to just under "Hidden tokens" (ends 1951)
TAB_FROM = 2260  # capture rows 2260..2532: the tab bar (2298..2492) and its margin
SS = 4  # supersampling for the drawn status bar
FONT = '/System/Library/Fonts/SFNS.ttf'


def status_bar(bg, fg):
    w, h = W * SS, STATUS * SS
    im = Image.new('RGB', (w, h), bg)
    d = ImageDraw.Draw(im)
    u = SS * W / 393  # one iOS point
    cy = 31 * u  # centre line of the status items

    # Dynamic Island: 126 x 37pt, 11pt from the top, always black
    iw, ih, it = 126 * u, 37 * u, 11 * u
    d.rounded_rectangle([(w - iw) / 2, it, (w + iw) / 2, it + ih], radius=ih / 2, fill=(0, 0, 0))

    # 9:41, centred in the left ear
    font = ImageFont.truetype(FONT, int(17 * u))
    # Width 100 (normal), optical size 17, default grade, weight 590: iOS's status bar time.
    font.set_variation_by_axes([100, 17, 400, 590])
    left_ear = ((w - iw) / 2) / 2 + 6 * u
    d.text((left_ear, cy), '9:41', font=font, fill=fg, anchor='mm')

    # Right ear: signal, wifi, battery
    right_c = w - ((w - iw) / 2) / 2 - 2 * u
    x = right_c - 33 * u
    # signal: four bars
    bw, gap = 3 * u, 1.6 * u
    for i, bh in enumerate((4.5, 6.5, 8.5, 10.5)):
        bx = x + i * (bw + gap)
        d.rounded_rectangle([bx, cy + 5.2 * u - bh * u, bx + bw, cy + 5.2 * u], radius=0.9 * u, fill=fg)
    # wifi: three arcs and a dot
    wx, wy = x + 26 * u, cy + 5 * u
    for r, wd in ((11 * u, 2.2 * u), (7.2 * u, 2.2 * u)):
        d.arc([wx - r, wy - r, wx + r, wy + r], start=225, end=315, fill=fg, width=int(wd))
    d.pieslice([wx - 3.8 * u, wy - 3.8 * u, wx + 3.8 * u, wy + 3.8 * u], start=225, end=315, fill=fg)
    # battery: outline, fill, nub
    bx0 = x + 42 * u
    bx1, by0, by1 = bx0 + 24.5 * u, cy - 5.8 * u, cy + 5.8 * u
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=3.6 * u, outline=fg, width=int(1.1 * u))
    d.rounded_rectangle([bx0 + 2 * u, by0 + 2 * u, bx1 - 2 * u, by1 - 2 * u], radius=2 * u, fill=fg)
    d.rounded_rectangle([bx1 + 1.2 * u, cy - 2 * u, bx1 + 2.6 * u, cy + 2 * u], radius=1 * u, fill=fg)
    return im.resize((W, STATUS), Image.LANCZOS)


def compose(theme):
    cap = Image.open(f'{SRC}/home-{theme}.png').convert('RGB')
    bg = cap.getpixel((W // 2, cap.height - 3))
    fg = (0, 0, 0) if theme == 'light' else (255, 255, 255)
    out = Image.new('RGB', (W, H), bg)
    out.paste(status_bar(bg, fg), (0, 0))
    out.paste(cap.crop((0, 0, W, KEEP_TOP)), (0, STATUS))
    bottom = cap.crop((0, TAB_FROM, W, cap.height))
    out.paste(bottom, (0, H - bottom.height - (H - STATUS - KEEP_TOP - bottom.height)))
    # home indicator: 134 x 5pt, 8pt from the bottom
    d = ImageDraw.Draw(out)
    u = W / 393
    hw, hh = 134 * u, 5 * u
    d.rounded_rectangle([(W - hw) / 2, H - 8 * u - hh, (W + hw) / 2, H - 8 * u], radius=hh / 2, fill=fg)
    out = out.resize((739, round(739 * H / W)), Image.LANCZOS)
    out.save(f'{OUT}/screen-home-{theme}.jpg', quality=88, optimize=True, progressive=True)
    print(theme, out.size)


for t in ('light', 'dark'):
    compose(t)
