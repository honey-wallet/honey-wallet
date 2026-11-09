#!/bin/sh
# Builds the invite email images in apps/web/public/email/ with ImageMagick (macOS for the
# Apple glyph and SF fonts): invite-hero.png from real Play Store screenshots, icon-honey.png
# (the honey mark), the store buttons btn-*.png and the white icons they use (icon-*.png).
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

# --- Store buttons: PNGs so no mail client can invert or restyle them. 362x88 (2x of
# 181x44; three fill a 560px row with 8px gaps, and they stack on narrow screens). Each
# store has a dark pill (#2a2826, white icon and label) and a primary one (honey fill,
# dark icon and label) used for the first configured store. Transparent corners; SF with a
# light stroke for semibold.
button() { # icon label out fill ink
  magick -background none -fill "$5" -stroke "$5" -strokewidth 0.7 \
    -font /System/Library/Fonts/SFNS.ttf -pointsize 28 label:"$2" "$T/label.png"
  magick "$OUT/$1" -resize 32x32 -fill "$5" -colorize 100 "$T/icon.png"
  magick -background none "$T/icon.png" \( -size 14x1 xc:none \) "$T/label.png" \
    -gravity center +append "$T/content.png"
  magick -size 362x88 xc:none -fill "$4" -draw "roundrectangle 0,0 361,87 44,44" \
    "$T/content.png" -gravity center -compose Over -composite \
    -strip +dither -colors 64 -define png:compression-level=9 "$OUT/$3"
}
for spec in "icon-apple.png|App Store|btn-app-store" "icon-play.png|Google Play|btn-google-play" \
  "icon-chrome.png|Chrome|btn-chrome"; do
  icon="${spec%%|*}"; rest="${spec#*|}"; label="${rest%%|*}"; name="${rest#*|}"
  button "$icon" "$label" "$name.png" '#2a2826' '#ffffff'
  button "$icon" "$label" "$name-primary.png" '#f3c969' '#1a1408'
done

# --- Logo: the honey mark alone (no square), 64x56 (2x of 32x28), transparent.
magick -background none -density 300 apps/web/public/honey-mark.svg -trim +repage \
  -resize 64x56 -strip "$OUT/icon-honey.png"

# --- Hero phones (2x of 560x340, transparent background).
B=13; R=58
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
phone "$T/proposal.jpg" 494 878 "$T/proposal.png"
magick "$T/proposal.png" -channel RGB -evaluate multiply 0.85 +channel "$T/proposal.png"
phone "$SRC/screenshot-4-home.jpg" 494 878 "$T/home.png"

# 1120x680, transparent around the phones so the email card shows through (and its rounded
# corners stay visible). The phones span ~90% of the width: proposal back-left and lower,
# home front-right overlapping only its right bezel. Both rise out of the bottom edge,
# which sits flush with the card's bottom.
magick -size 1120x680 xc:none \
  "$T/proposal.png" -geometry +56+100 -compose Over -composite \
  "$T/home.png" -geometry +545+36 -compose Over -composite \
  -strip +dither -colors 128 -define png:compression-level=9 -define png:compression-filter=5 "$OUT/invite-hero.png"
rm -rf "$T"
