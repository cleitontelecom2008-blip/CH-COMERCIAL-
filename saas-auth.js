/**
 * @fileoverview SaaS Auth — Autenticação + Gestão de Empresas
 * @version 1.0.0
 *
 * Fluxo:
 *  1. Inicializa Firebase App (antes de firebase.js e sync.js)
 *  2. Verifica onAuthStateChanged
 *  3. Se autenticado → busca dados da empresa → seta window.SAAS_UID
 *  4. Se novo → mostra wizard de cadastro
 *  5. Dispara evento 'saas:ready' → sync.js pode iniciar
 *
 * ⚠️  CONFIGURE seu Firebase abaixo antes de usar!
 */

import {
  initializeApp, getApps, getApp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc, getDoc, setDoc, updateDoc, serverTimestamp, increment,
  collection, getDocs, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ═══════════════════════════════════════════════════════════════════
   ⚠️  CONFIGURE AQUI — Crie um novo projeto Firebase para o SaaS
   firebase.google.com → Adicionar projeto → habilitar Authentication
   (Email/Senha) e Firestore Database
═══════════════════════════════════════════════════════════════════ */
const SAAS_CONFIG = {
    apiKey:            "AIzaSyBwIYy2lsE5l7kPlNg6BHJMrFk6pH2uO28",
  authDomain:        "meu-pdv-saas.firebaseapp.com",
  projectId:         "meu-pdv-saas",
  storageBucket:     "meu-pdv-saas.firebasestorage.app",
  messagingSenderId: "722034622350",
  appId:             "1:722034622350:web:9f0001fe5b850c6b8aeedf",
};

/* UID do super-admin (você). Obtenha após o primeiro login em admin.html */
const ADMIN_UID = "SEU_UID_ADMIN";

/* ═══════════════════════════════════════════════════════════════════
   PLANOS — definição mestre (espelhada em saas-plans.js)
═══════════════════════════════════════════════════════════════════ */
const PLANOS_DEF = {
  free: {
    nome: 'Grátis',         preco: 0,
    vendasMes: 200,         delivery: false,
    ia: false,              usuarios: 1,
    cor: '#6b7280',         badge: 'FREE',
  },
  basic: {
    nome: 'Basic',          preco: 4900,
    vendasMes: 2000,        delivery: true,
    ia: false,              usuarios: 3,
    cor: '#3b82f6',         badge: 'BASIC',
  },
  pro: {
    nome: 'Pro',            preco: 9900,
    vendasMes: Infinity,    delivery: true,
    ia: true,               usuarios: 10,
    cor: '#a855f7',         badge: 'PRO',
  },
};

/* ═══════════════════════════════════════════════════════════════════
   FIREBASE INIT — reutiliza app se firebase.js já criou
═══════════════════════════════════════════════════════════════════ */
const _app  = getApps().length ? getApp() : initializeApp(SAAS_CONFIG);
const _auth = getAuth(_app);
const _db   = getFirestore(_app);

// Expõe para firebase.js e sync.js reutilizarem
window._saasApp = _app;
window._saasDb  = _db;

/* ═══════════════════════════════════════════════════════════════════
   ESTADO
═══════════════════════════════════════════════════════════════════ */
let _currentUser    = null;
let _currentEmpresa = null;

/* ═══════════════════════════════════════════════════════════════════
   LOGIN OVERLAY HTML
═══════════════════════════════════════════════════════════════════ */
function _injectLoginOverlay() {
  if (document.getElementById('saas-overlay')) return;

  const el = document.createElement('div');
  el.id = 'saas-overlay';
  el.innerHTML = `
<style>
#saas-overlay{
  position:fixed;inset:0;z-index:99990;
  background:linear-gradient(135deg,#060810 0%,#0d1117 50%,#060810 100%);
  display:flex;align-items:center;justify-content:center;
  font-family:'Plus Jakarta Sans',sans-serif;
}
#saas-overlay.hide{
  opacity:0;pointer-events:none;transition:opacity .4s;
}
.saas-card{
  background:rgba(17,24,39,.98);border:1px solid rgba(255,255,255,.08);
  border-radius:2rem;padding:2.5rem 2rem;width:100%;max-width:400px;
  box-shadow:0 32px 64px rgba(0,0,0,.6);
}
.saas-logo{
  text-align:center;margin-bottom:1.5rem;
}
.saas-logo .icon{font-size:3rem;display:block;margin-bottom:.5rem;}
.saas-logo h1{font-size:1.5rem;font-weight:900;color:#f1f5f9;letter-spacing:-.02em;}
.saas-logo p{font-size:.75rem;color:#4b5563;margin-top:.25rem;}
.saas-tabs{display:flex;gap:.5rem;margin-bottom:1.5rem;}
.saas-tab{
  flex:1;padding:.6rem;font-size:.75rem;font-weight:800;text-transform:uppercase;
  letter-spacing:.05em;border-radius:.75rem;border:none;cursor:pointer;
  background:transparent;color:#4b5563;transition:all .15s;
}
.saas-tab.active{background:rgba(59,130,246,.15);color:#60a5fa;}
.saas-inp{
  width:100%;background:#1e293b;border:2px solid #334155;border-radius:.75rem;
  padding:.85rem 1rem;color:#fff;font-size:.9rem;font-family:inherit;
  outline:none;margin-bottom:.75rem;transition:border-color .15s;
}
.saas-inp:focus{border-color:#3b82f6;}
.saas-btn{
  width:100%;padding:.9rem;border-radius:.9rem;border:none;cursor:pointer;
  font-size:.9rem;font-weight:800;font-family:inherit;transition:all .15s;
  background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;margin-top:.25rem;
}
.saas-btn:hover{opacity:.9;transform:translateY(-1px);}
.saas-btn:active{transform:translateY(0);}
.saas-btn:disabled{opacity:.4;cursor:not-allowed;transform:none;}
.saas-btn-ghost{
  background:transparent;border:1px solid rgba(255,255,255,.1);color:#94a3b8;
  margin-top:.5rem;font-size:.8rem;
}
.saas-err{
  background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);
  color:#f87171;border-radius:.75rem;padding:.75rem 1rem;
  font-size:.8rem;margin-bottom:.75rem;display:none;
}
.saas-err.show{display:block;}
.saas-success{
  background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);
  color:#34d399;border-radius:.75rem;padding:.75rem 1rem;
  font-size:.8rem;margin-bottom:.75rem;display:none;
}
.saas-success.show{display:block;}
.saas-sep{text-align:center;font-size:.7rem;color:#374151;margin:.5rem 0;}
.saas-plan-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;margin-bottom:1rem;}
.saas-plan-btn{
  border:2px solid transparent;border-radius:.75rem;padding:.75rem .5rem;
  text-align:center;cursor:pointer;background:rgba(255,255,255,.03);
  transition:all .15s;
}
.saas-plan-btn.sel{background:rgba(59,130,246,.1);border-color:#3b82f6;}
.saas-plan-btn .pname{font-size:.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;}
.saas-plan-btn .pprice{font-size:.8rem;font-weight:700;color:#94a3b8;margin-top:.2rem;}
.saas-back{font-size:.75rem;color:#6b7280;text-align:center;margin-top:1rem;cursor:pointer;}
.saas-back:hover{color:#94a3b8;}
</style>

<div class="saas-card">
  <div class="saas-logo">
    <span class="icon">🏪</span>
    <h1>PDV SaaS</h1>
    <p>Sistema de gestão para seu negócio</p>
  </div>

  <!-- PAINEL: Login -->
  <div id="saas-pnl-login">
    <div class="saas-tabs">
      <button class="saas-tab active" onclick="SaasAuth._tab('login')">Entrar</button>
      <button class="saas-tab"        onclick="SaasAuth._tab('register')">Cadastrar</button>
    </div>
    <div class="saas-err" id="saas-err-login"></div>
    <input class="saas-inp" id="saas-email" type="email" placeholder="seu@email.com" autocomplete="email">
    <input class="saas-inp" id="saas-pass"  type="password" placeholder="Senha" autocomplete="current-password">
    <button class="saas-btn" id="saas-btn-login" onclick="SaasAuth._login()">Entrar</button>
    <button class="saas-btn saas-btn-ghost" onclick="SaasAuth._tab('forgot')">Esqueci minha senha</button>
  </div>

  <!-- PAINEL: Cadastro -->
  <div id="saas-pnl-register" style="display:none">
    <div class="saas-tabs">
      <button class="saas-tab"        onclick="SaasAuth._tab('login')">Entrar</button>
      <button class="saas-tab active" onclick="SaasAuth._tab('register')">Cadastrar</button>
    </div>
    <div class="saas-err" id="saas-err-register"></div>
    <input class="saas-inp" id="saas-r-nome"  type="text"     placeholder="Nome do estabelecimento">
    <input class="saas-inp" id="saas-r-email" type="email"    placeholder="seu@email.com" autocomplete="email">
    <input class="saas-inp" id="saas-r-pass"  type="password" placeholder="Senha (mín. 6 caracteres)">
    <div style="font-size:.75rem;color:#6b7280;margin-bottom:.75rem;font-weight:600;">Escolha seu plano:</div>
    <div class="saas-plan-grid" id="saas-plan-grid"></div>
    <button class="saas-btn" id="saas-btn-register" onclick="SaasAuth._register()">Criar conta grátis</button>
  </div>

  <!-- PAINEL: Esqueci senha -->
  <div id="saas-pnl-forgot" style="display:none">
    <div class="saas-tabs" style="opacity:.5;pointer-events:none">
      <button class="saas-tab">Entrar</button>
      <button class="saas-tab">Cadastrar</button>
    </div>
    <div class="saas-err"     id="saas-err-forgot"></div>
    <div class="saas-success" id="saas-ok-forgot"></div>
    <input class="saas-inp" id="saas-f-email" type="email" placeholder="seu@email.com">
    <button class="saas-btn" onclick="SaasAuth._forgotPassword()">Enviar link de recuperação</button>
    <div class="saas-back" onclick="SaasAuth._tab('login')">← Voltar ao login</div>
  </div>

  <!-- PAINEL: Loading -->
  <div id="saas-pnl-loading" style="display:none;text-align:center;padding:2rem 0">
    <div style="font-size:2rem;margin-bottom:.75rem;">⏳</div>
    <div style="font-size:.85rem;color:#6b7280;font-weight:600;" id="saas-loading-msg">Verificando...</div>
  </div>
</div>`;

  document.body.appendChild(el);
  _renderPlanGrid();
}

/* ═══════════════════════════════════════════════════════════════════
   HELPERS DE UI
═══════════════════════════════════════════════════════════════════ */
function _showPanel(id) {
  ['login','register','forgot','loading'].forEach(p => {
    const el = document.getElementById(`saas-pnl-${p}`);
    if (el) el.style.display = p === id ? '' : 'none';
  });
}

function _showError(panel, msg) {
  const el = document.getElementById(`saas-err-${panel}`);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 5000);
}

