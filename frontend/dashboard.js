// dashboard.js — Dashboard Institutionnel Centre de Téléchirurgie
// Version API Prisma/PostgreSQL + Socket.IO Temps Réel ROBUSTE

// ---------------------------------------------------------------------------
// SYSTÈME DE ROBUSTESSE CLIENT-SIDE
// ---------------------------------------------------------------------------

const EventDeduplicator = {
    processedEvents: new Set(),
    maxSize: 1000,

    isDuplicate(eventId) {
        if (!eventId) return false;
        if (this.processedEvents.has(eventId)) return true;

        this.processedEvents.add(eventId);

        // Limiter la taille
        if (this.processedEvents.size > this.maxSize) {
            const toDelete = this.maxSize * 0.2;
            const iter = this.processedEvents.values();
            for (let i = 0; i < toDelete; i++) {
                const val = iter.next().value;
                if (val) this.processedEvents.delete(val);
            }
        }
        return false;
    },

    clear() {
        this.processedEvents.clear();
    }
};

const NotificationQueue = {
    queue: [],
    maxVisible: 5,
    maxQueueSize: 20,

    add(msg, type = 'info') {
        if (this.queue.length >= this.maxQueueSize) {
            this.queue.shift();
        }
        this.queue.push({ msg, type, id: Date.now() + Math.random() });
        this.process();
    },

    process() {
        // Simple console log for dashboard (pas d'UI toast complexe ici)
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            console.log(`[NOTIFICATION ${item.type}] ${item.msg}`);
        }
    }
};

// ---------------------------------------------------------------------------
// Détection automatique du backend
// ---------------------------------------------------------------------------
if (typeof BACKEND_HOST === 'undefined') {
  function getBackendHost() {
    const stored = localStorage.getItem('medibot_backend_host');
    if (stored) return stored;
    return window.location.hostname === 'localhost' ? 'localhost:3000' : '10.117.147.182:3000';
  }
  const BACKEND_HOST = getBackendHost();
}
const API_URL = `http://${BACKEND_HOST}/api`;
const WS_URL  = `http://${BACKEND_HOST}`;

// ---------------------------------------------------------------------------
// État global
// ---------------------------------------------------------------------------
let socket = null;
let currentUser = null;
let currentSection = 'patients';
let patientsData = [];
let filteredPatients = [];
let historyData = [];
let logsData = [];
let lastDataVersion = 0;

// État système (source unique de vérité)
let arduinoConnected = false;
let arduinoSimulation = false;  // ← Mode simulation actif
let assistantReady = false;
let assistantOnline = false;
let patientConsent = false;
let patientConsentPatientId = null;
let activeOperationPatientId = null;

