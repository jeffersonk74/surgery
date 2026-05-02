// test_chirurgien.js
// Script de test simulant un chirurgien contrôlant le robot

import { io } from 'socket.io-client';

const SERVER_URL = 'http://localhost:3000';
const ROOM_ID = 'chirurgie';

const socket = io(SERVER_URL);

socket.on('connect', () => {
  console.log('[TEST] Connecté au serveur:', socket.id);
  
  // S'enregistrer comme chirurgien
  socket.emit('register', 'SURGEON', 'Dr. Test');
  
  // Rejoindre la room
  socket.emit('join-room', ROOM_ID, (response) => {
    if (response && response.success) {
      console.log(`[TEST] Rejoint la room '${ROOM_ID}'`);
      console.log(`[TEST] Peers dans la room: ${response.peers.length}`);
    }
  });
  
  // Envoyer une commande move-command toutes les 2 secondes
  setInterval(() => {
    const move = {
      x: 120,
      y: 90,
      z: 45,
      r: 0,
      p: 0,
      y: 0,
      sentAt: Date.now()
    };
    
    console.log('[TEST] Envoi move-command:', move);
    socket.emit('move-command', move);
  }, 2000);
});

socket.on('peer-joined', (data) => {
  console.log('[TEST] Nouveau peer dans la room:', data.peerId, data.role);
});

socket.on('peer-left', (data) => {
  console.log('[TEST] Peer parti:', data.peerId);
});

socket.on('disconnect', () => {
  console.log('[TEST] Déconnecté du serveur');
});

socket.on('error', (err) => {
  console.error('[TEST] Erreur:', err);
});
