// backend/src/hardware/arduinoBridge.js
// Pont SerialPort pour Arduino MEGA (Robot + Joystick) avec Socket.io

import { SerialPort } from 'serialport';
import { setIo } from '../blockchain/logger.js';
import { updateArduinoStatus } from '../sockets/index.js';
import { logger } from '../utils/logger.js';

// Détection automatique du port Arduino (adapter selon votre système)
const ARDUINO_PORT = process.env.ARDUINO_PORT || '/dev/ttyACM0';
const BAUD_RATE = 115200;
const HEARTBEAT_INTERVAL = 500; // 500ms maximum
const HEARTBEAT_TIMEOUT = 3000; // 3 secondes sans réponse

let port = null;
let isConnected = false;
let lastHeartbeat = 0;
let heartbeatTimer = null;
let responseCallback = null; // Callback pour réponse ACK
let ioInstance = null; // Instance Socket.io pour émission directe
let simulationMode = false;
let simulationInterval = null;

let reconnectionInterval = null;
let serialBuffer = '';  // Buffer pour assembler les lignes série
let lastDataReceived = 0;  // Timestamp dernière donnée reçue
let zombieCheckInterval = null;  // Timer pour détection port zombie

// Positions actuelles des servos (mises à jour par les messages POS de l'Arduino)
let currentPositions = {
    base: null, epaule: null, coude: null,
    poignet: null, inc: null, pince: null
};

// Récupérer l'instance io
export function setArduinoIo(io) {
  ioInstance = io;
  // Démarrer la surveillance de connexion si pas encore fait
  startConnectionMonitor();
  startHeartbeatMonitor();
}

async function startConnectionMonitor() {
  if (reconnectionInterval) return;

  reconnectionInterval = setInterval(async () => {
    if (!isConnected) {
      logger.info('[ARDUINO] Surveillance : Tentative de reconnexion...');
      try {
        await initArduino();
      } catch (err) {
        // Silencieux, on réessaiera
      }
    }
  }, 3000);

  // Démarrer la détection de port zombie (30s sans données)
  startZombiePortDetection();
}

// Détection de port zombie - si pas de données pendant 30s et isConnected=true
function startZombiePortDetection() {
  if (zombieCheckInterval) clearInterval(zombieCheckInterval);

  zombieCheckInterval = setInterval(() => {
    if (isConnected && lastDataReceived > 0) {
      const elapsed = Date.now() - lastDataReceived;
      if (elapsed > 30000) { // 30 secondes sans données
        logger.warn(`[ARDUINO] Port zombie détecté - aucune donnée depuis ${elapsed}ms, tentative de reconnexion...`);
        handleDisconnect();
        // La reconnexion sera tentée par startConnectionMonitor
      }
    }
  }, 5000); // Vérifier toutes les 5 secondes
}

// Surveillance PASSIVE - uniquement événements natifs, pas de ping
function startHeartbeatMonitor() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  
  // Vérification légère toutes les 5 secondes (sans envoi de données)
  heartbeatTimer = setInterval(() => {
    if (isConnected && (!port || !port.isOpen)) {
      logger.warn('[ARDUINO] Port fermé détecté par surveillance passive');
      handleDisconnect();
    }
  }, 5000); // 5 secondes = beaucoup moins intrusif
}

function handleDisconnect() {
  if (!isConnected) return;

  isConnected = false;
  serialBuffer = '';
  lastDataReceived = 0;  // Reset le timestamp
  logger.error('[ARDUINO] Robot déconnecté (Perte de signal)');

  if (port && port.isOpen) {
    port.close();
  }

  if (ioInstance) {
    updateArduinoStatus(ioInstance, false, null, simulationMode, currentPositions);
  }
}