// ---------------------------------------------------------------------------
// Initialisation au chargement du DOM
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  const auth = checkAuth();
  if (!auth) return;

  // Restaurer l'état depuis localStorage (anti‑refresh)
  arduinoConnected = localStorage.getItem('arduino_connected') === 'true';
  arduinoSimulation = localStorage.getItem('arduino_simulation') === 'true';
  assistantReady   = localStorage.getItem('assistant_ready') === 'true';
  patientConsent   = localStorage.getItem('patient_consent') === 'true';

  initSocket();
  await loadPatients();
  await loadHistory();
  renderHistory();
  renderLogs();
  updateMonitoringUI();

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.onclick = logoutWithConfirm;
});

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------
function checkAuth() {
  const token = sessionStorage.getItem('token');
  const user  = sessionStorage.getItem('user');

  if (!token || !user) {
    window.location.href = 'login.html';
    return null;
  }

  const userData = JSON.parse(user);
  if (userData.role !== 'chirurgien') {
    alert('Accès réservé aux chirurgiens. Redirection vers l\'interface assistant.');
    window.location.href = 'assistant.html';
    return null;
  }

  currentUser = userData;
  const nameEl = document.querySelector('.user-name');
  if (nameEl) nameEl.textContent = `Dr. ${userData.nom}`;

  return { token, user: userData };
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
function initSocket() {
  const token = sessionStorage.getItem('token');
  if (!token) return;

  socket = io(WS_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 15,
    reconnectionDelay: 1000
  });

  socket.on('connect', () => {
    socket.emit('surgeon:online', { userId: currentUser?.id });
    updateSocketStatusUI('connected');

    // Demander sync après connexion/reconnexion
    socket.emit('sync:request', {
      lastVersion: lastDataVersion,
      timestamp: Date.now()
    });
  });

  socket.on('reconnect', (attempt) => {
    console.log(`[DASHBOARD] Reconnecté après ${attempt} tentatives`);
    updateSocketStatusUI('connected');
    NotificationQueue.add('Reconnecté au serveur', 'success');
  });

  socket.on('reconnecting', (attempt) => {
    console.log(`[DASHBOARD] Tentative de reconnexion ${attempt}`);
    updateSocketStatusUI('reconnecting');
  });

  socket.on('reconnect_error', () => {
    updateSocketStatusUI('disconnected');
  });

  socket.on('disconnect', () => {
    console.log('[DASHBOARD] Déconnecté');
    updateSocketStatusUI('disconnected');
    NotificationQueue.add('Déconnecté du serveur', 'warning');
  });

  socket.on('assistant:online', () => {
    assistantOnline = true;
    updateMonitoringUI();
  });

  socket.on('assistant:offline', () => {
    assistantOnline = false;
    assistantReady = false;
    localStorage.setItem('assistant_ready', 'false');
    updateMonitoringUI();
  });

  socket.on('assistant:status', (data) => {
    assistantOnline = data.online;
    assistantReady  = data.ready;
    patientConsent = !!data.patientConsent;
    patientConsentPatientId = data.patientConsentPatientId || null;
    localStorage.setItem('assistant_ready', assistantReady);
    localStorage.setItem('patient_consent', patientConsent);
    updateMonitoringUI();
  });

  socket.on('arduino:status', (data) => {
    arduinoConnected = data.connected;
    arduinoSimulation = data.simulationMode || false;
    localStorage.setItem('arduino_connected', arduinoConnected);
    localStorage.setItem('arduino_simulation', arduinoSimulation);
    updateMonitoringUI();
  });

  // Handler pour le mode simulation (avertissement)
  socket.on('arduino:simulation-mode', (data) => {
    if (data.active) {
      arduinoSimulation = true;
      localStorage.setItem('arduino_simulation', 'true');
      NotificationQueue.add(`⚠️ Mode simulation: ${data.reason}`, 'warning');
      updateMonitoringUI();
    }
  });

  socket.on('assistant:ready', (data) => {
    assistantReady = true;
    patientConsent = false;
    patientConsentPatientId = null;
    localStorage.setItem('assistant_ready', 'true');
    if (data?.patientId) updatePatientRowInDOM(data.patientId, 'Prêt');
    updateMonitoringUI();
  });

  socket.on('assistant:unready', (data) => {
    assistantReady = false;
    patientConsent = false;
    patientConsentPatientId = null;
    localStorage.setItem('assistant_ready', 'false');
    localStorage.setItem('patient_consent', 'false');
    if (data?.patientId) updatePatientRowInDOM(data.patientId, 'En attente');
    updateMonitoringUI();
  });

  socket.on('assistant:consent', (data) => {
    patientConsent = true;
    patientConsentPatientId = data?.patientId || null;
    localStorage.setItem('patient_consent', 'true');
    updateMonitoringUI();
  });

  socket.on('assistant:consent-revoked', () => {
    patientConsent = false;
    patientConsentPatientId = null;
    localStorage.setItem('patient_consent', 'false');
    updateMonitoringUI();
  });

  // Patient créé en temps réel avec déduplication
  socket.on('patient:created', (data) => {
    if (EventDeduplicator.isDuplicate(data._eventId)) return;

    console.log('[DASHBOARD] Patient created via realtime:', data.patient.patientId);

    // Mettre à jour le tableau sans recharger entièrement
    addPatientToTable(data.patient);

    // Mettre à jour la version des données
    if (data.dataVersion) {
      lastDataVersion = data.dataVersion;
      sessionStorage.setItem('dataVersion', lastDataVersion);
    }
  });

  socket.on('patients:updated', async () => {
    await loadPatients();
    await loadHistory();
  });

  socket.on('operation:ended', async () => {
    await loadPatients();
    await loadHistory();
  });

  // Système de sync post-reconnexion
  socket.on('sync:full', (data) => {
    console.log('[DASHBOARD] Full sync received');

    if (data.dataVersion) {
      lastDataVersion = data.dataVersion;
      sessionStorage.setItem('dataVersion', lastDataVersion);
    }

    if (data.patients) {
      patientsData = data.patients;
      filteredPatients = [...patientsData];
      renderPatients();
    }

    NotificationQueue.add('Données synchronisées', 'success');
  });

  socket.on('sync:ok', (data) => {
    if (data.dataVersion) {
      lastDataVersion = data.dataVersion;
      sessionStorage.setItem('dataVersion', lastDataVersion);
    }
  });

  // Gestion des erreurs serveur
  socket.on('system:error', (error) => {
    console.error('[DASHBOARD] Server error:', error);
    NotificationQueue.add(`Erreur: ${error.message || error.code}`, 'error');
  });

  socket.on('patient:error', (error) => {
    console.error('[DASHBOARD] Patient error:', error);
    NotificationQueue.add(`Patient error: ${error.message}`, 'error');
  });

  socket.on('system:status', (data) => {
    if (data.arduino !== undefined) {
      arduinoConnected = data.arduino.connected ?? data.arduino;
      arduinoSimulation = data.arduino.simulationMode || false;
      localStorage.setItem('arduino_connected', arduinoConnected);
      localStorage.setItem('arduino_simulation', arduinoSimulation);
    }
    if (data.assistants) {
      assistantReady = data.assistants.ready > 0;
      localStorage.setItem('assistant_ready', assistantReady);
    }
    if (data.assistant) {
      patientConsent = !!data.assistant.patientConsent;
      patientConsentPatientId = data.assistant.patientConsentPatientId || null;
      localStorage.setItem('patient_consent', patientConsent);
    }
    updateMonitoringUI();
  });
}

