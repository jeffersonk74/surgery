// app.js — Interface Chirurgien Téléchirurgie
// WebRTC + Socket.io + Contrôle Robot
// Version corrigée et stabilisée

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function getBackendHost() {
  const stored = localStorage.getItem('medibot_backend_host');
  if (stored) return stored;
  return window.location.hostname === 'localhost' ? 'localhost:3000' : '10.117.147.182:3000';
}
const BACKEND_HOST = getBackendHost();
const SERVER_URL = `http://${BACKEND_HOST}`;
const ROOM_ID = 'Bloc-01';
const LATENCY_THRESHOLD = 150; // ms
const COMMAND_THROTTLE_MS = 50; // max ~20 Hz

// ---------------------------------------------------------------------------
// État global (toutes les variables déclarées AVANT leur utilisation)
// ---------------------------------------------------------------------------
let socket = null;
let peerConnection = null;
let assistantPeerId = null;
let localStream = null;
let lastCommandTime = 0;
let pingInterval = null;
let latencyInterval = null;
let heartbeatInterval = null;
let operationStarted = false;
let blockchainActive = false;
let assistantOnline = false;
let assistantReconnecting = false;
let arduinoOnline = false;
let safetyTriggered = false;
let isDeadmanPressed = false;
let joystickBase = 90;
let joystickEpaule = 90;
let assistantDisplayName = 'Assistant';

// ---------------------------------------------------------------------------
// Références DOM (remplies après DOMContentLoaded)
// ---------------------------------------------------------------------------
let remoteVideo, videoOverlay, connectionStatus, startCallBtn, endCallBtn;
let lastHashEl, blockCountEl, latencyEl;
let patientIdEl, patientNameEl, patientStatusEl, assistantNameEl, assistantStatusEl;

// ---------------------------------------------------------------------------
// Initialisation des éléments DOM
// ---------------------------------------------------------------------------
function initDomElements() {
  remoteVideo = document.getElementById('remoteVideo');
  videoOverlay = document.getElementById('videoOverlay');
  connectionStatus = document.getElementById('connectionStatus');
  startCallBtn = document.getElementById('startCall');
  endCallBtn = document.getElementById('endCall');
  lastHashEl = document.querySelector('.hash-value') || document.getElementById('blockchain-hash');
  blockCountEl = document.getElementById('blockCount');
  latencyEl = document.getElementById('latency');
  patientIdEl = document.getElementById('patientId');
  patientNameEl = document.getElementById('patientName');
  patientStatusEl = document.getElementById('patientStatus');
  assistantNameEl = document.getElementById('assistantName');
  assistantStatusEl = document.getElementById('assistantStatus');

  // Sliders robot
  sliders = {
    coude: document.getElementById('coude'),
    poignetRot: document.getElementById('poignetRot'),
    poignetInc: document.getElementById('poignetInc'),
    pince: document.getElementById('pince')
  };

  valueLabels = {
    coude: document.getElementById('coudeValue'),
    poignetRot: document.getElementById('poignetRotValue'),
    poignetInc: document.getElementById('poignetIncValue'),
    pince: document.getElementById('pinceValue')
  };

  // Bouton reprise sécurité
  const btnResumeSafety = document.getElementById('btn-resume-safety');
  if (btnResumeSafety) btnResumeSafety.onclick = resumeOperation;

  // Dead Man's Switch
  const btnDeadman = document.getElementById('btn-deadman');
  if (btnDeadman) {
    btnDeadman.onmousedown = () => {
      isDeadmanPressed = true;
      btnDeadman.style.background = '#10b981';
      btnDeadman.style.color = 'white';
      btnDeadman.style.boxShadow = 'none';
      btnDeadman.style.transform = 'translateY(4px)';
    };
    btnDeadman.onmouseup = btnDeadman.onmouseleave = () => {
      isDeadmanPressed = false;
      btnDeadman.style.background = '#ffc107';
      btnDeadman.style.color = '#000';
      btnDeadman.style.boxShadow = '0 4px 0 #d39e00';
      btnDeadman.style.transform = 'translateY(0)';
    };
  }

  // Joystick
  initJoystick();

  // Blockchain panel toggle
  const trigger = document.getElementById('blockchain-trigger');
  const panel = document.getElementById('blockchain-panel');
  if (trigger && panel) {
    trigger.onclick = () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    };
  }

  updateOperationInfoPanel();
}