function _setLoading(panel, btn, loading) {
  const btnEl = document.getElementById(`saas-btn-${panel}`);
  if (btnEl) { btnEl.disabled = loading; btnEl.textContent = loading ? 'Aguarde...' : btn; }
}

function _setLoadingMsg(msg) {
  const el = document.getElementById('saas-loading-msg');
  if (el) el.textContent = msg;
}

function _renderPlanGrid() {
  const grid = document.getElementById('saas-plan-grid');
  if (!grid) return;
  let sel = 'free';
  grid.innerHTML = Object.entries(PLANOS_DEF).map(([key, p]) => `
    <div class="saas-plan-btn ${key === sel ? 'sel' : ''}"
         id="saas-plan-${key}"
         onclick="SaasAuth._selPlan('${key}')"
         style="border-color:${key === sel ? p.cor : 'transparent'}">
      <div class="pname" style="color:${p.cor}">${p.nome}</div>
      <div class="pprice">${p.preco === 0 ? 'Grátis' : 'R$' + (p.preco/100).toFixed(0) + '/mês'}</div>
    </div>`).join('');
  window._saasSelPlan = 'free';
}

/* ═══════════════════════════════════════════════════════════════════
   API PÚBLICA (window.SaasAuth)
═══════════════════════════════════════════════════════════════════ */
window.SaasAuth = {
  _tab(tab) {
    _showPanel(tab);
    // Sync tab buttons
    document.querySelectorAll('#saas-pnl-login .saas-tab, #saas-pnl-register .saas-tab').forEach((btn, i) => {
      btn.classList.toggle('active', (tab === 'login' && i === 0) || (tab === 'register' && i === 1));
    });
  },

  _selPlan(key) {
    window._saasSelPlan = key;
    Object.keys(PLANOS_DEF).forEach(k => {
      const el = document.getElementById(`saas-plan-${k}`);
      if (!el) return;
      el.classList.toggle('sel', k === key);
      el.style.borderColor = k === key ? PLANOS_DEF[k].cor : 'transparent';
    });
  },

  async _login() {
    const email = document.getElementById('saas-email')?.value?.trim();
    const pass  = document.getElementById('saas-pass')?.value;
    if (!email || !pass) { _showError('login', 'Preencha email e senha.'); return; }
    _setLoading('login', 'Entrar', true);
    try {
      await signInWithEmailAndPassword(_auth, email, pass);
      // onAuthStateChanged vai resolver o resto
    } catch (err) {
      _setLoading('login', 'Entrar', false);
      _showError('login', _errMsg(err.code));
    }
  },

  async _register() {
    const nome  = document.getElementById('saas-r-nome')?.value?.trim();
    const email = document.getElementById('saas-r-email')?.value?.trim();
    const pass  = document.getElementById('saas-r-pass')?.value;
    const plano = window._saasSelPlan || 'free';
    if (!nome)             { _showError('register', 'Informe o nome do estabelecimento.'); return; }
    if (!email)            { _showError('register', 'Informe o email.'); return; }
    if (!pass || pass.length < 6) { _showError('register', 'Senha deve ter no mínimo 6 caracteres.'); return; }
    _setLoading('register', 'Criar conta grátis', true);
    try {
      const cred = await createUserWithEmailAndPassword(_auth, email, pass);
      await _createEmpresa(cred.user.uid, { nome, email, plano });
      // onAuthStateChanged continua o fluxo
    } catch (err) {
      _setLoading('register', 'Criar conta grátis', false);
      _showError('register', _errMsg(err.code));
    }
  },

  async _forgotPassword() {
    const email = document.getElementById('saas-f-email')?.value?.trim();
    if (!email) { _showError('forgot', 'Informe o email.'); return; }
    try {
      await sendPasswordResetEmail(_auth, email);
      const ok = document.getElementById('saas-ok-forgot');
      if (ok) { ok.textContent = 'Link enviado! Verifique sua caixa de entrada.'; ok.classList.add('show'); }
    } catch (err) {
      _showError('forgot', _errMsg(err.code));
    }
  },

  async logout() {
    await signOut(_auth);
    window.SAAS_UID     = null;
    window.SAAS_EMPRESA = null;
    location.reload();
  },

  getEmpresa: () => _currentEmpresa,
  getUid:     () => _currentUser?.uid || null,
};

