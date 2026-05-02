-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "prenom" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "patientId" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "prenom" TEXT NOT NULL,
    "pathologie" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "chirurgienId" INTEGER,
    "assistantId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Patient_chirurgienId_fkey" FOREIGN KEY ("chirurgienId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Patient_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AssistantStatus" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "updatedAt" DATETIME NOT NULL,
    "patientId" INTEGER NOT NULL,
    "assistantId" INTEGER NOT NULL,
    CONSTRAINT "AssistantStatus_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AssistantStatus_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dateDebut" DATETIME,
    "dateFin" DATETIME,
    "dureeSeconds" INTEGER,
    "statut" TEXT NOT NULL DEFAULT 'en_cours',
    "blockchainHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "patientId" INTEGER NOT NULL,
    "chirurgienId" INTEGER NOT NULL,
    CONSTRAINT "Operation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Operation_chirurgienId_fkey" FOREIGN KEY ("chirurgienId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BlockchainLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "data" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operationId" INTEGER,
    CONSTRAINT "BlockchainLog_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HistoriqueOperation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "patientId" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "prenom" TEXT NOT NULL,
    "pathologie" TEXT NOT NULL,
    "dateDebut" DATETIME,
    "dateFin" DATETIME,
    "statut" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RobotState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "isConnected" BOOLEAN NOT NULL DEFAULT false,
    "lastPing" DATETIME,
    "port" TEXT,
    "simulationMode" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SystemSession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "assistantOnline" BOOLEAN NOT NULL DEFAULT false,
    "assistantReady" BOOLEAN NOT NULL DEFAULT false,
    "robotConnected" BOOLEAN NOT NULL DEFAULT false,
    "activePatientId" TEXT,
    "lastUpdated" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_patientId_key" ON "Patient"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantStatus_patientId_assistantId_key" ON "AssistantStatus"("patientId", "assistantId");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSession_sessionId_key" ON "SystemSession"("sessionId");
