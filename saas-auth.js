/**
 * @fileoverview SaaS Auth — Autenticação + Gestão de Empresas
 * @version 2.1.0
 *
 * Arquitetura v2 (multi-usuário real):
 *  ┌─────────────────────────────────────────────────────────┐
 *  │  empresas/{empresaId}  ← dados da empresa (plano, etc.) │
 *  │  usuarios/{uid}        ← vínculo usuário ↔ empresa      │
 *  │  saas_dados/{empresaId}← dados PDV isolados por empresa │
 *  └─────────────────────────────────────────────────────────┘
 *
 * Fluxo:
 *  1. Inicializa Firebase (antes de firebase.js e sync.js)
 *  2. onAuthStateChanged → busca usuarios/{uid} → obtém empresaId
 *  3. Carrega empresas/{empresaId} → valida status/plano
 *  4. Seta window.SAAS_UID = empresaId (sync.js usa este valor)
 *  5. Dispara evento 'saas:ready' → sync.js inicia
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
  doc, getDoc, setDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ═══════════════════════════════════════════════════════════════════
   ⚠️  CONFIGURE AQUI
═══════════════════════════════════════════════════════════════════ */
const SAAS_CONFIG = {
  apiKey:            "AIzaSyBwIYy2lsE5l7kPlNg6BHJMrFk6pH2uO28",
  authDomain:        "meu-pdv-saas.firebaseapp.com",
  projectId:         "meu-pdv-saas",
  storageBucket:     "meu-pdv-saas.firebasestorage.app",
  messagingSenderId: "722034622350",
  appId:             "1:722034622350:web:9f0001fe5b850c6b8aeedf",
};


/* ═══════════════════════════════════════════════════════════════════
   PLANOS
═══════════════════════════════════════════════════════════════════ */
const PLANOS_DEF = {
  free:  { nome:'Grátis', preco:0,    vendasMes:200,      delivery:false, ia:false, usuarios:1,  cor:'#6b7280', badge:'FREE'  },
  basic: { nome:'Basic',  preco:4900, vendasMes:2000,     delivery:true,  ia:false, usuarios:3,  cor:'#3b82f6', badge:'BASIC' },
  pro:   { nome:'Pro',    preco:9900, vendasMes:Infinity, delivery:true,  ia:true,  usuarios:10, cor:'#a855f7', badge:'PRO'   },
};

/* ═══════════════════════════════════════════════════════════════════
   FIREBASE INIT
═══════════════════════════════════════════════════════════════════ */
const _app  = getApps().length ? getApp() : initializeApp(SAAS_CONFIG);
const _auth = getAuth(_app);
const _db   = getFirestore(_app);

window._saasApp = _app;
window._saasDb  = _db;

/* ═══════════════════════════════════════════════════════════════════
   ESTADO
═══════════════════════════════════════════════════════════════════ */
let _currentUser    = null;
let _currentEmpresa = null;
let _currentUsuario = null;

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════════ */
function _mesKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function _gerarEmpresaId() {
  const rand = Math.random().toString(36).slice(2,8).toUpperCase();
  return `emp_${Date.now()}_${rand}`;
}

/* ═══════════════════════════════════════════════════════════════════
   CRIAÇÃO DE EMPRESA + USUÁRIO
═══════════════════════════════════════════════════════════════════ */
async function _createEmpresaEUsuario(uid, { nome, email, plano }) {
  const empresaId = _gerarEmpresaId();
  const expira    = new Date();
  expira.setDate(expira.getDate() + 14);

  await setDoc(doc(_db, 'empresas', empresaId), {
    nome,
    plano:       plano === 'free' ? 'free' : 'trial_' + plano,
    planoReal:   plano,
    planoExpira: expira.toISOString(),
    status:      'ativo',
    criadoEm:    new Date().toISOString(),
    dono:        uid,
    vendasMes:   0,
    mesAtual:    _mesKey(),
    limites:     PLANOS_DEF[plano] || PLANOS_DEF.free,
  });

  await setDoc(doc(_db, 'usuarios', uid), {
    empresaId,
    nome,
    email,
    cargo:        'dono',
    criadoEm:     new Date().toISOString(),
    ultimoAcesso: new Date().toISOString(),
  });

  return empresaId;
}