async function initArduino() {
  let targetPort = ARDUINO_PORT;
  
  if (port && port.isOpen) {
    return;
  }

  try {
    // Si un port existe mais est fermé, on le nettoie
    if (port) {
      port.removeAllListeners();
      port = null;
    }

    port = new SerialPort({
      path: targetPort,
      baudRate: BAUD_RATE,
      autoOpen: false
    });

    port.on('open', () => {
      logger.info(`[ARDUINO] ✅ Connecté sur ${targetPort}`);
      isConnected = true;
      lastHeartbeat = Date.now();
      simulationMode = false;
      stopSimulationMode();
      
      // Émettre statut connexion à tous les clients
      if (ioInstance) {
        updateArduinoStatus(ioInstance, true, targetPort, false);
      }
    });

    port.on('error', (err) => {
      logger.error('[ARDUINO] ❌ Erreur Port Série:', { error: err.message });
      isConnected = false;
      
      if (ioInstance) {
        updateArduinoStatus(ioInstance, false, null, simulationMode);
      }
    });

    port.on('close', () => {
      logger.warn('[ARDUINO] ⚠️ Port fermé');
      isConnected = false;
      
      if (ioInstance) {
        updateArduinoStatus(ioInstance, false, null, simulationMode);
      }
    });

    port.on('data', (data) => {
      lastDataReceived = Date.now();  // Tracker la dernière réception de données
      serialBuffer += data.toString();
      
      // Traiter toutes les lignes complètes dans le buffer
      let newlineIdx;
      while ((newlineIdx = serialBuffer.indexOf('\n')) !== -1) {
        const line = serialBuffer.substring(0, newlineIdx).trim();
        serialBuffer = serialBuffer.substring(newlineIdx + 1);
        
        if (!line) continue;  // Ignorer lignes vides
        
        logger.debug('[ARDUINO] Ligne:', { line: line.substring(0, 80) });
        handleSerialLine(line);
      }
    });

    await port.open();
  } catch (err) {
    logger.warn('[ARDUINO] Échec ouverture port, passage en mode simulation');
    simulationMode = true;
    isConnected = false;
    
    if (ioInstance) {
      updateArduinoStatus(ioInstance, false, null, true);
    }
    
    startSimulationMode();
    throw err;
  }
}

// Traitement d'une ligne complète reçue du MEGA
function handleSerialLine(line) {
  // Données joystick du MEGA : JX:val,JY:val,J1X:val,J1Y:val
  if (line.includes('JX:') && line.includes('JY:')) {
    try {
      const jxMatch = line.match(/JX:(\d+)/);
      const jyMatch = line.match(/JY:(\d+)/);
      const j1xMatch = line.match(/J1X:(\d+)/);
      const j1yMatch = line.match(/J1Y:(\d+)/);
      
      const joystickData = { timestamp: new Date().toISOString() };
      
      if (jxMatch) joystickData.j2x = parseInt(jxMatch[1], 10);
      if (jyMatch) joystickData.j2y = parseInt(jyMatch[1], 10);
      if (j1xMatch) joystickData.j1x = parseInt(j1xMatch[1], 10);
      if (j1yMatch) joystickData.j1y = parseInt(j1yMatch[1], 10);
      
      if (ioInstance) {
        ioInstance.emit('joystick:data', joystickData);
      }
    } catch (e) {
      logger.warn('[ARDUINO] Erreur parsing joystick:', { error: e.message });
    }
    return;
  }

  // SYSTEM_READY du MEGA
  if (line.includes('SYSTEM_READY')) {
    logger.info('[ARDUINO] MEGA système prêt');
    return;
  }

  // Arrêt d'urgence acquitté
  if (line.includes('EMERGENCY_ACK')) {
    logger.info('[ARDUINO] Arrêt d\'urgence acquitté');
    if (ioInstance) {
      ioInstance.emit('emergency:ack', { timestamp: new Date().toISOString() });
    }
    if (responseCallback) { responseCallback(line); responseCallback = null; }
    return;
  }

  // Synchronisation OK
  if (line.includes('SYNC_OK')) {
    logger.info('[ARDUINO] Synchronisation OK');
    if (responseCallback) { responseCallback(line); responseCallback = null; }
    return;
  }

  // ACK classique
  if (line.includes('[ACK]') || line.includes('[HB]')) {
    if (line.includes('[ACK]')) {
      logger.info('[ARDUINO] ACK reçu:', line);
    }
    if (responseCallback && line.includes('[ACK]')) {
      responseCallback(line);
      responseCallback = null;
    }
    return;
  }

  // Positions des servos : POS base epaule coude poignet inc pince
  if (line.startsWith('POS ')) {
    try {
      const parts = line.split(' ').filter(p => p !== '');
      if (parts.length >= 7) {
        currentPositions.base = parseInt(parts[1], 10);
        currentPositions.epaule = parseInt(parts[2], 10);
        currentPositions.coude = parseInt(parts[3], 10);
        currentPositions.poignet = parseInt(parts[4], 10);
        currentPositions.inc = parseInt(parts[5], 10);
        currentPositions.pince = parseInt(parts[6], 10);

        logger.debug('[ARDUINO] Positions servos mises à jour:', currentPositions);

        // Émettre les positions avec le statut Arduino
        if (ioInstance) {
          ioInstance.emit('servo:position', {
            base: currentPositions.base,
            epaule: currentPositions.epaule,
            coude: currentPositions.coude,
            poignet: currentPositions.poignet,
            inc: currentPositions.inc,
            pince: currentPositions.pince,
            timestamp: new Date().toISOString()
          });

          // Mettre à jour le statut avec les positions
          updateArduinoStatus(ioInstance, true, ARDUINO_PORT, simulationMode, currentPositions);
        }
      }
    } catch (e) {
      logger.warn('[ARDUINO] Erreur parsing positions:', { error: e.message, line });
    }
    return;
  }

  // Ligne non reconnue - log en debug
  logger.debug('[ARDUINO] Ligne non traitée:', { line });
}