function updateOperationInfoPanel(overrides = {}) {
  const patientData = JSON.parse(sessionStorage.getItem('currentPatient') || 'null');
  const patientId = overrides.patientId ?? patientData?.id ?? '--';
  const patientName = overrides.patientName ?? patientData?.name ?? '--';
  const patientStatus = overrides.patientStatus ?? (patientData ? 'PRÊT POUR OPÉRATION' : '--');
  const assistantStatus = overrides.assistantStatus ?? (assistantReconnecting ? 'Reconnexion...' : assistantOnline ? 'En ligne' : 'Hors ligne');

  if (patientIdEl) patientIdEl.textContent = patientId;
  if (patientNameEl) patientNameEl.textContent = patientName;
  if (patientStatusEl) {
    patientStatusEl.textContent = patientStatus;
    patientStatusEl.style.color = patientStatus.includes('EN SALLE') ? '#10b981' : '#f59e0b';
  }

  if (assistantNameEl) assistantNameEl.textContent = assistantDisplayName;
  if (assistantStatusEl) {
    assistantStatusEl.textContent = assistantStatus;
    assistantStatusEl.style.color = assistantOnline ? (assistantReconnecting ? '#f59e0b' : '#10b981') : '#f43f5e';
  }
}

// ---------------------------------------------------------------------------
// Joystick
// ---------------------------------------------------------------------------
function initJoystick() {
  const container = document.getElementById('joystick-container');
  const handle = document.getElementById('joystick-handle');
  if (!container || !handle) return;

  let isDragging = false;
  const rect = container.getBoundingClientRect();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;

  const moveJoystick = (e) => {
    if (!isDragging) return;
    const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
    const clientY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
    const r = container.getBoundingClientRect();
    let x = clientX - r.left - centerX;
    let y = clientY - r.top - centerY;
    const dist = Math.sqrt(x * x + y * y);
    const maxRadius = r.width / 2 - 25;
    if (dist > maxRadius) {
      x = (x / dist) * maxRadius;
      y = (y / dist) * maxRadius;
    }
    handle.style.transform = `translate(${x}px, ${y}px)`;
    joystickBase = Math.round(90 + (x / maxRadius) * 90);
    joystickEpaule = Math.round(90 - (y / maxRadius) * 90);
    sendCommand();
  };

  container.onmousedown = (e) => { isDragging = true; moveJoystick(e); };
  window.addEventListener('mousemove', moveJoystick);
  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      handle.style.transform = 'translate(0, 0)';
      joystickBase = 90;
      joystickEpaule = 90;
      sendCommand();
    }
  });
  container.ontouchstart = (e) => { isDragging = true; moveJoystick(e); e.preventDefault(); };
  window.addEventListener('touchmove', moveJoystick);
  window.addEventListener('touchend', () => {
    if (isDragging) {
      isDragging = false;
      handle.style.transform = 'translate(0, 0)';
      joystickBase = 90;
      joystickEpaule = 90;
      sendCommand();
    }
  });
}

// ---------------------------------------------------------------------------
// Sliders (initialisés dans initDomElements après DOMContentLoaded)
// ---------------------------------------------------------------------------
let sliders = {};
let valueLabels = {};

function updateSliderLabels() {
  Object.keys(sliders).forEach(key => {
    if (sliders[key] && valueLabels[key]) {
      valueLabels[key].textContent = sliders[key].value + '°';
    }
  });
}

