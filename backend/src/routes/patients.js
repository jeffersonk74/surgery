// backend/src/routes/patients.js
// Routes pour la gestion des patients - VERSION PRISMA

import express from 'express';
import prisma from '../config/prisma.js';
import { verifyToken } from './auth.js';
import crypto from 'crypto';
import { systemState } from '../sockets/index.js';

const router = express.Router();

// Générer un ID patient unique au format PAT-2026-XXXX
function generatePatientID() {
  const year = new Date().getFullYear();
  const random = Math.floor(1000 + Math.random() * 9000); // 4 chiffres
  return `PAT-${year}-${random}`;
}

// Générer un hash SHA-256 fictif pour la traçabilité
function generateHash(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

// Middleware pour toutes les routes
router.use(verifyToken);

// Récupérer tous les patients avec le statut assistant
router.get('/', async (req, res) => {
  try {
    console.log('[PATIENTS] Récupération patients avec Prisma...');
    
    const patients = await prisma.patient.findMany({
      where: {
        statut: { in: ['en_attente', 'pret', 'en_cours'] }
      },
      orderBy: { createdAt: 'desc' },
      include: {
        assistantStatuses: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { statut: true, assistantId: true }
        }
      }
    });
    
    // Formater la réponse
    const result = patients.map(p => {
      const assistantStatus = p.assistantStatuses[0];
      return {
        id: p.patientId,
        db_id: p.id,
        name: `${p.prenom} ${p.nom}`,
        pathologie: p.pathologie,
        statut: p.statut,
        consentementPatient: p.consentementPatient,
        consentementAt: p.consentementAt,
        assistantSignal: assistantStatus?.statut === 'pret' ? 'Prêt' : 'En attente',
        date_creation: p.createdAt
      };
    });
    
    console.log(`[PATIENTS] ${result.length} patients récupérés (Prisma)`);
    res.json(result);
    
  } catch (error) {
    console.error('[PATIENTS] Erreur récupération:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer l'historique / archive des opérations terminées
router.get('/history/list', async (req, res) => {
  try {
    const history = await prisma.historiqueOperation.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const result = history.map((op) => {
      const hasDates = op.dateDebut && op.dateFin;
      const durationMinutes = hasDates
        ? Math.max(0, Math.round((new Date(op.dateFin).getTime() - new Date(op.dateDebut).getTime()) / 60000))
        : null;

      return {
        id: op.id,
        date: new Date(op.createdAt).toLocaleString('fr-FR'),
        patient: `${op.prenom} ${op.nom}`.trim(),
        duree: durationMinutes === null ? 'N/A' : `${durationMinutes} min`,
        statut: op.statut
      };
    });

    res.json(result);
  } catch (error) {
    console.error('[PATIENTS] Erreur récupération historique:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer un patient par ID
router.get('/:patientId', async (req, res) => {
  try {
    const { patientId } = req.params;
    
    const patient = await prisma.patient.findUnique({
      where: { patientId },
      include: {
        assistantStatuses: { orderBy: { updatedAt: 'desc' }, take: 1 },
        chirurgien: { select: { nom: true, prenom: true } }
      }
    });
    
    if (!patient) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }
    
    const assistantStatus = patient.assistantStatuses[0];
    res.json({
      id: patient.patientId,
      name: `${patient.prenom} ${patient.nom}`,
      pathologie: patient.pathologie,
      statut: patient.statut,
      consentementPatient: patient.consentementPatient,
      consentementAt: patient.consentementAt,
      assistantSignal: assistantStatus?.statut === 'pret' ? 'Prêt' : 'En attente',
      chirurgien: patient.chirurgien ? `${patient.chirurgien.prenom} ${patient.chirurgien.nom}` : null
    });
    
  } catch (error) {
    console.error('[PATIENTS] Erreur récupération patient:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Créer un nouveau patient (assistant ou chirurgien) - AVEC TRANSACTION PRISMA
router.post('/', async (req, res) => {
  try {
    // Les assistants ET chirurgiens peuvent créer des patients
    if (req.user.role !== 'chirurgien' && req.user.role !== 'assistant') {
      return res.status(403).json({ error: 'Accès réservé au personnel médical' });
    }
    
    const { nom, prenom, pathologie, patient_id, type_operation } = req.body;
    
    if (!nom || !prenom || !pathologie) {
      return res.status(400).json({ 
        error: 'Nom, prénom et pathologie sont requis' 
      });
    }
    
    // Générer un ID patient au format PAT-2026-XXXX si non fourni
    const finalPatientId = patient_id || generatePatientID();
    
    // Stocker le type d'opération dans la pathologie si fourni
    const fullPathologie = type_operation 
      ? `${pathologie} [${type_operation}]` 
      : pathologie;
    
    // TRANSACTION PRISMA - Création atomique du patient + statut assistant
    const result = await prisma.$transaction(async (tx) => {
      // Créer le patient
      const patient = await tx.patient.create({
        data: {
          patientId: finalPatientId,
          nom,
          prenom,
          pathologie: fullPathologie,
          chirurgienId: req.user.userId,
          statut: 'en_attente',
          consentementPatient: false,
          consentementAt: null
        }
      });
      
      // Créer le statut assistant
      await tx.assistantStatus.create({
        data: {
          patientId: patient.id,
          assistantId: req.user.userId,
          statut: 'en_attente'
        }
      });
      
      return patient;
    });
    
    console.log(`[PATIENTS] Patient créé: ${finalPatientId} par ${req.user.userId} (Prisma)`);
    
    res.status(201).json({
      message: 'Patient créé avec succès',
      patientId: finalPatientId,
      dbId: result.id
    });
    
  } catch (error) {
    console.error('[PATIENTS] Erreur création:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Mettre à jour un patient
router.put('/:patientId', async (req, res) => {
  try {
    if (req.user.role !== 'chirurgien') {
      return res.status(403).json({ error: 'Accès réservé aux chirurgiens' });
    }
    
    const { patientId } = req.params;
    const { nom, prenom, pathologie, statut } = req.body;
    
    // Vérifier que le patient existe et appartient au chirurgien
    const existing = await prisma.patient.findFirst({
      where: { patientId, chirurgienId: req.user.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Patient non trouvé ou non autorisé' });
    }
    
    await prisma.patient.update({
      where: { id: existing.id },
      data: { nom, prenom, pathologie, statut }
    });
    
    res.json({ message: 'Patient mis à jour' });
    
  } catch (error) {
    console.error('[PATIENTS] Erreur mise à jour:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprimer un patient
router.delete('/:patientId', async (req, res) => {
  try {
    if (req.user.role !== 'chirurgien') {
      return res.status(403).json({ error: 'Accès réservé aux chirurgiens' });
    }
    
    const { patientId } = req.params;
    
    // Vérifier que le patient existe et appartient au chirurgien
    const existing = await prisma.patient.findFirst({
      where: { patientId, chirurgienId: req.user.userId }
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Patient non trouvé ou non autorisé' });
    }
    
    await prisma.patient.delete({ where: { id: existing.id } });
    
    res.json({ message: 'Patient supprimé' });
    
  } catch (error) {
    console.error('[PATIENTS] Erreur suppression:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route pour télécharger les logs (Surgical Black Box)
// GET /api/patients/download-logs/:patientId
router.get('/download-logs/:patientId', async (req, res) => {
  try {
    const { patientId } = req.params;
    
    // Récupérer les informations du patient avec Prisma
    const patient = await prisma.patient.findUnique({
      where: { patientId },
      include: {
        chirurgien: { select: { nom: true, prenom: true, role: true } }
      }
    });
    
    if (!patient) {
      return res.status(404).json({ error: 'Patient non trouvé' });
    }
    
    // Extraire le type d'opération de la pathologie (format: "pathologie [type]")
    const pathologieMatch = patient.pathologie.match(/^(.*)\s*\[(.*)\]$/);
    const pathologieBase = pathologieMatch ? pathologieMatch[1].trim() : patient.pathologie;
    const typeOperation = pathologieMatch ? pathologieMatch[2].trim() : 'Non spécifié';
    
    // Générer des hashs SHA-256 fictifs simulant les commandes Arduino
    const commandHashes = [];
    const numCommands = Math.floor(Math.random() * 20) + 5; // Entre 5 et 25 commandes
    
    for (let i = 0; i < numCommands; i++) {
      const commandData = {
        patientId: patient.patient_id,
        commandIndex: i + 1,
        timestamp: new Date(Date.now() - (numCommands - i) * 60000).toISOString(),
        coordinates: {
          x: Math.round(Math.sin(i) * 45),
          y: Math.round(Math.cos(i) * 30),
          z: Math.round(Math.sin(i * 0.5) * 20)
        },
        action: i % 3 === 0 ? 'MOVE' : (i % 3 === 1 ? 'GRIP' : 'RELEASE')
      };
      
      commandHashes.push({
        sequence: i + 1,
        timestamp: commandData.timestamp,
        hash: generateHash(commandData),
        action: commandData.action,
        coordinates: commandData.coordinates
      });
    }
    
    // Construire le fichier JSON de la "Boîte Noire Chirurgicale"
    const blackBoxData = {
      surgicalBlackBox: {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        integrity: 'SHA-256',
        totalCommands: numCommands
      },
      patient: {
        id: patient.patient_id,
        nom: patient.nom,
        prenom: patient.prenom,
        pathologie: pathologieBase,
        typeOperation: typeOperation,
        statut: patient.statut,
        dateCreation: patient.created_at,
        dateIntervention: patient.date_intervention || null
      },
      operator: {
        nom: patient.chirurgien ? `${patient.chirurgien.prenom} ${patient.chirurgien.nom}` : 'Inconnu',
        role: patient.chirurgien?.role || 'Inconnu'
      },
      auditTrail: {
        commandLog: commandHashes,
        verificationHash: generateHash({
          patientId: patient.patient_id,
          commands: commandHashes.map(h => h.hash)
        })
      },
      metadata: {
        system: 'Téléchirurgie 5G - Centre Hospitalier',
        license: 'Medical Device Class II',
        compliance: 'ISO 13485'
      }
    };
    
    // Définir les headers pour le téléchargement
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="surgical-blackbox-${patientId}.json"`);
    
    res.json(blackBoxData);
    
  } catch (error) {
    console.error('[PATIENTS] Erreur génération logs:', error);
    res.status(500).json({ error: 'Erreur serveur lors de la génération des logs' });
  }
});

// Terminer une opération (chirurgien sort et marque comme terminé) - TRANSACTION PRISMA
router.post('/:patientId/complete', async (req, res) => {
  try {
    const { patientId } = req.params;
    
    // TRANSACTION PRISMA - Archivage + mise à jour atomiques
    const result = await prisma.$transaction(async (tx) => {
      // Vérifier que le patient existe et est en cours
      const patient = await tx.patient.findUnique({
        where: { patientId }
      });
      
      if (!patient) {
        throw new Error('Patient non trouvé');
      }
      
      if (patient.statut !== 'en_cours') {
        throw new Error('Le patient n\'est pas en cours d\'opération');
      }
      
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
      const updated = await tx.patient.update({
        where: { id: patient.id },
        data: { statut: 'archive', chirurgienId: null }
      });
      
      return { patient, updated };
    });

    // Réinitialiser l'état assistant pour permettre un nouveau cycle patient
    systemState.operation.active = false;
    systemState.operation.patientId = null;
    systemState.operation.surgeonId = null;
    systemState.operation.startedAt = null;
    systemState.assistant.ready = false;
    systemState.assistant.patientConsent = false;
    systemState.assistant.patientConsentPatientId = null;
    systemState.assistant.activePatient = null;
    
    console.log(`[PATIENTS] Opération terminée pour ${patientId} (Prisma Transaction)`);
    
    res.json({ 
      message: 'Opération terminée avec succès',
      patient_id: patientId,
      archived: true
    });
    
  } catch (error) {
    console.error('[PATIENTS] Erreur terminaison opération:', error);
    if (error.message === 'Patient non trouvé') {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === 'Le patient n\'est pas en cours d\'opération') {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
