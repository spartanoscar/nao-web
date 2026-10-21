#!/usr/bin/env bash
# Descarga las mallas 3D oficiales del NAO (© Aldebaran / SoftBank Robotics, CC BY-NC-ND 4.0) y las
# copia SIN MODIFICAR a public/models/nao_meshes/ (no se versionan en git).
#
# Fuente: paquete ROS 2 ros-jazzy-nao-meshes (packages.ros.org). El .deb se abre como archivo de
# datos (ar + tar): no se instala ni se ejecuta nada de él. Solo se toman las mallas visuales .dae
# (39, una por link, ya alineadas con reference/urdf/naoV50.urdf), la textura y la licencia.
#
# Condiciones (ver README del paquete y LICENSE): uso no comercial, sin obras derivadas, atribución,
# y el usuario final acepta la licencia con un clic (la app lo pide antes de cargarlas).
#
#   bash scripts/fetch-nao-meshes.sh
set -euo pipefail

NAO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$NAO_ROOT/public/models/nao_meshes"
URL="http://packages.ros.org/ros2/ubuntu/pool/main/r/ros-jazzy-nao-meshes/ros-jazzy-nao-meshes_2.1.2-1noble.20260624.072223_amd64.deb"
SHA256="925bf83b406b9584d0f7b3fe79fb36e56fd79acc054d120912f0d4a816a21afa"
LICENSE_URL="https://raw.githubusercontent.com/ros-naoqi/nao_meshes2/master/LICENSE"

die() { echo "✗ $*" >&2; exit 1; }
command -v ar >/dev/null || die "falta ar (binutils / Xcode CLT)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL -o "$TMP/pkg.deb" "$URL" || die "descarga falló: $URL"
echo "$SHA256  $TMP/pkg.deb" | shasum -a 256 -c - >/dev/null || die "checksum distinto: el paquete cambió"

(cd "$TMP" && ar x pkg.deb data.tar.zst) || die "el .deb no tiene data.tar.zst"
mkdir -p "$TMP/data"
if command -v zstd >/dev/null; then zstd -dc "$TMP/data.tar.zst" | tar -x -C "$TMP/data"; else tar -xf "$TMP/data.tar.zst" -C "$TMP/data"; fi

SRC="$(find "$TMP/data" -type d -path '*share/nao_meshes' | head -1)"
[ -n "$SRC" ] || die "no encontré share/nao_meshes en el paquete"

rm -rf "$DEST"
mkdir -p "$DEST/meshes/V40" "$DEST/texture"
cp "$SRC"/meshes/V40/*.dae "$DEST/meshes/V40/"
cp "$SRC"/texture/textureNAO.png "$DEST/texture/"
curl -fsSL -o "$DEST/LICENSE.txt" "$LICENSE_URL" || die "no pude descargar la licencia"

echo "✓ $(ls "$DEST/meshes/V40" | wc -l | tr -d ' ') mallas → ${DEST#$NAO_ROOT/} ($(du -sh "$DEST" | cut -f1))"
