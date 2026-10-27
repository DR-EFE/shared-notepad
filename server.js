require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const mime = require('mime-types');

const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme';
const APP_SECRET = process.env.APP_SECRET || 'changeme';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT debe ser un número entre 1 y 65535');
}

if (APP_PASSWORD === 'changeme' || APP_SECRET === 'changeme') {
  console.warn('[Aviso] Configura APP_PASSWORD y APP_SECRET en .env antes de exponer el servidor.');
}

// Broadcast helper a todos los clientes WebSocket autenticados
function broadcast(data, excludeWs = null) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN && client.isAuthenticated) {
      client.send(message);
    }
  });
}

// Asegurar directorios de almacenamiento
const STORAGE_DIR = path.join(__dirname, 'storage');
const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
const NOTE_FILE = path.join(STORAGE_DIR, 'note.txt');

if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Middlewares base
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint para comprobaciones de systemd, Nginx y monitorización.
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Función para sanitizar nombres de archivo (evita path traversal y caracteres peligrosos)
function sanitizeFilename(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const base = path.basename(originalName, ext);
  // Limpiar caracteres extraños, reemplazar espacios por guiones bajos
  let cleanBase = base.replace(/[^a-zA-Z0-9_\-\.]/g, '_').replace(/_+/g, '_');
  if (!cleanBase) cleanBase = 'file';
  
  let candidate = `${cleanBase}${ext}`;
  let counter = 1;
  while (fs.existsSync(path.join(UPLOADS_DIR, candidate))) {
    candidate = `${cleanBase}_${counter}${ext}`;
    counter++;
  }
  return candidate;
}

// Configuración de Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const safeName = sanitizeFilename(file.originalname);
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

// Middleware de autenticación (Header Authorization o query param 'token')
function authMiddleware(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  jwt.verify(token, APP_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
    req.user = decoded;
    next();
  });
}

// POST /api/login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  // Token con expiración de 30 días
  const token = jwt.sign({ auth: true }, APP_SECRET, { expiresIn: '30d' });
  return res.json({ token });
});

// Proteger todas las rutas /api/* siguientes con el middleware
app.use('/api', authMiddleware);

// GET /api/me - Validar token actual
app.get('/api/me', (req, res) => {
  res.json({ ok: true });
});

// GET /api/note - Obtener contenido de la nota
app.get('/api/note', (req, res) => {
  fs.readFile(NOTE_FILE, 'utf8', (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        return res.json({ content: '' });
      }
      return res.status(500).json({ error: 'Error al leer la nota' });
    }
    res.json({ content: data });
  });
});

// PUT /api/note - Guardar contenido de la nota
app.put('/api/note', (req, res) => {
  const { content } = req.body;
  const text = typeof content === 'string' ? content : '';
  fs.writeFile(NOTE_FILE, text, 'utf8', (err) => {
    if (err) {
      return res.status(500).json({ error: 'Error al guardar la nota' });
    }
    // Notificar a otros clientes conectados
    broadcast({ type: 'note_update', content: text });
    res.json({ success: true });
  });
});

// POST /api/upload - Subir archivos (múltiples permitidos)
app.post('/api/upload', upload.array('files'), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No se subieron archivos' });
  }
  const uploaded = req.files.map(f => ({
    name: f.filename,
    size: f.size
  }));
  broadcast({ type: 'files_update' });
  res.json({ uploaded });
}, (err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'El archivo supera el límite de 50 MB' });
  }
  res.status(500).json({ error: err.message || 'Error en subida de archivo' });
});

// GET /api/files - Lista de archivos
app.get('/api/files', (req, res) => {
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) {
      return res.status(500).json({ error: 'Error al leer el directorio de archivos' });
    }
    const fileList = [];
    for (const file of files) {
      try {
        const filePath = path.join(UPLOADS_DIR, file);
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          fileList.push({
            name: file,
            size: stats.size,
            mtime: stats.mtime
          });
        }
      } catch (e) {
        // Ignorar posibles errores en lecturas puntuales
      }
    }
    // Ordenar de más reciente a más antiguo
    fileList.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json({ files: fileList });
  });
});

// GET /api/files/:name - Descarga o visualización inline
app.get('/api/files/:name', (req, res) => {
  const fileName = path.basename(req.params.name); // Protección básica path traversal
  const filePath = path.join(UPLOADS_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Archivo no encontrado');
  }

  const contentType = mime.lookup(filePath) || 'application/octet-stream';
  const isImage = contentType.startsWith('image/');

  res.setHeader('Content-Type', contentType);
  if (isImage) {
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  }

  const readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

// DELETE /api/files/:name - Borrar archivo
app.delete('/api/files/:name', (req, res) => {
  const fileName = path.basename(req.params.name);
  const filePath = path.join(UPLOADS_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }

  fs.unlink(filePath, (err) => {
    if (err) {
      return res.status(500).json({ error: 'No se pudo eliminar el archivo' });
    }
    broadcast({ type: 'files_update' });
    res.json({ success: true });
  });
});

// Manejo de conexiones WebSocket
wss.on('connection', (ws, req) => {
  ws.isAuthenticated = false;

  // Extraer token de url ej: ws://localhost:3000/?token=...
  try {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const token = parsedUrl.searchParams.get('token');
    if (token) {
      jwt.verify(token, APP_SECRET, (err, decoded) => {
        if (!err && decoded) {
          ws.isAuthenticated = true;
        }
      });
    }
  } catch (e) {}

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Autenticación por mensaje si no se pasó en query
      if (data.type === 'auth') {
        jwt.verify(data.token, APP_SECRET, (err, decoded) => {
          if (!err && decoded) {
            ws.isAuthenticated = true;
            ws.send(JSON.stringify({ type: 'auth_ok' }));
          } else {
            ws.close();
          }
        });
        return;
      }

      if (!ws.isAuthenticated) return;

      // Evento de actualización de nota en tiempo real desde el cliente
      if (data.type === 'note_input') {
        const text = typeof data.content === 'string' ? data.content : '';
        // Guardar a disco
        fs.writeFile(NOTE_FILE, text, 'utf8', () => {});
        // Reenviar a los demás usuarios inmediatamente
        broadcast({ type: 'note_update', content: text }, ws);
      }
    } catch (e) {}
  });
});

// Iniciar servidor en 0.0.0.0
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Error] El puerto ${PORT} ya está en uso. Detén el proceso anterior o cambia PORT en .env.`);
  } else {
    console.error('[Error] No se pudo iniciar el servidor:', err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Servidor] Bloc de notas compartido escuchando en http://0.0.0.0:${PORT}`);
});
