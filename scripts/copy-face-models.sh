#!/usr/bin/env bash
# Copia de node_modules/@vladmandic/face-api (MIT) a public/models/face/ solo los 3 modelos que usa el reconocimiento de
# rostros (src/ai/faces.ts): el detector diminuto (siempre), y los puntos de la cara y la huella de 128 números (solo
# cuando el detector encontró una cara). No se versionan: salen del paquete instalado con npm.
#
#   bash scripts/copy-face-models.sh
set -euo pipefail
NAO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$NAO_ROOT/node_modules/@vladmandic/face-api/model"
DEST="$NAO_ROOT/public/models/face"
[ -d "$SRC" ] || { echo "✗ falta @vladmandic/face-api: npm install" >&2; exit 1; }
mkdir -p "$DEST"
for m in tiny_face_detector_model face_landmark_68_tiny_model face_recognition_model; do
  cp "$SRC/$m-weights_manifest.json" "$SRC/$m.bin" "$DEST/"
done
cp "$NAO_ROOT/node_modules/@vladmandic/face-api/LICENSE" "$DEST/LICENSE-face-api.txt"
echo "✓ modelos de rostros → ${DEST#$NAO_ROOT/} ($(du -sh "$DEST" | cut -f1))"
