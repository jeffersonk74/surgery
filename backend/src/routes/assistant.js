// backend/src/routes/assistant.js
// Routes pour l'assistant - VERSION PRISMA AVEC TRANSACTIONS

import express from 'express';
import prisma from '../config/prisma.js';
import { verifyToken } from './auth.js';

const router = express.Router();

// Middleware pour toutes les routes
router.use(verifyToken);

// Vérifier que l'utilisateur est un assistant
router.use((req, res, next) => {
  if (req.user.role !== 'assistant') {
    return res.status(403).json({ error: 'Accès réservé aux assistants' });
  }
  next();
});

// Récupérer les patients assignés à cet assistant
router.get('/patients', async (req, res) => {
  try {
    console.log(`[ASSISTANT] Récupération patients (Prisma) pour assistant_id=${req.user.userId}`);
    
    const patients = await prisma.patient.findMany({
      where: {
        statut: { in: ['en_attente', 'pret', 'en_cours'] }
      },
      orderBy: { createdAt: 'desc' },
      include: {
        assistantStatuses: {
          where: { assistantId: req.user.userId },
          select: { statut: true }
        },
        chirurgien: { select: { nom: true, prenom: true } }
      }
    });

    const result = patients.map(p => ({
      db_id: p.id,
      patient_id: p.patientId,
      nom: p.nom,
      prenom: p.prenom,
      name: `${p.prenom} ${p.nom}`, // pour compatibilité frontend
      pathologie: p.pathologie,
      statut: p.statut,
      consentementPatient: p.consentementPatient,
      consentementAt: p.consentementAt,
      assistant_statut: p.assistantStatuses[0]?.statut || 'en_attente',
      pret: p.assistantStatuses[0]?.statut === 'pret',
      chirurgien: p.chirurgien ? `${p.chirurgien.prenom} ${p.chirurgien.nom}` : null,
      date_creation: p.createdAt
    }));

    console.log(`[ASSISTANT] ${result.length} patients trouvés (Prisma)`);
    result.forEach(p => {
      console.log(`[ASSISTANT] Patient: ID=${p.patient_id}, Nom=${p.prenom} ${p.nom}, Statut=${p.statut}`);
    });

    res.json(result);
  } catch (error) {
    console.error('[ASSISTANT] Erreur récupération patients (Prisma):', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Mettre à jour le statut "Prêt" pour un patient - TRANSACTION PRISMA
router.post('/status', async (req, res) => {
  try {
    const { patient_db_id, statut } = req.body;
    
    if (!patient_db_id || !statut || !['en_attente', 'pret'].includes(statut)) {
      return res.status(400).json({ 
        error: 'patient_db_id et statut (en_attente/pret) requis' 
      });
    }
    
    const patientId = parseInt(patient_db_id);
    
    // TRANSACTION PRISMA - Mise à jour atomique
    await prisma.$transaction(async (tx) => {
      // Vérifier que le patient existe
      const patient = await tx.patient.findUnique({ where: { id: patientId } });
      if (!patient) throw new Error('Patient non trouvé');
      
      // Upsert du statut assistant
      await tx.assistantStatus.upsert({
        where: { patientId_assistantId: { patientId, assistantId: req.user.userId } },
        create: { patientId, assistantId: req.user.userId, statut },
        update: { statut }
      });
      
      // Mettre à jour le patient
      await tx.patient.update({
        where: { id: patientId },
        data: {
          statut: statut === 'pret' ? 'pret' : 'en_attente',
          assistantId: statut === 'pret' ? req.user.userId : null,
          consentementPatient: false,
          consentementAt: null
        }
      });
    });
    
    console.log(`[ASSISTANT] Statut mis à jour (Prisma): patient ${patientId} -> ${statut}`);
    
    res.json({ 
      message: 'Statut mis à jour',
      patient_id: patient_db_id,
      statut,
      assistant_id: req.user.userId
    });
    
  } catch (error) {
    console.error('[ASSISTANT] Erreur mise à jour statut:', error);
    if (error.message === 'Patient non trouvé') {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Basculer le statut (toggle prêt/en_attente) - TRANSACTION PRISMA
router.post('/toggle-status', async (req, res) => {
  try {
    const { patient_db_id } = req.body;
    if (!patient_db_id) return res.status(400).json({ error: 'patient_db_id requis' });
    
    const patientId = parseInt(patient_db_id);
    
    // TRANSACTION PRISMA
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.assistantStatus.findUnique({
        where: { patientId_assistantId: { patientId, assistantId: req.user.userId } }
      });
      
      const currentStatus = current?.statut || 'en_attente';
      const newStatus = currentStatus === 'pret' ? 'en_attente' : 'pret';
      
      await tx.assistantStatus.upsert({
        where: { patientId_assistantId: { patientId, assistantId: req.user.userId } },
        create: { patientId, assistantId: req.user.userId, statut: newStatus },
        update: { statut: newStatus }
      });
      
      await tx.patient.update({
        where: { id: patientId },
        data: {
          statut: newStatus === 'pret' ? 'pret' : 'en_attente',
          assistantId: newStatus === 'pret' ? req.user.userId : null,
          consentementPatient: false,
          consentementAt: null
        }
      });
      
      return { currentStatus, newStatus };
    });
    
    console.log(`[ASSISTANT] Toggle statut (Prisma): patient ${patientId} -> ${result.newStatus}`);
    
    res.json({
      message: 'Statut basculé',
      patient_id: patient_db_id,
      ancien_statut: result.currentStatus,
      nouveau_statut: result.newStatus
    });
    
  } catch (error) {
    console.error('[ASSISTANT] Erreur toggle statut:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
