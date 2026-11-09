#!/bin/sh
# Builds apps/web/public/email/invite-hero.png (invite email hero) from real Play Store
# screenshots with ImageMagick. Usage: sh apps/web/scripts/invite-hero.sh . apps/web/public/email/invite-hero.png
set -eu
REPO="$1"; OUT="$2"; T="$(mktemp -d)"; mkdir -p "$T"
W=380; H=676; R=46; B=10   # screen size, corner radius, bezel

phone() { # src out
  magick "$1" -resize ${W}x${H}! -alpha set \
    \( -size ${W}x${H} xc:none -fill white -draw "roundrectangle 0,0 $((W-1)),$((H-1)) $R,$R" \) \
    -compose DstIn -composite "$T/screen.png"
  FW=$((W+2*B)); FH=$((H+2*B))
  magick -size ${FW}x${FH} xc:none \
    -fill '#1a1815' -stroke '#34302a' -strokewidth 2 \
    -draw "roundrectangle 1,1 $((FW-2)),$((FH-2)) $((R+B)),$((R+B))" \
    "$T/screen.png" -geometry +$B+$B -compose Over -composite "$2"
}
phone "$REPO/docs/launch/play-store/screenshot-1-ask.jpg" "$T/ask.png"; magick "$T/ask.png" -channel RGB -evaluate multiply 0.7 +channel "$T/ask.png"
phone "$REPO/docs/launch/play-store/screenshot-4-home.jpg" "$T/home.png"

# 1120x700 matte ink; a thin honey arc behind the phones; phones bleed off the bottom.
magick -size 1120x700 xc:'#0b0b0a' \
  -fill none -stroke "#f3c969" -strokewidth 3 -draw "circle 560,900 560,420" -stroke none \
  "$T/ask.png" -geometry +230+120 -compose Over -composite \
  "$T/home.png" -geometry +490+64 -compose Over -composite \
  -strip +dither -colors 256 -define png:compression-level=9 "$OUT"
rm -rf "$T"
