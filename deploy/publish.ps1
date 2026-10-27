param(
    [string]$Server = "root@192.168.0.62",
    [string]$RemotePath = "/var/www/shared-notepad"
)

$ErrorActionPreference = "Stop"

Write-Host "Subiendo archivos de la aplicación..."
scp package.json package-lock.json server.js "${Server}:${RemotePath}/"
scp public/* "${Server}:${RemotePath}/public/"
scp deploy/* "${Server}:${RemotePath}/deploy/"

ssh $Server "set -e; cd '$RemotePath'; npm ci --omit=dev; chown -R www-data:www-data '$RemotePath'; chmod 600 .env; chmod +x deploy/update.sh; systemctl restart shared-notepad; systemctl is-active --quiet shared-notepad; curl --fail --silent http://127.0.0.1:3000/health; echo"

Write-Host "Publicación completada correctamente."