/* ═══════════════════════════════════════════════════════════════════
   CRIAÇÃO DE EMPRESA (primeiro acesso)
═══════════════════════════════════════════════════════════════════ */
async function _createEmpresa(uid, { nome, email, plano }) {
  const expira = new Date();
  expira.setDate(expira.getDate() + 14); // 14 dias trial

  await setDoc(doc(_db, 'empresas', uid), {
    uid,
    nome,
    email,
    plano:       plano === 'free' ? 'free' : 'trial_' + plano,
    planoReal:   plano,
    planoExpira: expira.toISOString(),
    ativo:       true,
    criadoEm:    new Date().toISOString(),
    vendasMes:   0,
    mesAtual:    _mesKey(),
    limites:     PLANOS_DEF[plano] || PLANOS_DEF.free,
  });
}

/* ═══════════════════════════════════════════════════════════════════
   FETCH / RESOLVE EMPRESA
═══════════════════════════════════════════════════════════════════ */
async function _resolveEmpresa(uid) {
  const snap = await getDoc(doc(_db, 'empresas', uid));
  if (!snap.exists()) return null;
  return snap.data();
}

function _mesKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

/* ═══════════════════════════════════════════════════════════════════
   BADGE DE PLANO NO HEADER
═══════════════════════════════════════════════════════════════════ */
function _injectPlanBadge(empresa) {
  if (document.getElementById('saas-plan-badge')) return;
  const planoKey = empresa.planoReal || empresa.plano || 'free';
  const plano    = PLANOS_DEF[planoKey] || PLANOS_DEF.free;
  const badge = document.createElement('div');
  badge.id = 'saas-plan-badge';
  badge.style.cssText = [
    'position:fixed','top:env(safe-area-inset-top,0px)','left:0','z-index:99998',
    'padding:4px 10px','border-radius:0 0 12px 0',
    `background:${plano.cor}22`,`color:${plano.cor}`,
    'font-size:8px','font-weight:900','letter-spacing:.1em',
    'font-family:Plus Jakarta Sans,sans-serif','pointer-events:none',
  ].join(';');
  badge.innerHTML = `
    <span style="opacity:.6">${empresa.nome?.substring(0,18) || 'Empresa'}</span>
    <span style="margin-left:4px;background:${plano.cor};color:#fff;border-radius:4px;padding:1px 5px">${plano.badge || planoKey.toUpperCase()}</span>
  `;
  document.body.appendChild(badge);
}

