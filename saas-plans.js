/**
 * @fileoverview SaaS Plans — Controle de planos e limites
 * @version 1.0.0
 *
 * Uso:
 *   SaasPlans.check('ia')       → true/false
 *   SaasPlans.check('delivery') → true/false
 *   SaasPlans.podeVender()      → true/false (limite mensal)
 *   SaasPlans.incrementVenda()  → registra +1 venda no Firebase
 *   SaasPlans.getInfo()         → { plano, vendasMes, limiteVendas, ... }
 */

(function() {
  'use strict';

  /* ─── Definição dos Planos ──────────────────────────────── */
  const PLANOS = {
    free: {
      nome: 'Grátis',       preco: 0,
      vendasMes: 200,       delivery: false,
      ia: false,            usuarios: 1,
      cor: '#6b7280',
    },
    basic: {
      nome: 'Basic',        preco: 4900,
      vendasMes: 2000,      delivery: true,
      ia: false,            usuarios: 3,
      cor: '#3b82f6',
    },
    pro: {
      nome: 'Pro',          preco: 9900,
      vendasMes: Infinity,  delivery: true,
      ia: true,             usuarios: 10,
      cor: '#a855f7',
    },
    premium: {
      nome: 'Premium',      preco: 19900,
      vendasMes: Infinity,  delivery: true,
      ia: true,             usuarios: 50,
      cor: '#f59e0b',
    },
  };

  /* ─── Helpers ────────────────────────────────────────────── */
  function _getEmpresa() { return window.SAAS_EMPRESA || {}; }
  function _getPlanoKey() {
    const e = _getEmpresa();
    return e.planoReal || e.plano?.replace('trial_', '') || 'free';
  }
  function _getPlano() { return PLANOS[_getPlanoKey()] || PLANOS.free; }

  function _isExpired() {
    const e = _getEmpresa();
    if (!e.planoExpira) return false;
    return new Date(e.planoExpira) < new Date();
  }

  function _mesKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }

  /* ─── Leitura de vendas do mês (localStorage) ────────────── */
  function _getVendasMes() {
    try {
      const key  = `SAAS_VENDAS_${window.SAAS_UID || 'local'}_${_mesKey()}`;
      const val  = localStorage.getItem(key);
      return val ? parseInt(val, 10) : 0;
    } catch { return 0; }
  }

  function _setVendasMes(n) {
    try {
      const key = `SAAS_VENDAS_${window.SAAS_UID || 'local'}_${_mesKey()}`;
      localStorage.setItem(key, String(n));
    } catch {}
  }

  /* ─── Atualização no Firebase (fundo) ────────────────────── */
  async function _syncVendasFirebase() {
    try {
      const uid = window.SAAS_UID;
      if (!uid || !window._saasDb) return;
      const { doc, updateDoc, increment } =
        await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      const mes = _mesKey();
      const ref = doc(window._saasDb, 'empresas', uid);
      await updateDoc(ref, {
        vendasMes: increment(1),
        mesAtual:  mes,
      });
    } catch (err) {
      console.warn('[SaasPlans] Falha ao sync vendas:', err.message);
    }
  }

  /* ─── Badge de uso no header ─────────────────────────────── */
  function _updateUsageBadge() {
    const plano  = _getPlano();
    const vendas = _getVendasMes();
    const limite = plano.vendasMes;
    const pct    = limite === Infinity ? 0 : Math.min(100, (vendas / limite) * 100);
    const cor    = pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : '#10b981';

    let badge = document.getElementById('saas-usage-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'saas-usage-badge';
      badge.style.cssText = [
        'position:fixed','bottom:env(safe-area-inset-bottom,0px)','right:0',
        'z-index:99997','padding:3px 10px 3px 8px','border-radius:8px 0 0 0',
        'font-size:9px','font-weight:800','font-family:Plus Jakarta Sans,sans-serif',
        'pointer-events:none','background:rgba(13,17,23,.95)',
        'border-top:1px solid rgba(255,255,255,.06)',
        'border-left:1px solid rgba(255,255,255,.06)',
      ].join(';');
      document.body.appendChild(badge);
    }

    const limiteStr = limite === Infinity ? '∞' : limite.toLocaleString('pt-BR');
    badge.style.color = cor;
    badge.innerHTML   = `Vendas: ${vendas.toLocaleString('pt-BR')} / ${limiteStr}`;
  }

  /* ─── API Pública ────────────────────────────────────────── */
  window.SaasPlans = {
    PLANOS,

    /** Verifica se feature está disponível no plano atual */
    check(feature) {
      if (_isExpired()) {
        // Plano expirado: apenas free é permitido
        return PLANOS.free[feature] === true;
      }
      const plano = _getPlano();
      return !!plano[feature];
    },

    /** true se pode fazer mais vendas este mês */
    podeVender() {
      if (_isExpired()) {
        // Expirado: usa limite free
        return _getVendasMes() < PLANOS.free.vendasMes;
      }
      const limite = _getPlano().vendasMes;
      if (limite === Infinity) return true;
      return _getVendasMes() < limite;
    },

    /** Registra +1 venda. Chamar APÓS venda confirmada. */
    incrementVenda() {
      const atual = _getVendasMes();
      _setVendasMes(atual + 1);
      _updateUsageBadge();
      _syncVendasFirebase(); // async, não bloqueia
    },

    /** Retorna info de uso atual */
    getInfo() {
      const plano  = _getPlano();
      const vendas = _getVendasMes();
      const limite = plano.vendasMes;
      return {
        planoKey:     _getPlanoKey(),
        planoNome:    plano.nome,
        preco:        plano.preco,
        vendasMes:    vendas,
        limiteVendas: limite,
        restante:     limite === Infinity ? Infinity : Math.max(0, limite - vendas),
        expirado:     _isExpired(),
        expiraEm:     _getEmpresa().planoExpira || null,
        features:     {
          delivery: plano.delivery,
          ia:       plano.ia,
          usuarios: plano.usuarios,
        },
      };
    },

    /** Mostra modal de upgrade se recurso bloqueado */
    requireFeature(feature, acao) {
      if (this.check(feature)) { acao?.(); return true; }
      this.showUpgradeModal(feature);
      return false;
    },

    /** Modal de upgrade */
    showUpgradeModal(feature) {
      const FEATURE_NOMES = { ia: 'Análise de IA', delivery: 'Módulo Delivery' };
      const planoMinimo   = feature === 'ia' ? 'pro' : 'basic';

      // Se SaasPagamentos estiver disponível, abre checkout
      if (window.SaasPagamentos?.abrirCheckout) {
        SaasPagamentos.abrirCheckout(planoMinimo);
        return;
      }

      // Fallback direto
      const base = window.location.origin + window.location.pathname.replace(/\/[^\/]*$/, '/');
      window.open(`${base}checkout.html?plano=${planoMinimo}`, '_blank');
    },

    /** Bloqueia venda se limite atingido */
    checkVendaLimit() {
      if (this.podeVender()) return true;
      const info = this.getInfo();
      const msg = info.expirado
        ? '⚠️ Plano expirado. Renove para continuar vendendo.'
        : `Limite de ${info.limiteVendas} vendas/mês atingido no plano ${info.planoNome}. Faça upgrade para continuar.`;
      if (window.UIService?.showToast) {
        UIService.showToast('Limite atingido', msg, 'error');
      } else {
        alert(msg);
      }
      return false;
    },

    init() {
      window.addEventListener('saas:ready', () => {
        _updateUsageBadge();
        console.info('[SaasPlans] ✅ Plano:', _getPlanoKey(), '| Vendas mês:', _getVendasMes());
      });
    },
  };

  SaasPlans.init();
})();
