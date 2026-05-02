// backend/src/hardware/androidBridge.js
// Pont WebSocket pour communication avec Android/Termux (Robot 6DOF)
// Remplace arduinoBridge.js pour architecture distribuée

import WebSocket from 'ws';
import { updateArduinoStatus } from '../sockets/index.js';
import { logger } from '../utils/logger.js';

// Configuration
const ANDROID_WS_HOST = process.env.ANDROID_BRIDGE_IP || '192.168.43.1';
const ANDROID_WS_PORT = process.env.ANDROID_BRIDGE_PORT || '8765';
const RECONNECT_INTERVAL = 3000; // 3 secondes

let ws = null;
let isConnected = false;
let ioInstance = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let commandQueue = [];
let responseCallbacks = new Map();

// Récupérer l'instance io
export function setAndroidIo(io) {
  ioInstance = io;
  startConnectionMonitor();
  startHeartbeat();
}

// Connexion WebSocket au serveur Android
async function connectToAndroid() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return;
  }

  const wsUrl = `ws://${ANDROID_WS_HOST}:${ANDROID_WS_PORT}`;
  logger.info(`[ANDROID_BRIDGE] 🔌 Connexion à ${wsUrl}...`);

  try {
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      logger.info('[ANDROID_BRIDGE] ✅ Connecté au bridge Android');
      isConnected = true;
      
      // Envoyer le statut à tous les clients
      if (ioInstance) {
        updateArduinoStatus(ioInstance, true, `${ANDROID_WS_HOST}:${ANDROID_WS_PORT}`, false);
      }
      
      // Vider la file d'attente
      flushCommandQueue();
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        handleAndroidMessage(msg);
      } catch (e) {
        logger.debug('[ANDROID_BRIDGE] Message non-JSON reçu:', data.toString());
      }
    });

    ws.on('error', (err) => {
      logger.error('[ANDROID_BRIDGE] ❌ Erreur WebSocket:', err.message);
      isConnected = false;
      
      if (ioInstance) {
        updateArduinoStatus(ioInstance, false, null, false);
      }
    });

    ws.on('close', () => {
      logger.warn('[ANDROID_BRIDGE] 🔌 Connexion fermée');
      isConnected = false;
      
      if (ioInstance) {
        updateArduinoStatus(ioInstance, false, null, false);
      }
      
      // Relancer la reconnexion
      scheduleReconnect();
    });

  } catch (err) {
    logger.error('[ANDROID_BRIDGE] ❌ Échec connexion:', err.message);
    isConnected = false;
    scheduleReconnect();
  }
}

// Gère les messages reçus de l'Android
function handleAndroidMessage(msg) {
  const { type, data, timestamp } = msg;

  switch (type) {
    case 'ack':
      // Acknowledgment de commande
      logger.info('[ANDROID_BRIDGE] ✅ ACK reçu:', data);
      
      // Résoudre le callback si présent
      const callbackId = data?.command?.__callbackId;
      if (callbackId && responseCallbacks.has(callbackId)) {
        const callback = responseCallbacks.get(callbackId);
        callback('[ACK] Android forwarded');
        responseCallbacks.delete(callbackId);
      }
      
      // Forward au frontend
      if (ioInstance) {
        ioInstance.emit('robot:ack', data);
      }
      break;

    case 'status':
      // Statut du robot
      logger.info('[ANDROID_BRIDGE] 📊 Statut robot:', data);
      if (ioInstance) {
        updateArduinoStatus(ioInstance, data.robot_connected, null, false);
      }
      break;

    case 'telemetry':
      // Télémétrie du robot
      logger.debug('[ANDROID_BRIDGE] 📡 Télémétrie:', data);
      if (ioInstance) {
        ioInstance.emit('robot:telemetry', parseTelemetry(data));
      }
      break;

    case 'robot_response':
      // Réponse brute du robot
      logger.debug('[ANDROID_BRIDGE] 📥 Réponse robot:', data);
      if (ioInstance) {
        ioInstance.emit('robot:response', { raw: data, timestamp });
      }
      break;

    case 'pong':
      // Heartbeat response
      logger.debug('[ANDROID_BRIDGE] 💓 Pong reçu');
      break;

    case 'error':
      logger.error('[ANDROID_BRIDGE] ❌ Erreur Android:', msg.message);
      break;

    default:
      logger.warn('[ANDROID_BRIDGE] ⚠️ Type inconnu:', type);
  }
}