/**
 * Ajoute un patient au tableau sans recharger la page
 */
function addPatientToTable(patient) {
  // Vérifier si le patient existe déjà
  const existingIndex = patientsData.findIndex(p =>
    p.patientId === patient.patientId || p.id === patient.id
  );

  if (existingIndex >= 0) {
    // Mettre à jour le patient existant
    patientsData[existingIndex] = { ...patientsData[existingIndex], ...patient };
    updatePatientRowInDOM(patient.patientId || patient.id, patient.statut || 'En attente');
    return;
  }

  // Nouveau patient - l'ajouter au début du tableau
  const newPatient = {
    id: patient.id,
    patientId: patient.patientId,
    nom: patient.nom,
    prenom: patient.prenom,
    pathologie: patient.pathologie,
    statut: patient.statut || 'en_attente',
    createdAt: patient.createdAt
  };

  patientsData.unshift(newPatient);
  filteredPatients = [...patientsData];

  // Créer la nouvelle ligne avec animation
  const tbody = document.getElementById('patientsBody');
  if (!tbody) return;

  const row = document.createElement('tr');
  row.setAttribute('data-patient-id', newPatient.patientId || newPatient.id);
  row.style.opacity = '0';
  row.style.transform = 'translateY(-10px)';

  row.innerHTML = `
    <td>${newPatient.patientId || newPatient.id}</td>
    <td>${newPatient.prenom} ${newPatient.nom}</td>
    <td>${newPatient.pathologie || '-'}</td>
    <td><span class="badge">En attente</span></td>
    <td><button class="btn-primary" onclick="startPatientOperation('${newPatient.patientId || newPatient.id}')">Démarrer</button></td>
  `;

  // Insérer après l'en-tête
  if (tbody.firstChild) {
    tbody.insertBefore(row, tbody.firstChild.nextSibling);
  } else {
    tbody.appendChild(row);
  }

  // Animation
  requestAnimationFrame(() => {
    row.style.transition = 'all 0.3s ease';
    row.style.opacity = '1';
    row.style.transform = 'translateY(0)';
    row.style.background = 'rgba(16, 185, 129, 0.1)';

    setTimeout(() => {
      row.style.background = '';
    }, 1000);
  });

  // Mettre à jour les stats
  updateStats();
}

