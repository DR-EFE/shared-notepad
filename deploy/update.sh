#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/shared-notepad}"

cd "$APP_DIR"
git pull --ff-only origin main
npm ci --omit=dev
sudo systemctl restart shared-notepad
sudo systemctl --no-pager --full status shared-notepad
curl --fail --silent http://127.0.0.1:3000/health
echo
echo "Despliegue completado correctamente."
