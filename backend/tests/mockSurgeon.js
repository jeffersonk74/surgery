// backend/tests/mockSurgeon.js
// Simule un chirurgien qui envoie des commandes de mouvement

import { io } from 'socket.io-client';

const socket = io('http://localhost:3000');

socket.on('connect', () => {
  console.log('Connecté en tant que SURGEON');
  socket.emit('register', 'SURGEON');

  setInterval(() => {
    const move = {
      x: Math.random() * 100,
      y: Math.random() * 100,
      z: Math.random() * 100,
      pitch: Math.random() * 180,
      roll: Math.random() * 180,
      yaw: Math.random() * 180,
      sentAt: Date.now()
    };
    const t0 = Date.now();
    socket.emit('move-command', move, () => {
      const t1 = Date.now();
      console.log(`[SURGEON] move-command envoyé, latence aller-retour: ${t1 - t0} ms`);
    });
  }, 100);
});

socket.on('disconnect', () => {
  console.log('Déconnecté du serveur');
});