// ---------------------------------------------------------------------------
// Mise à jour de l'indicateur Socket.io
// ---------------------------------------------------------------------------
function updateSocketStatusUI(state) {
  const socketDot   = document.getElementById('socketStatusDot');
  const socketText  = document.getElementById('socketStatusText');
  const socketIcon  = document.getElementById('socketIcon');

  if (!socketDot || !socketText) return;

  const states = {
    connected:    { color: 'var(--emerald-500)', class: 'online', text: 'Connecté', icon: 'fa-wifi' },
    reconnecting: { color: 'var(--amber-500)',   class: 'unknown', text: 'Reconnexion...', icon: 'fa-sync fa-spin' },
    disconnected: { color: 'var(--rose-500)',    class: 'offline', text: 'Déconnecté', icon: 'fa-wifi-slash' }
  };

  const config = states[state] || states.disconnected;

  socketDot.className = `status-indicator ${config.class}`;
  socketText.textContent = config.text;
  socketText.style.color = config.color;

  if (socketIcon) {
    socketIcon.className = `fas ${config.icon}`;
    socketIcon.style.color = config.color;
  }
}

// ---------------------------------------------------------------------------
// Vérification système prêt
// ---------------------------------------------------------------------------
function isSystemReady() {
  return assistantReady && patientConsent;
}

// ---------------------------------------------------------------------------
// Mise à jour de la barre de monitoring
// ---------------------------------------------------------------------------
function updateMonitoringUI() {
  const arduinoDot  = document.getElementById('arduinoStatusDot');
  const arduinoText = document.getElementById('arduinoStatusText');
  const assistDot   = document.getElementById('assistantStatusDot');
  const assistText  = document.getElementById('assistantStatusText');
  const consentDot  = document.getElementById('consentStatusDot');
  const consentText = document.getElementById('consentStatusText');

  // Arduino (gère aussi le mode simulation)
  if (arduinoDot) {
    if (arduinoConnected && !arduinoSimulation) {
      arduinoDot.className = 'status-indicator online';
    } else if (arduinoSimulation) {
      arduinoDot.className = 'status-indicator unknown';  // Orange pour simulation
    } else {
      arduinoDot.className = 'status-indicator offline';
    }
  }
  if (arduinoText) {
    if (arduinoConnected && !arduinoSimulation) {
      arduinoText.textContent = 'Connecté';
      arduinoText.style.color = 'var(--emerald-600)';
    } else if (arduinoSimulation) {
      arduinoText.textContent = 'SIMULATION';
      arduinoText.style.color = 'var(--amber-500)';  // Orange
    } else {
      arduinoText.textContent = 'Déconnecté';
      arduinoText.style.color = 'var(--rose-500)';
    }
  }

  // Assistant
  if (assistDot) {
    assistDot.className = assistantOnline
      ? (assistantReady ? 'status-indicator online' : 'status-indicator unknown')
      : 'status-indicator offline';
  }
  if (assistText) {
    if (!assistantOnline) {
      assistText.textContent = 'OFFLINE';
      assistText.style.color = 'var(--rose-500)';
    } else if (assistantReady) {
      assistText.textContent = patientConsent ? 'PRÊT + CONSENTEMENT' : 'PRÊT (SANS CONSENTEMENT)';
      assistText.style.color = patientConsent ? 'var(--emerald-600)' : 'var(--amber-500)';
    } else {
      assistText.textContent = 'EN ATTENTE';
      assistText.style.color = 'var(--amber-500)';
    }
  }

  // Consentement patient
  if (consentDot) {
    consentDot.className = patientConsent
      ? 'status-indicator online'
      : 'status-indicator offline';
  }
  if (consentText) {
    consentText.textContent = patientConsent
      ? `VALIDÉ${patientConsentPatientId ? ` (${patientConsentPatientId})` : ''}`
      : 'NON VALIDÉ';
    consentText.style.color = patientConsent ? 'var(--emerald-600)' : 'var(--rose-500)';
  }

  updateWorkflowHint();

  // Rafraîchir le tableau pour les boutons
  renderPatients();
}

