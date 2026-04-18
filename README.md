# Lavandery — Sistema de Inspeção Técnica

Sistema web mobile-first para relatórios de visita técnica em lavanderias de condomínio.

## Stack (v1)
- **Frontend:** HTML + Tailwind (CDN) + Inter + JS vanilla (zero build step)
- **Persistência offline:** IndexedDB (via `localforage`)
- **Fotos:** captura nativa (`<input capture>`), compressão client-side, carimbo de data/hora
- **Assinatura:** canvas (signature_pad)
- **PDF:** jsPDF + html2canvas
- **Backend (stub):** Node.js + Express + SQLite — API REST
- **Admin:** `/admin.html`

## Rodar local
```bash
cd server
npm install
npm start
# → http://localhost:3000
# → login: admin@lavandery.com.br · senha: lavandery2026
```

## 🚀 Deploy (produção)

### Opção A — Render.com (mais fácil, 10 min)
1. Commit tudo num repo Git (GitHub)
2. Entrar em [render.com](https://render.com) → **New → Blueprint** → conectar o repo
3. Render detecta o `render.yaml` e cria o serviço Docker + volume persistente
4. Adicionar env vars (Settings → Environment):
   - `SEED_ADMIN_PASS` = senha forte inicial (troque no primeiro login)
   - `NODE_ENV` = `production`
   - `AUTENTIQUE_API_TOKEN` (se for usar)
   - `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (opcional — tem UI também)
5. Deploy → URL pública `https://lavandery.onrender.com` com HTTPS automático
6. Aponta `painel.lavandery.com.br` pro Render (CNAME)

### Opção B — Fly.io
```bash
fly launch   # lê fly.toml
fly secrets set SEED_ADMIN_PASS=... AUTENTIQUE_API_TOKEN=...
fly deploy
```

### Opção C — VPS próprio (Docker)
```bash
docker compose up -d
# acesse http://SEU_IP:3000
# Nginx + Let's Encrypt pra HTTPS
```

## 🔐 Autenticação

- Login em `/login.html` (e-mail + senha)
- 3 papéis: `admin` (tudo) · `gestor` (operação, sem gerenciar usuários) · `tecnico` (só app mobile)
- Sessão em cookie httpOnly de 30 dias
- Técnicos cadastrados na tabela `technicians` viram automaticamente `users` com role=tecnico usando o PIN como senha (trocável depois)
- Admin seed criado no primeiro boot: `admin@lavandery.com.br` com senha de `SEED_ADMIN_PASS` (default: `lavandery2026` — TROQUE)
- Rate limit: 10 tentativas/min por e-mail

## 🏗 Arquitetura

## Arquitetura
```
[Mobile Web App] ──(IndexedDB cache + fila)──> [API REST Express] ──> [SQLite]
        │                                              │
        └──(fotos comprimidas base64/multipart)────────┘
```

### Sincronização offline
1. Técnico preenche visita offline → salvo em IndexedDB.
2. App detecta conexão → envia fila pendente `POST /api/visits`.
3. Servidor persiste, retorna ID canônico, client atualiza local.

### Score automático
```
score = 100
 - (máquinas_inoperantes * 15)
 - (infra_com_problema * 8)
 - (insumos_faltando * 5)
 - (problemas_criticos * 10)
score = max(0, score)
```

## Modelo de dados
Ver `server/schema.sql`.

## Fluxo (6 etapas)
1. Dados gerais
2. Infraestrutura
3. Máquinas
4. Insumos
5. Fotos
6. Conclusão + assinaturas → PDF