// ---------------------------------------------------------------------------
// Positions prédéfinies
// ---------------------------------------------------------------------------
const positions = {
  HOME: { base: 90, epaule: 90, coude: 90, poignetRot: 90, poignetInc: 90, pince: 0 },
  PRET: { base: 90, epaule: 105, coude: 130, poignetRot: 90, poignetInc: 0, pince: 90 },
  OPERATION: { base: 40, epaule: 105, coude: 132, poignetRot: 5, poignetInc: 0, pince: 180 }
};

function applyPreset(name) {
  const preset = positions[name.toUpperCase()];
  if (!preset) {
    console.warn(`[PRESET] Position "${name}" non trouvée`);
    return;
  }
  console.log(`[PRESET] Application de ${name.toUpperCase()}:`, preset);
  Object.keys(preset).forEach(key => {
    if (sliders[key]) sliders[key].value = preset[key];
  });
  updateSliderLabels();
  sendCommand();
}

// ---------------------------------------------------------------------------
// Commandes robot (avec throttle + Dead Man's Switch)
// ---------------------------------------------------------------------------
function sendCommand() {
  if (!socket || !socket.connected || safetyTriggered) return;
  if (!isDeadmanPressed) return;
  const now = Date.now();
  if (now - lastCommandTime < COMMAND_THROTTLE_MS) return;
  lastCommandTime = now;

  const command = {
    x: joystickBase,
    y: joystickEpaule,
    z: parseInt(sliders.coude?.value || 90),
    roll: parseInt(sliders.poignetRot?.value || 90),
    pitch: parseInt(sliders.poignetInc?.value || 90),
    yaw: parseInt(sliders.pince?.value || 0),
    sentAt: now
  };

  socket.emit('move-command', command);

  // Send to Arduino if connected (convert to servo values matching .ino file)
  if (window.arduinoController?.isConnected?.()) {
    // Map joystick values (0-180) to servo ranges from .ino file
    const mapRange = (val, inMin, inMax, outMin, outMax) => {
      return Math.round(((val - inMin) * (outMax - outMin) / (inMax - inMin)) + outMin);
    };

    // B: Base (200-660), E: Epaule (500-800), C: Coude (400-630)
    // P: Poignet (100-500), I: Inclinaison (200-550), G: Pince (150-270)
    window.arduinoController.sendBase(mapRange(joystickBase, 0, 180, 200, 660));
    window.arduinoController.sendEpaule(mapRange(joystickEpaule, 0, 180, 500, 800));
    window.arduinoController.sendCoude(mapRange(command.z, 0, 180, 400, 630));
    window.arduinoController.sendPoignet(mapRange(command.roll, 0, 180, 100, 500));
    window.arduinoController.sendInc(mapRange(command.pitch, 0, 180, 200, 550));
    window.arduinoController.sendPince(mapRange(command.yaw, 0, 180, 150, 270));
  }
}

// ---------------------------------------------------------------------------
// Sécurité
// ---------------------------------------------------------------------------
function triggerEmergencyStop(latency) {
  if (safetyTriggered) return;
  safetyTriggered = true;
  console.warn(`[SAFETY] Arrêt d'urgence ! Latence: ${latency}ms`);

  const safetyAlert = document.getElementById('safety-alert');
  if (safetyAlert) safetyAlert.style.display = 'block';

  // Stop robot via Socket.IO
  if (socket?.connected) {
    socket.emit('emergency-stop', { latency, timestamp: Date.now() });
  }

  // Send emergency stop to Arduino directly
  if (window.arduinoController?.sendEmergency) {
    window.arduinoController.sendEmergency();
  }

  const controlsOverlay = document.getElementById('controlsOverlay');
  if (controlsOverlay) {
    controlsOverlay.style.display = 'flex';
    const overlayText = controlsOverlay.querySelector('p');
    if (overlayText) overlayText.textContent = 'SÉCURITÉ ACTIVÉE : Latence critique détectée.';
    const overlayBtn = document.getElementById('btn-start-op-overlay');
    if (overlayBtn) overlayBtn.style.display = 'none';
  }

  if (socket?.connected) {
    socket.emit('emergency-stop', { latency, timestamp: Date.now() });
  }
}