function updateWorkflowHint() {
  const hint = document.getElementById('workflowHint');
  if (!hint) return;

  let message = '';

  if (activeOperationPatientId) {
    message = '';
  } else if (!assistantOnline) {
    message = '<strong>DÉMARRER indisponible.</strong> L\'assistant médical doit être reconnecté avant de valider un nouveau patient.';
  } else if (!assistantReady) {
    message = '<strong>DÉMARRER indisponible.</strong> Après une opération terminée, l\'assistant doit sélectionner un nouveau patient puis repasser en mode PRÊT.';
  } else if (!patientConsent) {
    message = '<strong>DÉMARRER indisponible.</strong> Le patient sélectionné doit encore être marqué comme consenti côté assistant.';
  }

  hint.innerHTML = message;
  hint.style.display = message ? 'block' : 'none';
}

// ---------------------------------------------------------------------------
// Chargement des patients
// ---------------------------------------------------------------------------
async function loadPatients() {
  const auth = checkAuth();
  if (!auth) return;

  try {
    const response = await fetch(`${API_URL}/patients`, {
      headers: { Authorization: `Bearer ${auth.token}` }
    });
    if (!response.ok) throw new Error('Erreur chargement');

    patientsData = await response.json();
    filteredPatients = [...patientsData];
    activeOperationPatientId = patientsData.find(p => p.statut === 'en_cours')?.id || patientsData.find(p => p.statut === 'en_cours')?.patient_id || null;
    renderPatients();
    updateStats();
  } catch (err) {
    console.error('[DASHBOARD] Erreur chargement patients:', err);
    alert('Erreur de connexion au serveur. Vérifiez que le backend est démarré.');
  }
}

async function loadHistory() {
  const auth = checkAuth();
  if (!auth) return;

  try {
    const response = await fetch(`${API_URL}/patients/history/list`, {
      headers: { Authorization: `Bearer ${auth.token}` }
    });
    if (!response.ok) throw new Error('Erreur chargement historique');

    historyData = await response.json();
    if (currentSection === 'history') {
      renderHistory();
    }
  } catch (err) {
    console.error('[DASHBOARD] Erreur chargement historique:', err);
  }
}

