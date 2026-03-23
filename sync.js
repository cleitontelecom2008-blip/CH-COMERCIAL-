/**
 * @fileoverview PDV SaaS — Sync Module v7.0.0
 *
 * MUDANÇAS v7 (SaaS):
 *  - Aguarda evento 'saas:ready' antes de iniciar restore
 *  - STORAGE_KEY derivado de window.SAAS_UID (isolado por empresa)
 *  - Firestore path: saas_dados/{uid} (um doc por empresa)
 *  - Mantém toda lógica de sync, retry, realtime listener
 */

import {
  doc,
  setDoc,
  getDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTS (dinâmicas — dependem de SAAS_UID disponível em runtime)
═══════════════════════════════════════════════════════════════════ */
const SAAS_COLLECTION      = 'saas_dados';        // uma collection para todos
const FIREBASE_WAIT_MS     = 8_000;               // aumentado para aguardar auth SaaS
const BACKUP_DEBOUNCE_MS   = 1_500;
const BACKUP_TIMEOUT_MS    = 25_000;
const SNAPSHOT_MIN_GAP_MS  = 3_000;

/** Storage key isolada por empresa (UID Firebase Auth) */
function _getStorageKey() {
  const uid = window.SAAS_UID;
  if (uid) return `SAAS_DB_${uid.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  return 'SAAS_DB_OFFLINE';
}

/** Referência do doc Firestore da empresa atual */
function _getEmpresaRef(db) {
  const uid = window.SAAS_UID || 'offline';
  return doc(db, SAAS_COLLECTION, uid);
}

/* ═══════════════════════════════════════════════════════════════════
   ESTADO INTERNO
═══════════════════════════════════════════════════════════════════ */
let _backupTimer       = null;
let _initCalled        = false;
let _isOffline         = false;
let _unsubSnapshot     = null;
let _lastSnapshotApply = 0;
let _lastLocalSave     = 0;

/* ═══════════════════════════════════════════════════════════════════
   INDICADOR VISUAL DE CONECTIVIDADE
═══════════════════════════════════════════════════════════════════ */
const ConnectivityUI = (() => {
  const BADGE_ID = 'ch-sync-badge';

  function set(status) {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => set(status), { once: true });
      return;
    }
    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement('div');
      badge.id    = BADGE_ID;
      badge.style.cssText = [
        'position:fixed', 'top:env(safe-area-inset-top,0px)', 'right:0',
        'z-index:99999', 'display:flex', 'align-items:center', 'gap:4px',
        'padding:4px 10px 4px 8px', 'border-radius:0 0 0 12px',
        'font-size:9px', 'font-weight:800', 'letter-spacing:.06em',
        'text-transform:uppercase', 'pointer-events:none', 'transition:background .3s,color .3s',
        'font-family:Plus Jakarta Sans,sans-serif',
      ].join(';');
      document.body.appendChild(badge);
    }
    const MAP = {
      online:  { bg: 'rgba(16,185,129,.15)', color: '#34d399', dot: '🟢', label: 'Sync'     },
      syncing: { bg: 'rgba(245,158,11,.15)', color: '#fbbf24', dot: '🟡', label: 'Salvando'  },
      offline: { bg: 'rgba(71,85,105,.15)',  color: '#64748b', dot: '⚫', label: 'Offline'   },
      error:   { bg: 'rgba(239,68,68,.15)',  color: '#f87171', dot: '🔴', label: 'Erro Sync'  },
    };
    const cfg = MAP[status] ?? MAP.offline;
    badge.style.background = cfg.bg;
    badge.style.color      = cfg.color;
    badge.innerHTML        = `<span style="font-size:7px">${cfg.dot}</span>${cfg.label}`;
  }
  return Object.freeze({ set });
})();

/* ═══════════════════════════════════════════════════════════════════
   UTILITÁRIOS
═══════════════════════════════════════════════════════════════════ */

/**
 * Aguarda window.SAAS_UID ser definido (evento saas:ready).
 * Timeout de FIREBASE_WAIT_MS → modo offline.
 */
function _waitSaasReady() {
  return new Promise(resolve => {
    if (window.SAAS_UID) { resolve(); return; }
    const timeout = setTimeout(resolve, FIREBASE_WAIT_MS);
    window.addEventListener('saas:ready', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

/**
 * Aguarda window.firestoreDB ficar disponível ou null (falha).
 * Reutiliza o db do SaaS se disponível.
 */
function _waitFirebase() {
  return new Promise(resolve => {
    // Prefere o _saasDb (inicializado pelo saas-auth.js)
    if (window._saasDb)             { resolve(window._saasDb); return; }
    if (window.firestoreDB)         { resolve(window.firestoreDB); return; }
    if (window.firestoreDB === null) { resolve(null); return; }

    const deadline = Date.now() + FIREBASE_WAIT_MS;
    const tick = () => {
      if (window._saasDb)            return resolve(window._saasDb);
      if (window.firestoreDB)        return resolve(window.firestoreDB);
      if (window.firestoreDB === null) return resolve(null);
      if (Date.now() >= deadline)    return resolve(null);
      setTimeout(tick, 80);
    };
    tick();
  });
}

function _withTimeout(promise, ms) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`[Sync] Timeout ${ms}ms`)), ms)
  );
  return Promise.race([promise, timer]);
}

function _readLocal() {
  try {
    const raw = localStorage.getItem(_getStorageKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function _callCHInit() {
  if (_initCalled) return;
  _initCalled = true;
  if (typeof window.CH_INIT === 'function') {
    try { window.CH_INIT(); }
    catch (err) { console.error('[Sync] Erro em CH_INIT:', err); }
    return;
  }
  setTimeout(() => {
    if (typeof window.CH_INIT === 'function') {
      window.CH_INIT();
    } else {
      console.error('[Sync] ❌ CH_INIT não encontrado. Verifique a ordem dos <script>.');
    }
  }, 500);
}

/* ═══════════════════════════════════════════════════════════════════
   RESTORE — Firestore → localStorage (executa no boot)
═══════════════════════════════════════════════════════════════════ */
async function _restoreFirestore() {
  ConnectivityUI.set('syncing');

  // ▶ NOVO: aguarda SaaS auth resolver antes de qualquer coisa
  await _waitSaasReady();

  const db = await _waitFirebase();

  if (!db || !window.SAAS_UID) {
    _isOffline = true;
    ConnectivityUI.set('offline');
    console.warn('[Sync] Firebase/SaaS indisponível — modo offline');
    _callCHInit();
    return;
  }

  try {
    const ref  = _getEmpresaRef(db);
    const snap = await _withTimeout(getDoc(ref), BACKUP_TIMEOUT_MS);

    if (snap.exists()) {
      const remote = snap.data()?.data;
      if (remote && typeof remote === 'object') {
        const local    = _readLocal();
        const localTs  = local?._updatedAt  ?? 0;
        const remoteTs = remote._updatedAt   ?? 0;

        if (!local || remoteTs > localTs) {
          localStorage.setItem(_getStorageKey(), JSON.stringify(remote));
          console.info(`[Sync] ✅ Restore remoto (${new Date(remoteTs).toLocaleTimeString('pt-BR')})`);
        } else {
          console.info(`[Sync] ℹ️ Local mais recente — mantendo`);
        }
      }
    } else {
      console.info('[Sync] Primeiro acesso ou base limpa desta empresa');
    }

    ConnectivityUI.set('online');
  } catch (err) {
    _isOffline = true;
    ConnectivityUI.set('error');
    console.warn('[Sync] Restore falhou — usando localStorage:', err.message);
  } finally {
    _callCHInit();
    _startRealtimeListener();
  }
}

/* ═══════════════════════════════════════════════════════════════════
   REAL-TIME LISTENER — onSnapshot
═══════════════════════════════════════════════════════════════════ */
async function _startRealtimeListener() {
  const db = window._saasDb || window.firestoreDB;
  if (!db || !window.SAAS_UID) return;

  if (typeof _unsubSnapshot === 'function') {
    _unsubSnapshot();
    _unsubSnapshot = null;
  }

  try {
    const ref = _getEmpresaRef(db);
    _unsubSnapshot = onSnapshot(
      ref,
      { includeMetadataChanges: false },
      (snapshot) => {
        if (snapshot.metadata.hasPendingWrites) return;
        if (!snapshot.exists())                 return;

        const remote   = snapshot.data()?.data;
        if (!remote || typeof remote !== 'object') return;

        const remoteTs = remote._updatedAt ?? 0;
        const memTs    = _readLocal()?._updatedAt ?? 0;
        if (remoteTs <= memTs) return;

        const msSinceLastSave = Date.now() - _lastLocalSave;
        if (msSinceLastSave < SNAPSHOT_MIN_GAP_MS) {
          const delay = SNAPSHOT_MIN_GAP_MS - msSinceLastSave + 200;
          setTimeout(() => _applyRemoteSnapshot(remote, remoteTs), delay);
          return;
        }

        const msSinceLast = Date.now() - _lastSnapshotApply;
        if (msSinceLast < SNAPSHOT_MIN_GAP_MS) {
          const delay = SNAPSHOT_MIN_GAP_MS - msSinceLast + 200;
          setTimeout(() => _applyRemoteSnapshot(remote, remoteTs), delay);
          return;
        }

        if (window.CH_SYNC_LOCK) {
          setTimeout(() => _applyRemoteSnapshot(remote, remoteTs), 2_500);
          return;
        }

        _applyRemoteSnapshot(remote, remoteTs);
      },
      (err) => {
        const isTransient = !err.code || err.code === 'unavailable' ||
                            (err.message && err.message.includes('400'));
        if (!isTransient) {
          _isOffline = true;
          ConnectivityUI.set('error');
          console.warn('[Sync] onSnapshot erro:', err.code, err.message);
        }
        setTimeout(_startRealtimeListener, 30_000);
      }
    );
    console.info('[Sync] 👂 Real-time listener ativo — empresa:', window.SAAS_UID);
    _isOffline = false;
    ConnectivityUI.set('online');
  } catch (err) {
    console.error('[Sync] Falha ao iniciar listener:', err.message);
  }
}

function _applyRemoteSnapshot(remoteData, remoteTs) {
  _lastSnapshotApply = Date.now();
  try {
    localStorage.setItem(_getStorageKey(), JSON.stringify(remoteData));
  } catch (err) {
    console.error('[Sync] Falha ao escrever localStorage:', err);
    return;
  }
  if (typeof window.CH_SAFE_SYNC === 'function') {
    window.CH_SAFE_SYNC(remoteData);
    console.info(`[Sync] 📡 Sync remoto aplicado (${new Date(remoteTs).toLocaleTimeString('pt-BR')})`);
  }
  ConnectivityUI.set('online');
}

/* ═══════════════════════════════════════════════════════════════════
   BACKUP — localStorage → Firestore
═══════════════════════════════════════════════════════════════════ */
let _offlineQueue  = [];
let _retryAttempt  = 0;
const RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000];

async function _executeBackup() {
  const db = window._saasDb || window.firestoreDB;
  if (!db || !window.SAAS_UID) {
    _isOffline = true;
    ConnectivityUI.set('offline');
    _enqueueForRetry();
    return;
  }

  const data = _readLocal();
  if (!data) return;

  ConnectivityUI.set('syncing');
  _lastLocalSave = Date.now();

  try {
    const ref = _getEmpresaRef(db);
    await _withTimeout(
      setDoc(ref, {
        data,
        updated:   new Date().toISOString(),
        version:   '7.0.0-saas',
        empresaId: window.SAAS_UID,
        device:    navigator.userAgent.slice(0, 80),
      }),
      BACKUP_TIMEOUT_MS
    );

    _isOffline    = false;
    _retryAttempt = 0;
    _offlineQueue = [];
    ConnectivityUI.set('online');
    console.info(`[Sync] 🔥 Backup OK (${new Date().toLocaleTimeString('pt-BR')})`);

  } catch (err) {
    _isOffline = true;
    ConnectivityUI.set('error');
    _enqueueForRetry();
    const delay = RETRY_DELAYS[Math.min(_retryAttempt, RETRY_DELAYS.length - 1)];
    _retryAttempt++;
    console.warn(`[Sync] Backup falhou — retry #${_retryAttempt} em ${delay/1000}s:`, err.message);
    setTimeout(_executeBackup, delay);
  }
}

