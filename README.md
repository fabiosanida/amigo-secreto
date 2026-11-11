# Amigo Secreto

Aplicação publicada em https://amigosecreto.sanida.me.

Cadastro com nome, sobrenome e e-mail; acesso sem senha por código ou link de uso único; foto com recorte; grupos e convites por e-mail; acompanhamento de entrega, abertura estimada e aceite; sorteio em um único ciclo com no mínimo três participantes confirmados. Cada pessoa acessa apenas seu resultado. O sorteio é definitivo e não inclui convites pendentes.

A criação de grupo usa um calendário próprio, com navegação por teclado e bloqueio de datas passadas. O valor do presente é um campo textual com decimal pt-BR, sem controles de incremento, e deve ficar entre R$ 1,00 e R$ 100.000,00; o mesmo mínimo é validado pela API e pelo banco.

## Executar

Requer Node.js 24. Configure `.env.local` a partir de `.env.example` com as credenciais do ambiente. Nunca versione os segredos. `DATABASE_URL` usa pool de conexões; `DATABASE_URL_UNPOOLED` é usada nas migrações. `AUTH_SECRET` e `CRON_SECRET` devem ser aleatórios e ter pelo menos 32 caracteres.

```sh
npm ci
npm run migrate
npm run build
npm run dev
```

A aplicação local fica em `http://127.0.0.1:4174`. Os layouts de revisão estão em `prototype/` e podem ser abertos com `node prototype/server.mjs`; o build de produção não inclui o controlador de demonstração nem a barra de revisão.

## Estrutura

- `prototype/live.js`: aplicação de produção, navegação e chamadas à API.
- `prototype/auth.js`, `groups.js`, `profile.js`: telas e recorte de foto.
- `prototype/group-fields.js` e `group-fields.css`: calendário acessível e entrada de orçamento.
- `api/index.js`: API Node.js na Vercel.
- `lib/`: autenticação, Postgres, grupos, perfis e e-mails HTML.
- `migrations/`: migrações versionadas, aplicadas com bloqueio e verificação de hash.
- `scripts/build.mjs`: gera somente os arquivos públicos em `public/`.

Sessões usam cookies HttpOnly/Secure em produção e tokens armazenados como hash. Códigos expiram em 10 minutos, aceitam no máximo cinco tentativas e têm limites de envio. Fotos são reprocessadas no servidor. Aceite e sorteio bloqueiam o mesmo grupo em transação; o resultado não muda em uma repetição da requisição.

O serviço Notifications recebe `POST /api/v1/emails` e expõe `GET /api/v1/emails/:id`. A outbox mantém idempotência, registra falhas e retoma envios via cron protegido a cada cinco minutos. Aberturas de e-mail são estimativas: bloqueio de imagens e mecanismos de privacidade podem interferir. WhatsApp aguarda a integração fornecida pelo responsável pelo projeto.

## Verificar

```sh
npm test
RUN_DB_TESTS=1 node --env-file=.env.local --test tests/integration.test.mjs
```

A integração usa o banco configurado, cria dados temporários identificados e os remove ao concluir. Os envios são interceptados pelo teste: nenhuma mensagem é enviada a endereços fictícios. A suíte cobre código de uso único, expiração, concorrência, autorização, aceite, sorteio, privacidade do resultado e repetição idempotente de notificações.

## Publicar

O projeto `sanida/amigo-secreto` na Vercel acompanha a branch `main`. Build: `npm run build`; saída: `public`; Node.js 24. Execute as migrações no ambiente correto antes de publicar alterações de esquema. As variáveis obrigatórias são `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `APP_URL`, `AUTH_SECRET`, `NOTIFICATIONS_API_URL`, `NOTIFICATIONS_API_KEY` e `CRON_SECRET`.

Após publicar, confira `/api/health`, o domínio principal e `/assets/mark.png` (a marca usada pelos e-mails). O cron `/api/internal/notifications/drain` exige `Authorization: Bearer <CRON_SECRET>`.
