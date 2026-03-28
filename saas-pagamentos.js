/**
 * @fileoverview SaaS Pagamentos — Módulo client-side
 * @version 1.0.0
 *
 * Responsabilidades:
 *  - Chamar Firebase Function `criarPagamento`
 *  - Ouvir Firestore `pagamentos/{id}` em tempo real (onSnapshot)
 *  - Ao `status = aprovado` → atualizar window.SAAS_EMPRESA + disparar evento
 *
 * API Pública:
 *  SaasPagamentos.iniciarPagamento({ plano, gateway, meses })
 *    → cria sessão no gateway e redireciona o usuário
 *
 *  SaasPagamentos.ouvirPagamento(pagamentoId)
 *    → escuta Firestore e dispara 'pagamento:aprovado' quando confirmado
 *
 *  SaasPagamentos.getHistorico()
 *    → retorna lista de pagamentos da empresa atual
 *
 * Uso no app (substitui alert de upgrade):
 *  SaasPagamentos.abrirCheckout('pro');
 */

(function () {
  'use strict';

  /* ─── Helpers ──────────────────────────────────────────────── */
  function _db()      { return window._saasDb; }
  function _eid()     { return window.SAAS_UID; }

  function _toast(msg, type = 'info') {
    if (window.UIService?.showToast) {
      const t = { info: 'info', ok: 'success', err: 'error', warn: 'warning' };
      UIService.showToast('Pagamento', msg, t[type] || 'info');
    } else {
      console.info('[SaasPagamentos]', msg);
    }
  }

  /* ─── Chamar Firebase Function ──────────────────────────────── */
  async function _callFunction(name, payload) {
    // Tenta usar o SDK de Functions se disponível
    if (window.firebase?.functions) {
      const fn = window.firebase.functions().httpsCallable(name);
      const res = await fn(payload);
      return res.data;
    }

    // Fallback: chamada HTTP direta (mesma região configurada)
    const projectId = window._saasApp?.options?.projectId || 'meu-pdv-saas';
    const region    = 'southamerica-east1';
    const url       = `https://${region}-${projectId}.cloudfunctions.net/${name}`;

    // Pega token do usuário atual
    const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    const auth  = getAuth(window._saasApp);
    const token = await auth.currentUser?.getIdToken();

    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ data: payload }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }

    const json = await res.json();
    return json.result;
  }

  /* ─── Listener de pagamento ─────────────────────────────────── */
  let _unsubPag = null;

  function ouvirPagamento(pagamentoId, callback) {
    const db = _db();
    if (!db || !pagamentoId) return;

    if (typeof _unsubPag === 'function') {
      _unsubPag();
      _unsubPag = null;
    }

    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
      .then(({ doc, onSnapshot }) => {
        _unsubPag = onSnapshot(
          doc(db, 'pagamentos', pagamentoId),
          (snap) => {
            if (!snap.exists()) return;
            const pag = snap.data();

            if (pag.status === 'aprovado') {
              _onPagamentoAprovado(pag);
              if (typeof callback === 'function') callback(pag);
              if (typeof _unsubPag === 'function') {
                _unsubPag();
                _unsubPag = null;
              }
            } else if (pag.status === 'cancelado') {
              _toast('Pagamento cancelado ou recusado.', 'err');
              if (typeof callback === 'function') callback(pag);
            }
          },
          (err) => console.error('[SaasPagamentos] listener:', err)
        );
      });
  }

  /* ─── Atualizar estado local após aprovação ─────────────────── */
  async function _onPagamentoAprovado(pag) {
    // Rebusca empresa no Firestore (dados já foram atualizados pela Function)
    const db  = _db();
    const eid = _eid();
    if (!db || !eid) return;

    try {
      const { doc, getDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const snap    = await getDoc(doc(db, 'empresas', eid));
      const empresa = snap.exists() ? snap.data() : null;

      if (empresa) {
        window.SAAS_EMPRESA = empresa;
        window.dispatchEvent(new CustomEvent('pagamento:aprovado', {
          detail: { pagamento: pag, empresa },
        }));
        _toast(`✅ Plano ${(pag.plano || '').toUpperCase()} ativado com sucesso!`, 'ok');
      }
    } catch (err) {
      console.error('[SaasPagamentos] _onPagamentoAprovado:', err);
    }
  }

  /* ─── Histórico ─────────────────────────────────────────────── */
  async function getHistorico() {
    const db  = _db();
    const eid = _eid();
    if (!db || !eid) return [];
    try {
      const { collection, query, where, orderBy, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const q    = query(
        collection(db, 'pagamentos'),
        where('empresaId', '==', eid),
        orderBy('criadoEm', 'desc')
      );
      const snap = await getDocs(q);
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.error('[SaasPagamentos] getHistorico:', err);
      return [];
    }
  }

  /* ─── Iniciar pagamento ─────────────────────────────────────── */
  async function iniciarPagamento({ plano, gateway = 'mercadopago', meses = 1 }) {
    _toast('Criando sessão de pagamento...', 'info');

    try {
      const result = await _callFunction('criarPagamento', { plano, gateway, meses });
      const { pagamentoId, paymentUrl } = result;

      if (!paymentUrl) throw new Error('URL de pagamento não retornada.');

      // Salva id localmente para polling ao voltar
      sessionStorage.setItem('pdv_pag_id', pagamentoId);

      // Escuta em paralelo (caso o usuário não saia da página)
      ouvirPagamento(pagamentoId);

      // Redireciona para o checkout
      window.location.href = paymentUrl;

    } catch (err) {
      console.error('[SaasPagamentos] iniciarPagamento:', err);
      _toast('Erro ao iniciar pagamento: ' + err.message, 'err');
    }
  }

  /* ─── Abre checkout.html ────────────────────────────────────── */
  function abrirCheckout(planoSugerido) {
    const base = window.location.origin + window.location.pathname
      .replace(/\/[^/]*$/, '/');
    const url  = `${base}checkout.html${planoSugerido ? '?plano=' + planoSugerido : ''}`;
    window.open(url, '_blank');
  }

  /* ─── Boot: verifica retorno de pagamento ───────────────────── */
  function _checkRetorno() {
    const params     = new URLSearchParams(window.location.search);
    const status     = params.get('status');
    const pagIdRef   = params.get('ref') || sessionStorage.getItem('pdv_pag_id');

    if (!status || !pagIdRef) return;

    if (status === 'success') {
      _toast('Pagamento realizado! Aguardando confirmação...', 'info');
      ouvirPagamento(pagIdRef);
      sessionStorage.removeItem('pdv_pag_id');
    } else if (status === 'failure' || status === 'cancel') {
      _toast('Pagamento cancelado ou recusado.', 'err');
    }
  }

  /* ─── API Pública ───────────────────────────────────────────── */
  window.SaasPagamentos = {
    iniciarPagamento,
    ouvirPagamento,
    getHistorico,
    abrirCheckout,
  };

  // Sobrescreve showUpgradeModal do SaasPlans para abrir checkout
  window.addEventListener('saas:ready', () => {
    if (window.SaasPlans) {
      SaasPlans.showUpgradeModal = (feature) => {
        const NOMES = { ia: 'Análise de IA', delivery: 'Módulo Delivery' };
        const nome  = NOMES[feature] || feature;
        // Determina plano mínimo necessário
        const planoNecessario = feature === 'ia' ? 'pro' : 'basic';
        abrirCheckout(planoNecessario);
      };
    }

    // Verifica retorno de pagamento se voltou do gateway
    _checkRetorno();
  });

  console.info('[SaasPagamentos] ✅ Módulo carregado');
})();
