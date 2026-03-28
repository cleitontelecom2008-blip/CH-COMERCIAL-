/**
 * @fileoverview PDV SaaS — Cloud Functions PRODUÇÃO
 * @version 3.0.0
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  AUTOMAÇÕES                                                      │
 * │  1. criarEmpresaAuto  — Auth onCreate  → empresa free            │
 * │  2. verificarPlanos   — Cron 03h BRT   → bloqueia vencidos       │
 * │  3. backupDiario      — Cron 02h BRT   → backup Firestore        │
 * │                                                                  │
 * │  PAGAMENTOS                                                      │
 * │  4. criarPagamento    — HTTPS callable → MP / Stripe             │
 * │  5. mpWebhook         — Webhook Mercado Pago                     │
 * │  6. stripeWebhook     — Webhook Stripe                           │
 * │                                                                  │
 * │  LOGS & MONITORAMENTO                                            │
 * │  7. _log()            — Grava em logs/{empresaId}/eventos        │
 * │  8. Structured Logging → Firebase Console / Cloud Logging        │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Deploy:
 *   cd functions && npm install
 *   firebase deploy --only functions
 *
 * Configurar antes do deploy:
 *   firebase functions:config:set \
 *     mp.access_token="APP_USR-xxxx" \
 *     stripe.secret_key="sk_live_xxxx" \
 *     stripe.webhook_secret="whsec_xxxx" \
 *     app.base_url="https://pdvchgeladas.com"
 */

'use strict';

const functions    = require('firebase-functions');
const admin        = require('firebase-admin');
const axios        = require('axios');
const Stripe       = require('stripe');
const { v4: uuid } = require('uuid');

admin.initializeApp();
const db      = admin.firestore();
const REGION  = 'southamerica-east1';
const PROJECT = process.env.GCLOUD_PROJECT || 'meu-pdv-saas';

/* ═══════════════════════════════════════════════════════════════════
   REFERÊNCIA DE PLANOS E LIMITES
═══════════════════════════════════════════════════════════════════ */
const PLANOS_META = {
  free:    { nome: 'Free',    preco: 0,     mesesPadrao: 0 },
  basic:   { nome: 'Basic',   preco: 4900,  mesesPadrao: 1 },
  pro:     { nome: 'Pro',     preco: 9900,  mesesPadrao: 1 },
  premium: { nome: 'Premium', preco: 19900, mesesPadrao: 1 },
};

const LIMITES = {
  free:    { usuarios: 1,  vendasMes: 200,      delivery: false, ia: false },
  basic:   { usuarios: 3,  vendasMes: 2000,     delivery: true,  ia: false },
  pro:     { usuarios: 10, vendasMes: 999999999, delivery: true, ia: true  },
  premium: { usuarios: 50, vendasMes: 999999999, delivery: true, ia: true  },
};

function _mesKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function _gerarEmpresaId() {
  const r = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `emp_${Date.now()}_${r}`;
}