function resumeOperation() {
  safetyTriggered = false;
  const safetyAlert = document.getElementById('safety-alert');
  if (safetyAlert) safetyAlert.style.display = 'none';
  const controlsOverlay = document.getElementById('controlsOverlay');
  if (controlsOverlay) controlsOverlay.style.display = 'none';
  console.log('[SAFETY] Opération reprise par le chirurgien.');
}

// ---------------------------------------------------------------------------
// Statut système (panneau supérieur)
// ---------------------------------------------------------------------------
function updateSystemStatusPanel() {
  const dotAssistant = document.getElementById('dotAssistant');
  const dotArduino = document.getElementById('dotArduino');
  if (dotAssistant) {
    dotAssistant.style.background = assistantReconnecting
      ? '#f59e0b'
      : assistantOnline
        ? '#10b981'
        : '#f43f5e';
    dotAssistant.title = assistantReconnecting
      ? 'Assistant: Reconnexion...'
      : assistantOnline
        ? 'Assistant: En ligne'
        : 'Assistant: Hors ligne';
  }
    updateOperationInfoPanel({ assistantStatus: dotAssistant?.title?.replace('Assistant: ', '') });
  if (dotArduino) {
    dotArduino.style.background = arduinoOnline ? '#10b981' : '#f43f5e';
    dotArduino.title = arduinoOnline ? 'Arduino: Connecté' : 'Arduino: Déconnecté';
  }
}

// ---------------------------------------------------------------------------
// WebRTC
// ---------------------------------------------------------------------------
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

async function initVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false
    });
    console.log('[VIDEO] Caméra locale accessible');
    return stream;
  } catch (err) {
    console.error('[VIDEO] Erreur caméra:', err);
    return null;
  }
}

async function startCall() {
  try {
    let videoEl = document.getElementById('robot-video-feed');
    if (!videoEl) {
      videoEl = document.createElement('video');
      videoEl.id = 'robot-video-feed';
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      const container = document.querySelector('.video-section') || document.querySelector('.video-container');
      if (container) {
        container.innerHTML = '';
        container.appendChild(videoEl);
      }
    }

    localStream = await initVideo();
    if (videoEl && localStream) videoEl.srcObject = localStream;

    peerConnection = new RTCPeerConnection(iceServers);
    if (localStream) {
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    }

    peerConnection.ontrack = (event) => {
      console.log('[WebRTC] Stream reçu');
      if (videoEl) videoEl.srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          targetId: getRobotPeerId(),
          candidate: event.candidate
        });
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE State:', peerConnection.iceConnectionState);
      if (
        peerConnection.iceConnectionState === 'disconnected' ||
        peerConnection.iceConnectionState === 'failed'
      ) {
        console.warn('[WebRTC] Connexion perdue, re-signalisation...');
        reconnectWebRTC();
      }
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', { targetId: getRobotPeerId(), offer });

    if (startCallBtn) startCallBtn.disabled = true;
    if (endCallBtn) endCallBtn.disabled = false;
  } catch (err) {
    console.error('[WebRTC] Erreur startCall:', err);
  }
}

async function handleOffer(offer, senderId) {
  try {
    peerConnection = new RTCPeerConnection(iceServers);

    peerConnection.ontrack = (event) => {
      if (remoteVideo) {
        remoteVideo.srcObject = event.streams[0];
        if (videoOverlay) videoOverlay.classList.add('hidden');
      }
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', { targetId: senderId, candidate: event.candidate });
      }
    };

    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', { targetId: senderId, answer });

    if (startCallBtn) startCallBtn.disabled = true;
    if (endCallBtn) endCallBtn.disabled = false;
  } catch (err) {
    console.error('[WebRTC] Erreur handleOffer:', err);
  }
}

