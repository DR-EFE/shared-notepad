// Estado global de la aplicación
let token = localStorage.getItem('notepad_token') || null;
let currentTab = 'note';
let socket = null;
let reconnectTimer = null;
let isReceivingRemoteUpdate = false;
let autoSaveTimer = null;
let titleSaveTimer = null;

// Estructura de notas y grupos
let notesStore = {
  groups: [],
  activeNoteId: null
};
let expandedGroups = new Set();
let sidebarCollapsed = false;

// Elementos DOM principales
const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

// Pestañas de navegación
const tabNoteBtn = document.getElementById('tab-note-btn');
const tabPanelBtn = document.getElementById('tab-panel-btn');
const tabFilesBtn = document.getElementById('tab-files-btn');
const sectionNote = document.getElementById('section-note');
const sectionPanel = document.getElementById('section-panel');
const sectionFiles = document.getElementById('section-files');

// Elementos del Editor de Notas
const notesSidebar = document.getElementById('notes-sidebar');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const btnAddGroup = document.getElementById('btn-add-group');
const sidebarSearchInput = document.getElementById('sidebar-search-input');
const groupsListEl = document.getElementById('groups-list');

const activeGroupLabel = document.getElementById('active-group-label');
const activeNoteTitleInput = document.getElementById('active-note-title');
const noteTextarea = document.getElementById('note-textarea');
const charCount = document.getElementById('char-count');
const lineCount = document.getElementById('line-count');
const saveStatus = document.getElementById('save-status');
const btnCopyNote = document.getElementById('btn-copy-note');
const btnDeleteCurrentNote = document.getElementById('btn-delete-current-note');

// Elementos del Panel de Secciones
const panelSearchInput = document.getElementById('panel-search-input');
const btnPanelAddGroup = document.getElementById('btn-panel-add-group');
const panelSectionsGrid = document.getElementById('panel-sections-grid');

// Elementos de Archivos
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadProgressContainer = document.getElementById('upload-progress-container');
const uploadProgressFill = document.getElementById('upload-progress-fill');
const uploadProgressText = document.getElementById('upload-progress-text');
const filesList = document.getElementById('files-list');
const filesBadge = document.getElementById('files-badge');
const refreshFilesBtn = document.getElementById('refresh-files-btn');

// Modal de Grupos
const groupModal = document.getElementById('group-modal');
const modalGroupTitle = document.getElementById('modal-group-title');
const groupForm = document.getElementById('group-form');
const groupNameInput = document.getElementById('group-name-input');
const btnCloseGroupModal = document.getElementById('btn-close-group-modal');
const btnCancelGroupModal = document.getElementById('btn-cancel-group-modal');
let groupModalContext = { mode: 'create', groupId: null };