/* ═══════════════════════════════════════════════════════════════════
   RESOLVE
═══════════════════════════════════════════════════════════════════ */
async function _resolveUsuario(uid) {
  const snap = await getDoc(doc(_db, 'usuarios', uid));
  return snap.exists() ? snap.data() : null;
}

async function _resolveEmpresa(empresaId) {
  const snap = await getDoc(doc(_db, 'empresas', empresaId));
  return snap.exists() ? snap.data() : null;
}

/* ═══════════════════════════════════════════════════════════════════
   VALIDAÇÃO DE PLANO
   Retorna: null (válido) | string (mensagem de erro)
═══════════════════════════════════════════════════════════════════ */
function _validarPlano(empresa) {
  // 1. Empresa deve existir
  if (!empresa) return '⚠️ Empresa não encontrada. Entre em contato com o suporte.';

  // 2. Status deve ser "ativo"
  if (empresa.status !== 'ativo')
    return '🚫 Conta desativada. Entre em contato com o suporte.';

  // 3. Plano free nunca expira — os demais têm planoExpira
  const planoKey = empresa.planoReal || empresa.plano?.replace('trial_', '') || 'free';
  if (planoKey === 'free') return null;          // free: sempre válido

  // 4. Verificar expiração (plano pago/trial)
  if (empresa.planoExpira) {
    const expira = new Date(empresa.planoExpira);
    if (expira < new Date()) {
      const dias = Math.ceil((new Date() - expira) / 86_400_000);
      return `⏳ Plano ${planoKey.toUpperCase()} expirado há ${dias} dia(s). Renove para continuar.`;
    }
  }

  return null; // plano válido
}

function _touchUsuario(uid) {
  updateDoc(doc(_db, 'usuarios', uid), { ultimoAcesso: new Date().toISOString() }).catch(()=>{});
}