// Parse la télémétrie
function parseTelemetry(data) {
  // Si les données contiennent des positions [POS]...
  if (typeof data === 'string' && data.includes('[POS]')) {
    // Format attendu: [POS] X:90 Y:105 Z:130
    const matches = data.match(/X:(-?\d+)\s*Y:(-?\d+)\s*Z:(-?\d+)/);
    if (matches) {
      return {
        x: parseInt(matches[1]),
        y: parseInt(matches[2]),
        z: parseInt(matches[3]),
        simulation: false
      };
    }
  }
  
  return { raw: data, simulation: false };
}

// Envoie une commande à l'Android
function sendToAndroid(type, data, callback = null) {
  if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) {
    logger.warn('[ANDROID_BRIDGE] ⚠️ Non connecté, commande mise en file d\'attente');
    commandQueue.push({ type, data, callback });
    return false;
  }

  const message = JSON.stringify({ type, data, timestamp: Date.now() });
  
  try {
    ws.send(message);
    logger.info(`[ANDROID_BRIDGE] 📤 ${type} envoyé:`, data);
    
    // Stocker le callback si présent
    if (callback && data?.__callbackId) {
      responseCallbacks.set(data.__callbackId, callback);
      // Timeout de 5s pour nettoyer
      setTimeout(() => {
        if (responseCallbacks.has(data.__callbackId)) {
          responseCallbacks.delete(data.__callbackId);
        }
      }, 5000);
    }
    
    return true;
  } catch (err) {
    logger.error('[ANDROID_BRIDGE] ❌ Erreur envoi:', err.message);
    commandQueue.push({ type, data, callback });
    return false;
  }
}

// Vide la file d'attente de commandes
function flushCommandQueue() {
  if (commandQueue.length === 0) return;
  
  logger.info(`[ANDROID_BRIDGE] 📤 Vidage file d'attente (${commandQueue.length} commandes)`);
  
  while (commandQueue.length > 0) {
    const cmd = commandQueue.shift();
    sendToAndroid(cmd.type, cmd.data, cmd.callback);
  }
}

// Heartbeat pour maintenir la connexion
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  
  heartbeatTimer = setInterval(() => {
    if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
      sendToAndroid('ping', {});
    }
  }, 5000); // Toutes les 5 secondes
}

// Surveillance de connexion et reconnexion
function startConnectionMonitor() {
  if (reconnectTimer) return;
  
  // Tentative initiale
  connectToAndroid();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToAndroid();
  }, RECONNECT_INTERVAL);
}

// Fonction publique: envoie commande mouvement au robot
function sendToRobot(coords, callback = null) {
  const { x = 0, y = 0, z = 0, r = 0, p = 0, y: yaw = 0 } = coords;
  
  const commandData = {
    x: Math.round(x),
    y: Math.round(y),
    z: Math.round(z),
    r: Math.round(r),
    p: Math.round(p),
    y: Math.round(yaw),
    __callbackId: callback ? `cb_${Date.now()}_${Math.random()}` : undefined
  };
  
  const success = sendToAndroid('move', commandData, callback);
  
  if (success) {
    return `X:${commandData.x},Y:${commandData.y},Z:${commandData.z} → Android`;
  } else {
    return 'Queued for Android';
  }
}

// Fonction publique: demande télémétrie
function requestTelemetry() {
  sendToAndroid('telemetry_request', {});
}

// Getters
function getConnectionStatus() {
  return {
    connected: isConnected,
    host: ANDROID_WS_HOST,
    port: ANDROID_WS_PORT,
    queueLength: commandQueue.length
  };
}

export {
  sendToRobot,
  requestTelemetry,
  getConnectionStatus,
  isConnected
};
