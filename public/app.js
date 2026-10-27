// Estado global
let token = localStorage.getItem('notepad_token') || null;
let currentTab = 'note';
let noteChanged = false;
let autoSaveTimer = null;
let lastSavedContent = '';
let socket = null;
let isReceivingRemoteUpdate = false;
let reconnectTimer = null;

// Elementos DOM
const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

const tabNoteBtn = document.getElementById('tab-note-btn');
const tabFilesBtn = document.getElementById('tab-files-btn');
const sectionNote = document.getElementById('section-note');
const sectionFiles = document.getElementById('section-files');

const noteTextarea = document.getElementById('note-textarea');
const saveStatus = document.getElementById('save-status');
const charCount = document.getElementById('char-count');
const lineCount = document.getElementById('line-count');

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadProgressContainer = document.getElementById('upload-progress-container');
const uploadProgressFill = document.getElementById('upload-progress-fill');
const uploadProgressText = document.getElementById('upload-progress-text');
const filesList = document.getElementById('files-list');
const filesBadge = document.getElementById('files-badge');
const refreshFilesBtn = document.getElementById('refresh-files-btn');
const toastEl = document.getElementById('toast');

// Utilidad Toast
let toastTimeout;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 3000);
}

// Helpers de Peticiones con Auth
async function apiFetch(endpoint, options = {}) {
  const headers = options.headers || {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  options.headers = headers;

  const res = await fetch(endpoint, options);
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error('Sesión no autorizada o expirada');
  }
  return res;
}

function handleUnauthorized() {
  token = null;
  localStorage.removeItem('notepad_token');
  if (socket) {
    socket.close();
    socket = null;
  }
  appScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  passwordInput.value = '';
  loginError.textContent = 'Tu sesión ha expirado o no es válida.';
}

// Inicialización de la App
async function initApp() {
  if (!token) {
    showLogin();
    return;
  }

  try {
    const res = await fetch('/api/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      showApp();
    } else {
      handleUnauthorized();
    }
  } catch (e) {
    handleUnauthorized();
  }
}

function showLogin() {
  loginScreen.classList.remove('hidden');
  appScreen.classList.add('hidden');
  passwordInput.focus();
}

function showApp() {
  loginScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  loadNote();
  loadFiles();
  connectWebSocket();
}

