#!/usr/bin/env bash
# Build y deploy de nao.bukivo.com sobre la infraestructura de Bukivo.
#
# Reutiliza de ../bukivo (sin modificarlo): la llave SSH, scripts/ssh/config.json, la conexión
# ControlMaster de ssh-manager.sh y el CLI `bukivo cf` para el DNS de Cloudflare.
#
#   bash scripts/deploy.sh build            npm run build → dist/
#   bash scripts/deploy.sh dns    [--yes]   crea nao.bukivo.com (proxied) igual que portal.bukivo.com
#   bash scripts/deploy.sh nginx  [--yes]   sube deploy/nginx/nao.bukivo.com.conf, nginx -t y reload
#   bash scripts/deploy.sh setup  [--yes]   dns + nginx (una sola vez)
#   bash scripts/deploy.sh prod   [--yes]   build + rsync --delete dist/ → /var/www/nao.bukivo.com
#   bash scripts/deploy.sh status           cabeceras HTTP de https://nao.bukivo.com
#   bash scripts/deploy.sh db-setup [--yes] crea la base y el usuario `nao` en Postgres (idempotente)
#   bash scripts/deploy.sh api    [--yes]   compila server/ y reinicia nao-api (PM2, 127.0.0.1:3030)
#   bash scripts/deploy.sh user <args>      nao-api user add|passwd|list en el servidor
#
# --yes (o NAO_DEPLOY_YES=1) salta la confirmación de producción.
# Override de la ruta de Bukivo: export BUKIVO_HOME=/ruta/a/bukivo
set -euo pipefail

NAO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUKIVO_HOME="${BUKIVO_HOME:-$(cd "$NAO_ROOT/../bukivo" && pwd)}"

FQDN="nao.bukivo.com"
WEB_ROOT="/var/www/$FQDN"
VHOST_SRC="$NAO_ROOT/deploy/nginx/$FQDN.conf"
VHOST_DST="/etc/nginx/sites-available/$FQDN"
# El registro DNS de nao copia el de este host (mismo servidor y mismo certificado Origin)
DNS_TEMPLATE_HOST="portal.bukivo.com"
# nao-api (server/): binario Go bajo PM2, como hv-ask y los servicios de Bukivo
API_DIR="/root/nao"
API_NAME="nao-api"
API_ADDR="127.0.0.1:3030"

SSH_DIR="$BUKIVO_HOME/scripts/ssh"
SSH_KEY="$BUKIVO_HOME/.private/ssh/bukivo_server"
SSH_CONTROL="/tmp/.ssh_bukivo"   # el mismo socket que ssh-manager.sh

if [ -t 1 ]; then
  C_BOLD='\033[1m'; C_DIM='\033[2m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[0;31m'; C_NC='\033[0m'
else
  C_BOLD=''; C_DIM=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_NC=''
fi

die() { echo -e "${C_RED}✗ $*${C_NC}" >&2; exit 1; }

_require() {
  [ -f "$SSH_DIR/config.json" ] || die "no existe $SSH_DIR/config.json (BUKIVO_HOME=$BUKIVO_HOME)"
  [ -f "$SSH_KEY" ] || die "no existe la llave SSH de Bukivo en .private/ssh/bukivo_server"
  command -v jq >/dev/null || die "falta jq (brew install jq)"
  SRV_HOST="$(jq -r .host "$SSH_DIR/config.json")"
  SRV_USER="$(jq -r .user "$SSH_DIR/config.json")"
}

# Abre (o reutiliza) la conexión maestra de Bukivo: nunca pide nada interactivo
_ssh_start() { bash "$SSH_DIR/ssh-manager.sh" start >/dev/null; }
_remote() { _ssh_start; ssh -S "$SSH_CONTROL" -i "$SSH_KEY" "$SRV_USER@$SRV_HOST" "$1"; }
_rsync() { _ssh_start; rsync -e "ssh -S $SSH_CONTROL -i $SSH_KEY" "$@"; }

# Misma regla que bukivo.sh: todo lo que toca producción se confirma
_confirm_prod() {
  local what="$1"; shift
  local a
  for a in "$@"; do [ "$a" = "--yes" ] && return 0; done
  [ "${NAO_DEPLOY_YES:-}" = "1" ] && return 0
  printf "%b" "${C_YELLOW}⚠ PRODUCCIÓN:${C_NC} ${what}. ¿Continuar? [y/N]: "
  local ok; read -r ok </dev/tty
  [[ "$ok" =~ ^[Yy]$ ]] || { echo -e "${C_DIM}Cancelado.${C_NC}"; return 1; }
}

