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

wss.on('error', (err) => {
  console.error('[WebSocket] Error del servidor:', err.message);
});

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
const NOTES_DATA_FILE = path.join(STORAGE_DIR, 'notes_data.json');

if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Cargar o inicializar estructura de grupos y notas
function loadNotesData() {
  if (fs.existsSync(NOTES_DATA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(NOTES_DATA_FILE, 'utf8'));
      if (data && Array.isArray(data.groups) && data.groups.length > 0) {
        return data;
      }
    } catch (e) {
      console.error('[Aviso] Error al leer notes_data.json, regenerando:', e);
    }
  }

  // Si existe note.txt previo, migrar su contenido a la nota inicial
  let initialContent = '';
  if (fs.existsSync(NOTE_FILE)) {
    try {
      initialContent = fs.readFileSync(NOTE_FILE, 'utf8');
    } catch (e) {}
  }

  const initialNoteId = 'note_' + Date.now();
  const initialGroupId = 'group_' + Date.now();
  const defaultData = {
    groups: [
      {
        id: initialGroupId,
        name: 'General',
        createdAt: Date.now(),
        notes: [
          {
            id: initialNoteId,
            title: 'Nota Principal',
            content: initialContent || '',
            updatedAt: Date.now()
          }
        ]
      }
    ],
    activeNoteId: initialNoteId
  };

  try {
    fs.writeFileSync(NOTES_DATA_FILE, JSON.stringify(defaultData, null, 2), 'utf8');
  } catch (err) {
    console.error('[Error] No se pudo escribir notes_data.json inicial:', err);
  }
  return defaultData;
}

let notesStore = loadNotesData();

let saveDebounceTimer = null;
function persistNotesDataDebounced() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    fs.writeFile(NOTES_DATA_FILE, JSON.stringify(notesStore, null, 2), 'utf8', (err) => {
      if (err) console.error('[Error] Error al persistir notes_data.json:', err);
    });
  }, 250);
}

function findNoteAndGroup(noteId) {
  for (const group of notesStore.groups) {
    const note = group.notes.find(n => n.id === noteId);
    if (note) return { group, note };
  }
  return { group: null, note: null };
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

// GET /api/notes-data - Obtener todos los grupos y notas
app.get('/api/notes-data', (req, res) => {
  res.json(notesStore);
});

// POST /api/restore-backup - Restaurar notas completas desde un archivo de respaldo
app.post('/api/restore-backup', (req, res) => {
  const { data } = req.body;
  if (!data || !Array.isArray(data.groups) || data.groups.length === 0) {
    return res.status(400).json({ error: 'Formato de respaldo no válido o vacío' });
  }
  notesStore = data;
  persistNotesDataDebounced();
  broadcast({ type: 'notes_data_update', data: notesStore });
  res.json({ success: true, activeNoteId: notesStore.activeNoteId });
});

// POST /api/groups - Crear nuevo grupo
app.post('/api/groups', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'El nombre del grupo es obligatorio' });
  }
  const newGroup = {
    id: 'group_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    name,
    createdAt: Date.now(),
    notes: []
  };
  notesStore.groups.push(newGroup);
  persistNotesDataDebounced();
  broadcast({ type: 'notes_data_update', data: notesStore });
  res.json(newGroup);
});

// PUT /api/groups/:id - Renombrar grupo
app.put('/api/groups/:id', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'El nombre del grupo es obligatorio' });
  }
  const group = notesStore.groups.find(g => g.id === req.params.id);
  if (!group) {
    return res.status(404).json({ error: 'Grupo no encontrado' });
  }
  group.name = name;
  persistNotesDataDebounced();
  broadcast({ type: 'notes_data_update', data: notesStore });
  res.json(group);
});

// DELETE /api/groups/:id - Eliminar grupo y sus notas
app.delete('/api/groups/:id', (req, res) => {
  const index = notesStore.groups.findIndex(g => g.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Grupo no encontrado' });
  }
  if (notesStore.groups.length <= 1) {
    return res.status(400).json({ error: 'No se puede eliminar el único grupo existente' });
  }
  notesStore.groups.splice(index, 1);

  // Asegurar que activeNoteId siga siendo válido
  const { note } = findNoteAndGroup(notesStore.activeNoteId);
  if (!note) {
    const firstGroupWithNotes = notesStore.groups.find(g => g.notes.length > 0);
    if (firstGroupWithNotes) {
      notesStore.activeNoteId = firstGroupWithNotes.notes[0].id;
    } else {
      const fallbackNote = {
        id: 'note_' + Date.now(),
        title: 'Nueva Nota',
        content: '',
        updatedAt: Date.now()
      };
      notesStore.groups[0].notes.push(fallbackNote);
      notesStore.activeNoteId = fallbackNote.id;
    }
  }

  persistNotesDataDebounced();
  broadcast({ type: 'notes_data_update', data: notesStore });
  res.json({ success: true, activeNoteId: notesStore.activeNoteId });
});

