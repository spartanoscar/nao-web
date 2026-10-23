#!/usr/bin/env bash
# Descarga las rutinas originales de Aldebaran para sentarse y levantarse (cajas "Sit Down" y "Stand Up" de la
# biblioteca estándar de Choregraphe 1.x, © Aldebaran Robotics) y las copia SIN MODIFICAR a public/motions/aldebaran/
# (no se versionan en git: no son nuestras).
#
# Fuente: el repositorio público del equipo de RoboCup Kouretes (Universidad Técnica de Creta), que guardó esas cajas
# exportadas con sus líneas de tiempo (keyframes): github.com/kouretes/Monas, config/xar/. Su código es GPLv2, pero
# estas cajas son de Aldebaran: se usan para un proyecto académico y sin fines de lucro, con atribución, como las
# mallas oficiales. La app las lee tal cual (src/naoqi/aldebaranMotions.ts) y las reproduce con angleInterpolation.
#
#   bash scripts/fetch-aldebaran-motions.sh
set -euo pipefail

NAO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$NAO_ROOT/public/motions/aldebaran"
COMMIT="51a8aa7334c5fc8851bacc6881e964e4f4b35483"
BASE="https://raw.githubusercontent.com/kouretes/Monas/$COMMIT/config/xar"
FILES=(
  "StandUpX.xar ece18a20a6435630a86d52fdcac4a70e462f6b79bb7b9fb644f8164507bb6124"
  "SitDownX.xar a73fd3755520ec1900b929309b7484d6f2f91d71f9e081d957eadc33fbe2342b"
)

die() { echo "✗ $*" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for entry in "${FILES[@]}"; do
  read -r name sha <<<"$entry"
  curl -fsSL -o "$TMP/$name" "$BASE/$name" || die "descarga falló: $BASE/$name"
  echo "$sha  $TMP/$name" | shasum -a 256 -c - >/dev/null || die "checksum distinto en $name: el archivo cambió"
done

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$TMP"/*.xar "$DEST/"
cat >"$DEST/NOTICE.txt" <<EOF
Rutinas "Sit Down" y "Stand Up" de la biblioteca estándar de Choregraphe 1.x, (c) Aldebaran Robotics.
Copia sin modificar tomada de https://github.com/kouretes/Monas (commit $COMMIT, config/xar/).
Uso académico y sin fines de lucro en NAO Web (proyecto de grado), con atribución.
EOF
echo "✓ $(ls "$DEST"/*.xar | wc -l | tr -d ' ') rutinas → ${DEST#$NAO_ROOT/}"
