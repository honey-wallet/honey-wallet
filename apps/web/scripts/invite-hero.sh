#!/bin/sh
# Builds the invite email images in apps/web/public/email/ with ImageMagick (macOS for the
# Apple glyph font): invite-hero.png from real Play Store screenshots, and 2x white store
# icons (icon-apple.png, icon-play.png, icon-chrome.png; shown at 20px).
# Usage, from the repo root: sh apps/web/scripts/invite-hero.sh
set -eu
SRC=docs/launch/play-store
OUT=apps/web/public/email
T="$(mktemp -d)"
mkdir -p "$OUT"

# --- Store icons: simple white marks, 40x40 (2x of 20px).
magick -background none -fill white -font /System/Library/Fonts/SFNS.ttf -pointsize 160 \
  label:"$(printf '\357\243\277')" -trim +repage -resize 34x34 -gravity center -extent 40x40 -strip "$OUT/icon-apple.png"
magick -size 160x160 xc:none -fill white -draw "polygon 36,18 36,142 140,80" \
  -resize 40x40 -strip "$OUT/icon-play.png"
# Chrome-like mark: a disc cut into three blades by tangent gaps around a center dot.
magick -size 160x160 xc:none -fill white -draw "circle 80,80 80,8" \
  \( -size 160x160 xc:none -fill none -stroke white -strokewidth 9 -draw "circle 80,80 80,45" \
     -draw "line 80,45 165,45" -draw "line 110,97 67,171" -draw "line 50,97 7,23" \) \
  -compose DstOut -composite -compose Over -fill white -draw "circle 80,80 80,52" \
  -resize 40x40 -strip "$OUT/icon-chrome.png"

# --- Hero phones.
B=10; R=44
phone() { # src w h out
  W=$2; H=$3
  magick "$1" -resize ${W}x${H}! -alpha set \
    \( -size ${W}x${H} xc:none -fill white -draw "roundrectangle 0,0 $((W-1)),$((H-1)) $R,$R" \) \
    -compose DstIn -composite "$T/screen.png"
  FW=$((W+2*B)); FH=$((H+2*B))
  magick -size ${FW}x${FH} xc:none \
    -fill '#1a1815' -stroke '#34302a' -strokewidth 2 \
    -draw "roundrectangle 1,1 $((FW-2)),$((FH-2)) $((R+B)),$((R+B))" \
    "$T/screen.png" -geometry +$B+$B -compose Over -composite "$4"
}
# Proposal: splice out the "Sources / Sample prices (test mode)" rows (y 1040-1190) so the
# card flows from the stats row into "Buy $500 / Edit" and the chips; pad the 150px back
# with the screen's own background above the input bar so it keeps the full 1080x1920.
magick "$SRC/screenshot-2-proposal.jpg" \
  \( -clone 0 -crop 1080x1040+0+0 +repage \) \
  \( -clone 0 -crop 1080x510+0+1190 +repage \) \
  \( -size 1080x150 xc:'#131313' \) \
  \( -clone 0 -crop 1080x220+0+1700 +repage \) \
  -delete 0 -append "$T/proposal.jpg"
phone "$T/proposal.jpg" 380 676 "$T/proposal.png"
magick "$T/proposal.png" -channel RGB -evaluate multiply 0.8 +channel "$T/proposal.png"
phone "$SRC/screenshot-4-home.jpg" 380 676 "$T/home.png"

# 1120x700 matte ink, thin honey arc behind; the proposal sits back-left and lower, and
# the home phone in front-right overlaps only its right bezel. Both bleed off the bottom.
magick -size 1120x700 xc:'#0b0b0a' \
  -fill none -stroke '#f3c969' -strokewidth 3 -draw "circle 560,900 560,420" -stroke none \
  "$T/proposal.png" -geometry +170+116 -compose Over -composite \
  "$T/home.png" -geometry +548+56 -compose Over -composite \
  -strip +dither -colors 256 -define png:compression-level=9 "$OUT/invite-hero.png"
rm -rf "$T"
