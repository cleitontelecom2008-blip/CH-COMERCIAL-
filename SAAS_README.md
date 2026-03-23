# PDV SaaS — Guia de Implantação

## O que foi adicionado

| Arquivo | Descrição |
|---|---|
| `saas-auth.js` | Login/Cadastro + isolamento por empresa |
| `saas-plans.js` | Controle de planos e limites de uso |
| `sync.js` | Modificado: aguarda auth, path por empresa |
| `firebase.js` | Modificado: reutiliza app do saas-auth.js |
| `admin.html` | Painel admin: gerencia todas as empresas |
| `firestore.rules` | Regras de segurança Firestore multi-tenant |

---

## Passo a Passo

### 1. Criar Projeto Firebase

1. Acesse [firebase.google.com](https://firebase.google.com)
2. **Criar Projeto** → dê um nome (ex: `meu-pdv-saas`)
3. Ativar **Authentication** → Email/Senha
4. Ativar **Firestore Database** → Modo Produção
5. Copie as credenciais do projeto (`firebaseConfig`)

### 2. Configurar os Arquivos

Substitua os placeholders em **3 arquivos**:

**`saas-auth.js`** — linha ~43:
```js
const SAAS_CONFIG = {
  apiKey:            "SUA_API_KEY_AQUI",
  authDomain:        "meu-pdv-saas.firebaseapp.com",
  projectId:         "meu-pdv-saas",
  storageBucket:     "meu-pdv-saas.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123",
};
```

**`firebase.js`** — mesma config

**`admin.html`** — linha ~185: mesma config

### 3. Atualizar index.html

Adicione/substitua os scripts no final do `index.html`:

```html
<!-- ANTES de firebase.js e sync.js — ADICIONE: -->
<script type="module" src="saas-auth.js"></script>

<!-- Mantenha: -->
<script type="module" src="firebase.js"></script>
<script type="module" src="sync.js"></script>

<!-- Após app-dialogs.js — ADICIONE: -->
<script src="saas-plans.js"></script>
```

**Exemplo do bloco final do index.html:**
```html
<script type="module" src="saas-auth.js"></script>   <!-- NOVO -->
<script type="module" src="firebase.js"></script>
<script type="module" src="sync.js"></script>
<script src="app-dialogs.js"></script>
<script src="saas-plans.js"></script>                <!-- NOVO -->
<script src="app-core.js"></script>
<!-- ... resto dos scripts ... -->
```

### 4. Deploy e Primeiro Acesso

1. Faça deploy do projeto (GitHub Pages, Firebase Hosting, etc.)
2. Acesse o app → aparecerá a tela de login
3. Clique em **Cadastrar** → crie sua conta admin
4. Após criar → copie o UID exibido no console do browser:
   ```
   [SaasAuth] ✅ Empresa: ... | uid: XXXXXXXXXXXXXXXX
   ```
5. Cole esse UID em:
   - `saas-auth.js` linha: `const ADMIN_UID = "SEU_UID_ADMIN";`
   - `admin.html` linha: `const ADMIN_UID = "SEU_UID_ADMIN";`
   - `firestore.rules` linha: `request.auth.uid == "SEU_UID_ADMIN"`

### 5. Deploy das Regras Firestore

No terminal:
```bash
firebase deploy --only firestore:rules
```
Ou cole manualmente em: Firebase Console → Firestore → Regras

---

## Planos

| Plano | Preço | Vendas/mês | Delivery | IA |
|---|---|---|---|---|
| Free | Grátis | 200 | ❌ | ❌ |
| Basic | R$49/mês | 2.000 | ✅ | ❌ |
| Pro | R$99/mês | Ilimitado | ✅ | ✅ |

Para mudar o preço, edite `saas-plans.js` e `saas-auth.js` (constante `PLANOS_DEF`).

---

## Como gerenciar empresas

Acesse `admin.html` com seu login admin:
- Listar todas as empresas cadastradas
- Alterar plano de qualquer empresa
- Definir data de expiração
- Ativar / Desativar conta

---

## Estrutura Firestore

```
/empresas/{uid}              ← metadados da empresa
  nome, email, plano, planoExpira, ativo, vendasMes, criadoEm

/saas_dados/{uid}            ← dados PDV isolados por empresa
  data { ... }               ← mesmo formato do sistema atual
  updated, version, empresaId
```

---

## Integrar bloqueio de features no app

No `app-ia.js` — antes de abrir a IA:
```js
if (!SaasPlans.check('ia')) {
  SaasPlans.showUpgradeModal('ia');
  return;
}
```

No `app-delivery.js` — antes de abrir delivery:
```js
if (!SaasPlans.check('delivery')) {
  SaasPlans.showUpgradeModal('delivery');
  return;
}
```

No `VendaService.finalizarVenda()` — antes de confirmar venda:
```js
if (!SaasPlans.checkVendaLimit()) return;
// ... finalizar venda ...
SaasPlans.incrementVenda();
```

---

## Logout

Chame de qualquer lugar no app:
```js
SaasAuth.logout(); // faz signOut e recarrega a tela de login
```

---

## Suporte

Para erros de CORS/Firebase: certifique-se de adicionar seu domínio em:
**Firebase Console → Authentication → Settings → Authorized domains**
