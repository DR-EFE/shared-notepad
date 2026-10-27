# Despliegue y operación

Este documento describe cómo funciona actualmente `shared-notepad` en el servidor Debian y cómo publicar nuevas versiones.

## Arquitectura actual

```text
Internet
   |
   v
Cloudflare Quick Tunnel (*.trycloudflare.com)
   |
   v
cloudflared-quick.service
   |
   v
Node.js / Express (127.0.0.1:3000)
   |
   +-- public/                 Interfaz web
   +-- storage/note.txt        Nota persistente
   +-- storage/uploads/        Archivos subidos
```

El servidor está en `192.168.0.62`, con Debian 13, y la aplicación está instalada en:

```text
/var/www/shared-notepad
```

La aplicación Node.js escucha en el puerto `3000`. El acceso público no entra directamente por ese puerto: `cloudflared` crea una conexión saliente hacia Cloudflare y Cloudflare entrega una URL HTTPS pública.

## Servicios de systemd

### Aplicación Node.js

```bash
systemctl status shared-notepad
systemctl restart shared-notepad
systemctl stop shared-notepad
systemctl start shared-notepad
journalctl -u shared-notepad -f
```

Comprobación de salud:

```bash
curl http://127.0.0.1:3000/health
```

Respuesta esperada:

```json
{"ok":true}
```

### Cloudflare Quick Tunnel

```bash
systemctl status cloudflared-quick
systemctl restart cloudflared-quick
journalctl -u cloudflared-quick -f
```

Para consultar la URL pública actual:

```bash
journalctl -u cloudflared-quick --no-pager | grep trycloudflare.com | tail -n 1
```

La URL se genera automáticamente y puede cambiar cuando el túnel se reinicia. Este tipo de túnel es útil para pruebas y acceso temporal; no tiene garantía de disponibilidad. Para producción estable se recomienda un túnel administrado con dominio propio.

## Publicar cambios desde Windows

El acceso SSH debe estar configurado para `root@192.168.0.62`.

Desde PowerShell, situado en la carpeta del proyecto:

```powershell
cd C:\Users\pipe6\Documents\shared-notepad
.\deploy\publish.ps1
```

El script:

1. Copia `package.json`, `package-lock.json` y `server.js`.
2. Copia el contenido de `public/`.
3. Copia los archivos de despliegue.
4. Ejecuta `npm ci --omit=dev` en Debian.
5. Conserva el `.env` existente del servidor.
6. Ajusta permisos para `www-data`.
7. Reinicia `shared-notepad`.
8. Comprueba `/health`.

Para otro servidor o ruta:

```powershell
.\deploy\publish.ps1 -Server root@OTRA_IP -RemotePath /var/www/otra-app
```

El script no copia `.env`, `storage/` ni `node_modules/`. Esto es intencional: las credenciales y los datos de usuarios deben permanecer en el servidor.

## Publicar manualmente desde Debian

Si los cambios ya fueron copiados al servidor:

```bash
cd /var/www/shared-notepad
npm ci --omit=dev
chown -R www-data:www-data /var/www/shared-notepad
chmod 600 .env
systemctl restart shared-notepad
curl --fail http://127.0.0.1:3000/health
```

También existe:

```bash
cd /var/www/shared-notepad
bash deploy/update.sh
```

Ese script está pensado para una instalación que tenga el proyecto conectado a un repositorio Git. Para la instalación actual, la publicación recomendada es `publish.ps1` desde Windows.

## Variables de entorno

El archivo real está en:

```text
/var/www/shared-notepad/.env
```

Contenido esperado:

```env
APP_PASSWORD=una_contraseña_segura
APP_SECRET=un_secreto_largo_y_aleatorio
PORT=3000
```

No subir `.env` a GitHub ni compartirlo. Si se cambia `PORT`, también debe cambiarse la URL de origen de Cloudflare Tunnel.

## Datos persistentes

La aplicación no usa base de datos:

```text
/var/www/shared-notepad/storage/note.txt
/var/www/shared-notepad/storage/uploads/
```

Antes de migrar o reinstalar, hacer una copia:

```bash
tar -czf /root/shared-notepad-backup-$(date +%F).tar.gz \
  /var/www/shared-notepad/storage \
  /var/www/shared-notepad/.env
```

## Diagnóstico rápido

Si aparece `ERR_CONNECTION_REFUSED`:

```bash
systemctl is-active shared-notepad
systemctl is-active cloudflared-quick
curl http://127.0.0.1:3000/health
journalctl -u shared-notepad -n 50 --no-pager
journalctl -u cloudflared-quick -n 50 --no-pager
```

Si la aplicación local responde pero la URL pública no:

```bash
systemctl restart cloudflared-quick
journalctl -u cloudflared-quick --no-pager | grep trycloudflare.com | tail -n 1
```

La URL anterior dejará de funcionar y habrá que usar la nueva URL mostrada en los logs.

Si `npm start` indica que el puerto está ocupado:

```bash
ss -ltnp | grep ':3000'
systemctl restart shared-notepad
```

No iniciar manualmente otro `node server.js` mientras `shared-notepad` esté activo.

## Otras páginas en el mismo servidor

Cada aplicación adicional debe tener, idealmente:

```text
/var/www/otra-aplicacion
/etc/systemd/system/otra-aplicacion.service
```

Cada una debe usar un puerto local diferente. Por ejemplo:

```text
shared-notepad: 3000
otra-aplicacion: 3001
```

En el futuro, lo recomendable es usar un túnel administrado de Cloudflare y configurar varios hostnames, por ejemplo:

```text
notas.example.com  -> http://127.0.0.1:3000
otra.example.com   -> http://127.0.0.1:3001
```

Así se pueden alojar varias páginas sin exponer directamente sus puertos y sin que una aplicación interfiera con otra.
