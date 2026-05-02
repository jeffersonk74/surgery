// backend/tests/mockRobot.js
// Simule un robot qui reçoit les commandes de mouvement

import { io } from 'socket.io-client';

const socket = io('http://localhost:3000');

socket.on('connect', () => {
  console.log('Connecté en tant que ROBOT');
  socket.emit('register', 'ROBOT');
});

socket.on('move-command', (data) => {
  const now = Date.now();
  const sentAt = data.sentAt || now;
  const totalLatency = now - sentAt;
  console.log(`[ROBOT] Commande reçue:`, data, `| Latence totale: ${totalLatency} ms`);
});

socket.on('disconnect', () => {
  console.log('Déconnecté du serveur');
});