// ---------------------------------------------------------------------------
// Rendu du tableau des patients
// ---------------------------------------------------------------------------
function renderPatients(data = filteredPatients) {
  const tbody = document.getElementById('patientsBody');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!data || data.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center;padding:30px;color:#666;">
          <i class="fas fa-inbox"></i> Aucun patient trouvé
        </td>
      </tr>`;
    return;
  }

  data.forEach(patient => {
    const id           = patient.id || patient.patient_id || 'ID-?';
    const name         = patient.name || `${patient.prenom || ''} ${patient.nom || ''}`.trim() || 'Inconnu';
    const pathologie   = patient.pathologie || patient.intervention || 'N/A';
    const isReady      = patient.assistantSignal === 'Prêt' || patient.statut === 'pret';
    const isOperating  = patient.statut === 'en_cours';
    const lockActive    = !!activeOperationPatientId && !isOperating;
    const hasConsent   = patientConsent && (!patientConsentPatientId || patientConsentPatientId === id);
    const systemReady  = isSystemReady();
    const canEnter     = isOperating || (!lockActive && isReady && hasConsent && systemReady);

    let statusBadge, statusClass;
    if (isOperating) {
      statusBadge = 'OPÉRATION EN COURS';
      statusClass = 'status-operating';
    } else if (!assistantOnline) {
      statusBadge = 'ASSISTANT HORS LIGNE';
      statusClass = 'status-preparing';
    } else if (lockActive) {
      statusBadge = 'SYSTÈME VERROUILLÉ';
      statusClass = 'status-preparing';
    } else if (isReady && hasConsent && systemReady) {
      statusBadge = 'PRÊT';
      statusClass = 'status-ready';
    } else if (isReady && !hasConsent) {
      statusBadge = 'CONSENTEMENT MANQUANT';
      statusClass = 'status-waiting';
    } else if (isReady && !systemReady) {
      statusBadge = 'PRÊT EN ATTENTE';
      statusClass = 'status-preparing';
    } else if (assistantOnline && !assistantReady) {
      statusBadge = 'VALIDATION ASSISTANT REQUISE';
      statusClass = 'status-preparing';
    } else {
      statusBadge = 'EN ATTENTE';
      statusClass = 'status-waiting';
    }

    const btnText      = isOperating ? 'REPRENDRE' : 'DÉMARRER';
    const disabledAttr = canEnter ? '' : 'disabled';
    const btnClass     = canEnter ? 'btn-enter active' : 'btn-enter btn-disabled';

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${id}</strong></td>
      <td>${name}</td>
      <td>${pathologie}</td>
      <td><span class="status-badge ${statusClass}">${statusBadge}</span></td>
      <td>
        <button class="${btnClass}" data-patient-id="${id}"
                onclick="enterSalle('${id}', '${name.replace(/'/g, "\\'")}')"
                ${disabledAttr}>
          ${btnText}
        </button>
      </td>`;
    tbody.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Mise à jour d'une ligne sans rechargement complet
// ---------------------------------------------------------------------------
function updatePatientRowInDOM(patientId, newStatus) {
  const patient = patientsData.find(p => (p.id || p.patient_id) === patientId);
  if (patient) {
    patient.assistantSignal = newStatus;
    if (newStatus === 'Prêt') {
      localStorage.setItem('active_patient_name', patient.name || `${patient.prenom} ${patient.nom}`);
    }
    renderPatients();
  }
}

// ---------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------
function updateStats() {
  const total   = patientsData.length;
  const prets   = patientsData.filter(p => p.assistantSignal === 'Prêt' || p.statut === 'pret').length;
  const enCours = patientsData.filter(p => p.statut === 'en_cours').length;

  const totalEl   = document.getElementById('statTotal');
  const pretsEl   = document.getElementById('statPrets');
  const enCoursEl = document.getElementById('statEnCours');

  if (totalEl)   totalEl.textContent   = total;
  if (pretsEl)   pretsEl.textContent   = prets;
  if (enCoursEl) enCoursEl.textContent = enCours;
}

// ---------------------------------------------------------------------------
// Recherche / Filtrage
// ---------------------------------------------------------------------------
function filterPatients() {
  const term = (document.getElementById('searchBox')?.value || '').toLowerCase().trim();

  filteredPatients = term
    ? patientsData.filter(p => {
        const id   = (p.id || p.patient_id || '').toLowerCase();
        const name = (p.name || `${p.prenom || ''} ${p.nom || ''}`).toLowerCase();
        const path = (p.pathologie || p.intervention || '').toLowerCase();
        return id.includes(term) || name.includes(term) || path.includes(term);
      })
    : [...patientsData];

  renderPatients(filteredPatients);
}

// ---------------------------------------------------------------------------
// Navigation entre sections
// ---------------------------------------------------------------------------
function navigateTo(section) {
  currentSection = section;

  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
    if (item.dataset.section === section) item.classList.add('active');
  });

  document.querySelectorAll('.content-section').forEach(sec => sec.classList.remove('active'));
  document.getElementById(`${section}-section`)?.classList.add('active');

  const titles = {
    patients: 'Suivi des Patients en Temps Réel',
    history:  'Historique des Opérations',
    logs:     'Archives & Logs Blockchain'
  };
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = titles[section] || '';

  const searchContainer = document.querySelector('.search-container');
  if (searchContainer) searchContainer.style.display = section === 'patients' ? 'flex' : 'none';

  if (section === 'history') renderHistory();
  if (section === 'logs')    renderLogs();
}

