import { icon, brand, avatar } from './ui.js';

export const EMAIL_ROUTES = ['email-verify', 'email-invite', 'email-result'];

const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function emailButton(label, route, action = '') {
  return `<a class="email-cta" href="#${route}" ${action ? `data-action="${action}"` : `data-route="${route}"`}>${label} ${icon('arrow-right')}</a>`;
}

function fallback(route, label = 'abrir esta página') {
  return `<p class="email-fallback">Se o botão não funcionar, acesse <a href="#${route}" data-route="${route}">amigosecreto.sanida.me</a> para ${label}.</p>`;
}

function giftDrawing(kind = 'invite') {
  const isResult = kind === 'result';
  return `<svg class="email-gift-drawing" viewBox="0 0 280 150" fill="none" aria-hidden="true">
    <ellipse cx="140" cy="136" rx="71" ry="9" fill="#D9E1D3"/>
    <path d="M100 60H180V125C180 130 176 134 171 134H109C104 134 100 130 100 125V60Z" fill="${isResult ? '#E7EDE2' : '#F2C7AE'}" stroke="#203D35" stroke-width="2"/>
    <path d="M133 61H147V134H133V61Z" fill="#EE775B"/>
    <g transform="${isResult ? 'translate(6 -10) rotate(8 140 54)' : 'translate(0 0)'}">
      <rect x="94" y="48" width="92" height="22" rx="4" fill="#FAF8F2" stroke="#203D35" stroke-width="2"/>
      <path d="M132 49H148V70H132V49Z" fill="#EE775B"/>
      <path d="M140 48C135 24 112 19 111 34C110 44 126 49 140 48ZM140 48C145 24 168 19 169 34C170 44 154 49 140 48Z" fill="#EE775B" stroke="#203D35" stroke-width="2" stroke-linejoin="round"/>
    </g>
    <path d="M72 35L75 44L84 47L75 50L72 59L69 50L60 47L69 44L72 35Z" fill="#EE775B"/>
    <path d="M207 80L209 86L215 88L209 90L207 96L205 90L199 88L205 86L207 80Z" fill="#203D35"/>
    <path d="M202 27L205 34M64 95L58 100M222 55L229 52" stroke="#203D35" stroke-width="2" stroke-linecap="round"/>
    <circle cx="85" cy="112" r="3" fill="#EE775B"/><circle cx="188" cy="17" r="3" fill="#EE775B"/>
  </svg>`;
}

function verifyEmail(user) {
  return {
    subject: 'Só falta confirmar seu email. A surpresa vem depois.',
    body: `<div class="email-symbol">${icon('mail')}</div>
      <p class="email-eyebrow">QUE BOM TER VOCÊ POR AQUI</p>
      <h1>Uma boa surpresa<br>começa com você.</h1>
      <p class="email-copy">Oi, ${safe(user.firstName)}! Antes de reunir sua turma, vamos confirmar que este email é seu. É rapidinho.</p>
      <p class="email-code-label">Você também pode confirmar com este código no app</p>
      <div class="email-code" aria-label="Código de confirmação: 1 2 3 4 5 6">${'123456'.split('').map((digit) => `<span>${digit}</span>`).join('')}</div>
      <p class="email-code-expiry">Este código é válido por 10 minutos.</p>
      ${emailButton('Validar minha conta', 'account-ready', 'verify-email-link')}
      ${fallback('verify', 'digitar seu código de confirmação')}
      <div class="email-note">${icon('shield')}<p>Não foi você quem criou esta conta? Pode ignorar este email. Sua tranquilidade vem primeiro.</p></div>`,
  };
}

