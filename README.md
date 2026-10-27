# Bloc de Notas Compartido con Adjuntos

La guía completa de instalación, operación y despliegue está en [DEPLOYMENT.md](DEPLOYMENT.md).

Aplicación web ligera para compartir notas y archivos entre máquinas remotas de forma sencilla y funcional.

## Características

- **Persistencia sin base de datos**: todo se guarda en archivos locales dentro del directorio `storage/` (`storage/note.txt` y `storage/uploads/`).
- **Sincronización en tiempo real (WebSockets)**: cada tecla pulsada o archivo subido se refleja de inmediato en todas las pantallas abiertas, sin necesidad de recargar la página.
- **Autoguardado automático**: sin necesidad de botones de guardar; guarda al vuelo con debounce en disco.
- **Autenticación con contraseña única**: protegida por JWT firmado con duración de 30 días.
- **Adjuntos de hasta 50 MB**: subida múltiple o mediante arrastrar y soltar (drag & drop), con progreso de subida.
- **Enlaces con token compartible**: opción de copiar enlace directo (`?token=...`) para visualizar o descargar desde otra máquina sin login previo.
- **Visualización inline**: las imágenes se muestran en miniatura y se abren directamente en el navegador.

---

## 🌐 Opciones de Despliegue en la Nube / Acceso Remoto

Esta aplicación requiere un servidor Node.js activo para mantener conexiones WebSocket vivas y guardar archivos en disco.

### Opción 1: Túnel Cloudflare / Ngrok / Localtunnel (Recomendado para correr en tu máquina)
No necesitas subir nada a un hosting ni configurar DNS:
```bash
cloudflared tunnel --url http://localhost:3000
```
Te dará una URL HTTPS pública inmediata, segura y con soporte WebSocket directo.

### Opción 2: Plataformas en la nube (Render, Railway, Fly.io, VPS)
Para tenerla 24/7 sin dejar tu PC encendida:
- **Render.com** (Web Service gratuito/pago): Conectas este repositorio de GitHub, comando de inicio `npm start`.
- **Railway.app** o **Fly.io**: Detectan Node.js automáticamente y soportan WebSockets y volúmenes persistentes.

> ℹ️ **Nota sobre Netlify / Vercel**: 
> Netlify está diseñado principalmente para sitios estáticos o funciones serverless efímeras (que se apagan tras unos segundos y no admiten WebSockets persistentes ni escritura en disco local `storage/`). Por tanto, si deseas subirla a la nube para tener WebSockets y almacenamiento de archivos, se debe usar **Render**, **Railway** o un **VPS**, o mantenerla mediante **Túnel** (Cloudflare Tunnel).

---

## Instalación y Configuración

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configuración de variables de entorno
Copia el archivo de plantilla `.env.example` a `.env` (si no lo tienes ya):
```bash
cp .env.example .env
```

Edita `.env` con tus propios valores seguros:
```env
APP_PASSWORD=tu_password_seguro_aqui
APP_SECRET=tu_secreto_aleatorio_para_firmar_jwt
PORT=3000
```

> *Tip: Puedes generar un secreto aleatorio seguro ejecutando en Node o terminal:*
> `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## Cómo arrancar la aplicación

Para iniciar el servidor:
```bash
npm start
```

El servidor escuchará en `0.0.0.0:$PORT` (por defecto puerto 3000). Accede desde tu navegador local o remoto a:
```
http://localhost:3000
```
(O la IP local/pública de la máquina en el puerto configurado).

### Despliegue recomendado en Debian con systemd y Nginx

Los archivos de ejemplo están en `deploy/`. En el servidor:

```bash
sudo apt update
sudo apt install -y nodejs npm nginx
sudo mkdir -p /var/www/shared-notepad
sudo chown -R www-data:www-data /var/www/shared-notepad
```

Copia el proyecto a `/var/www/shared-notepad`, crea `.env` con `APP_PASSWORD`, `APP_SECRET` y `PORT=3000`, y ejecuta:

```bash
cd /var/www/shared-notepad
npm ci --omit=dev
sudo install -m 644 deploy/shared-notepad.service.example /etc/systemd/system/shared-notepad.service
sudo systemctl daemon-reload
sudo systemctl enable --now shared-notepad
curl http://127.0.0.1:3000/health
```

Para Nginx, copia `deploy/nginx.conf.example` a `/etc/nginx/sites-available/shared-notepad`, cambia `server_name`, activa el sitio y valida:

```bash
sudo ln -s /etc/nginx/sites-available/shared-notepad /etc/nginx/sites-enabled/shared-notepad
sudo nginx -t && sudo systemctl reload nginx
```

El proxy incluye soporte para WebSockets y subidas de hasta 50 MB. Si usas otro puerto interno, cambia `PORT` en `.env` y el valor de `proxy_pass` para que coincidan.

### Actualizaciones posteriores

Desde Windows puedes publicar los cambios directamente con:

```powershell
.\deploy\publish.ps1
```

El script usa `root@192.168.0.62` por defecto. Para otro servidor o ruta:

```powershell
.\deploy\publish.ps1 -Server root@OTRA_IP -RemotePath /var/www/otra-app
```

También puedes ejecutar el mantenimiento desde Debian:

```bash
cd /var/www/shared-notepad
bash deploy/update.sh
```

La publicación instala las dependencias exactas del `package-lock.json`, reinicia el servicio y comprueba `/health`. Cada página adicional podrá tener su propio directorio, servicio y dominio Nginx sin modificar esta aplicación.