cmd_build() {
  # Las mallas oficiales no se versionan (licencia): se descargan del paquete ROS si faltan
  [ -d "$NAO_ROOT/public/models/nao_meshes/meshes" ] || bash "$NAO_ROOT/scripts/fetch-nao-meshes.sh" || die "no pude descargar las mallas"
  [ -f "$NAO_ROOT/public/motions/aldebaran/StandUpX.xar" ] || bash "$NAO_ROOT/scripts/fetch-aldebaran-motions.sh" || die "no pude descargar las rutinas de Aldebaran"
  [ -f "$NAO_ROOT/public/motions/naoqi28/postures-h25.json" ] || bash "$NAO_ROOT/scripts/fetch-naoqi-postures.sh" || die "no pude descargar el grafo de posturas de NAOqi"
  [ -f "$NAO_ROOT/public/models/face/face_recognition_model.bin" ] || bash "$NAO_ROOT/scripts/copy-face-models.sh" || die "no pude copiar los modelos de rostros"
  (cd "$NAO_ROOT" && npm run build) || die "build falló"
  echo -e "${C_GREEN}✓ build → dist/${C_NC}"
}

cmd_dns() {
  command -v bukivo >/dev/null || die "falta el CLI bukivo (symlink a $BUKIVO_HOME/scripts/bukivo-cli/bukivo.sh)"
  # El token de Cloudflare solo responde desde la IP de la oficina (error 9109 fuera de ella)
  local row type content
  row=$(bukivo cf dns "$DNS_TEMPLATE_HOST" | awk -v h="$DNS_TEMPLATE_HOST" '$2 == h { print $1, $3; exit }')
  [ -n "$row" ] || die "no encontré el registro DNS de $DNS_TEMPLATE_HOST (¿estás en la red de la oficina?)"
  read -r type content <<<"$row"
  echo -e "${C_DIM}plantilla: $type $DNS_TEMPLATE_HOST → $content${C_NC}"
  bukivo cf dns-set "$FQDN" "$type" "$content" "$@"
}

cmd_nginx() {
  _require
  [ -f "$VHOST_SRC" ] || die "no existe $VHOST_SRC"
  _confirm_prod "instalar el vhost $FQDN en nginx y recargar" "$@" || return 1
  _rsync -az "$VHOST_SRC" "$SRV_USER@$SRV_HOST:$VHOST_DST.new" || die "subida del vhost falló"
  # Si nginx -t falla se restaura el vhost anterior: nunca se recarga una config rota
  _remote "set -e
    mkdir -p $WEB_ROOT
    [ -f $VHOST_DST ] && cp $VHOST_DST $VHOST_DST.bak || true
    mv $VHOST_DST.new $VHOST_DST
    ln -sf $VHOST_DST /etc/nginx/sites-enabled/$FQDN
    if nginx -t 2>&1; then systemctl reload nginx; else
      if [ -f $VHOST_DST.bak ]; then mv $VHOST_DST.bak $VHOST_DST; else rm -f $VHOST_DST /etc/nginx/sites-enabled/$FQDN; fi
      echo 'nginx -t falló: vhost revertido' >&2; exit 1
    fi" || die "instalación de nginx falló"
  echo -e "${C_GREEN}✓ vhost $FQDN instalado y nginx recargado${C_NC}"
}

cmd_prod() {
  _require
  cmd_build
  [ -f "$NAO_ROOT/dist/index.html" ] || die "dist/index.html no existe"
  _confirm_prod "reemplazar $WEB_ROOT con dist/ (rsync --delete)" "$@" || return 1
  _rsync -az --delete "$NAO_ROOT/dist/" "$SRV_USER@$SRV_HOST:$WEB_ROOT/" || die "subida falló"
  echo -e "${C_GREEN}✓ $FQDN desplegado → $WEB_ROOT${C_NC}"
  echo -e "${C_DIM}  https://$FQDN${C_NC}"
}

