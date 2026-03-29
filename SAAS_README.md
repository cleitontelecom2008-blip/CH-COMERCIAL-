# PDV SaaS — v7 (Patch Release)

## Correções aplicadas nesta versão

### 🔴 CRÍTICO — Firestore Rules (`firestore.rules`)

**BUG 1 — Dono não conseguia ler lista de colaboradores**
- `usuarios/{userId}` só permitia `isOwner(userId)` ou `isAdmin()` no `read`
- Corrigido: adicionado `resource.data.empresaId == userEmpresaId()` para que qualquer membro da empresa leia usuários da mesma empresa

**BUG 2 — Dono não conseguia alterar cargo nem remover colaboradores**
- Regras anteriores não previam `update` nem `delete` pelo dono da empresa
- Corrigido: novo helper `isDonoDaEmpresa()` e permissões explícitas de `update` (somente campo `cargo`/`status`, nunca para `'dono'`) e `delete` (nunca o próprio dono)
- Proteção anti-escalada: `hasOnly(['cargo','status'])` + `cargo != 'dono'`

**BUG 3 (parcial rules) — Qualquer membro podia criar convite**
- Corrigido: `convites/create` exige `isDonoDaEmpresa()`, não apenas `isEmpresaMember()`

---

### 🔴 CRÍTICO — Colaborador removido retornava ao sistema (`saas-users.js` + `saas-auth.js`)

**BUG 3 — Remover usuário com `deleteDoc` causava recriação de empresa**
- O `saas-auth.js` tem fallback: se `usuarios/{uid}` não existe, cria uma nova empresa automaticamente
- Portanto: deletar o documento fazia o colaborador banido receber uma empresa nova no próximo login
- **Fix `saas-users.js`**: substituído `deleteDoc` por `updateDoc({ status: 'removido', removidoEm, removidoPor })`
- **Fix `saas-auth.js`**: após resolver `usuario`, verifica `status === 'removido'` → bloqueia com mensagem e chama `signOut`
- **Fix `saas-users.js` UI**: `_renderLista` filtra usuários com `status === 'removido'`
- **Fix extra**: `ADMIN_UID` hardcoded removido de `saas-auth.js` (credencial desnecessária exposta)
- **Fix extra**: `_confirmarRemover` usa `Dialog.confirm` async em vez de `confirm()` nativo bloqueante

---

### 🟡 MÉDIO — `functions/index.js` — Batch reutilizado após commit

**BUG 4 — `batch.commit()` seguido de novas operações no mesmo batch**
- O Firestore WriteBatch lança erro se chamado após `commit()`
- Corrigido: extraída função `_flushBatch()` que commita e recria o batch localmente

---

### 🟡 MÉDIO — `saas-plans.js` — Contador de vendas não sincronizava com Firebase

**BUG 5 — Novo dispositivo começava sempre do zero**
- O contador ficava somente em `localStorage`
- No login em um segundo device, o usuário conseguia fazer até `limite` vendas novamente
- **Fix**: listener `saas:ready` lê `SAAS_EMPRESA.vendasMes` e inicializa o localStorage com o maior valor entre Firebase e local

---

### 🟡 MÉDIO — `functions/index.js` — `vendasMes` nunca resetava mensalmente

**BUG 6 — O campo `vendasMes` acumulava infinitamente**
- O cron `verificarPlanos` não resetava o contador ao virar o mês
- Corrigido: dentro do loop, se `empresa.mesAtual !== mesAtual` → `batch.update({ vendasMes: 0, mesAtual })`

---

### 🟢 MENOR — `firebase.json` — Cache `immutable` em arquivos JS sem hash

**BUG 7 — Deploy de atualizações ignorado pelo browser**
- `Cache-Control: public, max-age=31536000, immutable` em `**/*.js`
- Sem hash no nome do arquivo (ex: `app-core.js` não vira `app-core.abc123.js`), o browser nunca revalidava
- Corrigido: `public, max-age=3600, must-revalidate`

---

## Arquivos modificados

| Arquivo | Versão anterior | Versão nova |
|---|---|---|
| `firestore.rules` | 3.0.0 | 3.1.0 |
| `projeto/saas-auth.js` | 2.0.0 | 2.1.0 |
| `projeto/saas-users.js` | 1.0.0 | 1.1.0 |
| `projeto/saas-plans.js` | 1.0.0 | 1.1.0 |
| `projeto/firebase.json` | — | patch |
| `functions/index.js` | 3.0.0 | 3.1.0 |

## Deploy

```bash
# Regras Firestore
firebase deploy --only firestore:rules

# Cloud Functions
cd functions && npm install
firebase deploy --only functions

# Hosting
firebase deploy --only hosting
```
