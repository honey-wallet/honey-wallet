#!/bin/sh
# Builds the invite email images in apps/web/public/email/ with ImageMagick (macOS for the
# Apple glyph font): invite-hero.png from real Play Store screenshots, icon-honey.png (logo)
# and white store icons (icon-apple.png, icon-play.png, icon-chrome.png; shown at 16px).
# Usage, from the repo root: sh apps/web/scripts/invite-hero.sh
set -eu
SRC=docs/launch/play-store
OUT=apps/web/public/email
T="$(mktemp -d)"
mkdir -p "$OUT"

# --- Store icons: simple white marks, 40x40.
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

# --- Logo: the app icon at 56x56 (2x of 28px) with rounded corners.
magick apps/web/public/apple-touch-icon.png -resize 56x56 -alpha set \
  \( -size 56x56 xc:none -fill white -draw "roundrectangle 0,0 55,55 13,13" \) \
  -compose DstIn -composite -strip "$OUT/icon-honey.png"

# --- Hero phones (2x of 496x350, transparent background).
B=11; R=50
phone() { # src w h out
  W=$2; H=$3
  magick "$1" -resize ${W}x${H}! -alpha set \
    \( -size ${W}x${H} xc:none -fill white -draw "roundrectangle 0,0 $((W-1)),$((H-1)) $R,$R" \) \
    -compose DstIn -composite "$T/screen.png"
  FW=$((W+2*B)); FH=$((H+2*B))
  magick -size ${FW}x${FH} xc:none \
    -fill '#151413' -stroke '#3d3934' -strokewidth 2 \
    -draw "roundrectangle 1,1 $((FW-2)),$((FH-2)) $((R+B)),$((R+B))" \
    "$T/screen.png" -geometry +$B+$B -compose Over -composite "$4"
}
# Proposal, kept visual: header, risk ring, $500.00 and the three picks with their bars
# (y 0-870), then the "Buy $500 / Edit" row and card bottom (y 1185-1375). Fees, sources,
# chips and the input bar are dropped; the app's plain background fills the full height.
magick "$SRC/screenshot-2-proposal.jpg" \
  \( -clone 0 -crop 1080x870+0+0 +repage \) \
  \( -clone 0 -crop 1080x190+0+1185 +repage \) \
  \( -size 1080x860 xc:'#131313' \) \
  -delete 0 -append "$T/proposal.jpg"
phone "$T/proposal.jpg" 428 762 "$T/proposal.png"
magick "$T/proposal.png" -channel RGB -evaluate multiply 0.85 +channel "$T/proposal.png"
phone "$SRC/screenshot-4-home.jpg" 428 762 "$T/home.png"

# 992x700, transparent around the phones (no rectangle if a client inverts the card);
# the proposal sits back-left and lower,
# and the home phone in front-right overlaps only its right bezel. Both run off the bottom
# edge, flush with the bottom of the email card (no bottom padding).
magick -size 992x700 xc:none \
  "$T/proposal.png" -geometry +58+100 -compose Over -composite \
  "$T/home.png" -geometry +483+30 -compose Over -composite \
  -strip +dither -colors 200 -define png:compression-level=9 "$OUT/invite-hero.png"
rm -rf "$T"