function endCall() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  const videoEl = document.getElementById('robot-video-feed');
  if (videoEl?.parentElement) {
    videoEl.parentElement.innerHTML =
      '<div class="video-overlay" id="videoOverlay"><p>En attente de connexion...</p></div>';
  }
  if (remoteVideo) remoteVideo.srcObject = null;
  if (videoOverlay) videoOverlay.classList.remove('hidden');

  if (startCallBtn) startCallBtn.disabled = false;
  if (endCallBtn) endCallBtn.disabled = true;
}

async function reconnectWebRTC() {
  if (!operationStarted || !socket?.connected) return;
  console.log('[WebRTC] Tentative de re-signalisation...');
  try {
    if (peerConnection) {
      const offer = await peerConnection.createOffer({ iceRestart: true });
      await peerConnection.setLocalDescription(offer);
      socket.emit('offer', { targetId: getRobotPeerId(), offer });
    } else {
      startCall();
    }
  } catch (err) {
    console.error('[WebRTC] Erreur re-signalisation:', err);
    setTimeout(startCall, 2000);
  }
}

function getRobotPeerId() {
  return assistantPeerId || 'robot-peer-id';
}

// ---------------------------------------------------------------------------
// Blockchain
// ---------------------------------------------------------------------------
function updateBlockchainDisplay(data) {
  let hashEl =
    document.getElementById('blockchain-hash') ||
    document.getElementById('hash-display');

  if (!hashEl) {
    const spans = document.querySelectorAll('span, div, p');
    hashEl = Array.from(spans).find(
      el => el.textContent.includes('En attente') || el.textContent.includes('0x')
    );
  }
  if (hashEl) {
    hashEl.textContent = data.hash;
    hashEl.style.color = '#00ff00';
  }
}

