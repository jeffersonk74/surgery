// prisma/seed.js
// Script d'initialisation des données de test pour Prisma/PostgreSQL

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Créer les mots de passe hashés
  const hashChirurgien = await bcrypt.hash('chirurgien123', 10);
  const hashAssistant = await bcrypt.hash('assistant123', 10);

  // Upsert chirurgien (idempotent + reset du mot de passe attendu)
  const chirurgien = await prisma.user.upsert({
    where: { email: 'chirurgien@hospital.com' },
    update: {
      password: hashChirurgien,
      nom: 'Jefferson',
      prenom: 'Arnaud',
      role: 'chirurgien'
    },
    create: {
      email: 'chirurgien@hospital.com',
      password: hashChirurgien,
      nom: 'Jefferson',
      prenom: 'Arnaud',
      role: 'chirurgien'
    }
  });
  console.log(`👨‍⚕️ Chirurgien créé: ${chirurgien.prenom} ${chirurgien.nom}`);

  // Upsert assistant (idempotent + reset du mot de passe attendu)
  const assistant = await prisma.user.upsert({
    where: { email: 'assistant@hospital.com' },
    update: {
      password: hashAssistant,
      nom: 'Laurent',
      prenom: 'Marie',
      role: 'assistant'
    },
    create: {
      email: 'assistant@hospital.com',
      password: hashAssistant,
      nom: 'Laurent',
      prenom: 'Marie',
      role: 'assistant'
    }
  });
  console.log(`👩‍⚕️ Assistant créé: ${assistant.prenom} ${assistant.nom}`);

  const patientId = `PAT-${new Date().getFullYear()}-0001`;
  const patient = await prisma.patient.upsert({
    where: { patientId },
    update: {
      nom: 'Dupont',
      prenom: 'Jean',
      pathologie: 'Appendicite [Chirurgie digestive]',
      statut: 'en_attente',
      chirurgienId: chirurgien.id,
      assistantId: null
    },
    create: {
      patientId,
      nom: 'Dupont',
      prenom: 'Jean',
      pathologie: 'Appendicite [Chirurgie digestive]',
      statut: 'en_attente',
      chirurgienId: chirurgien.id
    }
  });
  console.log(`🧑‍⚕️ Patient de test créé: ${patient.patientId}`);

  await prisma.assistantStatus.upsert({
    where: {
      patientId_assistantId: {
        patientId: patient.id,
        assistantId: assistant.id
      }
    },
    update: { statut: 'en_attente' },
    create: {
      patientId: patient.id,
      assistantId: assistant.id,
      statut: 'en_attente'
    }
  });

  const existingRobotState = await prisma.robotState.findFirst({ select: { id: true } });
  if (existingRobotState) {
    await prisma.robotState.update({
      where: { id: existingRobotState.id },
      data: {
        isConnected: false,
        simulationMode: true,
        port: '/dev/ttyUSB0'
      }
    });
  } else {
    await prisma.robotState.create({
      data: {
        isConnected: false,
        simulationMode: true,
        port: '/dev/ttyUSB0'
      }
    });
  }
  console.log(`🤖 État robot initialisé`);

  console.log('\n✅ Seeding terminé avec succès (idempotent) !');
  console.log('\n🔑 Identifiants de test:');
  console.log('  Chirurgien: chirurgien@hospital.com / chirurgien123');
  console.log('  Assistant:  assistant@hospital.com / assistant123');
}

main()
  .catch((e) => {
    console.error('❌ Erreur seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
