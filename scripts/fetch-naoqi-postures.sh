#!/usr/bin/env bash
# Descarga el grafo de posturas de NAOqi 2.8 (lo que usa ALRobotPosture.goToPosture en el NAO V6) y lo deja en
# public/motions/naoqi28/ (no se versiona en git: es de Aldebaran).
#
# Fuente: Choregraphe 2.8.7.4 para Linux, publicado por Aldebaran en github.com/aldebaran/nao6-binaries (Git LFS) al
# cerrar en 2025. Trae share/naoqi/robot_posture/postures_naoh25.xml (168 posturas del NAO H25 con sus vecinos, costos
# y velocidades) y motion_postures_naoh25.xml (poses del fall manager). Se abre el .tar.gz como datos (no se instala ni
# se ejecuta nada), se sacan solo esos dos XML y se convierten a JSON sin cambiar valores
# (scripts/extract-naoqi-postures.py). Uso académico y sin fines de lucro, con atribución.
#
#   bash scripts/fetch-naoqi-postures.sh
#   NAOQI_TARBALL=/ruta/choregraphe-suite-2.8.7.4-linux64.tar.gz bash scripts/fetch-naoqi-postures.sh   # sin descargar
set -euo pipefail

NAO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$NAO_ROOT/public/motions/naoqi28"
SHA="edf95da2ae8ec7573e3a590b6db47a472f9d2733280a4a597841fbf0c1e6c63c"
SIZE=1330448842
DIR="choregraphe-suite-2.8.7.4-linux64/share/naoqi/robot_posture"

die() { echo "✗ $*" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="${NAOQI_TARBALL:-}"
if [ -z "$TARBALL" ]; then
  # Git LFS: la API de lotes da el enlace de descarga del objeto (sha256 + tamaño del puntero del repo)
  href="$(curl -fsS -X POST -H 'Accept: application/vnd.git-lfs+json' -H 'Content-Type: application/vnd.git-lfs+json' \
    https://github.com/aldebaran/nao6-binaries.git/info/lfs/objects/batch \
    -d "{\"operation\":\"download\",\"transfers\":[\"basic\"],\"objects\":[{\"oid\":\"$SHA\",\"size\":$SIZE}]}" |
    python3 -I -c 'import json,sys; print(json.load(sys.stdin)["objects"][0]["actions"]["download"]["href"])')" ||
    die "GitHub no dio el enlace de descarga"
  echo "… descargando Choregraphe 2.8.7.4 (1.3 GB, una sola vez)"
  TARBALL="$TMP/choregraphe.tar.gz"
  curl -fsSL -o "$TARBALL" "$href" || die "descarga falló"
fi
echo "$SHA  $TARBALL" | shasum -a 256 -c - >/dev/null || die "checksum distinto: el archivo cambió"

mkdir -p "$TMP/x"
tar -xzf "$TARBALL" -C "$TMP/x" "$DIR/postures_naoh25.xml" "$DIR/motion_postures_naoh25.xml"

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$TMP/x/$DIR/postures_naoh25.xml" "$TMP/x/$DIR/motion_postures_naoh25.xml" "$DEST/"
python3 -I "$NAO_ROOT/scripts/extract-naoqi-postures.py" "$DEST/postures_naoh25.xml" "$DEST/motion_postures_naoh25.xml" \
  "$DEST/postures-h25.json"
cat >"$DEST/NOTICE.txt" <<EOF
Grafo de posturas de NAOqi 2.8 (share/naoqi/robot_posture/ de Choregraphe 2.8.7.4 linux64), (c) Aldebaran.
Tomado de https://github.com/aldebaran/nao6-binaries (sha256 $SHA). Los .xml van sin modificar; postures-h25.json es
el mismo contenido en otro formato. Uso académico y sin fines de lucro en NAO Web (proyecto de grado), con atribución.
EOF
