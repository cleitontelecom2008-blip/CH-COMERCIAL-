/**
 * @fileoverview SaaS Users — Gestão de Usuários por Empresa
 * @version 1.0.0
 *
 * Estrutura Firestore:
 *  usuarios/{uid}     → { empresaId, nome, email, cargo, criadoEm, ultimoAcesso }
 *  convites/{code}    → { empresaId, nomeEmpresa, cargo, criadoPor, criadoEm, expiraEm, usado }
 *
 * API Pública:
 *  SaasUsers.carregarUI()          → renderiza lista de usuários no modal de config
 *  SaasUsers.gerarConvite()        → cria código e exibe no painel
 *  SaasUsers.removerUsuario(uid)   → remove colaborador da empresa
 *  SaasUsers.alterarCargo(uid,c)   → muda cargo do usuário
 *  SaasUsers.validarConvite(code)  → retorna dados do convite ou null
 *  SaasUsers.aceitarConvite(code, uid, { nome, email }) → vincula usuário à empresa
 */

(function () {
  'use strict';

  /* ─── Definição de Cargos ───────────────────────────────────────── */
  const CARGOS = {
    dono:        { label: '👑 Dono',         cor: '#a855f7', ordem: 0 },
    gerente:     { label: '⭐ Gerente',       cor: '#3b82f6', ordem: 1 },
    colaborador: { label: '👤 Colaborador',  cor: '#6b7280', ordem: 2 },
  };

  /* ─── Helpers ───────────────────────────────────────────────────── */
  function _db()        { return window._saasDb;       }
  function _uid()       { return window.SAAS_UID;       }    // empresaId
  function _userUid()   { return window.SAAS_USER_UID;  }    // firebase auth uid
  function _empresa()   { return window.SAAS_EMPRESA || {}; }
  function _usuario()   { return window.SAAS_USUARIO || {}; }
  function _isDono()    { return _usuario().cargo === 'dono'; }
  function _isGerente() { return ['dono','gerente'].includes(_usuario().cargo); }

  function _gerarCodigo() {
    // 6 chars uppercase sem ambíguos (0/O, 1/I/L)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  async function _importFirestore() {
    return import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  }

  /* ─── Listar Usuários da Empresa ────────────────────────────────── */
  async function _listarUsuarios() {
    const db = _db();
    if (!db || !_uid()) return [];
    try {
      const { collection, query, where, getDocs } = await _importFirestore();
      const q = query(collection(db, 'usuarios'), where('empresaId', '==', _uid()));
      const snap = await getDocs(q);
      return snap.docs
        .map(d => ({ uid: d.id, ...d.data() }))
        .sort((a, b) => {
          const oa = CARGOS[a.cargo]?.ordem ?? 99;
          const ob = CARGOS[b.cargo]?.ordem ?? 99;
          return oa - ob;
        });
    } catch (err) {
      console.error('[SaasUsers] listar:', err);
      return [];
    }
  }

  /* ─── Remover Usuário ───────────────────────────────────────────── */
  async function _removerUsuario(uid) {
    if (!_isDono()) { _toast('Apenas o dono pode remover usuários.', 'error'); return false; }
    if (uid === _userUid()) { _toast('Não é possível remover a si mesmo.', 'error'); return false; }
    const db = _db();
    if (!db) return false;
    try {
      const { doc, deleteDoc } = await _importFirestore();
      await deleteDoc(doc(db, 'usuarios', uid));
      return true;
    } catch (err) {
      console.error('[SaasUsers] remover:', err);
      _toast('Erro ao remover usuário.', 'error');
      return false;
    }
  }

  /* ─── Alterar Cargo ─────────────────────────────────────────────── */
  async function _alterarCargo(uid, cargo) {
    if (!_isDono()) { _toast('Apenas o dono pode alterar cargos.', 'error'); return false; }
    if (!CARGOS[cargo]) return false;
    const db = _db();
    if (!db) return false;
    try {
      const { doc, updateDoc } = await _importFirestore();
      await updateDoc(doc(db, 'usuarios', uid), { cargo });
      return true;
    } catch (err) {
      console.error('[SaasUsers] cargo:', err);
      _toast('Erro ao alterar cargo.', 'error');
      return false;
    }
  }

  /* ─── Limite de Usuários (por plano) ────────────────────────────── */
  function _limiteUsuarios() {
    const limites = _empresa().limites || {};
    return limites.usuarios ?? 1;
  }

  /* ─── Criar Convite ─────────────────────────────────────────────── */
  async function _criarConvite() {
    if (!_isDono()) { _toast('Apenas o dono pode criar convites.', 'error'); return null; }
    const db = _db();
    if (!db || !_uid()) return null;

    // Verifica limite de usuários
    const usuarios = await _listarUsuarios();
    const limite   = _limiteUsuarios();
    if (usuarios.length >= limite) {
      _toast(`Limite de ${limite} usuário(s) no plano atual. Faça upgrade para adicionar mais.`, 'warning');
      return null;
    }

    const code   = _gerarCodigo();
    const expira = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    try {
      const { doc, setDoc } = await _importFirestore();
      await setDoc(doc(db, 'convites', code), {
        empresaId:   _uid(),
        nomeEmpresa: _empresa().nome || '',
        cargo:       'colaborador',
        criadoPor:   _userUid(),
        criadoEm:    new Date().toISOString(),
        expiraEm:    expira.toISOString(),
        usado:       false,
      });
      console.info(`[SaasUsers] 🔑 Convite criado: ${code} | expira: ${expira.toLocaleString('pt-BR')}`);
      return code;
    } catch (err) {
      console.error('[SaasUsers] criarConvite:', err);
      _toast('Erro ao criar convite.', 'error');
      return null;
    }
  }

  /* ─── Validar Convite (usado no registro) ───────────────────────── */
  async function _validarConvite(code) {
    if (!code || code.length !== 6) return null;
    const db = _db() || window.firestoreDB;
    if (!db) return null;
    try {
      const { doc, getDoc } = await _importFirestore();
      const snap = await getDoc(doc(db, 'convites', code.toUpperCase().trim()));
      if (!snap.exists()) return null;
      const data = snap.data();
      if (data.usado) return null;
      if (new Date(data.expiraEm) < new Date()) return null;
      return { code, ...data };
    } catch (err) {
      console.error('[SaasUsers] validarConvite:', err);
      return null;
    }
  }

  /* ─── Aceitar Convite (chamado no register) ─────────────────────── */
  async function _aceitarConvite(code, uid, { nome, email }) {
    const db = _db() || window.firestoreDB;
    if (!db) return false;
    const convite = await _validarConvite(code);
    if (!convite) return false;
    try {
      const { doc, setDoc, updateDoc } = await _importFirestore();

      // Cria usuario apontando para a empresa do convite
      await setDoc(doc(db, 'usuarios', uid), {
        empresaId:    convite.empresaId,
        nome,
        email,
        cargo:        convite.cargo || 'colaborador',
        criadoEm:     new Date().toISOString(),
        ultimoAcesso: new Date().toISOString(),
        conviteUsado: code,
      });

      // Marca convite como usado
      await updateDoc(doc(db, 'convites', code), {
        usado:    true,
        usadoPor: uid,
        usadoEm:  new Date().toISOString(),
      });

      console.info(`[SaasUsers] ✅ Convite ${code} aceito → empresa: ${convite.empresaId}`);
      return true;
    } catch (err) {
      console.error('[SaasUsers] aceitarConvite:', err);
      return false;
    }
  }

  /* ─── Toast Helper ──────────────────────────────────────────────── */
  function _toast(msg, type = 'info') {
    if (window.UIService?.showToast) {
      const titles = { error: 'Erro', warning: 'Aviso', success: 'Sucesso', info: 'Info' };
      UIService.showToast(titles[type] || 'Info', msg, type);
    } else {
      console.warn('[SaasUsers]', msg);
    }
  }

  /* ─── Render UI ─────────────────────────────────────────────────── */
  function _renderLista(usuarios) {
    const list = document.getElementById('saas-users-list');
    if (!list) return;

    if (!usuarios.length) {
      list.innerHTML = `
        <div class="text-center py-4 text-slate-500">
          <i class="fas fa-users text-2xl mb-2 block opacity-30"></i>
          <span class="text-xs">Nenhum usuário encontrado</span>
        </div>`;
      return;
    }

    const myUid    = _userUid();
    const isDono   = _isDono();
    const cargoOptions = Object.entries(CARGOS)
      .filter(([k]) => k !== 'dono')
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
      .join('');

    list.innerHTML = usuarios.map(u => {
      const cargo  = CARGOS[u.cargo] || CARGOS.colaborador;
      const isMe   = u.uid === myUid;
      const isDonoDest = u.cargo === 'dono';
      const canEdit   = isDono && !isMe && !isDonoDest;

      return `
        <div class="flex items-center gap-3 p-3 rounded-xl border border-white/5
                    ${isMe ? 'bg-blue-500/5 border-blue-500/20' : 'bg-slate-900'}">
          <div class="w-9 h-9 rounded-full flex items-center justify-center
                      flex-shrink-0 text-sm font-black"
               style="background:${cargo.cor}22;color:${cargo.cor}">
            ${(u.nome || u.email || '?').charAt(0).toUpperCase()}
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-xs font-black text-white truncate">
              ${u.nome || 'Sem nome'}${isMe ? ' <span class="text-slate-500 font-bold">(você)</span>' : ''}
            </div>
            <div class="text-[10px] text-slate-500 truncate">${u.email || ''}</div>
            ${u.ultimoAcesso ? `<div class="text-[9px] text-slate-600 mt-0.5">Último acesso: ${new Date(u.ultimoAcesso).toLocaleDateString('pt-BR')}</div>` : ''}
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            ${canEdit ? `
              <select onchange="SaasUsers._mudarCargo('${u.uid}', this.value, this)"
                class="text-[9px] font-black px-2 py-1 rounded-lg border-0 outline-none
                       cursor-pointer transition-all"
                style="background:${cargo.cor}22;color:${cargo.cor}">
                ${Object.entries(CARGOS).filter(([k]) => k !== 'dono').map(([k, v]) =>
                  `<option value="${k}" ${u.cargo === k ? 'selected' : ''}>${v.label}</option>`
                ).join('')}
              </select>
              <button onclick="SaasUsers._confirmarRemover('${u.uid}', '${(u.nome || '').replace(/'/g, '\\\'')}')"
                class="w-7 h-7 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20
                       flex items-center justify-center text-xs transition-all flex-shrink-0">
                <i class="fas fa-user-times text-[9px]"></i>
              </button>
            ` : `
              <span class="text-[9px] font-black px-2 py-1 rounded-lg"
                    style="background:${cargo.cor}22;color:${cargo.cor}">
                ${cargo.label}
              </span>
            `}
          </div>
        </div>`;
    }).join('');
  }

  /* ─── Painel de Convite ─────────────────────────────────────────── */
  function _mostrarConvite(code) {
    const el = document.getElementById('saas-invite-result');
    if (!el) return;
    const url = `${location.origin}${location.pathname}?convite=${code}`;
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="bg-slate-950 border border-cyan-500/20 rounded-xl p-4">
        <div class="text-[9px] uppercase tracking-widest text-cyan-400 font-black mb-2">
          🔑 Código de Convite — válido por 24h
        </div>
        <div class="text-2xl font-black text-white tracking-[.25em] text-center my-3 font-mono">
          ${code}
        </div>
        <div class="text-[9px] text-slate-500 break-all text-center mb-3">${url}</div>
        <div class="flex gap-2">
          <button onclick="navigator.clipboard.writeText('${code}');this.innerHTML='✅ Copiado!';setTimeout(()=>this.innerHTML='📋 Copiar Código',2000)"
            class="flex-1 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-black
                   text-white transition-all">
            📋 Copiar Código
          </button>
          <button onclick="navigator.clipboard.writeText('${url}');this.innerHTML='✅ Copiado!';setTimeout(()=>this.innerHTML='🔗 Copiar Link',2000)"
            class="flex-1 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-black
                   text-white transition-all">
            🔗 Copiar Link
          </button>
        </div>
      </div>`;
  }

  /* ─── API Pública ───────────────────────────────────────────────── */
  window.SaasUsers = {
    CARGOS,

    /** Carrega e renderiza a lista de usuários no painel */
    async carregarUI() {
      const list = document.getElementById('saas-users-list');
      if (list) {
        list.innerHTML = `
          <div class="text-center py-3 text-slate-600 text-xs">
            <i class="fas fa-spinner fa-spin mr-1"></i> Carregando...
          </div>`;
      }

      // Esconde/mostra botão de convite conforme cargo
      const inviteSection = document.getElementById('saas-invite-section');
      if (inviteSection) inviteSection.style.display = _isDono() ? '' : 'none';

      // Limpa painel de convite anterior
      const inviteResult = document.getElementById('saas-invite-result');
      if (inviteResult) inviteResult.classList.add('hidden');

      // Mostra limite de usuários
      const countEl = document.getElementById('saas-users-count');
      if (countEl) {
        const usuarios = await _listarUsuarios();
        const limite   = _limiteUsuarios();
        const cor = usuarios.length >= limite ? '#ef4444' : '#10b981';
        countEl.innerHTML = `
          <span style="color:${cor};font-weight:800">
            ${usuarios.length}/${limite === Infinity ? '∞' : limite} usuários
          </span>`;
        _renderLista(usuarios);
      } else {
        const usuarios = await _listarUsuarios();
        _renderLista(usuarios);
      }
    },

    /** Gera e exibe um novo código de convite */
    async gerarConvite() {
      const btn = document.getElementById('saas-invite-btn');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Gerando...'; }

      const code = await _criarConvite();

      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-user-plus mr-1"></i> Gerar Novo Convite';
      }

      if (code) _mostrarConvite(code);
    },

    /** Confirma e remove um usuário */
    async _confirmarRemover(uid, nome) {
      if (!confirm(`Remover "${nome}" da empresa?\n\nO usuário perderá acesso ao sistema imediatamente.`)) return;
      const ok = await _removerUsuario(uid);
      if (ok) {
        _toast(`${nome} foi removido da empresa.`, 'success');
        this.carregarUI();
      }
    },

    /** Muda cargo de um usuário via select */
    async _mudarCargo(uid, novoCargo, selectEl) {
      const ok = await _alterarCargo(uid, novoCargo);
      if (ok) {
        _toast(`Cargo alterado para ${CARGOS[novoCargo]?.label || novoCargo}.`, 'success');
        this.carregarUI();
      } else if (selectEl) {
        // Reverte seleção
        const usuarios = await _listarUsuarios();
        const u = usuarios.find(x => x.uid === uid);
        if (u) selectEl.value = u.cargo;
      }
    },

    /** Valida convite (chamado pelo saas-auth.js no register) */
    validarConvite: _validarConvite,

    /** Aceita convite e vincula usuário à empresa */
    aceitarConvite: _aceitarConvite,
  };

  /* ─── Observer: Recarregar UI ao abrir modal de config ─────────── */
  window.addEventListener('saas:ready', () => {
    const modal = document.getElementById('modalConfig');
    if (!modal) return;

    new MutationObserver((entries) => {
      for (const e of entries) {
        if (e.type === 'attributes' && e.attributeName === 'class') {
          if (modal.classList.contains('open')) {
            // pequeno delay para DOM estar pronto
            setTimeout(() => SaasUsers.carregarUI(), 80);
          }
        }
      }
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  });

  console.info('[SaasUsers] ✅ Módulo carregado');
})();
