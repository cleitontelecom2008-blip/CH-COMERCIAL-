/**
 * @fileoverview PDV SaaS — Firebase Initialization v7.0.0
 *
 * MUDANÇAS v7 (SaaS):
 *  - Usa getApps() para reutilizar a app criada por saas-auth.js
 *  - Expõe window.firestoreDB como fallback para sync.js
 *  - Não precisa mais de LOJA_CONFIG (auth SaaS cuida do isolamento)
 */

import { initializeApp, getApps, getApp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, enableNetwork, disableNetwork }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ═══════════════════════════════════════════════════════════════════
   CONFIG — mesma do saas-auth.js (Firebase reutiliza a app já criada)
   ⚠️ Manter sincronizado com saas-auth.js!
═══════════════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyBwIYy2lsE5l7kPlNg6BHJMrFk6pH2uO28",
  authDomain:        "meu-pdv-saas.firebaseapp.com",
  projectId:         "meu-pdv-saas",
  storageBucket:     "meu-pdv-saas.firebasestorage.app",
  messagingSenderId: "722034622350",
  appId:             "1:722034622350:web:9f0001fe5b850c6b8aeedf",
};

/* ═══════════════════════════════════════════════════════════════════
   CONECTIVIDADE
═══════════════════════════════════════════════════════════════════ */
function _setupConnectivityListeners(db) {
  window.addEventListener('offline', async () => {
    console.info('[Firebase] 📴 Rede offline');
    try { await disableNetwork(db); } catch (_) {}
    window.dispatchEvent(new CustomEvent('ch:connectivity', { detail: { online: false } }));
  });

  window.addEventListener('online', async () => {
    console.info('[Firebase] 📶 Rede restaurada');
    try { await enableNetwork(db); } catch (_) {}
    window.dispatchEvent(new CustomEvent('ch:connectivity', { detail: { online: true } }));
  });
}

/* ═══════════════════════════════════════════════════════════════════
   INIT — reutiliza app do saas-auth.js se já criada
═══════════════════════════════════════════════════════════════════ */
try {
  // saas-auth.js pode já ter criado a app default
  const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
  const db  = getFirestore(app);

  // Expõe para sync.js (fallback — o _saasDb tem prioridade)
  window.firestoreDB = db;

  _setupConnectivityListeners(db);

  console.info(`[Firebase] ✅ Firestore pronto | online: ${navigator.onLine}`);

} catch (err) {
  console.error('[Firebase] ❌ Falha ao inicializar:', err);
  window.firestoreDB = null;
}
