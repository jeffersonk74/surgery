Tu es un expert fullstack Node.js/Express/Prisma/Socket.io/HTML vanilla.
Tu travailles sur un système de téléchirurgie 5G composé d'un backend Express
+ Socket.io, d'un frontend HTML/JS vanilla, et d'un hardware Arduino 6DOF.

Voici les améliorations à effectuer, par ordre de priorité :

═══════════════════════════════════════════════════════════
PRIORITÉ 1 — BUGS CRITIQUES À CORRIGER
═══════════════════════════════════════════════════════════

1.1 — CORRECTION patients.js (Surgical Black Box)
Fichier : backend/src/routes/patients.js
Dans la route GET /download-logs/:patientId, remplacer toutes les
occurrences de `patient.patient_id` par `patient.patientId` et
`patient.created_at` par `patient.createdAt` pour correspondre
aux champs réels du modèle Prisma.

1.2 — CORRECTION app.js (références DOM nulles)
Fichier : frontend/app.js
Les objets `sliders` et `valueLabels` sont initialisés au niveau
module avec document.getElementById() AVANT DOMContentLoaded.
Ces références sont null au moment de l'exécution.
Déplacer leur initialisation à l'intérieur de DOMContentLoaded
ou dans la fonction initDomElements().

1.3 — CORRECTION double initialisation des listeners chat
Fichier : frontend/index.html
La fonction setupChatSocketListeners() est appelée avec
`if (state.socket)` après initSocket(), mais le socket peut
ne pas encore être connecté à ce moment. Appeler
setupChatSocketListeners() dans le callback `socket.on('connect')`
à la place.

═══════════════════════════════════════════════════════════
PRIORITÉ 2 — SÉCURITÉ
═══════════════════════════════════════════════════════════

2.1 — Hardening JWT
Fichier : backend/src/routes/auth.js
- Ajouter un rate limiting sur POST /api/auth/login
  (max 5 tentatives / 15 minutes par IP) en utilisant
  le package `express-rate-limit`
- Ajouter la vérification que req.body.email est bien
  un email valide (regex ou validator.js) avant la requête Prisma
- Passer JWT_SECRET en variable d'environnement obligatoire :
  si process.env.JWT_SECRET est absent, throw une erreur au démarrage

2.2 — Validation des commandes robot
Fichier : backend/src/sockets/index.js
Dans le handler `move-command`, ajouter une validation stricte :
- Vérifier que x, y, z, roll, pitch, yaw sont des numbers
- Les contraindre entre 0 et 180 côté serveur (ne pas faire confiance au client)
- Si les valeurs sont hors limites, logger un warning et rejeter
  la commande sans l'envoyer à l'Arduino

2.3 — Sécuriser la route /api/system/status
Fichier : backend/src/server.js
La route GET /api/system/status est actuellement publique.
Ajouter le middleware verifyToken importé depuis routes/auth.js.

═══════════════════════════════════════════════════════════
PRIORITÉ 3 — QUALITÉ & ROBUSTESSE
═══════════════════════════════════════════════════════════

3.1 — Nettoyer le schema Prisma
Fichier : backend/prisma/schema.prisma
Le fichier backend/prisma/schema-postgres.prisma est une
copie obsolète avec des enums non supportés par SQLite.
Le supprimer. Vérifier que schema.prisma est le seul fichier
de schema actif et qu'il est cohérent avec le provider sqlite.

3.2 — Gestion d'erreur globale Express
Fichier : backend/src/server.js
Ajouter un middleware d'erreur global Express APRÈS toutes les routes :
  app.use((err, req, res, next) => {
    console.error('[EXPRESS ERROR]', err);
    res.status(500).json({ error: 'Erreur interne serveur' });
  });
Également ajouter des handlers process.on('uncaughtException')
et process.on('unhandledRejection') qui loggent sans crasher.

3.3 — Reconnexion Arduino plus robuste
Fichier : backend/src/hardware/arduinoBridge.js
La surveillance passive actuelle ne détecte pas les cas où le port
série devient zombie (ouvert mais sans données). Ajouter un timeout :
si aucune donnée n'est reçue pendant 30 secondes ET que isConnected
est true, appeler handleDisconnect() et tenter une reconnexion.
Utiliser le timestamp de la dernière donnée reçue pour ce calcul.

3.4 — Fixer le race condition patient:created côté assistant
Fichier : frontend/assistant.html
Dans le handler socket.on('patient:created'), la vérification
`if (data.by === currentUser?.id)` pour éviter le doublon est
fragile car currentUser peut être null. Remplacer par une
vérification basée sur l'EventDeduplicator déjà présent dans le code :
utiliser data._eventId avec EventDeduplicator.isDuplicate() au lieu
de comparer les IDs utilisateurs.

═══════════════════════════════════════════════════════════
PRIORITÉ 4 — AMÉLIORATIONS FONCTIONNELLES
═══════════════════════════════════════════════════════════

4.1 — Persistance de l'état système au redémarrage
Fichier : backend/src/sockets/index.js + backend/src/server.js
Au démarrage, la fonction recoverSessionState() récupère l'état
depuis la BDD mais ne l'injecte pas dans systemState.
Après l'appel recoverSessionState() dans startServer(),
si un patient est en statut 'en_cours', mettre à jour :
  systemState.operation.active = true
  systemState.operation.patientId = sessionState.activePatient.id
Cela évite que le dashboard montre un état incohérent après
un redémarrage serveur pendant une opération.

4.2 — Endpoint healthcheck enrichi
Fichier : backend/src/server.js
Enrichir la route GET /health pour qu'elle retourne aussi :
- Le nombre de patients actifs (statut en_cours)
- Le statut de connexion Arduino (systemState.arduino.connected)
- L'uptime du serveur (process.uptime())
- La version Node.js
Faire un await prisma.patient.count() avec un try/catch pour
inclure l'info BDD sans bloquer si Prisma est KO.

4.3 — Améliorer le rapport de session
Fichier : backend/src/sockets/index.js (class SessionMetricsCollector)
Ajouter le calcul de la médiane de latence en plus de la moyenne
dans la méthode calculateStats(). La médiane est plus représentative
pour détecter les pics. Algorithme : trier les valeurs et prendre
l'élément central.

4.4 — Ajouter un indicateur visuel de connexion Socket.io
Fichier : frontend/dashboard.html + frontend/dashboard.js
Ajouter dans la topbar du dashboard un petit indicateur
(point coloré + texte) qui reflète l'état de la connexion Socket.io :
- Vert "Connecté" quand socket.connected === true
- Orange "Reconnexion..." pendant les tentatives
- Rouge "Hors ligne" quand disconnected
Mettre à jour cet indicateur dans les events
socket.on('connect'), socket.on('disconnect'), socket.on('reconnect')
déjà présents dans dashboard.js.

═══════════════════════════════════════════════════════════
CONTRAINTES IMPORTANTES
═══════════════════════════════════════════════════════════

- Ne pas changer le provider de base de données (rester sur SQLite)
- Ne pas introduire de framework frontend (rester vanilla JS)
- Ne pas casser l'API existante (les routes et événements Socket.io
  actuels doivent garder les mêmes noms)
- Tester chaque modification en vérifiant qu'elle ne casse pas
  le workflow principal : login → dashboard → sélection patient
  → assistant prêt → entrée en salle → opération → rapport final
- Pour chaque fichier modifié, afficher un résumé des changements
  effectués à la fin

Commence par la Priorité 1 (bugs critiques) avant de passer
aux suivantes. Demande confirmation avant chaque priorité
si tu n'es pas sûr du contexte.