// Toast
const toastEl = document.getElementById('toast');
let toastTimeout;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 2800);
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
  loadNotesData();
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
          handleRemoteNoteUpdate(data);
        } else if (data.type === 'notes_data_update') {
          notesStore = data.data;
          renderSidebar(sidebarSearchInput.value);
          renderSectionsPanel(panelSearchInput.value);
          // Si la nota activa fue actualizada o eliminada, refrescar vista del editor
          const active = getActiveNote();
          if (active) {
            updateEditorHeader(active);
          } else {
            selectFirstAvailableNote();
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

function handleRemoteNoteUpdate(data) {
  // Actualizar la nota en el store local
  for (const group of notesStore.groups) {
    const n = group.notes.find(item => item.id === data.noteId);
    if (n) {
      if (typeof data.content === 'string') n.content = data.content;
      if (typeof data.title === 'string') n.title = data.title;
      n.updatedAt = Date.now();
      break;
    }
  }

  // Si es la nota actualmente abierta en el editor
  if (notesStore.activeNoteId === data.noteId) {
    if (typeof data.title === 'string' && activeNoteTitleInput.value !== data.title) {
      activeNoteTitleInput.value = data.title;
    }
    if (typeof data.content === 'string' && noteTextarea.value !== data.content) {
      isReceivingRemoteUpdate = true;
      const start = noteTextarea.selectionStart;
      const end = noteTextarea.selectionEnd;
      noteTextarea.value = data.content;
      updateNoteStats();
      try {
        noteTextarea.setSelectionRange(start, end);
      } catch (e) {}
      isReceivingRemoteUpdate = false;
      setSaveStatus('Sincronizado', 'saved');
    }
  }

  // Refrescar vistas visuales
  renderSidebar(sidebarSearchInput.value);
  if (currentTab === 'panel') {
    renderSectionsPanel(panelSearchInput.value);
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

  // Botones
  tabNoteBtn.classList.toggle('active', tab === 'note');
  tabPanelBtn.classList.toggle('active', tab === 'panel');
  tabFilesBtn.classList.toggle('active', tab === 'files');

  // Secciones
  sectionNote.classList.toggle('active', tab === 'note');
  sectionPanel.classList.toggle('active', tab === 'panel');
  sectionFiles.classList.toggle('active', tab === 'files');

  if (tab === 'note') {
    noteTextarea.focus();
  } else if (tab === 'panel') {
    renderSectionsPanel(panelSearchInput.value);
  } else if (tab === 'files') {
    loadFiles();
  }
}

// ============================================================
// GESTIÓN DE NOTAS, GRUPOS Y SIDEBAR
// ============================================================

function findNoteAndGroupByNoteId(noteId) {
  for (const group of notesStore.groups) {
    const note = group.notes.find(n => n.id === noteId);
    if (note) return { group, note };
  }
  return { group: null, note: null };
}

function getActiveNote() {
  const { note } = findNoteAndGroupByNoteId(notesStore.activeNoteId);
  return note;
}

async function loadNotesData() {
  try {
    setSaveStatus('Cargando...', '');
    const res = await apiFetch('/api/notes-data');
    const data = await res.json();
    notesStore = data;

    // Expandir automáticamente los grupos que tengan notas o al menos el primero
    notesStore.groups.forEach((g, index) => {
      if (index === 0 || g.notes.some(n => n.id === notesStore.activeNoteId)) {
        expandedGroups.add(g.id);
      }
    });

    selectNote(notesStore.activeNoteId || (notesStore.groups[0]?.notes[0]?.id));
    renderSidebar();
    setSaveStatus('Listo', 'saved');
  } catch (err) {
    console.error('Error cargando notas:', err);
    setSaveStatus('Error', 'error');
  }
}

function selectNote(noteId) {
  if (!noteId) {
    selectFirstAvailableNote();
    return;
  }

  const { group, note } = findNoteAndGroupByNoteId(noteId);
  if (!note) {
    selectFirstAvailableNote();
    return;
  }

  notesStore.activeNoteId = note.id;
  if (group) {
    expandedGroups.add(group.id);
  }

  // Asignar en editor
  isReceivingRemoteUpdate = true;
  activeNoteTitleInput.value = note.title || 'Nota sin título';
  noteTextarea.value = note.content || '';
  isReceivingRemoteUpdate = false;

  updateEditorHeader({ note, group });
  updateNoteStats();
  renderSidebar(sidebarSearchInput.value);
}

function selectFirstAvailableNote() {
  for (const group of notesStore.groups) {
    if (group.notes.length > 0) {
      selectNote(group.notes[0].id);
      return;
    }
  }
  // Si no hay notas en ningún grupo, limpiar editor
  notesStore.activeNoteId = null;
  activeGroupLabel.textContent = 'Sin grupo';
  activeNoteTitleInput.value = '';
  noteTextarea.value = '';
  updateNoteStats();
  renderSidebar();
}

function updateEditorHeader({ note, group }) {
  if (!group && note) {
    const found = findNoteAndGroupByNoteId(note.id);
    group = found.group;
  }
  activeGroupLabel.textContent = group ? group.name : 'General';
}

function updateNoteStats() {
  const val = noteTextarea.value;
  charCount.textContent = `${val.length} caracteres`;
  const lines = val.length === 0 ? 0 : val.split('\n').length;
  lineCount.textContent = `${lines} líneas`;
}

function setSaveStatus(text, statusClass) {
  saveStatus.textContent = text;
  saveStatus.className = 'status-indicator ' + (statusClass || '');
}

// Guardado del texto en la nota activa con debounce
noteTextarea.addEventListener('input', () => {
  if (isReceivingRemoteUpdate) return;
  const activeNote = getActiveNote();
  if (!activeNote) return;

  activeNote.content = noteTextarea.value;
  activeNote.updatedAt = Date.now();
  updateNoteStats();
  setSaveStatus('Sincronizando...', 'saving');

  // Enviar cambio al instante por WebSocket
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'note_input',
      noteId: activeNote.id,
      content: noteTextarea.value
    }));
  }

  // Guardar en servidor con debounce
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    try {
      await apiFetch(`/api/notes/${activeNote.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteTextarea.value })
      });
      setSaveStatus('Guardado', 'saved');
    } catch (err) {
      setSaveStatus('Error', 'error');
    }
  }, 350);
});

// Guardado del título de la nota con debounce
activeNoteTitleInput.addEventListener('input', () => {
  const activeNote = getActiveNote();
  if (!activeNote) return;

  const newTitle = activeNoteTitleInput.value.trim() || 'Nota sin título';
  activeNote.title = newTitle;
  renderSidebar(sidebarSearchInput.value);

  clearTimeout(titleSaveTimer);
  titleSaveTimer = setTimeout(async () => {
    try {
      await apiFetch(`/api/notes/${activeNote.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle })
      });
      showToast('Título actualizado');
    } catch (e) {}
  }, 400);
});

