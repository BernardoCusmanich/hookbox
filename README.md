# Hookbox

Caixa de entrada multi-tenant para webhooks: receba numa URL própria, inspecione cada requisição em tempo real, confira a assinatura HMAC e encaminhe para a sua aplicação com retry.

[![CI](https://github.com/BernardoCusmanich/hookbox/actions/workflows/ci.yml/badge.svg)](https://github.com/BernardoCusmanich/hookbox/actions/workflows/ci.yml)

**Demo ao vivo:** https://hookbox-demo.vercel.app (botão “Entrar na demo”, sem cadastro)

<!-- TODO: trocar pelo GIF do inspetor recebendo requisições em tempo real -->
![Inspetor do Hookbox](public/inspector.png)

## Funcionalidades

- **URL de ingestão por endpoint** (`/in/<slug>`) que aceita GET, POST, PUT, PATCH, DELETE, HEAD e OPTIONS, com corpo de até 256 KB.
- **Inspetor em tempo real** via Supabase Realtime: método, horário, tamanho e selo da assinatura de cada requisição; corpo com JSON formatado, headers, query e histórico de entregas.
- **Verificação de assinatura HMAC-SHA256** compatível com o [legacy-bridge](https://github.com/BernardoCusmanich/legacy-bridge), com janela de ±5 minutos para o timestamp. O status é informativo: a requisição é gravada mesmo com assinatura inválida.
- **Encaminhamento com retry** pelo Upstash QStash (até 5 novas tentativas), com proteção contra SSRF e botão “Reenviar”.
- **“Copiar como cURL”** e **“Enviar teste”** direto do inspetor.
- **Multi-tenant**: organizações, papéis (owner e membro), convites por link e seletor de organização, com o isolamento feito por RLS no Postgres.
- **Segredos cifrados** com AES-256-GCM; `authorization`, `cookie`, `proxy-authorization` e `x-api-key` são gravados como `[redacted]`.
- **Rate limit** de 60 req/min por endpoint e 120 req/min por IP (Upstash Redis).
- **Limpeza diária** (Vercel Cron): apaga requisições com mais de 7 dias e restaura a organização demo.
- Login por magic link ou GitHub, modo claro e escuro, layout responsivo e interface em português.

## Fluxo

```mermaid
flowchart LR
    P[Provedor do webhook] -->|HTTP| IN["/in/[slug]<br/>rate limit · 256 KB · HMAC"]
    IN -->|INSERT, service role| DB[(Postgres<br/>Supabase)]
    DB -->|postgres_changes<br/>filtrado pelo RLS| RT[Supabase Realtime]
    RT --> UI[Inspetor no navegador]

    IN -.->|forward_enabled| Q[Upstash QStash<br/>5 retries]
    UI -.->|Reenviar| Q
    Q -->|POST assinado| D["/api/deliver<br/>verifica assinatura · revalida SSRF"]
    D -->|método, corpo e headers originais| DEST[Seu destino]
    D -->|tentativa| DB
```

## Usando com o legacy-bridge

O [legacy-bridge](https://github.com/BernardoCusmanich/legacy-bridge) é um agente .NET que lê mudanças de um banco Firebird legado e envia eventos assinados (`entity`, `operation`, `data`) para um webhook. O Hookbox valida exatamente o mesmo formato de assinatura:

```
x-bridge-signature = "sha256=" + hex(HMAC-SHA256(segredo, "{x-bridge-timestamp}.{corpo bruto}"))
```

1. No Hookbox, crie um endpoint e, em **Configurações → Segredo de assinatura**, clique em **Gerar segredo**. Use **Revelar** para copiá-lo.
2. Aponte o agente para a URL de ingestão do endpoint:

   ```powershell
   [Environment]::SetEnvironmentVariable("Bridge__Webhook__Url", "https://hookbox-demo.vercel.app/in/<slug>", "Machine")
   [Environment]::SetEnvironmentVariable("Bridge__Webhook__Secret", "<segredo do Hookbox>", "Machine")
   ```

   Ou, no desenvolvimento, com user-secrets:

   ```bash
   dotnet user-secrets set "Bridge:Webhook:Url" "https://hookbox-demo.vercel.app/in/<slug>"
   dotnet user-secrets set "Bridge:Webhook:Secret" "<segredo do Hookbox>"
   ```

3. Gere uma mudança no ERP (ou rode o simulador do legacy-bridge). Cada evento aparece no inspetor com ✅ quando a assinatura e o timestamp conferem, ❌ quando não conferem e — quando os headers não vieram.
4. Opcional: ligue o **encaminhamento** para repassar os eventos ao seu backend. Os headers `x-bridge-*` vão junto, então o destino pode validar a assinatura de novo.

O Hookbox responde `200` em toda requisição gravada, então o bridge marca o evento como `sent`. Na demo, o endpoint “ERP via legacy-bridge (assinado)” já tem exemplos com assinatura válida, inválida, ausente e com timestamp vencido.

## Rodando localmente

Pré-requisitos: Node.js 24, Docker (para o Supabase local).

```bash
npm install

# 1. Supabase local: Postgres, Auth, Realtime e Mailpit (e-mails em http://127.0.0.1:54324)
npx supabase start            # aplica as migrations de supabase/migrations
npx supabase status           # mostra a URL, a anon key e a service role key

# 2. Variáveis de ambiente
cp .env.example .env.local    # preencha com os valores do passo 1 e os segredos abaixo
openssl rand -base64 32       # ENCRYPTION_KEY
openssl rand -hex 32          # CRON_SECRET

# 3. QStash local (outro terminal): mostra QSTASH_TOKEN e as signing keys; use QSTASH_URL=http://127.0.0.1:8080
npm run qstash:dev

# 4. Usuário, organização e requisições da demo
npm run seed

# 5. App
npm run dev                   # http://localhost:3000
```

**Rate limit no desenvolvimento.** O `@upstash/ratelimit` usa um recurso de script Lua que só existe no Upstash, então ele não roda contra um Redis comum. Crie um banco Redis gratuito em [console.upstash.com](https://console.upstash.com) e use a URL e o token REST dele. Sem isso, a ingestão funciona normalmente, mas o rate limit fica desligado (fail-open) e um aviso aparece no log.

**Encaminhamento no desenvolvimento.** A proteção contra SSRF recusa `localhost` e IPs privados também localmente. Para testar uma entrega de verdade, use uma URL pública (por exemplo, um endpoint temporário do webhook.site).

**Login com GitHub local.** Crie um OAuth App com callback `http://127.0.0.1:54321/auth/v1/callback`, troque `enabled = true` em `[auth.external.github]` no `supabase/config.toml` e exporte `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` e `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET`.

### Testes

```bash
npm test          # unitários e integração (assinatura, crypto, SSRF, ingestão, encaminhamento)
npm run db:test   # pgTAP: RLS, triggers e RPCs (precisa do Supabase local)
npm run lint
npm run typecheck
```

Outros comandos: `npm run db:types` regenera `lib/supabase/types.ts` a partir do banco local.

## Deploy na Vercel

1. **Supabase:** crie um projeto e aplique as migrations:
   ```bash
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
   Em **Authentication → URL Configuration**, defina o *Site URL* como `https://<seu-app>.vercel.app` e adicione `https://<seu-app>.vercel.app/auth/callback` às *Redirect URLs*. Em **Providers**, mantenha o e-mail com confirmação ligada e configure o GitHub, com o callback que o Supabase mostra.
   Os e-mails de autenticação em português ficam em `supabase/templates` (o Supabase local já os usa). Para aplicá-los no projeto hospedado, rode `npm run email:templates -- <ref>` depois do `supabase login`.
2. **Upstash:** crie um banco Redis e pegue o token e as signing keys do QStash no console.
3. **Vercel:** importe o repositório e cadastre todas as variáveis do `.env.example` (sem `QSTASH_URL`). `APP_URL` precisa ser a URL pública final, porque é ela que o QStash chama e que o `/api/deliver` usa para conferir a assinatura.
4. Faça o deploy. O build falha se faltar alguma variável.
5. Rode o seed apontando para produção, uma vez: `npm run seed` com as variáveis de produção num `.env.production.local`. Atenção: enquanto esse arquivo existir, ele tem prioridade sobre o `.env.local`, e o seed vai sempre para produção.
6. O cron (`vercel.json`) roda todo dia às 03:00 UTC e chama `/api/cron/cleanup` com `Authorization: Bearer $CRON_SECRET`. A Vercel envia esse header sozinha quando a variável `CRON_SECRET` existe.

## Decisões técnicas

**RLS como fronteira de multi-tenancy.** O isolamento entre organizações não depende de cada query lembrar de um `where org_id = ...`: ele está nas policies do Postgres, com `is_member(org)` e `is_owner(org)` (`security definer`, `stable`). O app usa a chave anon com a sessão do usuário em todo acesso a dados, e a service role só aparece em quatro lugares: a ingestão, o `/api/deliver`, o cron e o seed. Um bug numa Server Action resulta em “nenhuma linha”, não em vazamento. As actions ainda conferem a membership explicitamente, para dar mensagens de erro claras e como segunda camada. O Realtime herda as mesmas policies, então um usuário não consegue assinar as requisições de outra organização. As regras que o RLS não expressa bem viram triggers: o limite de 5 endpoints e o “sempre pelo menos um owner”. Tudo isso é coberto pelos testes pgTAP em `supabase/tests`.

**QStash em vez de worker próprio.** Na Vercel não existe processo de longa duração para consumir uma fila. O QStash guarda a mensagem, chama o `/api/deliver` e refaz a chamada com backoff quando a resposta é 5xx. A rota fica sem estado: verifica a assinatura do QStash, faz uma tentativa, grava o resultado em `deliveries` e devolve `500` para pedir retry (5xx, 408, 429, timeout, erro de rede) ou `200` para encerrar (2xx, 4xx, redirect). O número da tentativa vem do header `Upstash-Retried`. O custo é uma dependência externa; o ganho é não operar fila, worker nem cron de reprocessamento.

**Por que redigir headers sensíveis.** Um inspetor de webhooks guarda dados de terceiros e mostra esses dados para todos os membros da organização. `authorization`, `cookie`, `proxy-authorization` e `x-api-key` costumam carregar credenciais de longa duração, que não ajudam a depurar e virariam um risco se fossem gravadas. Por isso viram `[redacted]` antes do INSERT e não são reenviadas no encaminhamento. Os headers `x-vercel-*` são descartados pelo mesmo motivo: a plataforma os injeta (inclusive um token OIDC do projeto) e eles não vieram do provedor. A assinatura HMAC continua funcionando, porque usa headers próprios (`x-bridge-*`).

**Proteção contra SSRF.** Encaminhar para uma URL escolhida pelo usuário é um convite para alcançar a rede interna, como o metadata da cloud em `169.254.169.254`. A URL é validada ao salvar e de novo antes de cada envio: só `https`, sem usuário e senha na URL, sem o próprio domínio do Hookbox, e nenhum dos IPs resolvidos (`dns.lookup` com `all: true`) pode ser loopback, privado, link-local, CGNAT, multicast, reservado ou IPv4 embutido em IPv6. Validar só antes do fetch abre espaço para DNS rebinding (o domínio resolve para um IP público na checagem e para um interno na conexão). Por isso o envio usa um `undici.Agent` com um `lookup` próprio, que confere o IP no momento em que o socket conecta, e IP literal é checado à parte. Redirects não são seguidos (`redirect: 'manual'`) e contam como falha permanente, e cada tentativa tem timeout de 10 s. Para evitar loops (um endpoint encaminhando para outro, inclusive por uma URL alternativa do mesmo deploy), uma requisição que chega com `x-hookbox-request-id` é gravada, mas não é reencaminhada.

**Outras escolhas.**
- `proxy.ts` (o antigo `middleware.ts` do Next.js 16) renova a sessão, protege `/app/**` e manda para o onboarding quem ainda não tem organização.
- A conta demo é compartilhada, então tem papel de *membro* (não mexe em membros, convites nem no nome da org), não cria organizações e não consegue trocar a própria senha ou o e-mail (um trigger em `auth.users` descarta a mudança). Os endpoints de exemplo não podem ser excluídos, e o cron restaura tudo por dia.
- O Supabase Auth não separa um cadastro por senha de um por magic link. O cadastro por senha não aparece na interface, a confirmação de e-mail fica obrigatória e o aceite de convite exige e-mail confirmado. Assim, uma conta criada direto pela API com o e-mail de outra pessoa não consegue tomar um convite.
- Corpos que não são UTF-8 válido (ou que contêm `\0`, que o Postgres não aceita em `text`) são gravados em base64 e reenviados com os bytes originais.

## Roadmap

- Transformação de payload antes do encaminhamento
- Alertas por e-mail quando as entregas falharem
- API pública para listar e reenviar requisições
