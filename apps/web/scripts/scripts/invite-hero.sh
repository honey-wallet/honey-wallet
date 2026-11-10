#!/bin/sh
# Builds the invite email images in apps/web/public/email/ with ImageMagick (macOS for the
# SF font): invite-hero.png from real Play Store screenshots, icon-honey.png (the honey
# mark) and btn-get-honey.png (the one CTA).
# Usage, from the repo root: sh apps/web/scripts/invite-hero.sh
set -eu
SRC=docs/launch/play-store
OUT=apps/web/public/email
T="$(mktemp -d)"
mkdir -p "$OUT"

# --- "Get Honey" button: a PNG so no mail client can invert or restyle it; shown at
# width:100% so it scales. 1120x104 (2x of 560x52), honey pill, dark label at 46px (23px at
# 560 wide, ~14px on a 375px phone). Transparent corners; SF with a light stroke.
magick -background none -fill '#1a1408' -stroke '#1a1408' -strokewidth 1.1 \
  -font /System/Library/Fonts/SFNS.ttf -pointsize 46 label:"Get Honey" "$T/label.png"
magick -size 1120x104 xc:none -fill '#f3c969' -draw "roundrectangle 0,0 1119,103 52,52" \
  "$T/label.png" -gravity center -compose Over -composite \
  -strip +dither -colors 64 -define png:compression-level=9 "$OUT/btn-get-honey.png"

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