// POST /api/groups/:groupId/notes - Crear nueva nota en un grupo
app.post('/api/groups/:groupId/notes', (req, res) => {
  const group = notesStore.groups.find(g => g.id === req.params.groupId);
  if (!group) {
    return res.status(404).json({ error: 'Grupo no encontrado' });
  }
  const title = (req.body.title || '').trim() || 'Nota sin título';
  const content = typeof req.body.content === 'string' ? req.body.content : '';
  const newNote = {
    id: 'note_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    title,
    content,
    updatedAt: Date.now()
  };
  group.notes.push(newNote);
  notesStore.activeNoteId = newNote.id;
  persistNotesDataDebounced();
  broadcast({ type: 'notes_data_update', data: notesStore });
  res.json(newNote);
});

// PUT /api/notes/:id - Actualizar título o contenido de una nota
app.put('/api/notes/:id', (req, res) => {
  const { group, note } = findNoteAndGroup(req.params.id);
  if (!note) {
    return res.status(404).json({ error: 'Nota no encontrada' });
  }
  let changed = false;
  if (typeof req.body.title === 'string' && req.body.title.trim()) {
    note.title = req.body.title.trim();
    changed = true;
  }
  if (typeof req.body.content === 'string') {
    note.content = req.body.content;
    changed = true;
  }
  if (changed) {
    note.updatedAt = Date.now();
    persistNotesDataDebounced();
    broadcast({
      type: 'note_update',
      noteId: note.id,
      content: note.content,
      title: note.title
    });
  }
  res.json(note);
});

// DELETE /api/notes/:id - Eliminar una nota
app.delete('/api/notes/:id', (req, res) => {
  const { group, note } = findNoteAndGroup(req.params.id);
  if (!group || !note) {
    return res.status(404).json({ error: 'Nota no encontrada' });
  }
  group.notes = group.notes.filter(n => n.id !== req.params.id);

  if (notesStore.activeNoteId === req.params.id) {
    if (group.notes.length > 0) {
      notesStore.activeNoteId = group.notes[0].id;
    } else {
      const otherGroup = notesStore.groups.find(g => g.notes.length > 0);
      if (otherGroup) {
        notesStore.activeNoteId = otherGroup.notes[0].id;
      } else {
        const fallbackNote = {
          id: 'note_' + Date.now(),
          title: 'Nueva Nota',
          content: '',
          updatedAt: Date.now()
        };
        group.notes.push(fallbackNote);
        notesStore.activeNoteId = fallbackNote.id;
      }
    }
  }

  persistNotesDataDebounced();
  broadcast({ type: 'notes_data_update', data: notesStore });
  res.json({ success: true, activeNoteId: notesStore.activeNoteId });
});

// GET /api/note - Compatibilidad de la nota actual
app.get('/api/note', (req, res) => {
  const { note } = findNoteAndGroup(notesStore.activeNoteId);
  if (note) {
    return res.json({ content: note.content, id: note.id, title: note.title });
  }
  res.json({ content: '' });
});

// PUT /api/note - Compatibilidad de guardado
app.put('/api/note', (req, res) => {
  const { content, noteId } = req.body;
  const targetId = noteId || notesStore.activeNoteId;
  const { note } = findNoteAndGroup(targetId);
  const text = typeof content === 'string' ? content : '';
  if (note) {
    note.content = text;
    note.updatedAt = Date.now();
    persistNotesDataDebounced();
    broadcast({ type: 'note_update', noteId: note.id, content: text, title: note.title });
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Nota no encontrada' });
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
  const forceDownload = req.query.download === '1' || req.query.download === 'true';

  res.setHeader('Content-Type', contentType);
  if (isImage && !forceDownload) {
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
        const targetId = data.noteId || notesStore.activeNoteId;
        const { note } = findNoteAndGroup(targetId);
        const text = typeof data.content === 'string' ? data.content : '';
        if (note) {
          note.content = text;
          note.updatedAt = Date.now();
          persistNotesDataDebounced();
          // Reenviar a los demás usuarios inmediatamente
          broadcast({
            type: 'note_update',
            noteId: note.id,
            content: text,
            title: note.title
          }, ws);
        }
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