function recordBlockchainEntry(commandId, value) {
  const timestamp = new Date().toISOString();
  const dataString = `${commandId}:${value}:${timestamp}`;
  // btoa sécurisé (UTF-8)
  const hash = btoa(unescape(encodeURIComponent(dataString))).substring(0, 16);

  const entry = {
    timestamp,
    command: commandId,
    value,
    hash,
    patientId: JSON.parse(sessionStorage.getItem('currentPatient') || '{}')?.id
  };

  if (socket?.connected) socket.emit('blockchain:record', entry);

  if (lastHashEl) {
    lastHashEl.textContent = `0x${hash}`;
    lastHashEl.style.color = '#10b981';
  }
  if (blockCountEl) {
    blockCountEl.textContent = (parseInt(blockCountEl.textContent || '0') + 1).toString();
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Télémétrie
// ---------------------------------------------------------------------------
function updateTelemetryDisplay(data) {
  const teleX = document.getElementById('tele-x');
  const teleY = document.getElementById('tele-y');
  const teleZ = document.getElementById('tele-z');
  const color = data.simulation ? '#f59e0b' : '#10b981';
  if (teleX) { teleX.textContent = data.x ?? '--'; teleX.style.color = color; }
  if (teleY) { teleY.textContent = data.y ?? '--'; teleY.style.color = color; }
  if (teleZ) { teleZ.textContent = data.z ?? '--'; teleZ.style.color = color; }
}

function displayLatency(latency) {
  const el = document.querySelector('.latency-value') || document.getElementById('latency');
  if (el) {
    el.textContent = `${latency} ms`;
    if (latency > LATENCY_THRESHOLD) {
      el.style.color = '#f43f5e';
      triggerEmergencyStop(latency);
    } else if (latency > 100) {
      el.style.color = '#f59e0b';
    } else {
      el.style.color = '#10b981';
    }
  }
}

// ---------------------------------------------------------------------------
// Connexion Socket.io
// ---------------------------------------------------------------------------
function initSocket() {
  socket = io(SERVER_URL, {
    reconnection: true,
    reconnectionAttempts: 15,
    reconnectionDelay: 1000
  });

  socket.on('connect', () => {
    console.log('[SOCKET] Connecté:', socket.id);
    startHeartbeat();
    startLatencyCheck();
    updateConnectionStatus('connected', '🟢 Connecté');

    const userData = JSON.parse(sessionStorage.getItem('user') || '{}');
    socket.emit('register', 'SURGEON', `Dr. ${userData.nom || 'Inconnu'}`);
    socket.emit('surgeon:online', { userId: userData.id || 'surgeon-' + socket.id });

    const currentPatient = JSON.parse(sessionStorage.getItem('currentPatient'));
    if (currentPatient) {
      socket.emit('join-room', ROOM_ID, (response) => {
        console.log('[WebRTC] Room rejointe:', response);
        if (response?.peers?.length > 0) {
          assistantPeerId = response.peers[0];
          console.log('[WebRTC] Assistant trouvé:', assistantPeerId);
        }
      });
    }
  });

  socket.on('peer-joined', (data) => {
    console.log('[WebRTC] Pair rejoint:', data);
    if (data.role === 'ASSISTANT' || !assistantPeerId) {
      assistantPeerId = data.peerId;
    }
  });

  socket.on('peer-left', (data) => {
    console.log('[WebRTC] Pair parti:', data);
    if (data.peerId === assistantPeerId) assistantPeerId = null;
  });

  socket.on('disconnect', (reason) => {
    console.log('[SOCKET] Déconnecté:', reason);
    updateConnectionStatus('disconnected', '🔴 Déconnecté');
    stopHeartbeat();
  });

  socket.on('reconnect', (attempt) => {
    console.log(`[SOCKET] Reconnecté après ${attempt} tentatives`);
    const userData = JSON.parse(sessionStorage.getItem('user') || '{}');
    socket.emit('surgeon:online', { userId: userData.id });
  });

  socket.on('connect_error', (err) => {
    console.error('[SOCKET] Erreur:', err);
    updateConnectionStatus('error', '⚠️ Erreur');
  });

  socket.on('assistant:status', (data) => {
    assistantOnline = data.online;
    assistantReconnecting = data.reconnecting;
    assistantDisplayName = data.userId || data.assistantId || assistantDisplayName;
    updateSystemStatusPanel();
  });

  socket.on('assistant:online', () => {
    assistantOnline = true;
    assistantReconnecting = false;
    updateSystemStatusPanel();
  });

  socket.on('assistant:reconnecting', () => {
    assistantReconnecting = true;
    updateSystemStatusPanel();
  });

  socket.on('assistant:offline', () => {
    assistantOnline = false;
    assistantReconnecting = false;
    updateSystemStatusPanel();
  });

  socket.on('arduino:status', (data) => {
    arduinoOnline = data.connected;
    updateSystemStatusPanel();
  });

  socket.on('operation:paused', (data) => {
    operationStarted = false;
    blockchainActive = false;
    if (data?.patientId) {
      sessionStorage.removeItem('currentPatient');
    }
    updateOperationInfoPanel({
      patientId: '--',
      patientName: '--',
      patientStatus: '--'
    });
  });

  socket.on('operation:ended', (data) => {
    operationStarted = false;
    blockchainActive = false;
    if (data?.patientId) {
      sessionStorage.removeItem('currentPatient');
    }
    updateOperationInfoPanel({
      patientId: '--',
      patientName: '--',
      patientStatus: 'TERMINÉE'
    });
  });

  socket.on('offer', async (data) => {
    console.log('[WebRTC] Offer reçue de', data.senderId);
    await handleOffer(data.offer, data.senderId);
  });

  socket.on('answer', async (data) => {
    console.log('[WebRTC] Answer reçue');
    if (peerConnection) await peerConnection.setRemoteDescription(data.answer);
  });

  socket.on('ice-candidate', async (data) => {
    try {
      if (peerConnection) await peerConnection.addIceCandidate(data.candidate);
    } catch (err) {
      console.error('[WebRTC] Erreur ICE:', err);
    }
  });

  socket.on('blockchain-update', (data) => updateBlockchainDisplay(data));
  socket.on('robot:telemetry', (data) => updateTelemetryDisplay(data));
  socket.on('pong-latency', (startTime) => displayLatency(Date.now() - startTime));
  socket.on('pong', (timestamp) => {
    if (latencyEl) latencyEl.textContent = `${Date.now() - timestamp} ms`;
  });
}

function updateConnectionStatus(state, text) {
  if (connectionStatus) {
    connectionStatus.textContent = text;
    connectionStatus.className = 'connection-status ' + state;
  }
}

// ---------------------------------------------------------------------------
// Heartbeat & Latence
// ---------------------------------------------------------------------------
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (socket?.connected) socket.emit('heartbeat', { timestamp: Date.now() });
  }, 10000);
}

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

