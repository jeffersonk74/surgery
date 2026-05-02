// backend/src/utils/logger.js
// Système de journalisation structuré avec rotation (simulation simple)
// Niveaux: INFO, WARN, ERROR

import fs from 'fs/promises';
import path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = 'telechirurgie.log';
const LOG_PATH = path.join(LOG_DIR, LOG_FILE);

async function ensureLogDir() {
  try {
    await fs.access(LOG_DIR);
  } catch {
    await fs.mkdir(LOG_DIR, { recursive: true });
  }
}

async function writeLog(level, message, context = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...context
  };

  const logLine = JSON.stringify(logEntry) + '\n';
  
  try {
    await ensureLogDir();
    await fs.appendFile(LOG_PATH, logLine);
    
    // Console output pour debug (facultatif selon env)
    if (level === 'ERROR') {
      console.error(`[${level}] ${message}`, context);
    } else {
      console.log(`[${level}] ${message}`);
    }
  } catch (err) {
    console.error('[LOGGER] Erreur écriture log:', err.message);
  }
}

export const logger = {
  info: (msg, ctx) => writeLog('INFO', msg, ctx),
  warn: (msg, ctx) => writeLog('WARN', msg, ctx),
  error: (msg, ctx) => writeLog('ERROR', msg, ctx),
  debug: (msg, ctx) => writeLog('DEBUG', msg, ctx)
};