/* ═══════════════════════════════════════════════════════════════════
   PLAN LIMIT BADGE (contagem de vendas do mês)
═══════════════════════════════════════════════════════════════════ */
function _checkPlanExpired(empresa) {
  if (!empresa.planoExpira) return false;
  return new Date(empresa.planoExpira) < new Date();
}

/* ═══════════════════════════════════════════════════════════════════
   SIGNAL PRONTO (dispara sync.js)
═══════════════════════════════════════════════════════════════════ */
function _signalReady(uid, empresa) {
  window.SAAS_UID     = uid;
  window.SAAS_EMPRESA = empresa;
  window.dispatchEvent(new CustomEvent('saas:ready', { detail: { uid, empresa } }));
}

/* ═══════════════════════════════════════════════════════════════════
   FECHAR OVERLAY
═══════════════════════════════════════════════════════════════════ */
function _hideOverlay() {
  const el = document.getElementById('saas-overlay');
  if (el) {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 500);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   ERRO MESSAGES
═══════════════════════════════════════════════════════════════════ */
function _errMsg(code) {
  const MAP = {
    'auth/invalid-email':           'Email inválido.',
    'auth/user-not-found':          'Email não encontrado.',
    'auth/wrong-password':          'Senha incorreta.',
    'auth/invalid-credential':      'Email ou senha incorretos.',
    'auth/email-already-in-use':    'Este email já está cadastrado.',
    'auth/weak-password':           'Senha muito fraca.',
    'auth/too-many-requests':       'Muitas tentativas. Aguarde um momento.',
    'auth/network-request-failed':  'Erro de conexão. Verifique sua internet.',
  };
  return MAP[code] || `Erro: ${code}`;
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN — onAuthStateChanged
═══════════════════════════════════════════════════════════════════ */

// Injeta overlay assim que DOM estiver pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _injectLoginOverlay);
} else {
  _injectLoginOverlay();
}

// Mostra loading enquanto resolve auth
_showPanel('loading');
_setLoadingMsg('Verificando sessão...');

onAuthStateChanged(_auth, async (user) => {
  if (!user) {
    // Não autenticado → mostrar login
    _showPanel('login');
    return;
  }

  _currentUser = user;
  _showPanel('loading');
  _setLoadingMsg('Carregando dados da empresa...');

  try {
    let empresa = await _resolveEmpresa(user.uid);

    if (!empresa) {
      // Usuário Firebase sem empresa → cria empresa mínima
      await _createEmpresa(user.uid, {
        nome:  user.displayName || user.email?.split('@')[0] || 'Minha Empresa',
        email: user.email,
        plano: 'free',
      });
      empresa = await _resolveEmpresa(user.uid);
    }

    if (!empresa.ativo) {
      _showPanel('login');
      _showError('login', '⚠️ Conta desativada. Entre em contato com o suporte.');
      await signOut(_auth);
      return;
    }

    _currentEmpresa = empresa;

    // Aguarda DOM para injetar badges
    const _inject = () => {
      _injectPlanBadge(empresa);
      _hideOverlay();
    };
    document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', _inject)
      : _inject();

    // Sinaliza para sync.js iniciar
    _signalReady(user.uid, empresa);

    console.info(`[SaasAuth] ✅ Empresa: ${empresa.nome} | Plano: ${empresa.plano}`);

  } catch (err) {
    console.error('[SaasAuth] Erro ao carregar empresa:', err);
    _showPanel('login');
    _showError('login', 'Erro ao carregar dados. Tente novamente.');
  }
});