function _enqueueForRetry() {
  const data = _readLocal();
  if (data && _offlineQueue.length < 3) _offlineQueue.push({ data, ts: Date.now() });
}

function _scheduleBackup() {
  _lastLocalSave = Date.now();
  clearTimeout(_backupTimer);
  _backupTimer = setTimeout(_executeBackup, BACKUP_DEBOUNCE_MS);
}

function _flushImmediate() {
  if (_backupTimer !== null) {
    clearTimeout(_backupTimer);
    _backupTimer = null;
    _executeBackup();
  }
}

/* ═══════════════════════════════════════════════════════════════════
   CONECTIVIDADE
═══════════════════════════════════════════════════════════════════ */
window.addEventListener('ch:connectivity', ({ detail }) => {
  if (detail.online) {
    _startRealtimeListener();
    if (_readLocal()) {
      _retryAttempt = 0;
      _executeBackup();
    }
    if (_offlineQueue.length > 0) {
      _offlineQueue = [];
      _executeBackup();
    }
  } else {
    _isOffline = true;
    ConnectivityUI.set('offline');
  }
});

window.addEventListener('beforeunload', _flushImmediate);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !_isOffline && window.SAAS_UID) {
    if (!_unsubSnapshot) _startRealtimeListener();
  }
});

/* ═══════════════════════════════════════════════════════════════════
   API PÚBLICA
═══════════════════════════════════════════════════════════════════ */
window.CH_BACKUP      = _scheduleBackup;
window.CH_SYNC_APPLY  = (data) => { if (data) _applyRemoteSnapshot(data, data._updatedAt ?? Date.now()); };
window.CH_FORCE_SYNC  = _executeBackup;
window.CH_SYNC_STATUS = () => ({
  empresaId:        window.SAAS_UID || null,
  storageKey:       _getStorageKey(),
  offline:          _isOffline,
  listenerAtivo:    typeof _unsubSnapshot === 'function',
  ultimoSaveLocal:  _lastLocalSave    ? new Date(_lastLocalSave).toLocaleTimeString('pt-BR')    : '—',
  ultimoSnapshot:   _lastSnapshotApply ? new Date(_lastSnapshotApply).toLocaleTimeString('pt-BR') : '—',
});

/* ═══════════════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════════════ */
_restoreFirestore();