function stopSimulationMode() {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
    logger.info('[ARDUINO] Mode simulation arrêté');
  }
}

// Mode simulation - émet des données périodiques
function startSimulationMode() {
  if (simulationInterval) return;

  // Émettre un événement pour avertir tous les clients
  if (ioInstance) {
    ioInstance.emit('arduino:simulation-mode', {
      active: true,
      reason: 'Port série indisponible - Aucun Arduino détecté',
      port: ARDUINO_PORT,
      timestamp: new Date().toISOString()
    });
  }

  simulationInterval = setInterval(() => {
    if (!isConnected && ioInstance) {
      // Émettre données position simulées
      const simulatedPos = {
        x: Math.round(Math.sin(Date.now() / 1000) * 45),
        y: Math.round(Math.cos(Date.now() / 1000) * 30),
        z: 0
      };
      
      ioInstance.emit('servo:position', {
        ...simulatedPos,
        timestamp: new Date().toISOString(),
        simulation: true
      });

      // Mettre à jour le statut avec positions simulées
      const simulatedPositions = {
        base: simulatedPos.x || 0,
        epaule: simulatedPos.y || 0,
        coude: simulatedPos.z || 0,
        poignet: 0, inc: 0, pince: 0
      };
      updateArduinoStatus(ioInstance, false, null, true, simulatedPositions);
    }
  }, 5000);
}

// Mapping angles (0-180°) → valeurs PWM du MEGA
const PWM_RANGES = {
  base:     { min: 200, max: 660 },   // Servo 0
  epaule:   { min: 500, max: 800 },   // Servo 1
  coude:    { min: 400, max: 630 },   // Servo 2
  poignet:  { min: 100, max: 500 },   // Servo 3
  inclinaison: { min: 200, max: 550 }, // Servo 4
  pince:    { min: 150, max: 270 }    // Servo 5
};

function angleToPWM(angle, range) {
  // angle: 0-180 → PWM: range.min-range.max
  const clamped = Math.max(0, Math.min(180, angle));
  return Math.round(range.min + (clamped / 180) * (range.max - range.min));
}

function sendToRobot(coords, callback = null) {
  const { x = 90, y = 90, z = 90, r = 90, p = 90, y: yaw = 90, heartbeat = false, emergency = false } = coords;
  
  let command;
  if (emergency) {
    command = 'A\n';
  } else if (heartbeat) {
    command = 'S\n';
  } else {
    // Convertir angles 0-180° en valeurs PWM et envoyer au MEGA
    const bPWM = angleToPWM(x, PWM_RANGES.base);
    const ePWM = angleToPWM(y, PWM_RANGES.epaule);
    const cPWM = angleToPWM(z, PWM_RANGES.coude);
    const pPWM = angleToPWM(r, PWM_RANGES.poignet);
    const iPWM = angleToPWM(p, PWM_RANGES.inclinaison);
    const gPWM = angleToPWM(yaw, PWM_RANGES.pince);
    
    command = `B${bPWM}\nE${ePWM}\nC${cPWM}\nP${pPWM}\nI${iPWM}\nG${gPWM}\n`;
  }
  
  if (callback) {
    responseCallback = callback;
  }
  
  if (isConnected && port) {
    port.write(command, (err) => {
      if (err) {
        logger.error('[ARDUINO] Erreur écriture commande', { error: err.message });
        responseCallback = null;
      }
    });
  } else if (!heartbeat && !emergency) {
    // Simulation
    if (callback) {
      setTimeout(() => {
        callback('[ACK] Simulated');
        responseCallback = null;
      }, 100);
    }
  }
  
  return command;
}

export { initArduino, sendToRobot, isConnected, simulationMode };