// Conexión WebSocket para sincronización en tiempo real
function connectWebSocket() {
  if (!token) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/?token=${encodeURIComponent(token)}`;

  try {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      setSaveStatus('En línea', 'saved');
      socket.send(JSON.stringify({ type: 'auth', token }));
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'note_update') {
          // Si el texto es distinto, actualizar respetando cursor si es posible
          if (data.content !== noteTextarea.value) {
            isReceivingRemoteUpdate = true;
            const start = noteTextarea.selectionStart;
            const end = noteTextarea.selectionEnd;
            noteTextarea.value = data.content;
            lastSavedContent = data.content;
            noteChanged = false;
            updateNoteStats();
            // Restaurar cursor
            try {
              noteTextarea.setSelectionRange(start, end);
            } catch (e) {}
            isReceivingRemoteUpdate = false;
            setSaveStatus('Sincronizado', 'saved');
          }
        } else if (data.type === 'files_update') {
          loadFiles();
        }
      } catch (err) {}
    };

    socket.onclose = () => {
      socket = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (token) connectWebSocket();
      }, 3000);
    };

    socket.onerror = () => {
      if (socket) socket.close();
    };
  } catch (err) {
    console.error('Error al conectar WebSocket:', err);
  }
}

// Login
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const password = passwordInput.value;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (res.ok && data.token) {
      token = data.token;
      localStorage.setItem('notepad_token', token);
      showApp();
    } else {
      loginError.textContent = data.error || 'Contraseña incorrecta';
    }
  } catch (err) {
    loginError.textContent = 'Error de conexión con el servidor';
  }
});

// Logout
logoutBtn.addEventListener('click', () => {
  handleUnauthorized();
  loginError.textContent = '';
});

// Gestión de Pestañas
function switchTab(tab) {
  currentTab = tab;
  if (tab === 'note') {
    tabNoteBtn.classList.add('active');
    tabFilesBtn.classList.remove('active');
    sectionNote.classList.add('active');
    sectionFiles.classList.remove('active');
    noteTextarea.focus();
  } else {
    tabFilesBtn.classList.add('active');
    tabNoteBtn.classList.remove('active');
    sectionFiles.classList.add('active');
    sectionNote.classList.remove('active');
    loadFiles();
  }
}

// --- NOTAS ---
async function loadNote() {
  try {
    setSaveStatus('Cargando...', '');
    const res = await apiFetch('/api/note');
    const data = await res.json();
    noteTextarea.value = data.content || '';
    lastSavedContent = noteTextarea.value;
    noteChanged = false;
    updateNoteStats();
    setSaveStatus('Guardado', 'saved');
  } catch (e) {
    setSaveStatus('Error', 'error');
  }
}

async function saveNote() {
  const content = noteTextarea.value;
  if (!noteChanged && content === lastSavedContent) return;

  try {
    setSaveStatus('Guardando...', 'saving');
    const res = await apiFetch('/api/note', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (res.ok) {
      lastSavedContent = content;
      noteChanged = false;
      setSaveStatus('Guardado', 'saved');
    } else {
      setSaveStatus('Error', 'error');
    }
  } catch (e) {
    setSaveStatus('Error', 'error');
  }
}

function setSaveStatus(text, statusClass) {
  saveStatus.textContent = text;
  saveStatus.className = 'status-indicator ' + (statusClass || '');
}

function updateNoteStats() {
  const val = noteTextarea.value;
  charCount.textContent = `${val.length} caracteres`;
  const lines = val.length === 0 ? 0 : val.split('\n').length;
  lineCount.textContent = `${lines} líneas`;
}

// En cada tecleo: transmitir por WebSocket de inmediato y guardar con debounce
noteTextarea.addEventListener('input', () => {
  if (isReceivingRemoteUpdate) return;
  noteChanged = true;
  updateNoteStats();
  setSaveStatus('Sincronizando...', 'saving');

  // Enviar cambio al instante por WebSocket a todos los usuarios
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'note_input',
      content: noteTextarea.value
    }));
  }

  // Guardar en disco persistente (debounce de 400ms para no saturar I/O)
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    saveNote();
  }, 400);
});

// --- ARCHIVOS ---
async function loadFiles() {
  try {
    const res = await apiFetch('/api/files');
    const data = await res.json();
    renderFileList(data.files || []);
  } catch (e) {
    console.error('Error cargando archivos:', e);
  }
}

refreshFilesBtn.addEventListener('click', () => {
  loadFiles();
  showToast('Lista actualizada');
});

function formatBytes(bytes, decimals = 1) {
  if (!+bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function isImageFile(fileName) {
  return /\.(jpe?g|png|gif|webp|svg|bmp|ico)$/i.test(fileName);
}

function renderFileList(files) {
  filesBadge.textContent = files.length;
  filesList.innerHTML = '';

  if (files.length === 0) {
    filesList.innerHTML = `<div class="empty-files-msg">No hay archivos subidos aún. Arrastra alguno aquí arriba.</div>`;
    return;
  }

  files.forEach(file => {
    const isImg = isImageFile(file.name);
    const fileUrl = `${window.location.origin}/api/files/${encodeURIComponent(file.name)}?token=${encodeURIComponent(token)}`;
    const dateStr = new Date(file.mtime).toLocaleString();

    const card = document.createElement('div');
    card.className = 'file-card';

    let previewHtml = '';
    if (isImg) {
      previewHtml = `
        <div class="file-preview">
          <img src="${fileUrl}" alt="${file.name}" loading="lazy">
        </div>`;
    } else {
      previewHtml = `
        <div class="file-preview">
          <svg class="file-placeholder-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
        </div>`;
    }

    card.innerHTML = `
      ${previewHtml}
      <div class="file-info">
        <div class="file-name" title="${file.name}">${file.name}</div>
        <div class="file-meta">
          <span>${formatBytes(file.size)}</span>
          <span>${dateStr}</span>
        </div>
        <div class="file-actions">
          <button class="file-btn btn-copy" data-url="${fileUrl}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            Copiar enlace
          </button>
          <a class="file-btn" href="${fileUrl}" target="_blank" rel="noopener noreferrer">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            Abrir
          </a>
          <button class="file-btn btn-delete" data-filename="${file.name}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Borrar
          </button>
        </div>
      </div>
    `;

    // Botón Copiar enlace
    card.querySelector('.btn-copy').addEventListener('click', (e) => {
      const url = e.currentTarget.getAttribute('data-url');
      navigator.clipboard.writeText(url).then(() => {
        showToast('Enlace con token copiado al portapapeles');
      }).catch(() => {
        showToast('No se pudo copiar automáticamente');
      });
    });

    // Botón Borrar
    card.querySelector('.btn-delete').addEventListener('click', async (e) => {
      const fileName = e.currentTarget.getAttribute('data-filename');
      if (confirm(`¿Eliminar ${fileName}?`)) {
        try {
          const res = await apiFetch(`/api/files/${encodeURIComponent(fileName)}`, {
            method: 'DELETE'
          });
          if (res.ok) {
            showToast('Archivo eliminado');
            loadFiles();
          } else {
            showToast('Error al eliminar archivo');
          }
        } catch (err) {
          showToast('Error al procesar eliminación');
        }
      }
    });

    filesList.appendChild(card);
  });
}

// Subida de Archivos
async function uploadFiles(files) {
  if (!files || files.length === 0) return;

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i]);
  }

  uploadProgressContainer.classList.remove('hidden');
  uploadProgressFill.style.width = '0%';
  uploadProgressText.textContent = `Subiendo ${files.length} archivo(s)...`;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percent = Math.round((e.loaded / e.total) * 100);
      uploadProgressFill.style.width = percent + '%';
      uploadProgressText.textContent = `Subiendo... ${percent}%`;
    }
  };

  xhr.onload = () => {
    uploadProgressContainer.classList.add('hidden');
    if (xhr.status === 200) {
      showToast('Archivos subidos con éxito');
      loadFiles();
    } else if (xhr.status === 401) {
      handleUnauthorized();
    } else {
      let errMsg = 'Error al subir archivo';
      try {
        const resp = JSON.parse(xhr.responseText);
        if (resp.error) errMsg = resp.error;
      } catch (e) {}
      showToast(errMsg);
    }
  };

  xhr.onerror = () => {
    uploadProgressContainer.classList.add('hidden');
    showToast('Error de conexión durante la subida');
  };

  xhr.send(formData);
}

// Eventos Dropzone
['dragenter', 'dragover'].forEach(eventName => {
  dropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(eventName => {
  dropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('dragover');
  });
});

dropzone.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  const files = dt.files;
  uploadFiles(files);
});

fileInput.addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  fileInput.value = ''; // Reset para permitir volver a seleccionar el mismo archivo
});

// Arrancar comprobación de auth
window.addEventListener('DOMContentLoaded', initApp);