/* ═══════════════════════════════════════════════════════════════════
   SISTEMA DE LOGS
   Grava em: logs/{empresaId}/eventos/{autoId}
   Estrutura: { tipo, acao, detalhes, uid, ts }
═══════════════════════════════════════════════════════════════════ */
async function _log(empresaId, tipo, acao, detalhes = {}, uid = null) {
  try {
    await db
      .collection('logs')
      .doc(empresaId || 'sistema')
      .collection('eventos')
      .add({
        tipo,      // 'empresa' | 'plano' | 'pagamento' | 'usuario' | 'sistema'
        acao,      // string curta: 'criada', 'plano_ativado', 'bloqueada', etc.
        detalhes,  // objeto livre com contexto
        uid:       uid || null,
        ts:        admin.firestore.FieldValue.serverTimestamp(),
        tsIso:     new Date().toISOString(),
      });
  } catch (err) {
    // Log nunca deve derrubar a operação principal
    console.error('[_log] Falha ao gravar log:', err.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   AUTOMAÇÃO 1 — CRIAR EMPRESA AUTOMATICAMENTE
   Trigger: Firebase Auth → onCreate
   • Idempotente: verifica se usuarios/{uid} já existe
   • Origem marcada como 'auto_onCreate' para rastreio
═══════════════════════════════════════════════════════════════════ */
exports.criarEmpresaAuto = functions
  .region(REGION)
  .auth.user()
  .onCreate(async (user) => {
    const uid   = user.uid;
    const email = user.email || '';
    const nome  = user.displayName || email.split('@')[0] || 'Minha Empresa';

    functions.logger.info('[criarEmpresaAuto] Novo usuário', { uid, email });

    try {
      // Idempotência: evita duplicar se saas-auth.js já criou
      const usuarioDoc = await db.collection('usuarios').doc(uid).get();
      if (usuarioDoc.exists) {
        functions.logger.info('[criarEmpresaAuto] Vínculo já existe — ignorando', { uid });
        return null;
      }

      const empresaId = _gerarEmpresaId();
      const agora     = new Date().toISOString();

      const batch = db.batch();

      // empresas/{empresaId}
      batch.set(db.collection('empresas').doc(empresaId), {
        nome,
        email,
        plano:       'free',
        planoReal:   'free',
        planoExpira: null,
        status:      'ativo',
        criadoEm:    agora,
        dono:        uid,
        vendasMes:   0,
        mesAtual:    _mesKey(),
        limites:     LIMITES.free,
        origem:      'auto_onCreate',
      });

      // usuarios/{uid}
      batch.set(db.collection('usuarios').doc(uid), {
        empresaId,
        nome,
        email,
        cargo:        'dono',
        criadoEm:     agora,
        ultimoAcesso: agora,
      });

      await batch.commit();

      // Log da criação
      await _log(empresaId, 'empresa', 'criada', { nome, email, origem: 'auto_onCreate' }, uid);

      functions.logger.info('[criarEmpresaAuto] ✅ Empresa criada', { empresaId, uid });
      return null;

    } catch (err) {
      functions.logger.error('[criarEmpresaAuto] ❌', { uid, error: err.message });
      return null;
    }
  });

/* ═══════════════════════════════════════════════════════════════════
   AUTOMAÇÃO 2 — VERIFICAR PLANOS VENCIDOS
   Trigger: Cron todo dia às 03:00 BRT (06:00 UTC)
   • Percorre todas as empresas
   • Vencidas → status: inativo, plano: free, limites: free
   • Grava log por empresa e em planosVencidos/{id}
═══════════════════════════════════════════════════════════════════ */
exports.verificarPlanos = functions
  .region(REGION)
  .pubsub
  .schedule('0 6 * * *')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    const agora   = new Date();
    const bloq    = [];
    const ok      = [];

    functions.logger.info('[verificarPlanos] Iniciando verificação diária', {
      ts: agora.toISOString(),
    });

    try {
      const snap  = await db.collection('empresas').get();
      const batch = db.batch();
      let   ops   = 0;

      for (const docSnap of snap.docs) {
        const e   = docSnap.data();
        const eid = docSnap.id;

        // Free nunca expira; já bloqueados sem planoExpira: ignora
        if (!e.planoExpira || e.plano === 'free' || e.planoReal === 'free') {
          ok.push(eid);
          continue;
        }

        const expira = new Date(e.planoExpira);
        const dias   = Math.floor((agora - expira) / 86_400_000);

        if (expira < agora) {
          // ── Bloquear empresa ──────────────────────────────────────
          batch.update(db.collection('empresas').doc(eid), {
            status:        'inativo',
            plano:         'free',
            limites:       LIMITES.free,
            planoAnterior: {
              plano:     e.plano,
              planoReal: e.planoReal,
              expiraEm:  e.planoExpira,
            },
            vencidoEm:   agora.toISOString(),
            diasVencido: dias,
          });
          ops++;

          // Log de vencimento em planosVencidos
          batch.set(
            db.collection('planosVencidos').doc(`${eid}_${_mesKey()}`),
            {
              empresaId:   eid,
              nome:        e.nome || '',
              plano:       e.plano,
              planoExpira: e.planoExpira,
              bloqueadoEm: agora.toISOString(),
              diasVencido: dias,
            }
          );
          ops++;

          bloq.push({ eid, nome: e.nome, plano: e.plano, dias });

          // Flush batch a cada 480 ops (limite Firestore: 500)
          if (ops >= 480) {
            await batch.commit();
            ops = 0;
          }
        } else {
          ok.push(eid);
        }
      }

      if (ops > 0) await batch.commit();

      // Logs individuais (fora do batch para não explodir memória)
      for (const b of bloq) {
        await _log(b.eid, 'plano', 'bloqueada', {
          plano: b.plano,
          diasVencido: b.dias,
        });
      }

      // Log de sistema com resumo
      await _log('sistema', 'sistema', 'verificarPlanos', {
        total:     snap.size,
        bloqueadas: bloq.length,
        ok:        ok.length,
        ts:        agora.toISOString(),
      });

      functions.logger.info('[verificarPlanos] ✅ Concluído', {
        bloqueadas: bloq.length,
        ok:         ok.length,
        total:      snap.size,
      });

    } catch (err) {
      functions.logger.error('[verificarPlanos] ❌', { error: err.message });
      await _log('sistema', 'sistema', 'verificarPlanos_erro', { erro: err.message });
    }

    return null;
  });

/* ═══════════════════════════════════════════════════════════════════
   AUTOMAÇÃO 3 — BACKUP DIÁRIO DO FIRESTORE
   Trigger: Cron todo dia às 02:00 BRT (05:00 UTC)
   • Usa a API de Export do Firestore (Cloud Firestore managed exports)
   • Salva em gs://{project}-backups/YYYY-MM-DD/
   • Requer:
     - Cloud Storage bucket: {project}-backups
     - IAM: SA padrão das Functions com papel "Cloud Datastore Import Export Admin"
═══════════════════════════════════════════════════════════════════ */
exports.backupDiario = functions
  .region(REGION)
  .pubsub
  .schedule('0 5 * * *')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    const hoje   = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const bucket = `gs://${PROJECT}-backups/${hoje}`;

    functions.logger.info('[backupDiario] Iniciando backup', { destino: bucket });

    try {
      // Usa googleapis via Admin SDK Auth para chamar Firestore Admin API
      const { GoogleAuth } = require('google-auth-library');
      const gauth  = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/datastore'] });
      const client = await gauth.getClient();
      const token  = await client.getAccessToken();

      const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default):exportDocuments`;

      const res = await axios.post(
        url,
        {
          outputUriPrefix: bucket,
          collectionIds: [
            'admins', 'empresas', 'usuarios', 'saas_dados',
            'vendas', 'fiado', 'delivery', 'pagamentos',
            'logs', 'planosVencidos', 'convites',
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${token.token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      functions.logger.info('[backupDiario] ✅ Backup iniciado', {
        destino:   bucket,
        operation: res.data.name,
      });

      await _log('sistema', 'sistema', 'backup_iniciado', {
        destino:   bucket,
        operation: res.data.name,
        ts:        new Date().toISOString(),
      });

    } catch (err) {
      functions.logger.error('[backupDiario] ❌', { error: err.message });
      await _log('sistema', 'sistema', 'backup_erro', { erro: err.message });
    }

    return null;
  });

/* ═══════════════════════════════════════════════════════════════════
   HELPER — ATIVAR PLANO APÓS PAGAMENTO
   • Calcula nova data de expiração (estende se ainda vigente)
   • Atualiza empresas/{id}: plano, limites, status=ativo
   • Grava log
═══════════════════════════════════════════════════════════════════ */
async function _ativarPlano(empresaId, plano, meses, pagamentoId, valorCentavos) {
  const snap = await db.collection('empresas').doc(empresaId).get();
  if (!snap.exists) {
    functions.logger.error('[_ativarPlano] Empresa não encontrada', { empresaId });
    return;
  }

  const empresa = snap.data();
  const limites = LIMITES[plano] || LIMITES.free;

  // Estende a partir do vencimento atual se ainda vigente
  let base = new Date();
  if (empresa.planoExpira) {
    const atual = new Date(empresa.planoExpira);
    if (atual > base) base = atual;
  }
  base.setMonth(base.getMonth() + (Number(meses) || 1));

  await db.collection('empresas').doc(empresaId).update({
    plano,
    planoReal:    plano,
    planoExpira:  base.toISOString(),
    status:       'ativo',
    limites,
    ultimoPagamento: {
      pagamentoId,
      plano,
      meses:  Number(meses),
      valor:  valorCentavos || null,
      data:   new Date().toISOString(),
    },
    // Remove marcas de vencimento
    vencidoEm:     admin.firestore.FieldValue.delete(),
    diasVencido:   admin.firestore.FieldValue.delete(),
    planoAnterior: admin.firestore.FieldValue.delete(),
  });

  await _log(empresaId, 'plano', 'plano_ativado', {
    plano,
    meses,
    pagamentoId,
    expiraEm: base.toISOString(),
    valor:    valorCentavos,
  });

  functions.logger.info('[_ativarPlano] ✅', { empresaId, plano, expiraEm: base.toISOString() });
}

/* ═══════════════════════════════════════════════════════════════════
   PAGAMENTO 1 — CRIAR PAGAMENTO (HTTPS Callable)
═══════════════════════════════════════════════════════════════════ */
exports.criarPagamento = functions
  .region(REGION)
  .https.onCall(async (data, context) => {

    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');
    }

    const uid    = context.auth.uid;
    const plano  = data.plano;
    const gateway = data.gateway || 'mercadopago';
    const meses  = Number(data.meses) || 1;

    if (!PLANOS_META[plano] || plano === 'free') {
      throw new functions.https.HttpsError('invalid-argument', 'Plano inválido.');
    }
    if (!['mercadopago', 'stripe'].includes(gateway)) {
      throw new functions.https.HttpsError('invalid-argument', 'Gateway inválido.');
    }
    if (![1, 3, 6, 12].includes(meses)) {
      throw new functions.https.HttpsError('invalid-argument', 'Período: 1, 3, 6 ou 12.');
    }

    const usuarioSnap = await db.collection('usuarios').doc(uid).get();
    if (!usuarioSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Usuário não encontrado.');
    }
    const { empresaId } = usuarioSnap.data();

    const empresaSnap = await db.collection('empresas').doc(empresaId).get();
    if (!empresaSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Empresa não encontrada.');
    }
    const empresa = empresaSnap.data();

    // Desconto por período
    const precoBase  = PLANOS_META[plano].preco;
    const desconto   = meses >= 12 ? 0.80 : meses >= 6 ? 0.85 : meses >= 3 ? 0.90 : 1.00;
    const valorTotal = Math.round(precoBase * meses * desconto);
    const valorReais = (valorTotal / 100).toFixed(2);

    const pagamentoId = uuid().replace(/-/g, '').substring(0, 20);
    const baseUrl     = functions.config().app?.base_url || `https://${PROJECT}.web.app`;

    let paymentUrl, gatewayId;

    /* ── Mercado Pago ─────────────── */
    if (gateway === 'mercadopago') {
      const mpToken = functions.config().mp?.access_token;
      if (!mpToken) throw new functions.https.HttpsError('internal', 'MP não configurado.');

      const mpRes = await axios.post(
        'https://api.mercadopago.com/checkout/preferences',
        {
          external_reference: pagamentoId,
          items: [{
            id:          plano,
            title:       `PDV SaaS — ${PLANOS_META[plano].nome} (${meses}x)`,
            description: empresa.nome || '',
            quantity:    1,
            unit_price:  parseFloat(valorReais),
            currency_id: 'BRL',
          }],
          payer: { email: empresa.email || context.auth.token.email || '' },
          back_urls: {
            success: `${baseUrl}/checkout.html?status=success&ref=${pagamentoId}`,
            failure: `${baseUrl}/checkout.html?status=failure&ref=${pagamentoId}`,
            pending: `${baseUrl}/checkout.html?status=pending&ref=${pagamentoId}`,
          },
          auto_return:          'approved',
          notification_url:     `https://${REGION}-${PROJECT}.cloudfunctions.net/mpWebhook`,
          statement_descriptor: 'PDV SAAS',
          metadata:             { pagamentoId, empresaId, plano, meses: String(meses) },
        },
        { headers: { Authorization: `Bearer ${mpToken}` } }
      );
      paymentUrl = mpRes.data.init_point;
      gatewayId  = mpRes.data.id;

    /* ── Stripe ───────────────────── */
    } else {
      const stripeKey = functions.config().stripe?.secret_key;
      if (!stripeKey) throw new functions.https.HttpsError('internal', 'Stripe não configurado.');

      const stripe  = Stripe(stripeKey);
      const session = await stripe.checkout.sessions.create({
        mode:                'payment',
        payment_method_types: ['card'],
        client_reference_id: pagamentoId,
        customer_email:      empresa.email || context.auth.token.email || undefined,
        metadata:            { pagamentoId, empresaId, plano, meses: String(meses) },
        line_items: [{
          price_data: {
            currency:     'brl',
            unit_amount:  valorTotal,
            product_data: {
              name:        `PDV SaaS — ${PLANOS_META[plano].nome}`,
              description: `${meses} mês${meses > 1 ? 'es' : ''}`,
            },
          },
          quantity: 1,
        }],
        success_url: `${baseUrl}/checkout.html?status=success&ref=${pagamentoId}`,
        cancel_url:  `${baseUrl}/checkout.html?status=cancel&ref=${pagamentoId}`,
      });
      paymentUrl = session.url;
      gatewayId  = session.id;
    }

    await db.collection('pagamentos').doc(pagamentoId).set({
      empresaId, uid, plano,
      valor:    valorTotal,
      meses,
      gateway,  gatewayId, paymentUrl,
      status:   'pendente',
      criadoEm: new Date().toISOString(),
    });

    await _log(empresaId, 'pagamento', 'pagamento_criado', {
      pagamentoId, plano, gateway, valor: valorTotal, meses,
    }, uid);

    functions.logger.info('[criarPagamento] ✅', { pagamentoId, empresaId, plano, gateway });
    return { pagamentoId, paymentUrl };
  });