function inviteEmail(user, group) {
  const date = new Date(`${group.date}T12:00:00`);
  const dateLabel = Number.isNaN(date.getTime()) ? '24 de dezembro' : date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
  const budget = Number(group.budget || 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  return {
    subject: `Ana convidou você para ${group.name}.`,
    body: `<div class="email-illustration">${giftDrawing()}</div>
      <p class="email-eyebrow">TEM LUGAR PRA VOCÊ NESSA RODA</p>
      <h1>Ana convidou você<br>para uma boa surpresa.</h1>
      <p class="email-copy">Oi, ${safe(user.firstName)}! Vai ter encontro, abraço e aquele friozinho bom na hora de descobrir quem tirou quem. Só está faltando você.</p>
      <div class="email-group-card">
        <div class="email-group-heading"><span class="email-group-icon">${icon('gift')}</span><div><span>Você foi convidado para</span><h2>${safe(group.name)}</h2></div></div>
        <div class="email-group-details"><span>${icon('calendar')} ${safe(dateLabel)}</span><span>${icon('gift')} Até ${safe(budget)}</span></div>
        <p class="email-group-location">${safe(group.location)}</p>
      </div>
      ${emailButton('Quero participar', 'invitation')}
      <p class="email-supporting">Aceite o convite para entrar no sorteio.<br>Depois, é só deixar a surpresa acontecer.</p>
      ${fallback('invitation', 'ver seu convite')}
      <div class="email-signoff"><span class="email-signoff-avatar">${avatar('Ana Oliveira', 0)}</span><p>“Vai ser mais especial com você.”<br><strong>Ana, organizadora do grupo</strong></p></div>`,
  };
}

function resultEmail(user, group, match) {
  return {
    subject: `O sorteio de ${group.name} aconteceu. Seu segredo está aqui.`,
    body: `<div class="email-illustration email-illustration-result">${giftDrawing('result')}</div>
      <p class="email-eyebrow">O SORTEIO ACONTECEU ✨</p>
      <h1>Seu amigo secreto<br>está esperando por você.</h1>
      <p class="email-copy">Oi, ${safe(user.firstName)}! A sorte fez a parte dela. Agora é com você: escolher um presente com carinho e guardar bem este segredo.</p>
      <div class="email-match-card">
        <span class="email-match-label">NO GRUPO ${safe(group.name).toUpperCase()}, VOCÊ TIROU</span>
        <span class="email-match-avatar">${avatar(match.name, 0, 'lg')}</span>
        <h2>${safe(match.name)}</h2>
        <p>Uma pessoa querida. Uma surpresa só sua.</p>
        <span class="email-secret-pill">${icon('lock')} Só você pode ver seu resultado</span>
      </div>
      ${emailButton('Ver meu amigo secreto', 'reveal')}
      ${fallback('reveal', 'ver seu resultado')}
      <div class="email-note email-secret-note">${icon('lock')}<p><strong>Segredo bom a gente guarda.</strong> Não encaminhe este email nem compartilhe seu resultado com a turma. A graça está na surpresa!</p></div>`,
  };
}

export function renderEmails(route, state = {}) {
  if (!EMAIL_ROUTES.includes(route)) return null;
  const user = { firstName: 'Fábio', lastName: 'Almeida', email: 'fabio@exemplo.com', ...state.user };
  const group = { name: 'Natal em família', date: '2026-12-24', budget: 100, location: 'Casa da vó Lúcia', ...state.group };
  const match = { name: 'Ana Oliveira', email: 'ana@exemplo.com', ...state.match };
  const email = route === 'email-verify' ? verifyEmail(user) : route === 'email-invite' ? inviteEmail(user, group) : resultEmail(user, group, match);
  const tabs = [['email-verify', 'Confirmação de conta'], ['email-invite', 'Convite para o grupo'], ['email-result', 'Resultado do sorteio']];

  return `<div class="email-page">
    <header class="email-preview-header"><a href="#dashboard" data-route="dashboard" class="email-home" aria-label="Voltar ao Amigo Secreto">${brand()}</a><a href="#dashboard" data-route="dashboard" class="email-back">${icon('arrow-left')} Voltar ao app</a></header>
    <main id="main" class="email-preview-main">
      <div class="email-preview-intro"><div><p class="email-eyebrow">CADA DETALHE CONTA</p><h2>Boas notícias na sua caixa de entrada.</h2></div><span class="email-preview-badge">${icon('mail')} Prévia dos emails</span></div>
      <nav class="email-tabs" aria-label="Modelos de email">${tabs.map(([value, label], index) => `<a href="#${value}" data-route="${value}" class="email-tab ${route === value ? 'email-tab-active' : ''}" ${route === value ? 'aria-current="page"' : ''}><span>0${index + 1}</span>${label}</a>`).join('')}</nav>
      <section class="email-envelope" aria-label="Prévia do email: ${safe(email.subject)}">
        <div class="email-envelope-meta"><div class="email-sender-icon">${icon('gift')}</div><div class="email-sender"><p><strong>Amigo Secreto</strong><span> &lt;oi@amigosecreto.sanida.me&gt;</span></p><p>Para: ${safe(user.email)}</p></div><span class="email-envelope-time">Agora</span></div>
        <div class="email-subject"><span>Assunto</span><strong>${safe(email.subject)}</strong></div>
        <div class="email-canvas"><article class="email-message"><div class="email-message-brand">${brand()}</div><div class="email-message-body">${email.body}</div><footer class="email-message-footer"><p class="email-tagline">Gente querida. Boas surpresas.</p><p>Feito para aproximar, com carinho.</p><span>Amigo Secreto · 2026</span></footer></article><p class="email-canvas-caption">Uma prévia com dados de demonstração. Nenhum email foi enviado.</p></div>
      </section>
    </main>
  </div>`;
}
