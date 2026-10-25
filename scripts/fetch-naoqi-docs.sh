#!/usr/bin/env bash
# Descarga la documentación oficial de NAOqi 2.8 que usa el proyecto (© SoftBank Robotics / Aldebaran) desde
# doc.aldebaran.com/2-8 y la convierte a Markdown en reference/naoqi-2.8-api/ (no se versiona en git: el repo no
# redistribuye la documentación de Aldebaran). El código cita estas páginas por nombre de archivo.
#
# Si el sitio deja de existir, cada página sigue en web.archive.org: NAOQI_DOCS_BASE=https://web.archive.org/web/2026/http://doc.aldebaran.com/2-8
#
#   bash scripts/fetch-naoqi-docs.sh
set -euo pipefail

NAO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$NAO_ROOT/reference/naoqi-2.8-api"
BASE="${NAOQI_DOCS_BASE:-http://doc.aldebaran.com/2-8}"

# archivo → página (sin .html)
PAGES=(
  dev_python_making_nao_speak=dev/python/making_nao_speak
  family_nao_technical_joints_naov6=family/nao_technical/joints_naov6
  family_nao_technical_leds_naov6=family/nao_technical/leds_naov6
  family_nao_technical_links_naov6=family/nao_technical/links_naov6
  family_nao_technical_masses_naov6=family/nao_technical/masses_naov6
  family_nao_technical_motors_naov6=family/nao_technical/motors_naov6
  family_nao_technical_video_naov6=family/nao_technical/video_naov6
  naoqi_audio_alanimatedspeech-api=naoqi/audio/alanimatedspeech-api
  naoqi_audio_alaudiodevice-api=naoqi/audio/alaudiodevice-api
  naoqi_audio_alsoundlocalization-api=naoqi/audio/alsoundlocalization-api
  naoqi_audio_alsoundlocalization=naoqi/audio/alsoundlocalization
  naoqi_audio_alspeechrecognition-api=naoqi/audio/alspeechrecognition-api
  naoqi_audio_altexttospeech-api=naoqi/audio/altexttospeech-api
  naoqi_core_almemory-api=naoqi/core/almemory-api
  naoqi_interaction_albasicawareness-api=naoqi/interaction/autonomousabilities/albasicawareness-api
  naoqi_interaction_albasicawareness=naoqi/interaction/autonomousabilities/albasicawareness
  naoqi_motion_almotion-api=naoqi/motion/almotion-api
  naoqi_motion_almotion=naoqi/motion/almotion
  naoqi_motion_alrobotposture-api=naoqi/motion/alrobotposture-api
  naoqi_motion_alrobotposture=naoqi/motion/alrobotposture
  naoqi_motion_control-cartesian-api=naoqi/motion/control-cartesian-api
  naoqi_motion_control-joint-api=naoqi/motion/control-joint-api
  naoqi_motion_control-joint=naoqi/motion/control-joint
  naoqi_motion_control-stiffness-api=naoqi/motion/control-stiffness-api
  naoqi_motion_control-stiffness=naoqi/motion/control-stiffness
  naoqi_motion_control-walk-api=naoqi/motion/control-walk-api
  naoqi_motion_reflexes-collision-avoidance=naoqi/motion/reflexes-collision-avoidance
  naoqi_motion_reflexes-external-collision-api=naoqi/motion/reflexes-external-collision-api
  naoqi_motion_reflexes-external-collision=naoqi/motion/reflexes-external-collision
  naoqi_motion_reflexes-fall-manager=naoqi/motion/reflexes-fall-manager
  naoqi_motion_reflexes-smart-stiffness=naoqi/motion/reflexes-smart-stiffness
  naoqi_peopleperception_alfacedetection-api=naoqi/peopleperception/alfacedetection-api
  naoqi_peopleperception_alfacedetection=naoqi/peopleperception/alfacedetection
  naoqi_sensors_alleds-api=naoqi/sensors/alleds-api
  naoqi_sensors_alleds=naoqi/sensors/alleds
  naoqi_sensors_alsonar-api=naoqi/sensors/alsonar-api
  naoqi_sensors_alsonar=naoqi/sensors/alsonar
  naoqi_vision_almovementdetection-api=naoqi/vision/almovementdetection-api
  naoqi_vision_almovementdetection=naoqi/vision/almovementdetection
  naoqi_vision_alvideodevice-api=naoqi/vision/alvideodevice-api
)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST"
for entry in "${PAGES[@]}"; do
  name="${entry%%=*}"
  url="$BASE/${entry#*=}.html"
  curl -fsS --retry 2 -o "$TMP/$name.html" "$url" || { echo "✗ $url" >&2; exit 1; }
  python3 -I "$NAO_ROOT/scripts/naoqi-docs-to-md.py" "$TMP/$name.html" "$url" > "$DEST/$name.md"
done
echo "✓ ${#PAGES[@]} páginas en reference/naoqi-2.8-api/"