// ---------------------------------------------------------------------------
// Entrée en salle d'opération
// ---------------------------------------------------------------------------
function enterSalle(patientId, patientName) {
  const patient = patientsData.find(p => (p.id || p.patient_id) === patientId);
  const isReady = patient && (patient.assistantSignal === 'Prêt' || patient.statut === 'pret' || patient.statut === 'en_cours');
  const hasConsent = patientConsent && (!patientConsentPatientId || patientConsentPatientId === patientId);

  if (activeOperationPatientId && activeOperationPatientId !== patientId) {
    alert('🔒 ACCÈS VERROUILLÉ\n\nUne salle est déjà active. Attendez que le chirurgien sorte de la salle en cours.');
    return;
  }

  if (!isReady) {
    alert('🔒 ACCÈS REFUSÉ\n\nLe patient n\'est pas encore prêt.\nVeuillez attendre la confirmation de l\'assistant médical.');
    return;
  }

  if (!hasConsent) {
    alert('🔒 ACCÈS REFUSÉ\n\nLe consentement patient n\'a pas encore été validé par l\'assistant.');
    return;
  }

  sessionStorage.setItem('currentPatient', JSON.stringify({ id: patientId, name: patientName }));
  window.location.href = `index.html?patientId=${patientId}`;
}

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------
function renderHistory() {
  const tbody = document.getElementById('historyBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!historyData.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align:center;padding:30px;color:#666;">
          <i class="fas fa-info-circle"></i> Aucune opération dans l'historique
        </td>
      </tr>`;
    return;
  }

  historyData.forEach(op => {
    const row = document.createElement('tr');
    const isSuccess = op.statut === 'terminee' || op.statut === 'Succès';
    const cls = isSuccess ? 'status-success' : 'status-archive';
    row.innerHTML = `
      <td>${op.date}</td>
      <td>${op.patient}</td>
      <td>${op.duree}</td>
      <td><span class="${cls}">${isSuccess ? '✓ Terminée' : `○ ${op.statut}`}</span></td>`;
    tbody.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Logs Blockchain
// ---------------------------------------------------------------------------
function renderLogs() {
  const container = document.getElementById('logsContainer');
  if (!container) return;
  container.innerHTML = '';

  if (!logsData.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:30px;color:#666;">
        <i class="fas fa-info-circle"></i> Aucun log disponible
      </div>`;
    return;
  }

  logsData.forEach(log => {
    const div = document.createElement('div');
    div.className = 'log-item';
    div.innerHTML = `
      <div class="log-info">
        <span class="log-icon">${log.type === 'pdf' ? '📄' : '📊'}</span>
        <div class="log-details">
          <h4>${log.name}</h4>
          <p>${log.date} · ${log.size}</p>
        </div>
      </div>
      <button class="btn-download" onclick="downloadLog('${log.name}')">Télécharger</button>`;
    container.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Téléchargement d'un log
// ---------------------------------------------------------------------------
async function downloadLog(patientId) {
  const auth = checkAuth();
  if (!auth) return;

  try {
    const response = await fetch(`${API_URL}/patients/download-logs/${patientId}`, {
      headers: { Authorization: `Bearer ${auth.token}` }
    });
    if (!response.ok) throw new Error('Erreur téléchargement');

    const data = await response.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `surgical-blackbox-${patientId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('[DASHBOARD] Erreur téléchargement:', err);
  }
}

// ---------------------------------------------------------------------------
// Déconnexion
// ---------------------------------------------------------------------------
function logoutWithConfirm() {
  if (confirm('⚠️ CONFIRMATION DE DÉCONNEXION\n\nSouhaitez-vous quitter le système ?')) {
    if (socket) socket.emit('surgeon:offline');
    sessionStorage.clear();
    localStorage.clear();
    window.location.href = 'login.html';
  }
}

// ---------------------------------------------------------------------------
// Exports globaux
// ---------------------------------------------------------------------------
window.navigateTo        = navigateTo;
window.filterPatients    = filterPatients;
window.enterSalle        = enterSalle;
window.downloadLog       = downloadLog;
window.logoutWithConfirm = logoutWithConfirm;
