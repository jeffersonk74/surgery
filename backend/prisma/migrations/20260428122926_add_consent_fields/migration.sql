-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Patient" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "patientId" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "prenom" TEXT NOT NULL,
    "pathologie" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "consentementPatient" BOOLEAN NOT NULL DEFAULT false,
    "consentementAt" DATETIME,
    "chirurgienId" INTEGER,
    "assistantId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Patient_chirurgienId_fkey" FOREIGN KEY ("chirurgienId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Patient_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Patient" ("assistantId", "chirurgienId", "createdAt", "id", "nom", "pathologie", "patientId", "prenom", "statut", "updatedAt") SELECT "assistantId", "chirurgienId", "createdAt", "id", "nom", "pathologie", "patientId", "prenom", "statut", "updatedAt" FROM "Patient";
DROP TABLE "Patient";
ALTER TABLE "new_Patient" RENAME TO "Patient";
CREATE UNIQUE INDEX "Patient_patientId_key" ON "Patient"("patientId");
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