// Toggle Sidebar
btnToggleSidebar.addEventListener('click', () => {
  sidebarCollapsed = !sidebarCollapsed;
  notesSidebar.classList.toggle('collapsed', sidebarCollapsed);
});

// Copiar contenido de la nota
btnCopyNote.addEventListener('click', () => {
  if (!noteTextarea.value) {
    showToast('La nota está vacía');
    return;
  }
  navigator.clipboard.writeText(noteTextarea.value).then(() => {
    showToast('Contenido copiado al portapapeles');
  }).catch(() => {
    showToast('No se pudo copiar');
  });
});

// Eliminar nota actual desde la barra del editor
btnDeleteCurrentNote.addEventListener('click', () => {
  const active = getActiveNote();
  if (!active) return;
  deleteNoteConfirm(active.id, active.title);
});

// Función para eliminar nota con confirmación
async function deleteNoteConfirm(noteId, title) {
  if (confirm(`¿Eliminar la página "${title || 'esta nota'}"?`)) {
    try {
      const res = await apiFetch(`/api/notes/${noteId}`, { method: 'DELETE' });
      const data = await res.json();
      showToast('Página eliminada');
      if (data.activeNoteId) {
        selectNote(data.activeNoteId);
      } else {
        selectFirstAvailableNote();
      }
    } catch (err) {
      showToast('Error al eliminar nota');
    }
  }
}

// Búsqueda en Sidebar
sidebarSearchInput.addEventListener('input', (e) => {
  renderSidebar(e.target.value.trim().toLowerCase());
});

