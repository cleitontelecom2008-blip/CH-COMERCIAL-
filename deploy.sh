#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# PDV SaaS — Deploy de Produção
# Site: pdvchgeladas.com
# ═══════════════════════════════════════════════════════════════════
set -e

PROJETO="meu-pdv-saas"
SITE="pdvchgeladas"
DOMINIO="pdvchgeladas.com"

echo "🚀 PDV SaaS — Deploy de Produção | $DOMINIO"

echo "🔑 [1/6] Verificando autenticação..."
firebase projects:list --project "$PROJETO" > /dev/null 2>&1 || firebase login
echo "   ✅ OK"

echo "📦 [2/6] Instalando dependências das Functions..."
cd "$(dirname "$0")/../functions" && npm install --production && cd -
echo "   ✅ OK"

echo "⚙️  [3/6] Verificando secrets..."
CONF=$(firebase functions:config:get --project "$PROJETO" 2>/dev/null || echo "{}")
if echo "$CONF" | grep -q '"mp"'; then
  echo "   ✅ Secrets configurados"
else
  echo "   ⚠️  Configure os secrets:"
  echo "   firebase functions:config:set \\"
  echo "     mp.access_token=\"APP_USR-xxxx\" \\"
  echo "     stripe.secret_key=\"sk_live_xxxx\" \\"
  echo "     stripe.webhook_secret=\"whsec_xxxx\" \\"
  echo "     app.base_url=\"https://$DOMINIO\""
  exit 1
fi

echo "🔒 [4/6] Deploy Firestore rules + indexes..."
firebase deploy --project "$PROJETO" --only firestore:rules,firestore:indexes --non-interactive
echo "   ✅ OK"

echo "⚡ [5/6] Deploy Cloud Functions..."
firebase deploy --project "$PROJETO" --only functions --non-interactive
echo "   ✅ OK"

echo "🌐 [6/6] Deploy Hosting..."
firebase deploy --project "$PROJETO" --only "hosting:$SITE" --non-interactive
echo "   ✅ OK"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅  Produção no ar!"
echo "   🌐  https://$DOMINIO"
echo "   🛡️   https://$DOMINIO/admin"
echo "   💳  https://$DOMINIO/checkout"
echo "   📊  console.firebase.google.com/project/$PROJETO"
echo "═══════════════════════════════════════════════════════════"
