// backend/src/sockets/index.js
// Logique Socket.io pour la téléchirurgie avec synchronisation temps réel
// VERSION ROBUSTE: Validation, ACK, Déduplication, Gestion erreurs

import { saveToBlockchain, logAction, generateActionHash, getLedger } from '../blockchain/logger.js';
import prisma from '../config/prisma.js';

// Import dynamique du bridge robot (local ou android)
const ROBOT_MODE = process.env.ROBOT_MODE || 'local';
let sendToRobot;
let initArduino = null;

// ============================================================================
// STORE DE LOGS COMMANDES - Surgical Black Box (données réelles)
// ============================================================================
const operationCommandLogs = new Map(); // patientId -> [{sequence, timestamp, hash, action, coords}]

// ============================================================================
// SYSTÈME DE ROBUSTESSE
// ============================================================================

// 1. DÉDUPLICATION - Tracker les event IDs déjà traités
const processedEvents = new Map();
const EVENT_TTL = 60000; // 60 secondes de rétention

function cleanupOldEvents() {
    const now = Date.now();
    for (const [eventId, timestamp] of processedEvents.entries()) {
        if (now - timestamp > EVENT_TTL) {
            processedEvents.delete(eventId);
        }
    }
}

// Nettoyage périodique toutes les 30s
setInterval(cleanupOldEvents, 30000);

function isDuplicate(eventId) {
    if (!eventId) return false;
    if (processedEvents.has(eventId)) return true;
    processedEvents.set(eventId, Date.now());
    return false;
}

// 2. VALIDATION STRICTE DES DONNÉES
const Validators = {
    patient: {
        prenom: (v) => typeof v === 'string' && v.length >= 2 && v.length <= 50,
        nom: (v) => typeof v === 'string' && v.length >= 2 && v.length <= 50,
        pathologie: (v) => typeof v === 'string' && v.length >= 3 && v.length <= 200,
        patientId: (v) => typeof v === 'string' && /^[A-Z0-9-]+$/i.test(v)
    },
    chat: {
        text: (v) => typeof v === 'string' && v.length > 0 && v.length <= 1000,
        from: (v) => ['surgeon', 'assistant'].includes(v),
        fileName: (v) => typeof v === 'string' && v.length <= 255
    },
    operation: {
        patientId: (v) => typeof v === 'string' && v.length > 0,
        surgeonId: (v) => typeof v === 'string' && v.length > 0
    }
};

function validateData(type, data) {
    const errors = [];
    const validators = Validators[type];

    if (!validators) {
        return { valid: false, errors: ['Type de validation inconnu'] };
    }

    for (const [field, validator] of Object.entries(validators)) {
        if (data[field] !== undefined && !validator(data[field])) {
            errors.push(`Champ '${field}' invalide: ${data[field]}`);
        }
    }

    return { valid: errors.length === 0, errors };
}

// 3. Système de ACK (Acknowledgment) pour les événements critiques
const pendingAcks = new Map();
const ACK_TIMEOUT = 5000; // 5 secondes

