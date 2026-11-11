# Amigo Secreto

Aplicação publicada em https://amigosecreto.sanida.me.

Cadastro com nome, sobrenome, e-mail e senha; acesso por e-mail e senha; foto com recorte; grupos e convites por e-mail; acompanhamento de entrega, abertura estimada e aceite; sorteio em um único ciclo com no mínimo três participantes confirmados. Na área dos grupos, cada participante acessa seu próprio resultado. O sorteio é definitivo e não inclui convites pendentes.

O criador pode apagar seu grupo após digitar o nome dele na confirmação. A exclusão é permanente e remove participações, convites, resultados e notificações relacionadas, preservando as contas dos usuários. Se um envio estiver em andamento, a API pede para aguardar antes de tentar novamente.

A área `#admin` é exclusiva da conta verificada `fabiosanida@gmail.com`. A autorização é conferida na API pela identidade da sessão, além de controlar a navegação. Ela permite consultar todos os grupos, seus criadores, participantes e resultados, além das contas e seus grupos criados e participações. O administrador também pode apagar qualquer grupo ou excluir usuários após revisar o impacto e digitar o nome do grupo ou e-mail da conta. A própria conta administrativa fica protegida contra exclusão. Listas e históricos são paginados; detalhes são carregados sob demanda, sem atualização automática. Dados administrativos não são persistidos no armazenamento do navegador.

Ao excluir um usuário, seus grupos são apagados e suas participações nos outros grupos ainda não sorteados são removidas. Nos sorteios de outras pessoas já realizados, uma identidade anonimizada preserva os pares originais; nome, e-mail, foto, senha e credenciais de acesso da conta excluída são removidos. Sessões e autorizações pendentes são revogadas. Um novo cadastro com o mesmo e-mail recebe uma nova identidade e não herda as participações antigas. A confirmação informa essas consequências antes da exclusão.

A página `#admin-marmelada` também é exclusiva do administrador. Ela permite selecionar um grupo sorteado, quem está anunciando seu amigo secreto e o nome anunciado. A API compara essa escolha com o sorteio original: o acerto abre uma apresentação verde com balões e confetes; a divergência abre a brincadeira “É MARMELADA!”. A apresentação oferece tela cheia, saída por Esc e uma nova conferência, com animações reduzidas para quem usa essa preferência. Uma resposta incorreta não revela o destinatário real. A conferência não modifica sorteios nem envia notificações.

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
- `prototype/admin.js` e `admin.css`: área administrativa privada.
- `prototype/marmelada.js` e `marmelada.css`: conferência e apresentação dos nomes anunciados.
- `prototype/group-fields.js` e `group-fields.css`: calendário acessível e entrada de orçamento.
- `api/index.js`: API Node.js na Vercel.
- `lib/`: autenticação, Postgres, grupos, perfis e e-mails HTML.
- `migrations/`: migrações versionadas, aplicadas com bloqueio e verificação de hash.
- `scripts/build.mjs`: gera somente os arquivos públicos em `public/`.

Sessões usam cookies HttpOnly/Secure em produção e tokens armazenados como hash. Senhas têm entre 12 e 128 caracteres e são armazenadas com scrypt e salt individual. Códigos de cadastro e recuperação expiram em 10 minutos, aceitam no máximo cinco tentativas e têm limites de envio. A recuperação emite uma autorização temporária de uso único para definir a senha; ao concluir, as sessões anteriores são encerradas. Contas anteriores à adoção de senhas usam “Recuperar senha” para definir a primeira senha. Fotos são reprocessadas no servidor. Aceite e sorteio bloqueiam o mesmo grupo em transação; o resultado não muda em uma repetição da requisição.

Um convite válido comprova apenas o e-mail destinatário: um novo cadastro com esse mesmo endereço dispensa outro código de confirmação. Cadastros com outro e-mail continuam exigindo confirmação, e contas existentes exigem login. O convite permanece durante cadastro, login, recuperação e troca de conta. Aceitar é uma ação explícita: uma pessoa logada só pode confirmar a própria participação se tiver convite ativo para aquele grupo.

O serviço Notifications recebe `POST /api/v1/emails` e expõe `GET /api/v1/emails/:id`. Os envios normais são imediatos. A outbox mantém idempotência, registra falhas e retoma envios via cron protegido uma vez por hora, ou quando o organizador atualiza um grupo com trabalho pendente. Sem atividade, uma nova tentativa e a atualização dos comprovantes de entrega podem aguardar até uma hora. Aberturas de e-mail são estimativas: bloqueio de imagens e mecanismos de privacidade podem interferir. WhatsApp aguarda a integração fornecida pelo responsável pelo projeto.

Para reduzir o uso do Neon, o cron passou de 288 para 24 verificações diárias e executa apenas uma consulta quando não há trabalho pendente. A visualização de grupo evita consultas de manutenção desnecessárias; o resultado individual só é carregado ao ser revelado. O pool tem no máximo três conexões e libera conexões ociosas após cinco segundos. Sessões continuam sendo verificadas no banco a cada requisição autenticada, preservando a revogação imediata; fotos são consultadas apenas quando necessárias. O endpoint de produção e os padrões do projeto foram ajustados para 0,25–1 CU e suspensão após 300 segundos sem uso. Isso reduz a capacidade mínima e as consultas ociosas, sem garantir um percentual fixo de economia na fatura.

## Verificar

```sh
npm test
RUN_DB_TESTS=1 node --env-file=.env.local --test tests/integration.test.mjs tests/password-integration.test.mjs
```

A integração usa o banco configurado, cria dados temporários identificados e os remove ao concluir. Os envios são interceptados pelo teste: nenhuma mensagem é enviada a endereços fictícios. A suíte cobre código de uso único, expiração, concorrência, autorização, aceite, sorteio, privacidade do resultado e repetição idempotente de notificações. A suíte adicional `tests/admin-integration.test.mjs` exige um schema isolado cujo nome comece com `as_test_`, com as migrações aplicadas e o `search_path` configurado na conexão. Ela testa permissões administrativas, paginação, consulta de resultados, exclusão confirmada de grupos e contas, anonimização dos sorteios preservados, revogação de acesso e conferência Marmelada sem alteração dos pares, sem tocar na conta administrativa real.

## Publicar

O projeto `sanida/amigo-secreto` na Vercel acompanha a branch `main`. Build: `npm run build`; saída: `public`; Node.js 24. Execute as migrações no ambiente correto antes de publicar alterações de esquema. As variáveis obrigatórias são `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `APP_URL`, `AUTH_SECRET`, `NOTIFICATIONS_API_URL`, `NOTIFICATIONS_API_KEY` e `CRON_SECRET`.

Após publicar, confira `/api/health`, o domínio principal e `/assets/mark.png` (a marca usada pelos e-mails). O cron `/api/internal/notifications/drain` exige `Authorization: Bearer <CRON_SECRET>`.