// Renderizado del Sidebar
function renderSidebar(filterQuery = '') {
  groupsListEl.innerHTML = '';

  if (!notesStore.groups || notesStore.groups.length === 0) {
    groupsListEl.innerHTML = `
      <div style="padding: 1.5rem; text-align: center; color: var(--text-dim); font-size: 0.85rem;">
        No hay grupos de notas. Haz clic en el botón '+' para crear uno.
      </div>`;
    return;
  }

  notesStore.groups.forEach(group => {
    const isExpanded = expandedGroups.has(group.id) || !!filterQuery;
    
    // Filtrado si hay búsqueda
    let visibleNotes = group.notes;
    if (filterQuery) {
      const groupMatches = group.name.toLowerCase().includes(filterQuery);
      if (!groupMatches) {
        visibleNotes = group.notes.filter(n => 
          n.title.toLowerCase().includes(filterQuery) || 
          (n.content && n.content.toLowerCase().includes(filterQuery))
        );
        if (visibleNotes.length === 0) return; // ocultar grupo entero si nada coincide
      }
    }

    const groupEl = document.createElement('div');
    groupEl.className = `group-item ${isExpanded ? 'open' : ''}`;
    groupEl.dataset.groupId = group.id;

    // Cabecera del grupo
    const groupHeader = document.createElement('div');
    groupHeader.className = 'group-header';
    groupHeader.innerHTML = `
      <div class="group-header-left">
        <span class="group-chevron">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </span>
        <svg class="group-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        <span class="group-name" title="${group.name}">${group.name}</span>
        <span class="group-badge">${group.notes.length}</span>
      </div>
      <div class="group-header-actions" onclick="event.stopPropagation()">
        <button class="btn-icon-subtle btn-add-note-inline" title="Añadir nueva página a este grupo">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </button>
        <button class="btn-icon-subtle btn-rename-group" title="Renombrar grupo">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
        </button>
        <button class="btn-icon-subtle btn-delete-danger btn-delete-group" title="Eliminar grupo">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    `;

    // Click para alternar acordeón
    groupHeader.addEventListener('click', () => {
      if (expandedGroups.has(group.id)) {
        expandedGroups.delete(group.id);
      } else {
        expandedGroups.add(group.id);
      }
      groupEl.classList.toggle('open', expandedGroups.has(group.id));
    });

    // Botón añadir nota al grupo
    groupHeader.querySelector('.btn-add-note-inline').addEventListener('click', () => {
      createNewNoteInGroup(group.id);
    });

    // Botón renombrar grupo
    groupHeader.querySelector('.btn-rename-group').addEventListener('click', () => {
      openGroupModal('rename', group.id, group.name);
    });

    // Botón eliminar grupo
    groupHeader.querySelector('.btn-delete-group').addEventListener('click', () => {
      deleteGroupConfirm(group.id, group.name);
    });

    groupEl.appendChild(groupHeader);

    // Sublista de notas
    const notesSublist = document.createElement('div');
    notesSublist.className = 'notes-sublist';

    if (visibleNotes.length === 0) {
      const emptyNoteEl = document.createElement('div');
      emptyNoteEl.style.cssText = 'padding: 0.3rem 0.5rem; font-size: 0.78rem; color: var(--text-dim); font-style: italic;';
      emptyNoteEl.textContent = 'Sin páginas de notas';
      notesSublist.appendChild(emptyNoteEl);
    } else {
      visibleNotes.forEach(note => {
        const isNoteActive = note.id === notesStore.activeNoteId;
        const noteEl = document.createElement('div');
        noteEl.className = `note-item ${isNoteActive ? 'active' : ''}`;
        noteEl.innerHTML = `
          <div class="note-item-left">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
            <span class="note-item-title" title="${note.title}">${note.title}</span>
          </div>
          <div class="note-item-actions" onclick="event.stopPropagation()">
            <button class="btn-icon-subtle btn-delete-danger btn-delete-note-item" title="Eliminar página">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        `;

        noteEl.addEventListener('click', () => {
          selectNote(note.id);
        });

        noteEl.querySelector('.btn-delete-note-item').addEventListener('click', () => {
          deleteNoteConfirm(note.id, note.title);
        });

        notesSublist.appendChild(noteEl);
      });
    }

    groupEl.appendChild(notesSublist);
    groupsListEl.appendChild(groupEl);
  });
}

