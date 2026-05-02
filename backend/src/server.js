
// backend/src/server.js
// Serveur Express + Socket.io pour téléchirurgie 5G avec Prisma/PostgreSQL

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import prisma from './config/prisma.js';
import authRoutes from './routes/auth.js';
import patientRoutes from './routes/patients.js';
import assistantRoutes from './routes/assistant.js';

const app = express();
app.use(cors({
  origin: "*",  // Autorise toutes les origines (localhost + réseau local)
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// Middleware de log pour mesurer la latence de chaque requête HTTP
app.use((req, res, next) => {
  const start = process.hrtime();
  res.on('finish', () => {
    const diff = process.hrtime(start);
    const ms = diff[0] * 1e3 + diff[1] / 1e6;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} - ${ms.toFixed(2)} ms`);
  });
  next();
});

// Route de santé (healthcheck)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    database: 'connected',
    message: 'Serveur prêt pour la 5G' 
  });
});

// Route API pour obtenir le statut système complet (Arduino, assistants, chirurgiens)
app.get('/api/system/status', (req, res) => {
  res.status(200).json(systemState.getSystemStatus());
});

// Routes API REST
app.use('/api/auth', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/assistant', assistantRoutes);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",  // Autorise toutes les origines
    methods: ["GET", "POST"]
  }
});

// Intégration de la logique Socket.io propre
import { setupSockets, systemState } from './sockets/index.js';
import { setupSignaling } from './webrtc/signaling.js';
import { setIo } from './blockchain/logger.js';

// Configuration du mode robot (local serial ou android bridge)
const ROBOT_MODE = process.env.ROBOT_MODE || 'local';
let setRobotIo;

if (ROBOT_MODE === 'android_bridge') {
  console.log('[SERVER] 🤖 Mode ANDROID BRIDGE activé');
  const { setAndroidIo } = await import('./hardware/androidBridge.js');
  setRobotIo = setAndroidIo;
} else {
  console.log('[SERVER] 🔌 Mode LOCAL (SerialPort) activé');
  const { setArduinoIo } = await import('./hardware/arduinoBridge.js');
  setRobotIo = setArduinoIo;
}

// Initialiser l'instance io pour la blockchain et le robot
setIo(io);
setRobotIo(io);

await setupSockets(io);
setupSignaling(io);

// Fonction de reconnexion de session - récupère l'état système au démarrage
async function recoverSessionState() {
  try {
    console.log('[SERVER] Récupération de l\'état de session...');
    
    // Récupérer le dernier état du robot
    const robotState = await prisma.robotState.findFirst();
    
    // Récupérer le patient actif (en cours)
    const activePatient = await prisma.patient.findFirst({
      where: { statut: 'en_cours' },
      include: { chirurgien: { select: { id: true, nom: true, prenom: true } } }
    });
    
    // Récupérer les assistants qui ont des patients prêts
    const readyAssistants = await prisma.assistantStatus.findMany({
      where: { statut: 'pret' },
      include: { 
        assistant: { select: { id: true, nom: true, prenom: true } },
        patient: { select: { patientId: true, nom: true, prenom: true } }
      }
    });
    
    const sessionState = {
      robot: robotState || { isConnected: false, simulationMode: true },
      activePatient: activePatient ? {
        id: activePatient.patientId,
        name: `${activePatient.prenom} ${activePatient.nom}`,
        chirurgien: activePatient.chirurgien 
          ? `${activePatient.chirurgien.prenom} ${activePatient.chirurgien.nom}`
          : null
      } : null,
      readyAssistants: readyAssistants.map(a => ({
        assistantId: a.assistantId,
        assistantName: `${a.assistant.prenom} ${a.assistant.nom}`,
        patientId: a.patient.patientId,
        patientName: `${a.patient.prenom} ${a.patient.nom}`
      })),
      timestamp: new Date().toISOString()
    };
    
    console.log('[SERVER] État de session récupéré:');
    console.log(`  - Robot connecté: ${sessionState.robot.isConnected}`);
    console.log(`  - Patient actif: ${sessionState.activePatient?.id || 'Aucun'}`);
    console.log(`  - Assistants prêts: ${sessionState.readyAssistants.length}`);
    
    return sessionState;
  } catch (error) {
    console.error('[SERVER] Erreur récupération session:', error);
    return null;
  }
}

// Démarrer le serveur avec Prisma/PostgreSQL
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Test de connexion Prisma
    await prisma.$connect();
    console.log('[SERVER] ✅ Connecté à PostgreSQL via Prisma');
    
    // Récupération de l'état de session pour synchronisation
    const sessionState = await recoverSessionState();
    
    // Stocker l'état récupéré dans une variable globale pour les sockets
    global.recoveredSession = sessionState;
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`=====================================\n`);
      console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
      console.log(`🗄️  Base de données: PostgreSQL (Prisma)`);
      console.log(`📡 API REST: http://0.0.0.0:${PORT}/api`);
      console.log(`🔌 WebSocket: ws://0.0.0.0:${PORT}`);
      console.log(`\n📡 Accessible depuis le réseau local:`);
      console.log(`   ws://<IP_DE_PC2>:${PORT}`);
      console.log(`=====================================`);
    });
    
  } catch (error) {
    console.error('[SERVER] ❌ Impossible de démarrer:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

// Gestion gracieuse de l'arrêt
process.on('SIGINT', async () => {
  console.log('\n[SERVER] Arrêt gracieux...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[SERVER] Arrêt gracieux (SIGTERM)...');
  await prisma.$disconnect();
  process.exit(0);
});

startServer();
