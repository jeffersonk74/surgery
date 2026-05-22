import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, Clock3, FileText, Stethoscope } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  arrayUnion,
  collection,
  doc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
} from 'firebase/firestore';

const fallbackConfig = {
  apiKey: 'demo-api-key',
  authDomain: 'demo.firebaseapp.com',
  projectId: 'demo-project',
  appId: 'demo-app-id',
};

const firebaseConfig = (() => {
  if (typeof __firebase_config === 'string' && __firebase_config.trim()) {
    try {
      return JSON.parse(__firebase_config);
    } catch {
      return fallbackConfig;
    }
  }
  if (typeof __firebase_config === 'object' && __firebase_config !== null) {
    return __firebase_config;
  }
  return fallbackConfig;
})();

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const appId = firebaseConfig.appId || 'default-app-id';
const patientsCollection = collection(db, 'artifacts', appId, 'public', 'data', 'patients');

function formatLog(log, index) {
  if (!log) return `Log #${index + 1}`;
  if (typeof log === 'string') return log;
  if (typeof log === 'object') return log.message || log.text || JSON.stringify(log);
  return String(log);
}

export default function App() {
  const [patients, setPatients] = useState([]);
  const [selectedPatientId, setSelectedPatientId] = useState('');
  const [logMessage, setLogMessage] = useState('');
  const [authError, setAuthError] = useState('');
  const [dataError, setDataError] = useState('');
  const [isWriting, setIsWriting] = useState(false);

  useEffect(() => {
    signInAnonymously(auth).catch((error) => {
      setAuthError(error?.message || 'Anonymous authentication failed.');
    });
  }, []);

  useEffect(() => {
    const patientsQuery = query(patientsCollection, orderBy('name'));
    const unsubscribe = onSnapshot(
      patientsQuery,
      (snapshot) => {
        setDataError('');
        const nextPatients = snapshot.docs.map((snapshotDoc) => ({
          id: snapshotDoc.id,
          ...snapshotDoc.data(),
        }));
        setPatients(nextPatients);
      },
      (error) => {
        setDataError(error?.message || 'Unable to read patients in realtime.');
      }
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!patients.length) {
      setSelectedPatientId('');
      return;
    }
    if (!patients.some((patient) => patient.id === selectedPatientId)) {
      setSelectedPatientId(patients[0].id);
    }
  }, [patients, selectedPatientId]);

  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.id === selectedPatientId) || null,
    [patients, selectedPatientId]
  );

  const setReady = async () => {
    if (!selectedPatient) return;
    setIsWriting(true);
    try {
      await updateDoc(doc(patientsCollection, selectedPatient.id), { status: 'ready' });
    } catch (error) {
      setDataError(error?.message || 'Unable to validate preparation.');
    } finally {
      setIsWriting(false);
    }
  };

  const addOperationLog = async () => {
    if (!selectedPatient || !logMessage.trim()) return;
    setIsWriting(true);
    try {
      await updateDoc(doc(patientsCollection, selectedPatient.id), {
        logs: arrayUnion(`${new Date().toISOString()} - ${logMessage.trim()}`),
      });
      setLogMessage('');
    } catch (error) {
      setDataError(error?.message || 'Unable to append operation log.');
    } finally {
      setIsWriting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl grid-cols-1 gap-4 p-4 lg:grid-cols-[360px_1fr]">
        <aside className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
          <div className="mb-4 flex items-center gap-2 text-blue-400">
            <Stethoscope className="h-5 w-5" />
            <h1 className="text-lg font-semibold">Medical Dash</h1>
          </div>
          <h2 className="mb-2 text-sm font-medium text-slate-300">Dashboard Patients</h2>
          <ul className="space-y-2">
            {patients.map((patient) => (
              <li key={patient.id}>
                <button
                  type="button"
                  onClick={() => setSelectedPatientId(patient.id)}
                  className={`w-full rounded-lg border p-3 text-left transition ${
                    selectedPatientId === patient.id
                      ? 'border-blue-400 bg-blue-500/10'
                      : 'border-slate-700 bg-slate-900 hover:border-slate-600'
                  }`}
                >
                  <p className="font-medium text-slate-100">{patient.name || 'Patient sans nom'}</p>
                  <p className="mt-1 text-xs text-slate-400">{patient.surgeryType || 'Chirurgie non définie'}</p>
                  <p className="mt-2 inline-flex items-center gap-1 text-xs">
                    {patient.status === 'ready' ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 text-blue-400" />
                        <span className="text-blue-300">ready</span>
                      </>
                    ) : (
                      <>
                        <Clock3 className="h-3.5 w-3.5 text-amber-400" />
                        <span className="text-amber-300">pending</span>
                      </>
                    )}
                  </p>
                </button>
              </li>
            ))}
          </ul>
          {!patients.length && (
            <p className="mt-3 text-sm text-slate-400">
              Aucun patient. Collection attendue : /artifacts/{appId}/public/data/patients
            </p>
          )}
        </aside>

        <main className="grid gap-4">
          <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
            <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-blue-300">
              <FileText className="h-4 w-4" />
              Dossier Patient
            </h2>
            {selectedPatient ? (
              <>
                <p className="text-lg font-semibold">{selectedPatient.name}</p>
                <p className="mt-1 text-sm text-slate-300">
                  Type d&apos;opération : {selectedPatient.surgeryType || 'Non renseigné'}
                </p>
                <button
                  type="button"
                  disabled={selectedPatient.status === 'pending'}
                  className="mt-4 rounded-lg bg-blue-400 px-4 py-2 text-sm font-medium text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                >
                  Démarrer l&apos;opération
                </button>
              </>
            ) : (
              <p className="text-sm text-slate-400">Sélectionnez un patient pour afficher son dossier.</p>
            )}
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
              <h3 className="mb-2 text-sm font-semibold text-blue-300">Interface Assistant</h3>
              <p className="mb-3 text-sm text-slate-400">
                Valide la préparation pour débloquer le démarrage côté chirurgien.
              </p>
              <button
                type="button"
                onClick={setReady}
                disabled={!selectedPatient || isWriting}
                className="rounded-lg border border-blue-400 px-4 py-2 text-sm font-medium text-blue-300 transition hover:bg-blue-400/10 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
              >
                Valider la préparation
              </button>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-blue-300">
                <Activity className="h-4 w-4" />
                Salle d&apos;Opération
              </h3>
              <div className="flex gap-2">
                <input
                  value={logMessage}
                  onChange={(event) => setLogMessage(event.target.value)}
                  placeholder="Ajouter un log opératoire..."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none ring-blue-400 focus:ring-1"
                />
                <button
                  type="button"
                  onClick={addOperationLog}
                  disabled={!selectedPatient || !logMessage.trim() || isWriting}
                  className="rounded-lg bg-blue-400 px-3 py-2 text-sm font-medium text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                >
                  Envoyer
                </button>
              </div>
              <ul className="mt-3 max-h-40 space-y-1 overflow-auto text-sm text-slate-300">
                {(selectedPatient?.logs || []).map((log, index) => (
                  <li key={`${selectedPatient.id}-log-${index}`} className="rounded bg-slate-950/70 px-2 py-1">
                    {formatLog(log, index)}
                  </li>
                ))}
                {!!selectedPatient && !(selectedPatient.logs || []).length && (
                  <li className="text-slate-500">Aucun log pour ce patient.</li>
                )}
              </ul>
            </div>
          </section>

          {(authError || dataError) && (
            <section className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
              <p>{authError || dataError}</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
