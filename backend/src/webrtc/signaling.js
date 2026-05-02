// backend/src/webrtc/signaling.js
// Signaling WebRTC via Socket.io pour téléchirurgie (Peer-to-Peer)

const rooms = new Map(); // roomId -> Set of socket IDs

function setupSignaling(io) {
  io.on('connection', (socket) => {
    console.log('[WebRTC] Nouveau client:', socket.id);

    // Rejoindre une room pour la session chirurgicale
    socket.on('join-room', (roomId, callback) => {
      socket.join(roomId);
      
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }
      rooms.get(roomId).add(socket.id);
      
      const roomSize = rooms.get(roomId).size;
      console.log(`[WebRTC] ${socket.id} a rejoint la room '${roomId}' (${roomSize} participants)`);
      
      // Notifier les autres participants qu'un nouveau pair est arrivé
      socket.to(roomId).emit('peer-joined', {
        peerId: socket.id,
        role: socket.role || 'unknown'
      });
      
      // Retourner la liste des pairs existants au nouveau client
      const peers = Array.from(rooms.get(roomId)).filter(id => id !== socket.id);
      if (callback) callback({ success: true, roomId, peers, yourId: socket.id });
    });

    // Recevoir et relayer une offre SDP (Session Description Protocol)
    socket.on('offer', (data) => {
      const { targetId, offer } = data;
      console.log(`[WebRTC] Offer de ${socket.id} vers ${targetId}`);
      
      io.to(targetId).emit('offer', {
        senderId: socket.id,
        offer: offer,
        role: socket.role
      });
    });

    // Recevoir et relayer une réponse SDP
    socket.on('answer', (data) => {
      const { targetId, answer } = data;
      console.log(`[WebRTC] Answer de ${socket.id} vers ${targetId}`);
      
      io.to(targetId).emit('answer', {
        senderId: socket.id,
        answer: answer
      });
    });

    // Recevoir et relayer les candidats ICE (Interactive Connectivity Establishment)
    socket.on('ice-candidate', (data) => {
      const { targetId, candidate } = data;
      
      io.to(targetId).emit('ice-candidate', {
        senderId: socket.id,
        candidate: candidate
      });
    });

    // Déconnexion : nettoyer les rooms
    socket.on('disconnect', () => {
      console.log('[WebRTC] Client déconnecté:', socket.id);
      
      for (const [roomId, participants] of rooms.entries()) {
        if (participants.has(socket.id)) {
          participants.delete(socket.id);
          socket.to(roomId).emit('peer-left', { peerId: socket.id });
          
          if (participants.size === 0) {
            rooms.delete(roomId);
            console.log(`[WebRTC] Room '${roomId}' supprimée (vide)`);
          }
        }
      }
    });
  });
}

export { setupSignaling };