/* ═══════════════════════════════════════════════════════════════════
   PAGAMENTO 2 — WEBHOOK MERCADO PAGO
═══════════════════════════════════════════════════════════════════ */
exports.mpWebhook = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {

    const topic = req.query.topic || req.body.type;
    const mpId  = req.query.id    || req.body.data?.id;
    if (!topic || !mpId || !['payment', 'merchant_order'].includes(topic)) {
      return res.sendStatus(200);
    }

    const mpToken = functions.config().mp?.access_token;
    if (!mpToken) return res.sendStatus(500);

    try {
      const mpRes = await axios.get(
        `https://api.mercadopago.com/v1/payments/${mpId}`,
        { headers: { Authorization: `Bearer ${mpToken}` } }
      );
      const payment = mpRes.data;
      const ref     = payment.external_reference;
      if (!ref) return res.sendStatus(200);

      const pagSnap = await db.collection('pagamentos').doc(ref).get();
      if (!pagSnap.exists) return res.sendStatus(200);
      const pag = pagSnap.data();

      const STATUS = {
        approved: 'aprovado', pending: 'pendente', in_process: 'pendente',
        rejected: 'cancelado', cancelled: 'cancelado',
        refunded: 'reembolsado', charged_back: 'reembolsado',
      };
      const novoStatus = STATUS[payment.status] || 'pendente';

      await db.collection('pagamentos').doc(ref).update({
        status:        novoStatus,
        gatewayStatus: payment.status,
        atualizadoEm:  new Date().toISOString(),
        mpPaymentId:   mpId,
      });

      await _log(pag.empresaId, 'pagamento', `pagamento_${novoStatus}`, {
        pagamentoId: ref, gateway: 'mercadopago', mpPaymentId: mpId,
        mpStatus: payment.status,
      });

      if (novoStatus === 'aprovado' && pag.status !== 'aprovado') {
        await _ativarPlano(pag.empresaId, pag.plano, pag.meses, ref, pag.valor);
      }

      functions.logger.info('[mpWebhook]', { ref, novoStatus });

    } catch (err) {
      functions.logger.error('[mpWebhook] ❌', { error: err.message });
    }

    return res.sendStatus(200);
  });