/* ═══════════════════════════════════════════════════════════════════
   BADGE DE PLANO
═══════════════════════════════════════════════════════════════════ */
function _injectPlanBadge(empresa) {
  if (document.getElementById('saas-plan-badge')) return;
  const planoKey = empresa.planoReal || empresa.plano?.replace('trial_','') || 'free';
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
   SIGNAL READY
   window.SAAS_UID      = empresaId  (path Firestore: saas_dados/{empresaId})
   window.SAAS_USER_UID = uid real do Firebase Auth
═══════════════════════════════════════════════════════════════════ */
function _signalReady(empresaId, uid, empresa, usuario) {
  window.SAAS_UID      = empresaId;   // path: saas_dados/{empresaId}
  window.SAAS_USER_UID = uid;         // firebase auth uid
  window.SAAS_EMPRESA  = empresa;
  window.SAAS_USUARIO  = usuario;
  window.empresaId     = empresaId;   // alias direto para uso no app
  window.dispatchEvent(new CustomEvent('saas:ready', {
    detail: { uid: empresaId, userUid: uid, empresa, usuario }
  }));
}

function _hideOverlay() {
  const el = document.getElementById('saas-overlay');
  if (el) { el.classList.add('hide'); setTimeout(() => el.remove(), 500); }
}

function _errMsg(code) {
  const MAP = {
    'auth/invalid-email':'Email inválido.',
    'auth/user-not-found':'Email não encontrado.',
    'auth/wrong-password':'Senha incorreta.',
    'auth/invalid-credential':'Email ou senha incorretos.',
    'auth/email-already-in-use':'Este email já está cadastrado.',
    'auth/weak-password':'Senha muito fraca.',
    'auth/too-many-requests':'Muitas tentativas. Aguarde um momento.',
    'auth/network-request-failed':'Erro de conexão. Verifique sua internet.',
  };
  return MAP[code] || `Erro: ${code}`;
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
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 5000);
}
function _setLoadingMsg(msg) {
  const el = document.getElementById('saas-loading-msg');
  if (el) el.textContent = msg;
}
function _setLoading(panel, label, loading) {
  const btn = document.getElementById(`saas-btn-${panel}`);
  if (!btn) return;
  btn.disabled = loading; btn.textContent = loading ? 'Aguarde...' : label;
}
function _renderPlanGrid() {
  const grid = document.getElementById('saas-plan-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(PLANOS_DEF).map(([key, p]) => `
    <div id="saas-plan-${key}" class="saas-plan-btn${key==='free'?' sel':''}"
         onclick="SaasAuth._selPlan('${key}')"
         style="${key==='free'?`border-color:${p.cor}`:''}">
      <div class="pname" style="color:${p.cor}">${p.nome}</div>
      <div class="pprice">${p.preco===0?'Grátis':'R$'+(p.preco/100).toFixed(0)+'/mês'}</div>
    </div>`).join('');
  window._saasSelPlan = 'free';
}

/* ═══════════════════════════════════════════════════════════════════
   LOGIN OVERLAY HTML
═══════════════════════════════════════════════════════════════════ */
function _injectLoginOverlay() {
  if (document.getElementById('saas-overlay')) return;
  const el = document.createElement('div');
  el.id = 'saas-overlay';
  el.innerHTML = `
<style>
#saas-overlay{position:fixed;inset:0;z-index:99999;background:#060810;
  display:flex;align-items:center;justify-content:center;padding:1rem;
  font-family:'Plus Jakarta Sans',sans-serif;transition:opacity .4s ease;}
#saas-overlay.hide{opacity:0;pointer-events:none;}
.saas-card{width:100%;max-width:380px;background:rgba(17,24,39,.98);
  border:1px solid rgba(255,255,255,.08);border-radius:1.5rem;padding:2rem;color:#f1f5f9;}
.saas-logo{text-align:center;margin-bottom:1.5rem;}
.saas-logo .icon{font-size:2.5rem;display:block;margin-bottom:.5rem;}
.saas-logo h1{font-size:1.25rem;font-weight:900;margin:0;}
.saas-logo p{font-size:.75rem;color:#4b5563;margin:.25rem 0 0;}
.saas-tabs{display:flex;gap:.5rem;margin-bottom:1.25rem;background:rgba(255,255,255,.03);
  border-radius:.75rem;padding:.25rem;}
.saas-tab{flex:1;padding:.5rem;border:none;border-radius:.6rem;background:transparent;
  color:#6b7280;font-size:.8rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s;}
.saas-tab.active{background:rgba(59,130,246,.15);color:#60a5fa;}
.saas-inp{width:100%;padding:.75rem 1rem;background:#1e293b;border:2px solid #1e293b;
  border-radius:.75rem;color:#f1f5f9;font-size:.85rem;font-family:inherit;
  outline:none;margin-bottom:.75rem;box-sizing:border-box;transition:border-color .15s;}
.saas-inp:focus{border-color:#3b82f6;}
.saas-btn{width:100%;padding:.8rem;background:linear-gradient(135deg,#3b82f6,#1d4ed8);
  border:none;border-radius:.75rem;color:#fff;font-size:.85rem;font-weight:800;
  cursor:pointer;font-family:inherit;margin-bottom:.5rem;transition:opacity .15s;}
.saas-btn:disabled{opacity:.5;cursor:not-allowed;}
.saas-btn-ghost{background:transparent;border:1px solid rgba(255,255,255,.1);color:#6b7280;}
.saas-btn-ghost:hover{border-color:rgba(255,255,255,.2);color:#94a3b8;}
.saas-err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);color:#f87171;
  border-radius:.75rem;padding:.75rem 1rem;font-size:.8rem;margin-bottom:.75rem;display:none;}
.saas-err.show{display:block;}
.saas-success{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);color:#34d399;
  border-radius:.75rem;padding:.75rem 1rem;font-size:.8rem;margin-bottom:.75rem;display:none;}
.saas-success.show{display:block;}
.saas-plan-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;margin-bottom:1rem;}
.saas-plan-btn{border:2px solid transparent;border-radius:.75rem;padding:.75rem .5rem;
  text-align:center;cursor:pointer;background:rgba(255,255,255,.03);transition:all .15s;}
.saas-plan-btn.sel{background:rgba(59,130,246,.1);}
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
  <div id="saas-pnl-login">
    <div class="saas-tabs">
      <button class="saas-tab active" onclick="SaasAuth._tab('login')">Entrar</button>
      <button class="saas-tab"        onclick="SaasAuth._tab('register')">Cadastrar</button>
    </div>
    <div class="saas-err" id="saas-err-login"></div>
    <input class="saas-inp" id="saas-email" type="email"    placeholder="seu@email.com" autocomplete="email">
    <input class="saas-inp" id="saas-pass"  type="password" placeholder="Senha" autocomplete="current-password">
    <button class="saas-btn" id="saas-btn-login" onclick="SaasAuth._login()">Entrar</button>
    <button class="saas-btn saas-btn-ghost" onclick="SaasAuth._tab('forgot')">Esqueci minha senha</button>
  </div>
  <div id="saas-pnl-register" style="display:none">
    <div class="saas-tabs">
      <button class="saas-tab"        onclick="SaasAuth._tab('login')">Entrar</button>
      <button class="saas-tab active" onclick="SaasAuth._tab('register')">Cadastrar</button>
    </div>
    <div class="saas-err" id="saas-err-register"></div>
    <input class="saas-inp" id="saas-r-nome"  type="text"     placeholder="Nome do estabelecimento">
    <input class="saas-inp" id="saas-r-email" type="email"    placeholder="seu@email.com" autocomplete="email">
    <input class="saas-inp" id="saas-r-pass"  type="password" placeholder="Senha (mín. 6 caracteres)">
    <div id="saas-invite-wrap" style="margin-bottom:.75rem">
      <div style="position:relative">
        <input class="saas-inp" id="saas-r-convite" type="text"
          placeholder="Código de convite (opcional)"
          style="text-transform:uppercase;letter-spacing:.1em;font-weight:700;padding-right:2.5rem;margin-bottom:0"
          maxlength="6" oninput="SaasAuth._onConviteInput(this)">
        <span id="saas-convite-status" style="position:absolute;right:.75rem;top:50%;transform:translateY(-50%);font-size:.9rem"></span>
      </div>
      <div id="saas-convite-info" style="display:none;background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.2);border-radius:.75rem;padding:.6rem .8rem;margin-top:.5rem;font-size:.75rem;color:#22d3ee;font-weight:700"></div>
    </div>
    <div id="saas-plan-section">
      <div style="font-size:.75rem;color:#6b7280;margin-bottom:.75rem;font-weight:600;">Escolha seu plano:</div>
      <div class="saas-plan-grid" id="saas-plan-grid"></div>
    </div>
    <button class="saas-btn" id="saas-btn-register" onclick="SaasAuth._register()">Criar conta grátis</button>
  </div>
  <div id="saas-pnl-forgot" style="display:none">
    <div class="saas-tabs" style="opacity:.5;pointer-events:none">
      <button class="saas-tab">Entrar</button><button class="saas-tab">Cadastrar</button>
    </div>
    <div class="saas-err"     id="saas-err-forgot"></div>
    <div class="saas-success" id="saas-ok-forgot"></div>
    <input class="saas-inp" id="saas-f-email" type="email" placeholder="seu@email.com">
    <button class="saas-btn" onclick="SaasAuth._forgotPassword()">Enviar link de recuperação</button>
    <div class="saas-back" onclick="SaasAuth._tab('login')">← Voltar ao login</div>
  </div>
  <div id="saas-pnl-loading" style="display:none;text-align:center;padding:2rem 0">
    <div style="font-size:2rem;margin-bottom:.75rem;">⏳</div>
    <div style="font-size:.85rem;color:#6b7280;font-weight:600;" id="saas-loading-msg">Verificando...</div>
  </div>
</div>`;
  document.body.appendChild(el);
  _renderPlanGrid();

  // Auto-preencher código de convite da URL (?convite=XXXXXX)
  const _urlConvite = new URLSearchParams(location.search).get('convite');
  if (_urlConvite && _urlConvite.length === 6) {
    _showPanel('register');
    const inp = document.getElementById('saas-r-convite');
    if (inp) {
      inp.value = _urlConvite.toUpperCase();
      // Trigger validation
      setTimeout(() => inp.dispatchEvent(new Event('input')), 600);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   API PÚBLICA
═══════════════════════════════════════════════════════════════════ */
window.SaasAuth = {
  _tab(tab) {
    _showPanel(tab);
    ['saas-err-login','saas-err-register','saas-err-forgot'].forEach(id =>
      document.getElementById(id)?.classList.remove('show'));
    document.querySelectorAll('#saas-pnl-login .saas-tab, #saas-pnl-register .saas-tab').forEach((btn, i) => {
      btn.classList.toggle('active', (tab==='login'&&i===0)||(tab==='register'&&i===1));
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
    if (!email || !pass) { _showError('login','Preencha email e senha.'); return; }
    _setLoading('login','Entrar',true);
    try {
      await signInWithEmailAndPassword(_auth, email, pass);
    } catch (err) {
      _setLoading('login','Entrar',false);
      _showError('login', _errMsg(err.code));
    }
  },

  async _register() {
    const nome    = document.getElementById('saas-r-nome')?.value?.trim();
    const email   = document.getElementById('saas-r-email')?.value?.trim();
    const pass    = document.getElementById('saas-r-pass')?.value;
    const convite = (document.getElementById('saas-r-convite')?.value || '').trim().toUpperCase();
    const plano   = window._saasSelPlan || 'free';

    if (!nome)                    { _showError('register','Informe o nome do estabelecimento.'); return; }
    if (!email)                   { _showError('register','Informe o email.'); return; }
    if (!pass || pass.length < 6) { _showError('register','Senha deve ter no mínimo 6 caracteres.'); return; }

    _setLoading('register','Criar conta grátis',true);
    try {
      const cred = await createUserWithEmailAndPassword(_auth, email, pass);
      const uid  = cred.user.uid;

      if (convite) {
        // ── Modo convite: entrar em empresa existente ─────────────
        const ok = window.SaasUsers
          ? await window.SaasUsers.aceitarConvite(convite, uid, { nome, email })
          : false;

        if (!ok) {
          // Convite inválido/expirado — cria empresa própria como fallback
          console.warn('[SaasAuth] Convite inválido, criando empresa própria.');
          await _createEmpresaEUsuario(uid, { nome, email, plano: 'free' });
          _showError('register', '⚠️ Código de convite inválido ou expirado. Conta criada sem convite.');
        }
      } else {
        // ── Modo padrão: criar nova empresa ─────────────────────
        await _createEmpresaEUsuario(uid, { nome, email, plano });
      }
    } catch (err) {
      _setLoading('register','Criar conta grátis',false);
      _showError('register', _errMsg(err.code));
    }
  },

  /** Valida código de convite em tempo real (chamado no oninput do campo) */
  _conviteDebounce: null,
  _onConviteInput(input) {
    const code      = input.value.trim().toUpperCase();
    const statusEl  = document.getElementById('saas-convite-status');
    const infoEl    = document.getElementById('saas-convite-info');
    const planSec   = document.getElementById('saas-plan-section');
    const btnReg    = document.getElementById('saas-btn-register');

    input.value = code;

    if (!code) {
      // Campo vazio — modo criação de empresa
      if (statusEl) statusEl.textContent = '';
      if (infoEl)   infoEl.style.display = 'none';
      if (planSec)  planSec.style.display = '';
      if (btnReg)   btnReg.textContent = 'Criar conta grátis';
      return;
    }

    if (code.length < 6) {
      if (statusEl) statusEl.textContent = '';
      return;
    }

    // Debounce 500ms para não fazer req a cada tecla
    clearTimeout(this._conviteDebounce);
    if (statusEl) statusEl.textContent = '⏳';
    this._conviteDebounce = setTimeout(async () => {
      if (!window.SaasUsers) return;
      const conv = await window.SaasUsers.validarConvite(code);
      if (conv) {
        if (statusEl) statusEl.textContent = '✅';
        if (infoEl) {
          infoEl.style.display = '';
          infoEl.textContent = `✅ Convite válido — você entrará na empresa "${conv.nomeEmpresa || 'desconhecida'}" como ${conv.cargo || 'colaborador'}.`;
        }
        if (planSec) planSec.style.display = 'none';  // oculta seleção de plano
        if (btnReg)  btnReg.textContent = 'Entrar na empresa';
      } else {
        if (statusEl) statusEl.textContent = '❌';
        if (infoEl) {
          infoEl.style.display = '';
          infoEl.style.color   = '#f87171';
          infoEl.style.background = 'rgba(239,68,68,.08)';
          infoEl.style.borderColor = 'rgba(239,68,68,.2)';
          infoEl.textContent = '❌ Código inválido ou expirado.';
        }
        if (planSec) planSec.style.display = '';
        if (btnReg)  btnReg.textContent = 'Criar conta grátis';
      }
    }, 500);
  },

  async _forgotPassword() {
    const email = document.getElementById('saas-f-email')?.value?.trim();
    if (!email) { _showError('forgot','Informe o email.'); return; }
    try {
      await sendPasswordResetEmail(_auth, email);
      const ok = document.getElementById('saas-ok-forgot');
      if (ok) { ok.textContent = 'Link enviado! Verifique sua caixa de entrada.'; ok.classList.add('show'); }
    } catch (err) { _showError('forgot', _errMsg(err.code)); }
  },

  async logout() {
    await signOut(_auth);
    window.SAAS_UID = window.SAAS_USER_UID = window.SAAS_EMPRESA = window.SAAS_USUARIO = null;
    location.reload();
  },

  getEmpresa:   () => _currentEmpresa,
  getUsuario:   () => _currentUsuario,
  getUid:       () => _currentUser?.uid || null,
  getEmpresaId: () => window.SAAS_UID || null,
};

/* ═══════════════════════════════════════════════════════════════════
   MAIN — onAuthStateChanged
═══════════════════════════════════════════════════════════════════ */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _injectLoginOverlay);
} else {
  _injectLoginOverlay();
}
_showPanel('loading');
_setLoadingMsg('Verificando sessão...');

onAuthStateChanged(_auth, async (user) => {
  // ── Passo 1: Login Firebase ────────────────────────────────────
  if (!user) { _showPanel('login'); return; }

  _currentUser = user;
  _showPanel('loading');

  try {
    // ── Passo 2: Buscar usuarios/{uid} ────────────────────────────
    // A Cloud Function criarEmpresaAuto (Auth onCreate) já pode ter criado
    // o vínculo. Tentamos até 3x com delay para aguardar o trigger.
    _setLoadingMsg('Buscando usuário...');
    let usuario = await _resolveUsuario(user.uid);

    if (!usuario) {
      // Aguarda até 3s para o trigger criarEmpresaAuto concluir
      for (let i = 0; i < 3 && !usuario; i++) {
        await new Promise(r => setTimeout(r, 1000));
        usuario = await _resolveUsuario(user.uid);
      }
    }

    if (!usuario) {
      // Fallback: cria localmente se o trigger não chegou a tempo
      _setLoadingMsg('Configurando conta...');
      await _createEmpresaEUsuario(user.uid, {
        nome:  user.displayName || user.email?.split('@')[0] || 'Minha Empresa',
        email: user.email,
        plano: 'free',
      });
      usuario = await _resolveUsuario(user.uid);
    }

    // ── Passo 3: Verificar status e obter empresaId ──────────────
    // BUG FIX v2.1: colaboradores removidos têm status='removido'.
    // Não devem entrar no sistema nem ganhar empresa nova.
    if (usuario.status === 'removido') {
      _showPanel('login');
      _showError('login', '🚫 Sua conta foi removida desta empresa. Entre em contato com o responsável.');
      await signOut(_auth);
      return;
    }

    const { empresaId } = usuario;
    if (!empresaId) {
      _showPanel('login');
      _showError('login', '⚠️ Vínculo com empresa não encontrado. Contate o suporte.');
      await signOut(_auth);
      return;
    }

    // ── Passo 4: Buscar empresas/{empresaId} ──────────────────────
    _setLoadingMsg('Carregando empresa...');
    const empresa = await _resolveEmpresa(empresaId);

    // ── Passo 5: Validar status ativo + plano válido ──────────────
    _setLoadingMsg('Validando plano...');
    const erroPlano = _validarPlano(empresa);
    if (erroPlano) {
      _showPanel('login');
      _showError('login', erroPlano);
      await signOut(_auth);
      return;
    }

    // ── Passo 6: Liberar sistema ──────────────────────────────────
    _currentEmpresa = empresa;
    _currentUsuario = usuario;
    _touchUsuario(user.uid);

    const _inject = () => { _injectPlanBadge(empresa); _hideOverlay(); };
    document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', _inject)
      : _inject();

    _signalReady(empresaId, user.uid, empresa, usuario);

    console.info(
      `[SaasAuth] ✅ Passo 6 OK | empresa: ${empresa.nome}` +
      ` | empresaId: ${empresaId}` +
      ` | cargo: ${usuario.cargo}` +
      ` | plano: ${empresa.plano}` +
      ` | window.empresaId: ${window.empresaId}`
    );

  } catch (err) {
    console.error('[SaasAuth] ❌ Erro no fluxo de autenticação:', err);
    _showPanel('login');
    _showError('login', 'Erro ao carregar dados. Tente novamente.');
  }
});