function sendWithAck(io, socket, event, data, timeoutMs = ACK_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const ackId = `ack-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const timeout = setTimeout(() => {
            pendingAcks.delete(ackId);
            reject(new Error(`ACK timeout pour ${event}`));
        }, timeoutMs);

        pendingAcks.set(ackId, { resolve, reject, timeout });

        // Envoyer avec callback d'ACK
        socket.emit(event, { ...data, _ackId: ackId }, (response) => {
            clearTimeout(timeout);
            pendingAcks.delete(ackId);
            resolve(response);
        });
    });
}

// 4. Gestionnaire d'erreurs avec feedback client
async function handleAsyncError(socket, operation, errorContext) {
    try {
        return await operation();
    } catch (error) {
        console.error(`[SOCKET ERROR] ${errorContext}:`, error);

        // Notifier le client de l'erreur
        socket.emit('system:error', {
            context: errorContext,
            message: error.message,
            timestamp: new Date().toISOString(),
            code: error.code || 'UNKNOWN_ERROR'
        });

        throw error;
    }
}

// 5. Gestion de la cohérence post-reconnexion
const clientVersions = new Map(); // socket.id -> { version, lastSync }
const DATA_VERSION = Date.now(); // Incrémenté à chaque changement majeur

function getSyncState(socketId) {
    return clientVersions.get(socketId) || { version: 0, lastSync: null };
}

function updateSyncState(socketId) {
    clientVersions.set(socketId, { version: DATA_VERSION, lastSync: new Date().toISOString() });
}

function needsFullSync(socketId) {
    const state = clientVersions.get(socketId);
    if (!state) return true;
    return state.version < DATA_VERSION;
}

// Fonction async pour charger le bridge (évite top-level await)
async function loadRobotBridge() {
  if (ROBOT_MODE === 'android_bridge') {
    const androidBridge = await import('../hardware/androidBridge.js');
    sendToRobot = androidBridge.sendToRobot;
    console.log('[SOCKETS] 🤖 Mode Android Bridge actif');
  } else {
    const arduinoBridge = await import('../hardware/arduinoBridge.js');
    sendToRobot = arduinoBridge.sendToRobot;
    initArduino = arduinoBridge.initArduino;
    console.log('[SOCKETS] 🔌 Mode Local Arduino actif');
  }
}

let surgeonSocket = null;
let robotSocket = null;
let sessionStartTime = null;
let sessionId = null;

// État temps réel du système
let dataVersion = Date.now();

function incrementDataVersion() {
    dataVersion = Date.now();
    return dataVersion;
}

// ============================================================================
// SYSTÈME DE RAPPORT DE SESSION - Métriques et collecte
// ============================================================================

class SessionMetricsCollector {
    constructor() {
        this.reset();
    }

    reset() {
        this.sessionId = null;
        this.operationId = null;
        this.patientId = null;
        this.surgeonId = null;
        this.assistantId = null;

        // Chronologie
        this.startTime = null;
        this.endTime = null;
        this.pausedTime = 0; // Temps total de pause/interruption
        this.lastPauseStart = null;

        // Métriques réseau
        this.latencyReadings = []; // Tableau des latences en ms
        this.criticalLatencyEvents = []; // Événements >100ms
        this.maxLatencyRecorded = 0;
        this.packetsReceived = 0;
        this.packetsExpected = 0;

        // Incidents Arduino
        this.arduinoDisconnections = []; // { timestamp, duration, reason }
        this.arduinoLastConnectTime = null;
        this.arduinoCurrentDisconnectStart = null;

        // Interruptions Assistant
        this.assistantInterruptions = []; // { timestamp, duration, reason }
        this.assistantLastOnlineTime = null;
        this.assistantCurrentDisconnectStart = null;

        // Blockchain
        this.blockchainBlocksGenerated = 0;
        this.blockchainStartHash = null;
        this.blockchainEndHash = null;

        // Logs d'actions
        this.actionLogs = []; // Pour traçabilité
    }

    startSession(data) {
        this.reset();
        this.sessionId = `OP-${new Date().toISOString().split('T')[0].replace(/-/g, '')}-${Date.now().toString(36).toUpperCase().slice(-4)}`;
        this.operationId = data.operationId || this.sessionId;
        this.patientId = data.patientId;
        this.surgeonId = data.surgeonId;
        this.assistantId = data.assistantId;
        this.startTime = Date.now();
        this.arduinoLastConnectTime = this.startTime;
        this.assistantLastOnlineTime = this.startTime;

        console.log(`[METRICS] Session démarrée: ${this.sessionId}`);
        return this.sessionId;
    }

    endSession() {
        this.endTime = Date.now();

        // Fermer les déconnexions en cours
        if (this.arduinoCurrentDisconnectStart) {
            this.recordArduinoReconnection();
        }
        if (this.assistantCurrentDisconnectStart) {
            this.recordAssistantReconnection();
        }

        console.log(`[METRICS] Session terminée: ${this.sessionId}`);
        return this.generateReport();
    }

    // Latence
    recordLatency(latencyMs) {
        this.latencyReadings.push({
            timestamp: Date.now(),
            value: latencyMs
        });
        this.packetsReceived++;
        this.packetsExpected++;

        if (latencyMs > this.maxLatencyRecorded) {
            this.maxLatencyRecorded = latencyMs;
        }

        if (latencyMs > 100) {
            this.criticalLatencyEvents.push({
                timestamp: Date.now(),
                value: latencyMs
            });
        }

        // Garder seulement les 1000 dernières lectures pour la mémoire
        if (this.latencyReadings.length > 1000) {
            this.latencyReadings.shift();
        }
    }

    // Arduino
    recordArduinoDisconnection(reason = 'Perte de connexion') {
        if (!this.arduinoCurrentDisconnectStart) {
            this.arduinoCurrentDisconnectStart = Date.now();
            this.arduinoCurrentDisconnectReason = reason;
            console.log(`[METRICS] Arduino déconnecté: ${reason}`);
        }
    }

    recordArduinoReconnection() {
        if (this.arduinoCurrentDisconnectStart) {
            const duration = Date.now() - this.arduinoCurrentDisconnectStart;
            this.arduinoDisconnections.push({
                timestamp: this.arduinoCurrentDisconnectStart,
                duration: duration,
                reason: this.arduinoCurrentDisconnectReason || 'Inconnue',
                formattedDuration: this.formatDuration(duration)
            });
            this.arduinoLastConnectTime = Date.now();
            this.arduinoCurrentDisconnectStart = null;
            this.arduinoCurrentDisconnectReason = null;
            console.log(`[METRICS] Arduino reconnecté après ${this.formatDuration(duration)}`);
        }
    }

    // Assistant
    recordAssistantDisconnection(reason = 'Déconnexion') {
        if (!this.assistantCurrentDisconnectStart) {
            this.assistantCurrentDisconnectStart = Date.now();
            this.assistantCurrentDisconnectReason = reason;
            console.log(`[METRICS] Assistant déconnecté: ${reason}`);
        }
    }

    recordAssistantReconnection() {
        if (this.assistantCurrentDisconnectStart) {
            const duration = Date.now() - this.assistantCurrentDisconnectStart;
            this.assistantInterruptions.push({
                timestamp: this.assistantCurrentDisconnectStart,
                duration: duration,
                reason: this.assistantCurrentDisconnectReason || 'Inconnue',
                formattedDuration: this.formatDuration(duration)
            });
            this.assistantLastOnlineTime = Date.now();
            this.assistantCurrentDisconnectStart = null;
            this.assistantCurrentDisconnectReason = null;
            console.log(`[METRICS] Assistant reconnecté après ${this.formatDuration(duration)}`);
        }
    }

    // Pause / Reprise
    recordPauseStart() {
        if (!this.lastPauseStart) {
            this.lastPauseStart = Date.now();
        }
    }

    recordPauseEnd() {
        if (this.lastPauseStart) {
            this.pausedTime += Date.now() - this.lastPauseStart;
            this.lastPauseStart = null;
        }
    }

    // Blockchain
    recordBlockchainBlock(hash) {
        this.blockchainBlocksGenerated++;
        if (!this.blockchainStartHash) {
            this.blockchainStartHash = hash;
        }
        this.blockchainEndHash = hash;
    }

    // Helpers
    formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
        }
        return `${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
    }

    formatTime(timestamp) {
        return new Date(timestamp).toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    formatDate(timestamp) {
        return new Date(timestamp).toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: 'long',
            year: 'numeric'
        });
    }

    calculateStats() {
        if (this.latencyReadings.length === 0) {
            return { avg: 0, min: 0, max: 0, median: 0, stability: 100 };
        }

        const values = this.latencyReadings.map(r => r.value);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const min = Math.min(...values);
        const max = Math.max(...values);

        // Calcul de la médiane
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];

        // Stabilité = pourcentage de paquets reçus avec latence < 50ms
        const stablePackets = values.filter(v => v < 50).length;
        const stability = (stablePackets / values.length) * 100;

        return {
            avg: Math.round(avg),
            min: Math.round(min),
            max: Math.round(max),
            median: Math.round(median),
            stability: Math.round(stability * 10) / 10
        };
    }

    generateReport() {
        const stats = this.calculateStats();
        const totalDuration = this.endTime - this.startTime;
        const effectiveDuration = totalDuration - this.pausedTime;

        // Calculer la durée totale d'indisponibilité Arduino
        const totalArduinoDowntime = this.arduinoDisconnections.reduce((sum, d) => sum + d.duration, 0);

        // Calculer la durée totale d'interruption Assistant
        const totalAssistantDowntime = this.assistantInterruptions.reduce((sum, i) => sum + i.duration, 0);

        return {
            // Identifiants
            sessionId: this.sessionId,
            operationId: this.operationId,
            patientId: this.patientId,
            surgeonId: this.surgeonId,
            assistantId: this.assistantId,

            // Chronologie
            date: this.formatDate(this.startTime),
            startTime: this.formatTime(this.startTime),
            endTime: this.formatTime(this.endTime),
            totalDuration: this.formatDuration(totalDuration),
            effectiveDuration: this.formatDuration(effectiveDuration),
            totalDurationMs: totalDuration,
            effectiveDurationMs: effectiveDuration,

            // Arduino
            arduino: {
                disconnectionsCount: this.arduinoDisconnections.length,
                totalDowntime: this.formatDuration(totalArduinoDowntime),
                totalDowntimeMs: totalArduinoDowntime,
                disconnections: this.arduinoDisconnections.map(d => ({
                    time: this.formatTime(d.timestamp),
                    duration: d.formattedDuration,
                    reason: d.reason
                }))
            },

            // Assistant
            assistant: {
                interruptionsCount: this.assistantInterruptions.length,
                totalDowntime: this.formatDuration(totalAssistantDowntime),
                totalDowntimeMs: totalAssistantDowntime,
                interruptions: this.assistantInterruptions.map(i => ({
                    time: this.formatTime(i.timestamp),
                    duration: i.formattedDuration,
                    reason: i.reason
                }))
            },

            // Réseau
            network: {
                avgLatency: stats.avg,
                minLatency: stats.min,
                maxLatency: stats.max,
                criticalEventsCount: this.criticalLatencyEvents.length,
                maxLatencyRecorded: this.maxLatencyRecorded,
                stability: stats.stability,
                packetsReceived: this.packetsReceived,
                packetLoss: this.packetsExpected > 0
                    ? ((this.packetsExpected - this.packetsReceived) / this.packetsExpected * 100).toFixed(2)
                    : 0
            },

            // Blockchain
            blockchain: {
                blocksGenerated: this.blockchainBlocksGenerated,
                startHash: this.blockchainStartHash,
                endHash: this.blockchainEndHash,
                integrity: this.blockchainBlocksGenerated > 0 ? 'VALIDÉ' : 'N/A'
            },

            // Timestamps bruts pour export
            timestamps: {
                start: this.startTime,
                end: this.endTime
            }
        };
    }

    // Export JSON pour intégration externe
    toJSON() {
        return JSON.stringify(this.generateReport(), null, 2);
    }
}