function startLatencyCheck() {
  stopLatencyCheck();
  latencyInterval = setInterval(() => {
    if (socket?.connected) socket.emit('ping-latency', Date.now());
  }, 2000);
}

function stopLatencyCheck() {
  if (latencyInterval) { clearInterval(latencyInterval); latencyInterval = null; }
}

// ---------------------------------------------------------------------------
// Opération
// ---------------------------------------------------------------------------
async function startOperation() {
  const patientData = JSON.parse(sessionStorage.getItem('currentPatient'));
  if (!patientData) {
    alert('❌ Aucun patient sélectionné');
    return;
  }
  if (!assistantOnline) {
    alert('⚠️ Assistant déconnecté. Impossible de démarrer.');
    return;
  }

  operationStarted = true;
  blockchainActive = true;

  const overlay = document.getElementById('controlsOverlay');
  if (overlay) overlay.style.display = 'none';

  Object.values(sliders).forEach(slider => {
    if (slider) slider.disabled = false;
  });

  const btnStart = document.getElementById('btn-start-op');
  const btnComplete = document.getElementById('btn-complete');
  if (btnStart) btnStart.style.display = 'none';
  if (btnComplete) btnComplete.style.display = 'inline-block';

  if (socket) {
    socket.emit('surgeon:enter-room', {
      patientId: patientData.id,
      timestamp: new Date().toISOString()
    });
  }
  updateOperationInfoPanel({
    patientId: patientData.id,
    patientName: patientData.name,
    patientStatus: 'EN SALLE'
  });
  console.log('[APP] ✅ Opération démarrée');
}

// ---------------------------------------------------------------------------
// Redimensionnement responsive
// ---------------------------------------------------------------------------
function handleResize() {
  const videoSection = document.querySelector('.video-container');
  if (!videoSection) return;
  const width = videoSection.clientWidth;
  const height = videoSection.clientHeight;
  console.log(`[RESIZE] Conteneur vidéo: ${width}x${height}`);
  if (remoteVideo?.srcObject) {
    const videoTrack = remoteVideo.srcObject.getVideoTracks()[0];
    if (videoTrack?.applyConstraints) {
      videoTrack
        .applyConstraints({
          width: { ideal: Math.min(width, 1920) },
          height: { ideal: Math.min(height, 1080) }
        })
        .catch(err => console.log('[RESIZE] Contraintes ignorées:', err));
    }
  }
}

// ---------------------------------------------------------------------------
// Nettoyage global
// ---------------------------------------------------------------------------
function cleanupAll() {
  stopHeartbeat();
  stopLatencyCheck();
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (socket) {
    socket.emit('surgeon:offline');
    socket.disconnect();
    socket = null;
  }
}

