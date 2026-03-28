# PDV SaaS — Guia de Produção
## pdvchgeladas.com

---

## Estrutura Firestore Final

```
admins/{uid}
  → UIDs com acesso admin

empresas/{empresaId}
  → nome, plano, planoReal, planoExpira, status
  → limites, vendasMes, dono, criadoEm

usuarios/{uid}
  → empresaId, nome, email, cargo, criadoEm, ultimoAcesso

saas_dados/{empresaId}
  → Dados PDV completos (vendas, estoque, inventário...)

vendas/{empresaId}/registros/{vendaId}
  → Histórico de vendas detalhado

fiado/{empresaId}/registros/{fiadoId}
  → Controle de fiado

delivery/{empresaId}/pedidos/{pedidoId}
  → Pedidos de delivery

pagamentos/{id}
  → empresaId, plano, valor, meses, gateway, status

logs/{empresaId}/eventos/{autoId}
  → Auditoria: tipo, acao, detalhes, uid, ts

planosVencidos/{id}
  → Log de bloqueios automáticos do cron

convites/{code}
  → Convites para colaboradores (24h)
```

---

## Cloud Functions (7 funções)

| Função           | Tipo        | Trigger                    |
|------------------|-------------|----------------------------|
| criarEmpresaAuto | Auth        | usuário onCreate           |
| verificarPlanos  | Cron        | todo dia 03:00 BRT         |
| backupDiario     | Cron        | todo dia 02:00 BRT         |
| criarPagamento   | HTTPS Call  | cliente → MP / Stripe      |
| mpWebhook        | HTTPS POST  | Mercado Pago IPN           |
| stripeWebhook    | HTTPS POST  | Stripe webhook             |

---

## Logs

Cada ação importante grava em `logs/{empresaId}/eventos`:
- empresa criada / bloqueada
- plano ativado / vencido
- pagamento criado / aprovado / reembolsado
- backup iniciado / erro

Ver no Firebase Console → Firestore → logs

---

## Deploy Completo

```bash
# 1. Configurar secrets
firebase functions:config:set \
  mp.access_token="APP_USR-xxxx" \
  stripe.secret_key="sk_live_xxxx" \
  stripe.webhook_secret="whsec_xxxx" \
  app.base_url="https://pdvchgeladas.com"

# 2. Deploy tudo
cd projeto && bash deploy.sh
```

---

## Domínio pdvchgeladas.com

No Firebase Console → Hosting → Add custom domain:
1. Adicionar: pdvchgeladas.com
2. Adicionar: www.pdvchgeladas.com
3. Copiar registros DNS → painel do registrador
4. Aguardar propagação (até 24h)

Também adicionar o domínio em:
Firebase Console → Authentication → Settings → Authorized domains

---

## Backup

O backup diário (`backupDiario`) exporta para:
`gs://meu-pdv-saas-backups/YYYY-MM-DD/`

Pré-requisito:
1. Criar bucket: `gsutil mb -l southamerica-east1 gs://meu-pdv-saas-backups`
2. IAM: dar papel "Cloud Datastore Import Export Admin" ao service account das Functions

---

## Monitoramento

- **Logs das Functions**: Firebase Console → Functions → Logs
- **Cloud Logging**: console.cloud.google.com → Logging
- **Alertas**: configurar em Cloud Monitoring → Alerting Policies
- **Métricas de uso**: Firebase Console → Usage and billing

---

## Planos

| Plano   | Preço/mês | Vendas  | Usuários | IA  | Delivery |
|---------|-----------|---------|----------|-----|----------|
| Free    | Grátis    | 200     | 1        | ❌  | ❌       |
| Basic   | R$49      | 2.000   | 3        | ❌  | ✅       |
| Pro     | R$99      | ∞       | 10       | ✅  | ✅       |
| Premium | R$199     | ∞       | 50       | ✅  | ✅       |

Descontos: Trimestral -10% | Semestral -15% | Anual -20%