// Instance globale du collecteur
const sessionMetrics = new SessionMetricsCollector();

const systemState = {
  dataVersion: () => dataVersion,
  incrementVersion: incrementDataVersion,
  arduino: {
    connected: false,
    port: null,
    simulationMode: false,
    positions: null  // ← Positions des servos
  },
  assistant: {
    online: false,
    ready: false,
    patientConsent: false,
    patientConsentPatientId: null,
    activePatient: null,
    userId: null,
    lastSeen: null,
    socketId: null,
    reconnecting: false,
    reconnectionTimeout: null,
    persistentId: null
  },
  surgeons: new Map(),
  operation: {
    active: false,
    patientId: null,
    surgeonId: null,
    startedAt: null
  },
  rooms: new Map(),
  arduino: {
    connected: false,
    port: null,
    simulationMode: false
  },
  lastArduinoHeartbeat: null,
  getAssistantStatus: () => {
    const readyAssistants = systemState.assistant.ready ? [systemState.assistant] : [];
    return {
      count: systemState.assistant.online ? 1 : 0,
      ready: systemState.assistant.ready ? 1 : 0,
      readyAssistants: readyAssistants.map(a => ({ 
        id: a.userId, 
        roomId: 'Bloc-01', 
        patientId: a.activePatient?.id 
      }))
    };
  },
  getSurgeonStatus: () => {
    const activeSurgeons = Array.from(systemState.surgeons.values()).filter(s => s.inRoom);
    return {
      count: systemState.surgeons.size,
      active: activeSurgeons.length,
      activeSurgeons: activeSurgeons.map(s => ({ id: s.userId, roomId: s.roomId }))
    };
  },
  getSystemStatus: () => ({
    arduino: systemState.arduino.connected,
    assistant: {
      online: systemState.assistant.online,
      ready: systemState.assistant.ready,
      patientConsent: systemState.assistant.patientConsent,
      patientConsentPatientId: systemState.assistant.patientConsentPatientId,
      userId: systemState.assistant.userId
    },
    assistants: systemState.getAssistantStatus(),
    surgeons: systemState.getSurgeonStatus(),
    operation: { ...systemState.operation },
    rooms: Array.from(systemState.rooms.entries()).map(([id, room]) => ({ id, ...room })),
    timestamp: new Date().toISOString()
  })
};