// ---------------------------------------------------------------------------
// Initialisation DOM
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const currentPatient = sessionStorage.getItem('currentPatient');
  if (!currentPatient) {
    alert('Veuillez d\'abord sélectionner un patient dans le dashboard');
    window.location.href = 'dashboard.html';
    return;
  }

  const patientData = JSON.parse(currentPatient);
  console.log(`[SESSION] Patient: ${patientData.name} (${patientData.id})`);

  const headerTitle = document.querySelector('header h1');
  if (headerTitle) {
    headerTitle.innerHTML = `🩺 Opération - ${patientData.name} <span style="font-size:0.7em;opacity:0.7">(${patientData.id})</span>`;
  }

  initDomElements();

  // Désactiver les sliders par défaut
  Object.values(sliders).forEach(slider => {
    if (slider) slider.disabled = true;
  });

  initSocket();
  updateSliderLabels();

  // Listeners sliders
  Object.values(sliders).forEach(slider => {
    if (slider) {
      slider.addEventListener('input', () => {
        if (!operationStarted) {
          alert('⚠️ Démarrer l\'opération pour activer les commandes');
          return;
        }
        updateSliderLabels();
        sendCommand();
        if (blockchainActive) recordBlockchainEntry(slider.id, slider.value);
      });
    }
  });

  // Boutons
  const btnStartOp = document.getElementById('btn-start-op');
  const btnStartOpOverlay = document.getElementById('btn-start-op-overlay');
  const btnComplete = document.getElementById('btn-complete');

  if (btnStartOp) btnStartOp.addEventListener('click', startOperation);
  if (btnStartOpOverlay) btnStartOpOverlay.addEventListener('click', startOperation);
  if (startCallBtn) startCallBtn.addEventListener('click', startCall);
  if (endCallBtn) endCallBtn.addEventListener('click', endCall);

  // Bouton retour
  const btnBack = document.getElementById('btn-back');
  if (btnBack) {
    btnBack.addEventListener('click', (e) => {
      e.preventDefault();
      if (operationStarted) {
        if (!confirm('⚠️ Opération en cours !\n\nQuitter la salle maintenant ?')) return;
        const pd = JSON.parse(sessionStorage.getItem('currentPatient') || 'null');
        if (socket && pd?.id) {
          socket.emit('surgeon:leave-room', {
            patientId: pd.id,
            timestamp: new Date().toISOString()
          });
        }
        sessionStorage.removeItem('currentPatient');
        operationStarted = false;
        blockchainActive = false;
        updateOperationInfoPanel({
          patientId: '--',
          patientName: '--',
          patientStatus: '--'
        });
      }
      window.location.href = 'dashboard.html';
    });
  }

  // Bouton terminer
  if (btnComplete) {
    btnComplete.addEventListener('click', async () => {
      if (!confirm('⚠️ Terminer l\'opération ?\n\nCette action archivera le patient.')) return;
      const pd = JSON.parse(sessionStorage.getItem('currentPatient'));
      if (!pd) { alert('Aucun patient'); return; }

      try {
        blockchainActive = false;
        operationStarted = false;

        const response = await fetch(`${SERVER_URL}/api/patients/${pd.id}/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionStorage.getItem('token')}`
          }
        });
        if (!response.ok) throw new Error('Erreur terminaison');

        if (socket) {
          socket.emit('operation:end', { patientId: pd.id, timestamp: new Date().toISOString() });
        }

        alert('✅ Opération terminée avec succès');
        sessionStorage.removeItem('currentPatient');
        window.location.href = 'dashboard.html';
      } catch (error) {
        console.error('[APP] Erreur terminaison:', error);
        alert('❌ Erreur lors de la terminaison');
      }
    });
  }

  // Presets
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

  // Resize
  window.addEventListener('resize', handleResize);
  handleResize();

  // Nettoyage à la fermeture
  window.addEventListener('beforeunload', cleanupAll);
});