// Crear nueva nota en un grupo
async function createNewNoteInGroup(groupId) {
  try {
    const res = await apiFetch(`/api/groups/${groupId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Nueva Página',
        content: ''
      })
    });
    const newNote = await res.json();
    expandedGroups.add(groupId);
    selectNote(newNote.id);
    activeNoteTitleInput.focus();
    activeNoteTitleInput.select();
    showToast('Nueva página de nota creada');
  } catch (err) {
    showToast('Error al crear nota');
  }
}

// Eliminar grupo con confirmación
async function deleteGroupConfirm(groupId, groupName) {
  if (notesStore.groups.length <= 1) {
    showToast('Debes mantener al menos un grupo de notas');
    return;
  }
  if (confirm(`¿Eliminar el grupo "${groupName}" y todas sus páginas de notas?`)) {
    try {
      const res = await apiFetch(`/api/groups/${groupId}`, { method: 'DELETE' });
      const data = await res.json();
      showToast('Grupo eliminado');
      if (data.activeNoteId) {
        selectNote(data.activeNoteId);
      } else {
        selectFirstAvailableNote();
      }
    } catch (err) {
      showToast('Error al eliminar grupo');
    }
  }
}

// ============================================================
// PANEL DE SECCIONES (VISTA DE TODAS LAS NOTAS POR GRUPOS)
// ============================================================

panelSearchInput.addEventListener('input', (e) => {
  renderSectionsPanel(e.target.value.trim().toLowerCase());
});

btnPanelAddGroup.addEventListener('click', () => {
  openGroupModal('create');
});

btnAddGroup.addEventListener('click', () => {
  openGroupModal('create');
});

function renderSectionsPanel(filterQuery = '') {
  panelSectionsGrid.innerHTML = '';

  if (!notesStore.groups || notesStore.groups.length === 0) {
    panelSectionsGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 4rem; color: var(--text-dim);">
        <h3>No hay grupos creados</h3>
        <p style="margin-top: 0.5rem;">Crea un grupo para organizar tus páginas de notas por secciones.</p>
      </div>`;
    return;
  }

  notesStore.groups.forEach(group => {
    let visibleNotes = group.notes;
    if (filterQuery) {
      const groupMatches = group.name.toLowerCase().includes(filterQuery);
      if (!groupMatches) {
        visibleNotes = group.notes.filter(n => 
          n.title.toLowerCase().includes(filterQuery) || 
          (n.content && n.content.toLowerCase().includes(filterQuery))
        );
        if (visibleNotes.length === 0) return;
      }
    }

    const sectionCard = document.createElement('div');
    sectionCard.className = 'section-group-card';

    // Header de la sección
    const header = document.createElement('div');
    header.className = 'section-group-header';
    header.innerHTML = `
      <div class="section-group-title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        <span>${group.name}</span>
        <span class="group-badge">${group.notes.length}</span>
      </div>
      <div class="section-group-actions">
        <button class="btn-icon-subtle btn-add-note-section" title="Añadir nota a ${group.name}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </button>
        <button class="btn-icon-subtle btn-rename-section" title="Renombrar grupo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
        </button>
        <button class="btn-icon-subtle btn-delete-danger btn-delete-section" title="Eliminar grupo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    `;

    header.querySelector('.btn-add-note-section').addEventListener('click', () => {
      createNewNoteInGroup(group.id);
      switchTab('note');
    });

    header.querySelector('.btn-rename-section').addEventListener('click', () => {
      openGroupModal('rename', group.id, group.name);
    });

    header.querySelector('.btn-delete-section').addEventListener('click', () => {
      deleteGroupConfirm(group.id, group.name);
    });

    sectionCard.appendChild(header);

    // Contenedor de notas de la sección
    const notesList = document.createElement('div');
    notesList.className = 'section-notes-list';

    if (visibleNotes.length === 0) {
      notesList.innerHTML = `
        <div class="empty-section-notes">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
          <span>No hay notas en este grupo</span>
          <button class="btn-secondary btn-sm-add" style="margin-top: 0.4rem; font-size: 0.78rem;">+ Añadir primera página</button>
        </div>`;
      notesList.querySelector('.btn-sm-add').addEventListener('click', () => {
        createNewNoteInGroup(group.id);
        switchTab('note');
      });
    } else {
      visibleNotes.forEach(note => {
        const noteCard = document.createElement('div');
        noteCard.className = 'panel-note-card';
        const dateStr = note.updatedAt ? new Date(note.updatedAt).toLocaleString() : 'Reciente';
        const previewText = note.content ? note.content.slice(0, 180) : '(Nota vacía)';

        noteCard.innerHTML = `
          <div class="panel-note-header">
            <span class="panel-note-title" title="${note.title}">${note.title}</span>
            <button class="btn-icon-subtle btn-delete-danger btn-delete-panel-note" title="Eliminar nota" onclick="event.stopPropagation()">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
          <div class="panel-note-preview">${escapeHtml(previewText)}</div>
          <div class="panel-note-footer">
            <span class="panel-note-date">${dateStr}</span>
            <span style="font-size: 0.75rem; color: var(--accent); font-weight: 500;">Abrir →</span>
          </div>
        `;

        noteCard.addEventListener('click', () => {
          selectNote(note.id);
          switchTab('note');
        });

        noteCard.querySelector('.btn-delete-panel-note').addEventListener('click', () => {
          deleteNoteConfirm(note.id, note.title);
        });

        notesList.appendChild(noteCard);
      });
    }

    sectionCard.appendChild(notesList);
    panelSectionsGrid.appendChild(sectionCard);
  });
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// ============================================================
// MODAL DE CREAR / RENOMBRAR GRUPO
// ============================================================

function openGroupModal(mode = 'create', groupId = null, currentName = '') {
  groupModalContext = { mode, groupId };
  modalGroupTitle.textContent = mode === 'create' ? 'Nuevo Grupo de Notas' : 'Renombrar Grupo de Notas';
  groupNameInput.value = currentName || '';
  groupModal.classList.remove('hidden');
  setTimeout(() => groupNameInput.focus(), 100);
}

function closeGroupModal() {
  groupModal.classList.add('hidden');
  groupNameInput.value = '';
}

btnCloseGroupModal.addEventListener('click', closeGroupModal);
btnCancelGroupModal.addEventListener('click', closeGroupModal);

groupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = groupNameInput.value.trim();
  if (!name) return;

  try {
    if (groupModalContext.mode === 'create') {
      const res = await apiFetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const newGroup = await res.json();
      expandedGroups.add(newGroup.id);
      showToast(`Grupo "${name}" creado`);
    } else {
      await apiFetch(`/api/groups/${groupModalContext.groupId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      showToast(`Grupo renombrado a "${name}"`);
    }
    closeGroupModal();
  } catch (err) {
    showToast('Error al guardar grupo');
  }
});

// Cerrar modal al hacer clic en fondo
groupModal.addEventListener('click', (e) => {
  if (e.target === groupModal) {
    closeGroupModal();
  }
});

// ============================================================
// SECCIÓN DE ARCHIVOS (CON DESCARGA IMPLEMENTADA)
// ============================================================

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
  showToast('Lista de archivos actualizada');
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
    filesList.innerHTML = `<div class="empty-files-msg">No hay archivos subidos aún. Arrastra archivos arriba para compartirlos.</div>`;
    return;
  }

  files.forEach(file => {
    const isImg = isImageFile(file.name);
    // URL normal (para ver o incrustar)
    const fileUrl = `${window.location.origin}/api/files/${encodeURIComponent(file.name)}?token=${encodeURIComponent(token)}`;
    // URL forzada a descarga mediante parámetro download=1
    const fileDownloadUrl = `${window.location.origin}/api/files/${encodeURIComponent(file.name)}?token=${encodeURIComponent(token)}&download=1`;
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
          <svg class="file-placeholder-icon" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
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
          <button class="file-btn btn-copy" data-url="${fileUrl}" title="Copiar enlace directo">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            Enlace
          </button>
          <a class="file-btn" href="${fileUrl}" target="_blank" rel="noopener noreferrer" title="Abrir en pestaña nueva">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            Abrir
          </a>
          <a class="file-btn btn-download" href="${fileDownloadUrl}" download="${file.name}" title="Descargar archivo directamente">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            Descargar
          </a>
          <button class="file-btn btn-delete" data-filename="${file.name}" title="Eliminar archivo">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Borrar
          </button>
        </div>
      </div>
    `;

    // Botón Copiar enlace
    card.querySelector('.btn-copy').addEventListener('click', (e) => {
      const url = e.currentTarget.getAttribute('data-url');
      navigator.clipboard.writeText(url).then(() => {
        showToast('Enlace copiado al portapapeles');
      }).catch(() => {
        showToast('No se pudo copiar');
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
  fileInput.value = '';
});

// Arrancar comprobación de auth al cargar DOM
window.addEventListener('DOMContentLoaded', initApp);