# Base `nao` con su propio usuario en el Postgres 12 del servidor. La contraseña se genera allá y solo vive en
# $API_DIR/.env (600). Las extensiones (citext, vector) las crea el superusuario; schema.sql no puede.
cmd_db_setup() {
  _require
  _confirm_prod "crear la base y el usuario nao en Postgres (si no existen)" "$@" || return 1
  _remote "set -e
    mkdir -p $API_DIR && chmod 700 $API_DIR
    if [ ! -f $API_DIR/.env ]; then
      pw=\$(openssl rand -hex 24)
      sudo -u postgres psql -v ON_ERROR_STOP=1 -qc \"CREATE ROLE nao LOGIN PASSWORD '\$pw'\"
      umask 077
      printf 'NAO_DB_URL=postgres://nao:%s@127.0.0.1:5432/nao?sslmode=disable\nNAO_ADDR=$API_ADDR\nNAO_ALLOWED_ORIGINS=$FQDN\n' \"\$pw\" > $API_DIR/.env
    fi
    if [ \"\$(sudo -u postgres psql -tAc \"SELECT 1 FROM pg_database WHERE datname='nao'\")\" != 1 ]; then
      sudo -u postgres psql -v ON_ERROR_STOP=1 -qc 'CREATE DATABASE nao OWNER nao'
    fi
    sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d nao -c 'CREATE EXTENSION IF NOT EXISTS citext' -c 'CREATE EXTENSION IF NOT EXISTS vector'
    sudo -u postgres psql -tAc \"SELECT 'base nao: ' || pg_size_pretty(pg_database_size('nao'))\"" || die "db-setup falló"
  echo -e "${C_GREEN}✓ base nao lista (credenciales en $API_DIR/.env del servidor)${C_NC}"
}

cmd_api() {
  _require
  (cd "$NAO_ROOT/server" && go vet ./... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$NAO_ROOT/server/$API_NAME" .) || die "build de nao-api falló"
  _confirm_prod "reemplazar y reiniciar $API_NAME en $API_ADDR" "$@" || return 1
  _rsync -az "$NAO_ROOT/server/$API_NAME" "$SRV_USER@$SRV_HOST:$API_DIR/$API_NAME.new" || die "subida de nao-api falló"
  # cwd = $API_DIR: así lee su .env. Si no arranca sano, vuelve al binario anterior.
  _remote "set -e
    cd $API_DIR
    [ -f $API_NAME ] && cp $API_NAME $API_NAME.bak || true
    mv $API_NAME.new $API_NAME && chmod 700 $API_NAME
    ./$API_NAME migrate
    if pm2 describe $API_NAME >/dev/null 2>&1; then pm2 restart $API_NAME --update-env >/dev/null; else pm2 start $API_DIR/$API_NAME --name $API_NAME --cwd $API_DIR >/dev/null; fi
    pm2 save >/dev/null
    for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf http://$API_ADDR/api/health >/dev/null && break; sleep 0.5; done
    if ! curl -sf http://$API_ADDR/api/health >/dev/null; then
      echo 'nao-api no responde: vuelvo al binario anterior' >&2
      [ -f $API_NAME.bak ] && mv $API_NAME.bak $API_NAME && pm2 restart $API_NAME >/dev/null
      exit 1
    fi" || die "despliegue de nao-api falló"
  echo -e "${C_GREEN}✓ $API_NAME desplegado y sano ($API_ADDR)${C_NC}"
}

cmd_user() {
  _require
  local args="" a
  for a in "$@"; do args+=" $(printf '%q' "$a")"; done
  # NAO_PASSWORD (opcional) viaja por stdin, no en la línea de comandos del servidor
  printf '%s' "${NAO_PASSWORD:-}" | _remote "cd $API_DIR && NAO_PASSWORD=\"\$(cat)\" ./$API_NAME user$args" || die "nao-api user falló"
}

cmd_status() {
  curl -sS -o /dev/null -D - --max-time 15 "https://$FQDN/" | grep -Ei '^(HTTP|server|cache-control|cf-cache-status|permissions-policy)' \
    || die "https://$FQDN no responde"
}

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

sub="${1:-}"; shift || true
case "$sub" in
  build)  cmd_build ;;
  dns)    cmd_dns "$@" ;;
  nginx)  cmd_nginx "$@" ;;
  setup)  cmd_dns "$@" && cmd_nginx "$@" ;;
  prod)   cmd_prod "$@" ;;
  status) cmd_status ;;
  db-setup) cmd_db_setup "$@" ;;
  api)    cmd_api "$@" ;;
  user)   cmd_user "$@" ;;
  ""|-h|--help|help) usage ;;
  *) die "comando desconocido: $sub (bash scripts/deploy.sh help)" ;;
esac