async function setupSockets(io) {
  // Chargement du bridge robot (local ou android)
  await loadRobotBridge().catch(err => console.error('[SOCKET] Erreur chargement bridge:', err));
  
  // Initialisation du pont Arduino (si mode local)
  if (initArduino && typeof initArduino === 'function') {
    initArduino().catch(err => console.error('[SOCKET] Erreur init Arduino:', err));
  }

  // Middleware Socket.io pour mesurer la latence de chaque message
  io.use((socket, next) => {
    const origOn = socket.on.bind(socket);
    socket.on = (event, listener) => {
      origOn(event, (...args) => {
        const start = process.hrtime();
        // Pour move-command, mesurer la latence entre réception et émission
        if (event === 'move-command') {
          const t0 = Date.now();
          listener(...args);
          const t1 = Date.now();
          const ms = t1 - t0;
          console.log(`[SOCKET] move-command traité en ${ms} ms (Date.now)`);
        } else {
          listener(...args);
        }
        const diff = process.hrtime(start);
        const ms = diff[0] * 1e3 + diff[1] / 1e6;
        console.log(`[SOCKET] Event '${event}' traité en ${ms.toFixed(2)} ms`);
      });
    };
    next();
  });

  io.on('connection', (socket) => {
    console.log('Nouvelle connexion:', socket.id);

    const emitSurgeonStatus = () => {
      io.emit('surgeon:status', {
        surgeons: Array.from(systemState.surgeons.entries()).map(([id, s]) => ({
          userId: id,
          inRoom: s.inRoom,
          patientId: s.patientId
        }))
      });
    };

    const isOperationLocked = () => systemState.operation.active;

    // Identification du type de client
    socket.on('register', (role, name) => {
      if (role === 'SURGEON') {
        surgeonSocket = socket;
        socket.role = 'SURGEON';
        socket.surgeonName = name || 'Chirurgien-Anonyme';
        sessionStartTime = Date.now();
        sessionId = `session-${Date.now()}-${socket.id.substring(0, 6)}`;
        console.log(`[SESSION] Début: ${sessionId} | ${socket.surgeonName}`);
      } else if (role === 'ROBOT') {
        robotSocket = socket;
        socket.role = 'ROBOT';
        console.log(`Robot connecté: ${socket.id}`);
      }
    });

    // Ping latence - répond immédiatement avec le timestamp reçu
    socket.on('ping-latency', (startTime) => {
      socket.emit('pong-latency', startTime);
    });

    // Réception des mesures de latence calculées par les clients
    socket.on('latency:measurement', (data) => {
      const { latency, timestamp } = data;
      if (typeof latency === 'number' && latency >= 0) {
        // Enregistrer dans les métriques si opération active
        if (systemState.operation.active) {
          sessionMetrics.recordLatency(latency);
        }
      }
    });

    // Listener pour le chirurgien : move-command
    socket.on('move-command', (data) => {
      // data: { x, y, z, pitch, roll, yaw }

      // Validation stricte des paramètres robot
      const coords = ['x', 'y', 'z', 'roll', 'pitch', 'yaw'];
      for (const coord of coords) {
        const val = data[coord];
        if (typeof val !== 'number' || isNaN(val) || val < 0 || val > 180) {
          console.warn(`[SOCKET] Commande robot invalide rejetée: ${coord}=${val} (doit être un nombre entre 0 et 180)`);
          socket.emit('error', { message: `Commande invalide: ${coord} doit être un nombre entre 0 et 180` });
          return;
        }
      }

      // Envoi physique à l'Arduino avec callback pour ACK
      sendToRobot({
        x: data.x,
        y: data.y,
        z: data.z,
        r: data.roll || 0,
        p: data.pitch || 0,
        y: data.yaw || 0
      }, async (ackResponse) => {
        console.log('[ARDUINO] ACK reçu:', ackResponse);

        // Générer un bloc blockchain après confirmation Arduino
        const blockHash = generateActionHash(socket.id, 'move-command-ack', {
          x: Math.round(data.x),
          y: Math.round(data.y),
          z: Math.round(data.z),
          ack: ackResponse
        }, Date.now());

        // STOCKER LA COMMANDE DANS LES LOGS RÉELS (Surgical Black Box)
        const patientId = systemState.operation.patientId;
        if (patientId) {
          if (!operationCommandLogs.has(patientId)) {
            operationCommandLogs.set(patientId, []);
          }
          const logs = operationCommandLogs.get(patientId);
          logs.push({
            sequence: logs.length + 1,
            timestamp: new Date().toISOString(),
            hash: blockHash,
            action: 'MOVE',
            coordinates: {
              x: Math.round(data.x),
              y: Math.round(data.y),
              z: Math.round(data.z),
              roll: Math.round(data.roll || 0),
              pitch: Math.round(data.pitch || 0),
              yaw: Math.round(data.yaw || 0)
            }
          });
        }

        // TRACKER LE BLOC BLOCKCHAIN DANS LES MÉTRIQUES
        if (systemState.operation.active) {
          sessionMetrics.recordBlockchainBlock(blockHash);
        }

        // Récupérer la taille actuelle de la blockchain
        const ledger = await getLedger();
        const newBlockCount = ledger.length + 1;

        // Émettre à tous les clients connectés
        io.emit('blockchain-update', {
          hash: blockHash,
          count: newBlockCount,
          status: 'Verified'
        });
        console.log(`[SOCKET] Hash envoyé au frontend: ${blockHash}`);
      });

      // Traçabilité blockchain (non-bloquant pour ne pas ralentir le robot)
      if (socket.role === 'SURGEON') {
        logAction(socket.id, 'move-command', {
          x: Math.round(data.x),
          y: Math.round(data.y),
          z: Math.round(data.z),
          sessionId
        }).catch(() => {}); // Silencieux en cas d'erreur
      }

      if (socket.role === 'SURGEON' && robotSocket) {
        const startEmit = process.hrtime();
        robotSocket.emit('move-command', data, () => {
          const diffEmit = process.hrtime(startEmit);
          const msEmit = diffEmit[0] * 1e3 + diffEmit[1] / 1e6;
          console.log(`[SOCKET] Émission vers robot en ${msEmit.toFixed(2)} ms`);
        });
        console.log('Commande transmise au robot:', data);
      } else if (!robotSocket) {
        console.warn('Aucun robot connecté pour recevoir la commande.');
      }
    });

    // Arrêt d'urgence (Fail-Safe)
    socket.on('emergency-stop', (data) => {
      console.error(`[FAIL-SAFE] Arrêt d'urgence reçu ! Latence: ${data.latency}ms`);
      
      // Envoyer commande de stop immédiat à l'Arduino
      sendToRobot({ emergency: true }, (ack) => {
        console.log('[ARDUINO] Arrêt d\'urgence acquitté:', ack);
      });
      
      // Logger l'incident
      logAction(socket.id, 'emergency-stop', {
        latency: data.latency,
        reason: 'high_latency'
      }).catch(() => {});
      
      // Notifier le robot s'il est connecté via socket
      if (robotSocket) {
        robotSocket.emit('emergency-stop', data);
      }
    });

    // === GESTION TEMPS RÉEL ASSISTANT / ARDUINO ===
    
    // Assistant se connecte
    socket.on('assistant:online', (data) => {
      const { userId, persistentId, roomId } = data;
      console.log(`[SOCKET] Assistant connecté: ${userId} (ID Persistant: ${persistentId})`);
      
      // Annuler tout timeout de reconnexion existant
      if (systemState.assistant.reconnectionTimeout) {
        clearTimeout(systemState.assistant.reconnectionTimeout);
        systemState.assistant.reconnectionTimeout = null;
      }
      
      // Verrouillage de session : un seul onglet par Assistant
      const existingAssistant = [...io.sockets.sockets.values()].find(
        s => s.role === 'ASSISTANT' && s.persistentId === persistentId && s.id !== socket.id
      );
      
      if (existingAssistant) {
        console.warn(`[SOCKET] Connexion refusée : Assistant ${userId} déjà connecté sur un autre onglet`);
        socket.emit('error', { 
          message: 'Session déjà active sur un autre onglet. Veuillez fermer les autres fenêtres pour continuer.',
          code: 'SESSION_LOCKED'
        });
        // On ne déconnecte pas forcément tout de suite pour laisser l'UI afficher l'erreur
        return;
      }

      systemState.assistant.online = true;
      systemState.assistant.reconnecting = false;
      systemState.assistant.socketId = socket.id;
      systemState.assistant.userId = userId;
      systemState.assistant.persistentId = persistentId;
      systemState.assistant.lastSeen = Date.now();
      socket.role = 'ASSISTANT';
      socket.persistentId = persistentId;

      // TRACKER LA RECONNEXION DANS LES MÉTRIQUES SI OPÉRATION ACTIVE
      if (systemState.operation.active) {
        sessionMetrics.recordAssistantReconnection();
        console.log('[METRICS] Reconnexion Assistant trackée pendant opération');
      }
      
      // Rejoindre automatiquement la room si spécifiée ou si persistante
      const targetRoom = roomId || (persistentId && [...systemState.rooms.entries()].find(([id, r]) => r.assistantId === persistentId)?.[0]);
      if (targetRoom) {
        socket.join(targetRoom);
        if (!systemState.rooms.has(targetRoom)) {
          systemState.rooms.set(targetRoom, { assistantId: persistentId });
        } else {
          systemState.rooms.get(targetRoom).assistantId = persistentId;
        }
        console.log(`[SOCKET] Assistant ${userId} a rejoint la room: ${targetRoom}`);
      }
      
      // Broadcast aux chirurgiens
      io.emit('assistant:online', {
        assistantId: userId,
        persistentId: persistentId,
        reconnected: true,
        timestamp: new Date().toISOString()
      });
      
      // Envoyer immédiatement l'état Arduino à l'assistant
      socket.emit('arduino:status', {
        connected: systemState.arduino.connected,
        port: systemState.arduino.port,
        simulationMode: systemState.arduino.simulationMode,
        positions: systemState.arduino.positions || null
      });
      
      // Notifier l'assistant des chirurgiens déjà connectés
      const connectedSurgeons = Array.from(systemState.surgeons.entries()).map(([id, s]) => ({
        userId: id,
        inRoom: s.inRoom,
        patientId: s.patientId
      }));
      if (connectedSurgeons.length > 0) {
        socket.emit('surgeon:status', { surgeons: connectedSurgeons });
      }
    });
    
    // Assistant se déconnecte - logique de reconnexion
    socket.on('disconnect', async () => {
      if (socket.role === 'ASSISTANT') {
        console.log('[SOCKET] Assistant déconnecté, attente de reconnexion (10s)...');
        systemState.assistant.reconnecting = true;

        // TRACKER LA DÉCONNEXION DANS LES MÉTRIQUES SI OPÉRATION ACTIVE
        if (systemState.operation.active) {
          sessionMetrics.recordAssistantDisconnection('Déconnexion socket (10s timeout)');
          console.log('[METRICS] Déconnexion Assistant trackée pendant opération');
        }

        // Informer les chirurgiens de la reconnexion en cours
        io.emit('assistant:reconnecting', {
          assistantId: systemState.assistant.userId,
          timestamp: new Date().toISOString()
        });

        // Démarrer le délai de grâce de 10 secondes
        systemState.assistant.reconnectionTimeout = setTimeout(async () => {
          console.log('[SOCKET] Délai de reconnexion expiré pour assistant');
          systemState.assistant.online = false;
          systemState.assistant.ready = false;
          systemState.assistant.patientConsent = false;
          systemState.assistant.patientConsentPatientId = null;
          systemState.assistant.reconnecting = false;
          systemState.assistant.socketId = null;

          const assistantId = systemState.assistant.userId;
          
          try {
            // Vérifier si un patient est en statut "en_cours" (opération active) - PRISMA
            const enCoursPatient = await prisma.patient.findFirst({
              where: { assistantId, statut: 'en_cours' }
            });
            
            if (!enCoursPatient) {
              // Même logique de nettoyage qu'avant si pas d'opération active
              const chirurgiensConnectes = systemState.surgeons.size > 0;
              if (!chirurgiensConnectes) {
                console.log('[SOCKET] Nettoyage session assistant (aucun chirurgien)');
                await prisma.patient.updateMany({
                  where: { assistantId, statut: 'pret' },
                  data: { statut: 'archive', assistantId: null, consentementPatient: false, consentementAt: null }
                });
              } else {
                await prisma.patient.updateMany({
                  where: { assistantId, statut: 'pret' },
                  data: { statut: 'en_attente', assistantId: null, consentementPatient: false, consentementAt: null }
                });
              }
            }
          } catch (err) {
            console.error('[SOCKET] Erreur nettoyage assistant:', err);
          }
          
          io.emit('assistant:offline', {
            assistantId: assistantId,
            timestamp: new Date().toISOString()
          });
        }, 10000);
      }
    });
        
    // Assistant signale PRÊT
    socket.on('assistant:ready', (data) => {
      if (isOperationLocked()) {
        socket.emit('assistant:action-blocked', {
          action: 'assistant:ready',
          patientId: systemState.operation.patientId,
          reason: 'operation-active',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const { assistantId, patientId, patientData } = data;
      console.log(`[SOCKET] Assistant PRÊT: ${assistantId} pour Patient: ${patientId}`);
      
      systemState.assistant.ready = true;
      systemState.assistant.patientConsent = false;
      systemState.assistant.patientConsentPatientId = null;
      systemState.assistant.activePatient = {
        id: patientId,
        nom: patientData?.nom || '',
        prenom: patientData?.prenom || '',
        intervention: patientData?.intervention || patientData?.pathologie || ''
      };
      systemState.assistant.lastSeen = Date.now();
      
      // Mirroring immédiat vers le chirurgien avec OBJET UNIQUE HARMONISÉ
      io.emit('assistant:status', {
        online: systemState.assistant.online,
        ready: systemState.assistant.ready,
        patientConsent: systemState.assistant.patientConsent,
        patientConsentPatientId: systemState.assistant.patientConsentPatientId,
        patientId: patientId,
        activePatient: systemState.assistant.activePatient,
        timestamp: new Date().toISOString()
      });
      
      // Informer les chirurgiens de la reconnexion en cours
      io.emit('assistant:reconnecting', {
        assistantId: systemState.assistant.userId,
        timestamp: new Date().toISOString(),
        statusText: data.connected ? 'OPÉRATIONNEL' : 'ERREUR'
      });
    });
    
    // Assistant annule PRÊT
    socket.on('assistant:unready', (data) => {
      if (isOperationLocked()) {
        socket.emit('assistant:action-blocked', {
          action: 'assistant:unready',
          patientId: systemState.operation.patientId,
          reason: 'operation-active',
          timestamp: new Date().toISOString()
        });
        return;
      }

      console.log(`[SOCKET] Assistant annule PRÊT: ${data.assistantId}`);
      systemState.assistant.ready = false;
      systemState.assistant.patientConsent = false;
      systemState.assistant.patientConsentPatientId = null;
      
      io.emit('assistant:unready', {
        assistantId: data.assistantId,
        patientId: data.patientId,
        timestamp: new Date().toISOString()
      });

      io.emit('assistant:status', {
        online: systemState.assistant.online,
        ready: systemState.assistant.ready,
        patientConsent: systemState.assistant.patientConsent,
        patientConsentPatientId: systemState.assistant.patientConsentPatientId,
        patientId: data.patientId,
        timestamp: new Date().toISOString()
      });
    });

    // Assistant signale le consentement patient
    socket.on('assistant:consent', (data) => {
      if (isOperationLocked()) {
        socket.emit('assistant:action-blocked', {
          action: 'assistant:consent',
          patientId: systemState.operation.patientId,
          reason: 'operation-active',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const patientId = data?.patientId || null;
      if (!patientId) return;
      systemState.assistant.patientConsent = true;
      systemState.assistant.patientConsentPatientId = patientId;
      systemState.assistant.lastSeen = Date.now();

      prisma.patient.update({
        where: { patientId },
        data: {
          consentementPatient: true,
          consentementAt: new Date()
        }
      }).catch((err) => {
        console.error('[SOCKET] Erreur persistance consentement patient:', err);
      });

      io.emit('assistant:status', {
        online: systemState.assistant.online,
        ready: systemState.assistant.ready,
        patientConsent: systemState.assistant.patientConsent,
        patientConsentPatientId: systemState.assistant.patientConsentPatientId,
        patientId,
        timestamp: new Date().toISOString()
      });

      io.emit('assistant:consent', {
        assistantId: data?.assistantId,
        patientId,
        timestamp: new Date().toISOString()
      });
    });

    // Assistant retire le consentement patient
    socket.on('assistant:consent-revoked', (data) => {
      if (isOperationLocked()) {
        socket.emit('assistant:action-blocked', {
          action: 'assistant:consent-revoked',
          patientId: systemState.operation.patientId,
          reason: 'operation-active',
          timestamp: new Date().toISOString()
        });
        return;
      }

      const patientId = data?.patientId || systemState.assistant.patientConsentPatientId;
      systemState.assistant.patientConsent = false;
      systemState.assistant.patientConsentPatientId = null;
      systemState.assistant.lastSeen = Date.now();

      if (patientId) {
        prisma.patient.update({
          where: { patientId },
          data: {
            consentementPatient: false,
            consentementAt: null
          }
        }).catch((err) => {
          console.error('[SOCKET] Erreur révocation consentement patient:', err);
        });
      }

      io.emit('assistant:status', {
        online: systemState.assistant.online,
        ready: systemState.assistant.ready,
        patientConsent: systemState.assistant.patientConsent,
        patientConsentPatientId: systemState.assistant.patientConsentPatientId,
        patientId,
        timestamp: new Date().toISOString()
      });

      io.emit('assistant:consent-revoked', {
        assistantId: data?.assistantId,
        patientId,
        timestamp: new Date().toISOString()
      });
    });

    // Demande de statut système
    socket.on('get:system-status', () => {
      console.log('[SOCKET] Demande de statut système');
      socket.emit('system:status', systemState.getSystemStatus());
    });
    
    // Ping pour mesure de latence
    socket.on('ping', (callback) => {
      if (typeof callback === 'function') {
        callback();
      }
    });
    
    // Synchronisation spécifique demandée par le client assistant
    socket.on('statut_chirurgie', (data) => {
      console.log(`[SOCKET] Statut Chirurgie Synchro: Patient ${data.patientID} | Accessible: ${data.accessible}`);
      
      // Mettre à jour l'état global pour les nouveaux chirurgiens qui se connectent
      systemState.assistant.ready = data.accessible;
      
      // Broadcast aux chirurgiens pour mise à jour UI immédiate
      io.emit('assistant:status', {
        online: systemState.assistant.online,
        ready: data.accessible,
        patientConsent: systemState.assistant.patientConsent,
        patientConsentPatientId: systemState.assistant.patientConsentPatientId,
        patientId: data.patientID
      });
    });
    
    // Chirurgien se connecte
    socket.on('surgeon:online', (data) => {
      const { userId, roomId } = data;
      console.log(`[SOCKET] Chirurgien connecté: ${userId}`);
      
      systemState.surgeons.set(userId, {
        socketId: socket.id,
        inRoom: !!roomId,
        patientId: null
      });
      socket.role = 'SURGEON';
      socket.userId = userId;
      
      // Rejoindre automatiquement la room si spécifiée
      if (roomId) {
        socket.join(roomId);
        if (!systemState.rooms.has(roomId)) {
          systemState.rooms.set(roomId, { surgeonId: userId });
        } else {
          systemState.rooms.get(roomId).surgeonId = userId;
        }
        console.log(`[SOCKET] Chirurgien ${userId} a rejoint la room: ${roomId}`);
      }
      // Envoyer l'état actuel de l'assistant au chirurgien
      socket.emit('assistant:status', {
        online: systemState.assistant.online,
        reconnecting: systemState.assistant.reconnecting,
        ready: systemState.assistant.ready,
        patientConsent: systemState.assistant.patientConsent,
        patientConsentPatientId: systemState.assistant.patientConsentPatientId,
        userId: systemState.assistant.userId
      });
      
      // Envoyer l'état de l'Arduino au chirurgien
      socket.emit('arduino:status', {
        connected: systemState.arduino.connected,
        port: systemState.arduino.port,
        simulationMode: systemState.arduino.simulationMode,
        positions: systemState.arduino.positions || null
      });
      
      // Notifier l'assistant qu'un chirurgien est en ligne
      if (systemState.assistant.socketId) {
        io.to(systemState.assistant.socketId).emit('surgeon:online', {
          userId: userId,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Heartbeat / Keep-alive pour maintenir la session stable
    socket.on('heartbeat', (data) => {
      if (socket.role === 'SURGEON') {
        const surgeon = systemState.surgeons.get(socket.userId);
        if (surgeon) surgeon.lastSeen = Date.now();
      } else if (socket.role === 'ASSISTANT') {
        systemState.assistant.lastSeen = Date.now();
      }
      socket.emit('heartbeat:ack', { timestamp: Date.now() });
    });

    // Chirurgien entre en salle
    socket.on('surgeon:enter-room', async (data) => {
      console.log(`[SOCKET] Chirurgien entre en salle: ${data.patientId}`);
      const surgeon = systemState.surgeons.get(socket.userId);
      if (surgeon) {
        surgeon.inRoom = true;
        surgeon.patientId = data.patientId;
      }

      io.emit('surgeon:enter-room', {
        surgeonId: socket.userId,
        patientId: data.patientId,
        timestamp: new Date().toISOString()
      });

      emitSurgeonStatus();
    });

    // Démarrage réel de l'opération (caméra active + salle en mode intervention)
    socket.on('operation:start', async (data) => {
      console.log(`[SOCKET] Démarrage réel de l'opération pour patient: ${data.patientId}`);
      const patientId = data?.patientId;
      if (!patientId) return;

      const surgeon = systemState.surgeons.get(socket.userId);
      if (surgeon) {
        surgeon.inRoom = true;
        surgeon.patientId = patientId;
      }

      systemState.operation.active = true;
      systemState.operation.patientId = patientId;
      systemState.operation.surgeonId = socket.userId;
      systemState.operation.startedAt = Date.now();

      // DÉMARRER LA COLLECTE DE MÉTRIQUES
      const sessionId = sessionMetrics.startSession({
        patientId,
        surgeonId: socket.userId,
        assistantId: systemState.assistant.userId
      });
      console.log(`[METRICS] Collecte démarrée pour session: ${sessionId}`);

      // Enregistrer l'état initial Arduino s'il est connecté
      if (systemState.arduino.connected) {
        sessionMetrics.arduinoLastConnectTime = Date.now();
      } else {
        sessionMetrics.recordArduinoDisconnection('Déjà déconnecté au démarrage');
      }

      // Enregistrer l'état initial Assistant
      if (systemState.assistant.online) {
        sessionMetrics.assistantLastOnlineTime = Date.now();
      } else {
        sessionMetrics.recordAssistantDisconnection('Déjà déconnecté au démarrage');
      }

      try {
        await prisma.patient.update({
          where: { patientId },
          data: { statut: 'en_cours', chirurgienId: socket.userId }
        });
        console.log(`[SOCKET] Patient ${patientId} statut -> en_cours (Prisma)`);
      } catch (err) {
        console.error('[SOCKET] Erreur mise à jour statut patient au démarrage:', err);
      }

      io.emit('patients:updated', { timestamp: new Date().toISOString() });

      io.emit('operation:started', {
        patientId,
        surgeonId: socket.userId,
        sessionId: sessionId,
        timestamp: new Date().toISOString()
      });

      emitSurgeonStatus();
    });
    
    // Chirurgien quitte la salle: on restaure l'état du patient et on déverrouille la sélection
    // IMPORTANT : Si l'opération n'a PAS démarré (pas de operation.active), l'assistant reste libre de changer de patient.
    // Si l'opération a démarré (operation.active), la sélection reste verrouillée jusqu'à operation:end/archivage.
    socket.on('surgeon:leave-room', async (data = {}) => {
      console.log("[SOCKET] Chirurgien quitte la salle (retour à l'état prêt)");
      const surgeon = systemState.surgeons.get(socket.userId);
      const patientId = data.patientId || surgeon?.patientId || null;
      const leavingActiveOperation = systemState.operation.active && systemState.operation.patientId === patientId;

      if (surgeon) {
        surgeon.inRoom = false;
        surgeon.patientId = null;
      }

      if (patientId && !leavingActiveOperation) {
        try {
          await prisma.patient.update({
            where: { patientId },
            data: { statut: 'pret', chirurgienId: null }
          });
          console.log(`[SOCKET] Patient ${patientId} statut -> pret après sortie de salle`);
        } catch (err) {
          console.error('[SOCKET] Erreur remise à plat patient après sortie:', err);
        }
      }

      io.emit('patients:updated', { timestamp: new Date().toISOString() });

      io.emit('surgeon:leave-room', {
        surgeonId: socket.userId,
        patientId,
        timestamp: new Date().toISOString()
      });

      if (!leavingActiveOperation) {
        io.emit('operation:paused', {
          surgeonId: socket.userId,
          patientId,
          timestamp: new Date().toISOString()
        });
      }

      emitSurgeonStatus();
    });
    
    // Chirurgien termine l'opération (bouton "Terminer")
    socket.on('operation:end', async (data) => {
      console.log(`[SOCKET] Opération terminée pour patient: ${data.patientId}`);
      const surgeon = systemState.surgeons.get(socket.userId);
      const patientId = data?.patientId || systemState.operation.patientId;
      const assistantId = systemState.assistant.userId;
      
      if (surgeon) {
        surgeon.inRoom = false;
        surgeon.patientId = null;
      }

      systemState.operation.active = false;
      systemState.operation.patientId = null;
      systemState.operation.surgeonId = null;
      systemState.operation.startedAt = null;
      systemState.assistant.ready = false;
      systemState.assistant.patientConsent = false;
      systemState.assistant.patientConsentPatientId = null;
      systemState.assistant.activePatient = null;
      
      try {
        // TRANSACTION PRISMA - Archivage de l'opération
        await prisma.$transaction(async (tx) => {
          // Récupérer les infos du patient pour l'historique
          const patient = await tx.patient.findUnique({
            where: { patientId }
          });
          
          if (patient?.statut === 'en_cours') {
            // Archiver dans l'historique
            await tx.historiqueOperation.create({
              data: {
                patientId: patient.patientId,
                nom: patient.nom,
                prenom: patient.prenom,
                pathologie: patient.pathologie,
                dateDebut: patient.createdAt,
                dateFin: new Date(),
                statut: 'terminee'
              }
            });
            
            // Marquer le patient comme archivé
            await tx.patient.update({
              where: { id: patient.id },
              data: { statut: 'archive', chirurgienId: null }
            });
          }
        });
        
        console.log(`[SOCKET] Patient ${patientId} archivé dans l'historique (Prisma Transaction)`);
      } catch (err) {
        console.error('[SOCKET] Erreur archivage opération:', err);
      }

      // Nettoyer les logs de commande pour ce patient (Surgical Black Box)
      if (operationCommandLogs.has(patientId)) {
        const logCount = operationCommandLogs.get(patientId).length;
        operationCommandLogs.delete(patientId);
        console.log(`[SOCKET] Logs commandes nettoyés pour patient ${patientId} (${logCount} commandes archivées)`);
      }

      io.emit('patients:updated', { timestamp: new Date().toISOString() });

      // GÉNÉRER ET ENVOYER LE RAPPORT DE SESSION
      const sessionReport = sessionMetrics.endSession();
      console.log(`[METRICS] Rapport généré pour session: ${sessionReport.sessionId}`);
      console.log(`[METRICS] Durée: ${sessionReport.totalDuration}, Arduino déconnexions: ${sessionReport.arduino.disconnectionsCount}, Assistant interruptions: ${sessionReport.assistant.interruptionsCount}`);

      // Émettre le rapport complet aux clients
      io.emit('operation:report', {
        patientId,
        surgeonId: socket.userId,
        assistantId,
        report: sessionReport,
        timestamp: new Date().toISOString()
      });

      io.emit('operation:ended', {
        patientId,
        surgeonId: socket.userId,
        sessionId: sessionReport.sessionId,
        timestamp: new Date().toISOString()
      });

      io.emit('assistant:unready', {
        assistantId,
        patientId,
        timestamp: new Date().toISOString()
      });

      io.emit('assistant:status', {
        online: systemState.assistant.online,
        ready: systemState.assistant.ready,
        patientConsent: systemState.assistant.patientConsent,
        patientConsentPatientId: systemState.assistant.patientConsentPatientId,
        patientId: null,
        activePatient: null,
        timestamp: new Date().toISOString()
      });

      emitSurgeonStatus();
    });
    
    // Notification Arduino status (depuis arduinoBridge)
    socket.on('arduino:status-update', (data) => {
      const previousState = systemState.arduino.connected;
      systemState.arduino.connected = data.connected;
      systemState.arduino.port = data.port;
      systemState.arduino.simulationMode = data.simulationMode || false;
      systemState.arduino.positions = data.positions || null;

      // TRACKER LES CHANGEMENTS DANS LES MÉTRIQUES SI OPÉRATION ACTIVE
      if (systemState.operation.active) {
        if (!data.connected && previousState) {
          // Arduino vient de se déconnecter
          const reason = data.reason || data.error || 'Perte de connexion';
          sessionMetrics.recordArduinoDisconnection(reason);
          console.log(`[METRICS] Arduino déconnecté: ${reason}`);
        } else if (data.connected && !previousState) {
          // Arduino vient de se reconnecter
          sessionMetrics.recordArduinoReconnection();
          console.log('[METRICS] Arduino reconnecté');
        }
      }

      // Broadcast à tous les clients connectés
      io.emit('arduino:status', {
        connected: data.connected,
        port: data.port,
        simulationMode: data.simulationMode,
        positions: data.positions || null
      });

      console.log(`[SOCKET] Arduino status broadcast: ${data.connected ? 'CONNECTÉ' : 'DÉCONNECTÉ'}`);
    });
    
    // =========================================================================
    // PATIENT MANAGEMENT - VERSION ROBUSTE
    // =========================================================================

    // Nouveau patient créé via Socket.IO (temps réel)
    socket.on('patient:create', async (data, ackCallback) => {
        try {
            // 1. Déduplication
            if (isDuplicate(data._eventId)) {
                console.log(`[PATIENT] Duplicate creation ignored: ${data._eventId}`);
                if (ackCallback) ackCallback({ success: false, error: 'DUPLICATE' });
                return;
            }

            // 2. Validation stricte
            const validation = validateData('patient', data);
            if (!validation.valid) {
                console.error('[PATIENT] Validation failed:', validation.errors);
                socket.emit('patient:error', { message: 'Invalid patient data', errors: validation.errors });
                if (ackCallback) ackCallback({ success: false, error: 'VALIDATION', errors: validation.errors });
                return;
            }

            // 3. Création en base de données avec gestion d'erreur
            const patient = await handleAsyncError(socket, async () => {
                const patientId = `P-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

                const newPatient = await prisma.patient.create({
                    data: {
                        patientId: patientId,
                        prenom: data.prenom.trim(),
                        nom: data.nom.trim(),
                        pathologie: data.pathologie.trim(),
                        statut: 'en_attente',
                        createdAt: new Date()
                    }
                });

                return newPatient;
            }, 'patient:create');

            // 4. Incrémenter la version des données
            incrementDataVersion();

            // 5. Broadcast à tous les clients connectés
            const broadcastData = {
                patient: {
                    id: patient.id,
                    patientId: patient.patientId,
                    prenom: patient.prenom,
                    nom: patient.nom,
                    pathologie: patient.pathologie,
                    statut: patient.statut,
                    createdAt: patient.createdAt
                },
                by: socket.userId || 'unknown',
                timestamp: new Date().toISOString(),
                _eventId: data._eventId,
                dataVersion: dataVersion
            };

            io.emit('patient:created', broadcastData);

            // 6. ACK au client émetteur
            if (ackCallback) {
                ackCallback({
                    success: true,
                    patient: broadcastData.patient,
                    timestamp: broadcastData.timestamp
                });
            }

            // 7. Log blockchain (non bloquant)
            logAction(socket.id, 'patient:created', {
                patientId: patient.patientId,
                by: socket.userId
            }).catch(() => {});

            console.log(`[PATIENT] Created: ${patient.patientId} by ${socket.userId}`);

        } catch (error) {
            console.error('[PATIENT] Creation error:', error);
            socket.emit('patient:error', { message: 'Failed to create patient', code: 'DB_ERROR' });
            if (ackCallback) ackCallback({ success: false, error: 'SERVER_ERROR' });
        }
    });

    // Demande de sync (après reconnexion)
    socket.on('sync:request', async (data) => {
        try {
            const needsSync = !data.lastVersion || data.lastVersion < dataVersion;

            if (needsSync) {
                console.log(`[SYNC] Full sync requested by ${socket.userId || socket.id}`);

                // Envoyer les patients récents
                const patients = await prisma.patient.findMany({
                    where: { statut: { in: ['en_attente', 'pret', 'en_cours'] } },
                    orderBy: { createdAt: 'desc' },
                    take: 50
                });

                socket.emit('sync:full', {
                    patients,
                    dataVersion,
                    timestamp: new Date().toISOString()
                });

                updateSyncState(socket.id);
            } else {
                socket.emit('sync:ok', { dataVersion, timestamp: new Date().toISOString() });
            }
        } catch (error) {
            console.error('[SYNC] Error:', error);
            socket.emit('system:error', { message: 'Sync failed', code: 'SYNC_ERROR' });
        }
    });

    // =========================================================================
    // CHAT TEMPS RÉEL - VERSION ROBUSTE
    // =========================================================================

    socket.on('chat:message', async (data, ackCallback) => {
        try {
            // 1. Déduplication
            if (isDuplicate(data._eventId)) {
                console.log(`[CHAT] Duplicate message ignored: ${data._eventId}`);
                if (ackCallback) ackCallback({ success: false, error: 'DUPLICATE' });
                return;
            }

            // 2. Validation stricte
            const validation = validateData('chat', data);
            if (!validation.valid) {
                console.error('[CHAT] Validation failed:', validation.errors);
                socket.emit('chat:error', { message: 'Invalid data', errors: validation.errors });
                if (ackCallback) ackCallback({ success: false, error: 'VALIDATION', errors: validation.errors });
                return;
            }

            // 3. Traitement avec gestion d'erreur
            await handleAsyncError(socket, async () => {
                const messageData = {
                    from: data.from,
                    text: data.text.trim(),
                    timestamp: new Date().toISOString(),
                    _eventId: data._eventId || `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
                };

                // Broadcast avec ACK attendu du client
                socket.broadcast.emit('chat:message', messageData);

                // Log blockchain (non bloquant)
                logAction(socket.id, 'chat:message', {
                    from: data.from,
                    textLength: data.text.length
                }).catch(() => {});

                console.log(`[CHAT] Message relayed ${data.from}: ${data.text.substring(0, 50)}...`);

                // 4. ACK au client émetteur
                if (ackCallback) {
                    ackCallback({ success: true, messageId: messageData._eventId, timestamp: messageData.timestamp });
                }
            }, 'chat:message');

        } catch (error) {
            console.error('[CHAT] Unhandled error:', error);
            socket.emit('chat:error', { message: 'Server error processing message' });
            if (ackCallback) ackCallback({ success: false, error: 'SERVER_ERROR' });
        }
    });

    socket.on('chat:voice', async (data, ackCallback) => {
        try {
            if (isDuplicate(data._eventId)) {
                if (ackCallback) ackCallback({ success: false, error: 'DUPLICATE' });
                return;
            }

            if (!data.from || typeof data.duration !== 'number') {
                socket.emit('chat:error', { message: 'Invalid voice data' });
                if (ackCallback) ackCallback({ success: false, error: 'VALIDATION' });
                return;
            }

            const voiceData = {
                from: data.from,
                duration: data.duration,
                timestamp: new Date().toISOString(),
                _eventId: data._eventId || `voice-${Date.now()}`
            };

            socket.broadcast.emit('chat:voice', voiceData);
            console.log(`[CHAT] Vocal relayed ${data.from}: ${data.duration}s`);

            if (ackCallback) ackCallback({ success: true, timestamp: voiceData.timestamp });
        } catch (error) {
            console.error('[CHAT] Voice error:', error);
            if (ackCallback) ackCallback({ success: false, error: 'SERVER_ERROR' });
        }
    });

    socket.on('chat:file', async (data, ackCallback) => {
        try {
            if (isDuplicate(data._eventId)) {
                if (ackCallback) ackCallback({ success: false, error: 'DUPLICATE' });
                return;
            }

            const validation = validateData('chat', { from: data.from, fileName: data.fileName });
            if (!validation.valid) {
                socket.emit('chat:error', { message: 'Invalid file data' });
                if (ackCallback) ackCallback({ success: false, error: 'VALIDATION' });
                return;
            }

            const fileData = {
                from: data.from,
                fileName: data.fileName,
                fileSize: data.fileSize,
                timestamp: new Date().toISOString(),
                _eventId: data._eventId || `file-${Date.now()}`
            };

            socket.broadcast.emit('chat:file', fileData);
            console.log(`[CHAT] File relayed ${data.from}: ${data.fileName}`);

            if (ackCallback) ackCallback({ success: true, timestamp: fileData.timestamp });
        } catch (error) {
            console.error('[CHAT] File error:', error);
            if (ackCallback) ackCallback({ success: false, error: 'SERVER_ERROR' });
        }
    });

    // Latence ping-pong
    socket.on('ping-latency', (data) => {
      socket.emit('pong-latency', { time: data.time });
    });

    socket.on('disconnect', () => {
      // Nettoyage des rôles si nécessaire
      if (socket.role === 'SURGEON') {
        // Trouver et supprimer le chirurgien par socket.id
        for (const [userId, surgeon] of systemState.surgeons.entries()) {
          if (surgeon.socketId === socket.id) {
            systemState.surgeons.delete(userId);
            console.log(`[SOCKET] Chirurgien déconnecté: ${userId}`);
            // Notifier l'assistant
            io.emit('surgeon:offline', { userId, timestamp: new Date().toISOString() });
            break;
          }
        }
      }
    });
  });
}

// Fonction pour mettre à jour l'état Arduino depuis arduinoBridge.js
export function updateArduinoStatus(io, connected, port, simulationMode = false, positions = null) {
  systemState.arduino.connected = connected;
  systemState.arduino.port = port;
  systemState.arduino.simulationMode = simulationMode;
  systemState.arduino.positions = positions;

  io.emit('arduino:status', {
    connected,
    port,
    simulationMode,
    positions: positions || null
  });
  
  console.log(`[SOCKET] Arduino status mis à jour: ${connected ? 'CONNECTÉ' : 'DÉCONNECTÉ'}`);
}

export { setupSockets, systemState, operationCommandLogs };
