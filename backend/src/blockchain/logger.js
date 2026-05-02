// backend/src/blockchain/logger.js
// Simulation de blockchain pour audit des sessions de téléchirurgie
// Génère des hashs SHA-256 comme preuves d'intégrité

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const LEDGER_FILE = 'blockchain_ledger.json';
const LEDGER_PATH = path.resolve(process.cwd(), 'data', LEDGER_FILE);

// Instance Socket.io pour émission temps réel
let ioInstance = null;

export function setIo(io) {
  ioInstance = io;
}

// Génère un hash SHA-256 des données de session
function generateSessionHash(sessionId, surgeonName, duration, timestamp) {
  const data = JSON.stringify({
    sessionId,
    surgeonName,
    duration,
    timestamp
  });
  
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Enregistre une preuve dans le ledger (simulation blockchain)
async function saveToBlockchain(data) {
  const { sessionId, surgeonName, duration, timestamp = Date.now() } = data;
  
  // Génération du hash de la session
  const hash = generateSessionHash(sessionId, surgeonName, duration, timestamp);
  
  // Création du bloc
  const block = {
    index: null, // Sera assigné lors du chargement
    timestamp: new Date(timestamp).toISOString(),
    sessionId,
    surgeonName,
    duration,
    hash,
    previousHash: null // Sera chaîné
  };
  
  try {
    // Charger le ledger existant ou créer un nouveau
    let ledger = [];
    try {
      const content = await fs.readFile(LEDGER_PATH, 'utf-8');
      ledger = JSON.parse(content);
    } catch (err) {
      // Fichier inexistant, création du genesis block
      console.log('[BLOCKCHAIN] Création du ledger genesis...');
    }
    
    // Assigner l'index et chaîner avec le bloc précédent
    block.index = ledger.length;
    block.previousHash = ledger.length > 0 ? ledger[ledger.length - 1].hash : '0'.repeat(64);
    
    // Ajouter le bloc au ledger
    ledger.push(block);
    
    // Sauvegarder
    await fs.writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
    
    console.log(`[BLOCKCHAIN] Bloc #${block.index} enregistré | Hash: ${hash.substring(0, 16)}...`);
    console.log(`[BLOCKCHAIN] Session ${sessionId} auditée (${surgeonName}, ${duration}s)`);
    
    // Émettre à tous les clients connectés
    if (ioInstance) {
      ioInstance.emit('blockchain-update', { 
        hash: hash, 
        count: ledger.length 
      });
      console.log(`[SOCKET] Hash envoyé au frontend: ${hash}`);
    }
    
    return {
      success: true,
      block,
      ledgerSize: ledger.length
    };
    
  } catch (err) {
    console.error('[BLOCKCHAIN] Erreur sauvegarde:', err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

// Récupère tout le ledger
async function getLedger() {
  try {
    const content = await fs.readFile(LEDGER_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    return [];
  }
}

// Vérifie l'intégrité de la chaîne
async function verifyChain() {
  const ledger = await getLedger();
  
  for (let i = 1; i < ledger.length; i++) {
    const current = ledger[i];
    const previous = ledger[i - 1];
    
    if (current.previousHash !== previous.hash) {
      console.error(`[BLOCKCHAIN] ALERTE: Bloc #${i} corrompu !`);
      return false;
    }
    
    // Recalculer le hash pour vérifier
    const recalculated = generateSessionHash(
      current.sessionId,
      current.surgeonName,
      current.duration,
      new Date(current.timestamp).getTime()
    );
    
    if (recalculated !== current.hash) {
      console.error(`[BLOCKCHAIN] ALERTE: Hash du bloc #${i} invalide !`);
      return false;
    }
  }
  
  console.log(`[BLOCKCHAIN] Chaîne vérifiée: ${ledger.length} blocs intègres`);
  return true;
}

// Génère un hash SHA-256 pour une action individuelle
function generateActionHash(surgeonId, actionType, details, timestamp) {
  const data = JSON.stringify({
    surgeonId,
    actionType,
    details,
    timestamp
  });
  
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Log une action en temps réel (non-bloquant pour le robot)
async function logAction(surgeonId, actionType, details) {
  const timestamp = Date.now();
  const hash = generateActionHash(surgeonId, actionType, details, timestamp);
  
  const block = {
    index: null,
    timestamp: new Date(timestamp).toISOString(),
    surgeonId,
    actionType,
    details,
    hash,
    previousHash: null
  };
  
  try {
    // Charger ou créer le ledger
    let ledger = [];
    try {
      const content = await fs.readFile(LEDGER_PATH, 'utf-8');
      ledger = JSON.parse(content);
    } catch (err) {
      // Genesis block
    }
    
    // Chaîner le bloc
    block.index = ledger.length;
    block.previousHash = ledger.length > 0 ? ledger[ledger.length - 1].hash : '0'.repeat(64);
    
    ledger.push(block);
    await fs.writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
    
    // Log silencieux en mode production (pas de console.log pour ne pas ralentir)
    if (process.env.DEBUG_BLOCKCHAIN) {
      console.log(`[BLOCKCHAIN] Action #${block.index} | ${actionType} | ${hash.substring(0, 12)}...`);
    }
    
    return { success: true, blockIndex: block.index };
  } catch (err) {
    console.error('[BLOCKCHAIN] Erreur logAction:', err.message);
    return { success: false, error: err.message };
  }
}

export { saveToBlockchain, getLedger, verifyChain, generateSessionHash, generateActionHash, logAction };
