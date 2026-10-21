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

cmd_status() {
  curl -sS -o /dev/null -D - --max-time 15 "https://$FQDN/" | grep -Ei '^(HTTP|server|cache-control|cf-cache-status|permissions-policy)' \
    || die "https://$FQDN no responde"
}

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

sub="${1:-}"; shift || true
case "$sub" in
  build)  cmd_build ;;
  dns)    cmd_dns "$@" ;;
  nginx)  cmd_nginx "$@" ;;
  setup)  cmd_dns "$@" && cmd_nginx "$@" ;;
  prod)   cmd_prod "$@" ;;
  status) cmd_status ;;
  ""|-h|--help|help) usage ;;
  *) die "comando desconocido: $sub (bash scripts/deploy.sh help)" ;;
esac