/* ═══════════════════════════════════════════════════════════════════
   PAGAMENTO 3 — WEBHOOK STRIPE
═══════════════════════════════════════════════════════════════════ */
exports.stripeWebhook = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {

    const stripeKey     = functions.config().stripe?.secret_key;
    const webhookSecret = functions.config().stripe?.webhook_secret;
    if (!stripeKey || !webhookSecret) return res.sendStatus(500);

    const stripe = Stripe(stripeKey);
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        webhookSecret
      );
    } catch (err) {
      functions.logger.warn('[stripeWebhook] Assinatura inválida', { error: err.message });
      return res.sendStatus(400);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session     = event.data.object;
        const ref         = session.client_reference_id;
        if (!ref) return res.sendStatus(200);

        const pagSnap = await db.collection('pagamentos').doc(ref).get();
        if (!pagSnap.exists) return res.sendStatus(200);
        const pag        = pagSnap.data();
        const novoStatus = session.payment_status === 'paid' ? 'aprovado' : 'pendente';

        await db.collection('pagamentos').doc(ref).update({
          status:          novoStatus,
          gatewayStatus:   session.payment_status,
          atualizadoEm:    new Date().toISOString(),
          stripeSessionId: session.id,
        });

        await _log(pag.empresaId, 'pagamento', `pagamento_${novoStatus}`, {
          pagamentoId: ref, gateway: 'stripe', stripeSessionId: session.id,
        });

        if (novoStatus === 'aprovado' && pag.status !== 'aprovado') {
          await _ativarPlano(pag.empresaId, pag.plano, pag.meses, ref, pag.valor);
        }

        functions.logger.info('[stripeWebhook]', { ref, novoStatus });

      } else if (event.type === 'charge.refunded') {
        const meta = event.data.object.metadata || {};
        if (meta.pagamentoId) {
          await db.collection('pagamentos').doc(meta.pagamentoId).update({
            status:       'reembolsado',
            atualizadoEm: new Date().toISOString(),
          });
          await _log(null, 'pagamento', 'pagamento_reembolsado', {
            pagamentoId: meta.pagamentoId,
          });
        }
      }
    } catch (err) {
      functions.logger.error('[stripeWebhook] ❌', { error: err.message });
    }

    return res.sendStatus(200);
  });
