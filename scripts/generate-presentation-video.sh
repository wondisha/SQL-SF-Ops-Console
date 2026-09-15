#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCENES_DIR="$ROOT_DIR/assets/presentation/video/scenes"
OUTPUT_PATH="${1:-$ROOT_DIR/assets/video/omnidb-console-presentation.mp4}"
OUTPUT_DIR="$(dirname "$OUTPUT_PATH")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Error: ffmpeg is required to generate the MP4 presentation." >&2
  echo "Install ffmpeg and rerun this script." >&2
  exit 1
fi

if [ ! -d "$SCENES_DIR" ]; then
  echo "Error: scene assets not found at $SCENES_DIR" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

FONT_BOLD="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REGULAR="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

if [ ! -f "$FONT_BOLD" ] || [ ! -f "$FONT_REGULAR" ]; then
  echo "Error: expected DejaVu fonts were not found on this system." >&2
  exit 1
fi

SCENES=(
  "01|OmniDB Console|6"
  "02|The Problem|7"
  "03|Unified Operations Console|7"
  "04|Key Features|8"
  "05|Demo-Safe Simulation Mode|7"
  "06|Security and Governance|7"
  "07|FinOps and Enterprise Readiness|7"
  "08|One Console, Enterprise Scale|6"
)

INDEX=0
for SCENE in "${SCENES[@]}"; do
  IFS='|' read -r SCENE_ID TITLE DURATION <<< "$SCENE"
  BODY_FILE="$SCENES_DIR/${SCENE_ID}.txt"
  SCENE_VIDEO="$WORK_DIR/${SCENE_ID}.mp4"

  if [ ! -f "$BODY_FILE" ]; then
    echo "Error: missing scene text file $BODY_FILE" >&2
    exit 1
  fi

  ffmpeg -y \
    -f lavfi -i "color=c=#0B0F12:s=1920x1080:d=${DURATION}" \
    -vf "drawbox=x=90:y=90:w=1740:h=900:color=#12181C:t=fill,\
         drawbox=x=90:y=90:w=1740:h=900:color=#263038:t=3,\
         drawbox=x=90:y=830:w=1740:h=160:color=#171F24:t=fill,\
         drawtext=fontfile=${FONT_BOLD}:text='${TITLE}':x=150:y=155:fontsize=66:fontcolor=#DCE4E8,\
         drawtext=fontfile=${FONT_REGULAR}:textfile='${BODY_FILE}':x=150:y=280:fontsize=38:line_spacing=14:fontcolor=#B9C7CF,\
         drawtext=fontfile=${FONT_BOLD}:text='SQL Server   •   Snowflake   •   PostgreSQL   •   MySQL   •   IBM DB2':x=150:y=882:fontsize=30:fontcolor=#4A90D9" \
    -r 30 -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
    "$SCENE_VIDEO" >/dev/null 2>&1

  echo "file '$SCENE_VIDEO'" >> "$WORK_DIR/concat-list.txt"
  INDEX=$((INDEX + 1))
done

ffmpeg -y -f concat -safe 0 -i "$WORK_DIR/concat-list.txt" -c copy "$OUTPUT_PATH" >/dev/null 2>&1

echo "Generated MP4 presentation: $OUTPUT_PATH"
