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

// ============================================================
// GESTIÓN DE DIRECTORIOS Y ALMACENAMIENTO POR USUARIO
// ============================================================
const STORAGE_DIR = path.join(__dirname, 'storage');
const USERS_DIR = path.join(STORAGE_DIR, 'users');
const LEGACY_NOTE_FILE = path.join(STORAGE_DIR, 'note.txt');
const LEGACY_NOTES_DATA_FILE = path.join(STORAGE_DIR, 'notes_data.json');

if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}
  if (!fs.existsSync(USERS_DIR)) {
    fs.mkdirSync(USERS_DIR, { recursive: true });
  }

      // Sanitizar id de usuario para prevenir path traversal o caracteres inválidos
      function sanitizeUserId(rawId) {
        if (!rawId || typeof rawId !== 'string') return 'invitado';
        const clean = rawId.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '_');
        return clean || 'invitado';
      }

      // Obtener rutas aisladas para un usuario específico
      function getUserDirs(userId) {
        const safeId = sanitizeUserId(userId);
        const userDir = path.join(USERS_DIR, safeId);
        const uploadsDir = path.join(userDir, 'uploads');
        const notesFile = path.join(userDir, 'notes_data.json');

        if (!fs.existsSync(userDir)) {
          fs.mkdirSync(userDir, { recursive: true });
        }
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }

        return { safeId, userDir, uploadsDir, notesFile };
      }

      // Cargar o inicializar estructura de notas para un usuario específico
      function loadUserNotesData(userId) {
        const { notesFile } = getUserDirs(userId);

        if (fs.existsSync(notesFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
            if (data && Array.isArray(data.groups) && data.groups.length > 0) {
              return data;
            }
          } catch (e) {
            console.error(`[Aviso] Error al leer notes_data.json para ${userId}, regenerando:`, e);
          }
        }

        // Si existe un notes_data.json legacy previo y es 'efe' o 'invitado', migrarlo como base
        if (fs.existsSync(LEGACY_NOTES_DATA_FILE) && (userId === 'efe' || userId === 'invitado')) {
          try {
            const legacyData = JSON.parse(fs.readFileSync(LEGACY_NOTES_DATA_FILE, 'utf8'));
            if (legacyData && Array.isArray(legacyData.groups) && legacyData.groups.length > 0) {
              fs.writeFileSync(notesFile, JSON.stringify(legacyData, null, 2), 'utf8');
              return legacyData;
            }
          } catch (e) { }
        }

        // Contenido de nota inicial
        let initialContent = '';
          if (fs.existsSync(LEGACY_NOTE_FILE)) {
            try {
              initialContent = fs.readFileSync(LEGACY_NOTE_FILE, 'utf8');
            } catch (e) { }
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
            fs.writeFileSync(notesFile, JSON.stringify(defaultData, null, 2), 'utf8');
          } catch (err) {
            console.error(`[Error] No se pudo escribir notes_data.json inicial para ${userId}:`, err);
          }
          return defaultData;
        }

        // Stores en memoria por usuario con persistencia debounced individual
        const userStores = new Map();
        const userSaveDebounceTimers = new Map();

              function getUserNotesData(userId) {
                const safeId = sanitizeUserId(userId);
                if (userStores.has(safeId)) {
                  return userStores.get(safeId);
                }
                const data = loadUserNotesData(safeId);
                userStores.set(safeId, data);
                return data;
              }

              function persistUserNotesDebounced(userId) {
                const safeId = sanitizeUserId(userId);
                clearTimeout(userSaveDebounceTimers.get(safeId));
                const timer = setTimeout(() => {
                  const store = userStores.get(safeId);
                  if (!store) return;
                  const { notesFile } = getUserDirs(safeId);
                  fs.writeFile(notesFile, JSON.stringify(store, null, 2), 'utf8', (err) => {
                    if (err) console.error(`[Error] Error al persistir notes_data.json de ${safeId}:`, err);
                  });
                }, 250);
                userSaveDebounceTimers.set(safeId, timer);
              }

                  function findUserNoteAndGroup(userId, noteId) {
                    const store = getUserNotesData(userId);
                    for (const group of store.groups) {
                      const note = group.notes.find(n => n.id === noteId);
                      if (note) return { group, note, store };
                    }
                    return { group: null, note: null, store };
                  }

                  // Broadcast helper a los clientes WebSocket de un usuario específico
                  function broadcastToUser(userId, data, excludeWs = null) {
                    const safeUserId = sanitizeUserId(userId);
                    const message = JSON.stringify(data);
                    wss.clients.forEach(client => {
                      if (client !== excludeWs && client.readyState === WebSocket.OPEN && client.isAuthenticated && client.userId === safeUserId) {
                        client.send(message);
                      }
                    });
                  }

                    // Sanitizar nombres de archivo (evita path traversal y caracteres peligrosos)
                    function sanitizeFilename(targetDir, originalName) {
                      const ext = path.extname(originalName).toLowerCase();
                      const base = path.basename(originalName, ext);
                      let cleanBase = base.replace(/[^a-zA-Z0-9_\-\.]/g, '_').replace(/_+/g, '_');
                      if (!cleanBase) cleanBase = 'file';

                      let candidate = `${cleanBase}${ext}`;
                      let counter = 1;
                        while (fs.existsSync(path.join(targetDir, candidate))) {
                          candidate = `${cleanBase}_${counter}${ext}`;
                          counter++;
                        }
                        return candidate;
                      }

                      // Configuración de Multer dinámico según el usuario autenticado
                      const storage = multer.diskStorage({
                        destination: (req, file, cb) => {
                          const safeId = sanitizeUserId(req.user?.userId || 'invitado');
                          const { uploadsDir } = getUserDirs(safeId);
                          cb(null, uploadsDir);
                        },
                        filename: (req, file, cb) => {
                          const safeId = sanitizeUserId(req.user?.userId || 'invitado');
                          const { uploadsDir } = getUserDirs(safeId);
                          const safeName = sanitizeFilename(uploadsDir, file.originalname);
                          cb(null, safeName);
                        }
                      });

                      const upload = multer({
                        storage,
                        limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
                      });

                      // Middlewares base
                      app.use(express.json({ limit: '15mb' }));
                      app.use(express.static(path.join(__dirname, 'public')));

                      // Endpoint de comprobación de salud
                      app.get('/health', (req, res) => {
                        res.json({ ok: true });
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
                            if (err || !decoded) {
                              return res.status(401).json({ error: 'Token inválido o expirado' });
                            }
                            req.user = decoded;
                            req.user.userId = sanitizeUserId(decoded.userId || decoded.username);
                            next();
                          });
                      }

                      // GET /api/users - Perfiles disponibles para el login
                      app.get('/api/users', (req, res) => {
                        res.json({
                          users: [
                            { id: 'invitado', name: 'Invitado', hasPassword: false, description: 'Acceso directo sin contraseña' },
                            { id: 'efe', name: 'Efe', hasPassword: true, description: 'Requiere contraseña' },
                            { id: 'casa', name: 'Casa', hasPassword: true, description: 'Requiere contraseña' },
                            { id: 'chamba', name: 'Chamba', hasPassword: true, description: 'Requiere contraseña' }
                          ]
                        });
                      });

                      // POST /api/login
                      app.post('/api/login', (req, res) => {
                        const { username, password } = req.body;
                        const userKey = (username || '').toLowerCase().trim();

                        // 1. Perfil Invitado: no requiere contraseña
                        if (userKey === 'invitado') {
                          const token = jwt.sign({ auth: true, userId: 'invitado', username: 'Invitado', role: 'guest' }, APP_SECRET, { expiresIn: '30d' });
                          return res.json({ token, username: 'Invitado', userId: 'invitado' });
                        }

                        // 2. Perfiles con contraseña definida en .env
                        const configUsers = {
                          'efe': { name: 'Efe', pass: process.env.PASSWORD_EFE || 'efe123' },
                          'casa': { name: 'Casa', pass: process.env.PASSWORD_CASA || 'casa123' },
                          'chamba': { name: 'Chamba', pass: process.env.PASSWORD_CHAMBA || 'chamba123' }
                        };

                        if (configUsers[userKey]) {
                          const target = configUsers[userKey];
                          if (!password || password !== target.pass) {
                            return res.status(401).json({ error: `Contraseña incorrecta para el usuario ${target.name}` });
                          }
                          const token = jwt.sign({ auth: true, userId: userKey, username: target.name, role: 'user' }, APP_SECRET, { expiresIn: '30d' });
                          return res.json({ token, username: target.name, userId: userKey });
                        }

                        // 3. Fallback de contraseña maestra general si no se envía usuario
                        if (!userKey && password && password === APP_PASSWORD) {
                          const token = jwt.sign({ auth: true, userId: 'admin', username: 'Usuario', role: 'admin' }, APP_SECRET, { expiresIn: '30d' });
                          return res.json({ token, username: 'Usuario', userId: 'admin' });
                        }

                        return res.status(400).json({ error: 'Por favor selecciona un usuario válido' });
                      });

                      // Proteger todas las rutas /api/* siguientes con el middleware
                      app.use('/api', authMiddleware);

                      // GET /api/me - Validar token actual y devolver datos del usuario
                      app.get('/api/me', (req, res) => {
                        res.json({
                          ok: true,
                          userId: req.user.userId,
                          username: req.user.username || 'Usuario'
                        });
                      });

                      // GET /api/notes-data - Obtener todos los grupos y notas del usuario autenticado
                      app.get('/api/notes-data', (req, res) => {
                        const store = getUserNotesData(req.user.userId);
                        res.json(store);
                      });

                      // POST /api/restore-backup - Restaurar notas completas para el usuario autenticado
                      app.post('/api/restore-backup', (req, res) => {
                        const { data } = req.body;
                        if (!data || !Array.isArray(data.groups) || data.groups.length === 0) {
                          return res.status(400).json({ error: 'Formato de respaldo no válido o vacío' });
                        }
                        const userId = req.user.userId;
                        userStores.set(userId, data);
                        persistUserNotesDebounced(userId);
                        broadcastToUser(userId, { type: 'notes_data_update', data });
                        res.json({ success: true, activeNoteId: data.activeNoteId });
                      });

                      // POST /api/groups - Crear nuevo grupo para el usuario autenticado
                      app.post('/api/groups', (req, res) => {
                        const userId = req.user.userId;
                        const store = getUserNotesData(userId);
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
                        store.groups.push(newGroup);
                        persistUserNotesDebounced(userId);
                        broadcastToUser(userId, { type: 'notes_data_update', data: store });
                        res.json(newGroup);
                      });

                      // PUT /api/groups/:id - Renombrar grupo del usuario autenticado
                      app.put('/api/groups/:id', (req, res) => {
                        const userId = req.user.userId;
                        const store = getUserNotesData(userId);
                        const name = (req.body.name || '').trim();
                        if (!name) {
                          return res.status(400).json({ error: 'El nombre del grupo es obligatorio' });
                        }
                        const group = store.groups.find(g => g.id === req.params.id);
                        if (!group) {
                          return res.status(404).json({ error: 'Grupo no encontrado' });
                        }
                        group.name = name;
                        persistUserNotesDebounced(userId);
                        broadcastToUser(userId, { type: 'notes_data_update', data: store });
                        res.json(group);
                      });

                      // DELETE /api/groups/:id - Eliminar grupo y sus notas para el usuario autenticado
                      app.delete('/api/groups/:id', (req, res) => {
                        const userId = req.user.userId;
                        const store = getUserNotesData(userId);
                        const index = store.groups.findIndex(g => g.id === req.params.id);
                        if (index === -1) {
                          return res.status(404).json({ error: 'Grupo no encontrado' });
                        }
                          if (store.groups.length <= 1) {
                            return res.status(400).json({ error: 'No se puede eliminar el único grupo existente' });
                          }
                          store.groups.splice(index, 1);

                          // Asegurar que activeNoteId siga siendo válido dentro de los datos del usuario
                          const { note } = findUserNoteAndGroup(userId, store.activeNoteId);
                          if (!note) {
                            const firstGroupWithNotes = store.groups.find(g => g.notes.length > 0);
                            if (firstGroupWithNotes) {
                              store.activeNoteId = firstGroupWithNotes.notes[0].id;
                            } else {
                              const fallbackNote = {
                                id: 'note_' + Date.now(),
                                title: 'Nueva Nota',
                                content: '',
                                updatedAt: Date.now()
                              };
                              store.groups[0].notes.push(fallbackNote);
                              store.activeNoteId = fallbackNote.id;
                            }
                          }

                          persistUserNotesDebounced(userId);
                          broadcastToUser(userId, { type: 'notes_data_update', data: store });
                          res.json({ success: true, activeNoteId: store.activeNoteId });
                        });

                      // POST /api/groups/:groupId/notes - Crear nueva nota en un grupo para el usuario autenticado
                      app.post('/api/groups/:groupId/notes', (req, res) => {
                        const userId = req.user.userId;
                        const store = getUserNotesData(userId);
                        const group = store.groups.find(g => g.id === req.params.groupId);
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
                        store.activeNoteId = newNote.id;
                        persistUserNotesDebounced(userId);
                        broadcastToUser(userId, { type: 'notes_data_update', data: store });
                        res.json(newNote);
                      });

                      // PUT /api/notes/:id - Actualizar título o contenido de una nota del usuario autenticado
                      app.put('/api/notes/:id', (req, res) => {
                        const userId = req.user.userId;
                        const { note } = findUserNoteAndGroup(userId, req.params.id);
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
                            persistUserNotesDebounced(userId);
    broadcastToUser(userId, {
                              type: 'note_update',
                              noteId: note.id,
                            content: note.content,
                            title: note.title
                          });
                        }
                        res.json(note);
                      });

                      // DELETE /api/notes/:id - Eliminar una nota del usuario autenticado
                      app.delete('/api/notes/:id', (req, res) => {
                        const userId = req.user.userId;
                        const { group, note, store } = findUserNoteAndGroup(userId, req.params.id);
                        if (!group || !note) {
                          return res.status(404).json({ error: 'Nota no encontrada' });
                        }
                        group.notes = group.notes.filter(n => n.id !== req.params.id);

                          if (store.activeNoteId === req.params.id) {
                            if (group.notes.length > 0) {
                              store.activeNoteId = group.notes[0].id;
                            } else {
                              const otherGroup = store.groups.find(g => g.notes.length > 0);
                              if (otherGroup) {
                                store.activeNoteId = otherGroup.notes[0].id;
                              } else {
                                const fallbackNote = {
                                  id: 'note_' + Date.now(),
                                  title: 'Nueva Nota',
                                  content: '',
                                  updatedAt: Date.now()
                                };
                                group.notes.push(fallbackNote);
                                store.activeNoteId = fallbackNote.id;
                              }
                            }
                          }

                          persistUserNotesDebounced(userId);
                          broadcastToUser(userId, { type: 'notes_data_update', data: store });
                          res.json({ success: true, activeNoteId: store.activeNoteId });
                        });

                      // GET /api/note - Compatibilidad de la nota actual para el usuario autenticado
                      app.get('/api/note', (req, res) => {
                        const userId = req.user.userId;
                        const store = getUserNotesData(userId);
                        const { note } = findUserNoteAndGroup(userId, store.activeNoteId);
                        if (note) {
                          return res.json({ content: note.content, id: note.id, title: note.title });
                        }
                        res.json({ content: '' });
                      });

                      // PUT /api/note - Compatibilidad de guardado para el usuario autenticado
                      app.put('/api/note', (req, res) => {
                        const userId = req.user.userId;
                        const store = getUserNotesData(userId);
                        const { content, noteId } = req.body;
                        const targetId = noteId || store.activeNoteId;
                        const { note } = findUserNoteAndGroup(userId, targetId);
                        const text = typeof content === 'string' ? content : '';
                        if (note) {
                          note.content = text;
                          note.updatedAt = Date.now();
                          persistUserNotesDebounced(userId);
                          broadcastToUser(userId, { type: 'note_update', noteId: note.id, content: text, title: note.title });
                          return res.json({ success: true });
                        }
                        res.status(404).json({ error: 'Nota no encontrada' });
                      });

                      // POST /api/upload - Subir archivos para el usuario autenticado
                      app.post('/api/upload', upload.array('files'), (req, res) => {
                        if (!req.files || req.files.length === 0) {
                          return res.status(400).json({ error: 'No se subieron archivos' });
                        }
                        const uploaded = req.files.map(f => ({
                          name: f.filename,
                          size: f.size
                        }));
                        broadcastToUser(req.user.userId, { type: 'files_update' });
                        res.json({ uploaded });
                      }, (err, req, res, next) => {
                        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
                          return res.status(400).json({ error: 'El archivo supera el límite de 50 MB' });
                        }
                        res.status(500).json({ error: err.message || 'Error en subida de archivo' });
                      });

                      // GET /api/files - Lista de archivos exclusivos del usuario autenticado
                      app.get('/api/files', (req, res) => {
                          const { uploadsDir } = getUserDirs(req.user.userId);
                          fs.readdir(uploadsDir, (err, files) => {
                            if (err) {
                              return res.status(500).json({ error: 'Error al leer el directorio de archivos' });
                            }
                            const fileList = [];
                            for (const file of files) {
                              try {
                                const filePath = path.join(uploadsDir, file);
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

                        // GET /api/files/:name - Descarga o visualización inline de archivo del usuario autenticado
                        app.get('/api/files/:name', (req, res) => {
                          const { uploadsDir } = getUserDirs(req.user.userId);
                          const fileName = path.basename(req.params.name);
                          const filePath = path.join(uploadsDir, fileName);

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

                        // DELETE /api/files/:name - Borrar archivo del usuario autenticado
                        app.delete('/api/files/:name', (req, res) => {
                          const { uploadsDir } = getUserDirs(req.user.userId);
                          const fileName = path.basename(req.params.name);
                          const filePath = path.join(uploadsDir, fileName);

                          if (!fs.existsSync(filePath)) {
                            return res.status(404).json({ error: 'Archivo no encontrado' });
                          }

                          fs.unlink(filePath, (err) => {
                            if (err) {
                              return res.status(500).json({ error: 'No se pudo eliminar el archivo' });
                            }
                            broadcastToUser(req.user.userId, { type: 'files_update' });
                            res.json({ success: true });
                          });
                        });

                        // Manejo de conexiones WebSocket segmentadas por usuario
                        wss.on('connection', (ws, req) => {
                          ws.isAuthenticated = false;
                          ws.userId = null;

                          // Extraer token de url ej: ws://localhost:3000/?token=...
                          try {
                            const parsedUrl = new URL(req.url, 'http://localhost');
                            const token = parsedUrl.searchParams.get('token');
                            if (token) {
                              jwt.verify(token, APP_SECRET, (err, decoded) => {
                                if (!err && decoded) {
                                  ws.isAuthenticated = true;
                                  ws.userId = sanitizeUserId(decoded.userId || decoded.username);
                                }
                              });
                            }
                          } catch (e) { }

                          ws.on('message', (message) => {
                            try {
                              const data = JSON.parse(message);

                              // Autenticación por mensaje si no se pasó en query
                              if (data.type === 'auth') {
                                jwt.verify(data.token, APP_SECRET, (err, decoded) => {
                                  if (!err && decoded) {
                                    ws.isAuthenticated = true;
                                    ws.userId = sanitizeUserId(decoded.userId || decoded.username);
                                    ws.send(JSON.stringify({ type: 'auth_ok' }));
                                  } else {
                                    ws.close();
                                  }
                                });
                                return;
                              }

                              if (!ws.isAuthenticated || !ws.userId) return;

                              // Evento de actualización de nota en tiempo real desde el cliente
                              if (data.type === 'note_input') {
                                const store = getUserNotesData(ws.userId);
                                const targetId = data.noteId || store.activeNoteId;
                                const { note } = findUserNoteAndGroup(ws.userId, targetId);
                                const text = typeof data.content === 'string' ? data.content : '';
                                if (note) {
                                  note.content = text;
                                  note.updatedAt = Date.now();
                                    persistUserNotesDebounced(ws.userId);
                                  // Reenviar únicamente a los demás clientes de este mismo usuario
                                  broadcastToUser(ws.userId, {
                                    type: 'note_update',
                                    noteId: note.id,
                                    content: text,
                                    title: note.title
                                  }, ws);
                                }
                              }
                            } catch (e) { }
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
