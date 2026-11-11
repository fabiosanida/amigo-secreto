import { icon, brand, avatar } from './ui.js';

export const AUTH_ROUTES = [
  'welcome', 'register', 'login', 'verify', 'verify-error', 'verify-expired',
  'account-ready', 'invitation', 'invitation-new', 'invitation-accepted',
  'invitation-expired', 'invitation-closed',
];

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const button = (text, route, style = 'primary', extraClass = '') => `<button type="button" class="btn btn-${style}${extraClass ? ` ${extraClass}` : ''}" data-route="${route}">${text}</button>`;
const help = `<button type="button" class="btn btn-secondary auth-help-button" data-action="help">${icon('info', 17)} Precisa de uma mão?</button>`;

function header(right = '') {
  return `<header class="auth-header"><button class="auth-brand-link" type="button" data-route="welcome" aria-label="Amigo secreto — início">${brand()}</button><div class="auth-header-right">${right}</div></header>`;
}

function footer() {
  return `<footer class="auth-footer">${help}</footer>`;
}

function giftArt() {
  return `<svg class="auth-gift-art" viewBox="0 0 600 560" fill="none" aria-hidden="true">
    <defs><linearGradient id="giftCoral" x1="178" y1="252" x2="418" y2="446" gradientUnits="userSpaceOnUse"><stop stop-color="#F9A088"/><stop offset="1" stop-color="#E97C61"/></linearGradient><linearGradient id="giftGreen" x1="350" y1="174" x2="515" y2="350" gradientUnits="userSpaceOnUse"><stop stop-color="#CED8BB"/><stop offset="1" stop-color="#A7B792"/></linearGradient><filter id="giftShadow" x="0" y="0" width="150%" height="150%"><feDropShadow dx="0" dy="18" stdDeviation="13" flood-color="#142E26" flood-opacity=".18"/></filter></defs>
    <ellipse cx="321" cy="467" rx="205" ry="31" fill="#173B30" opacity=".55"/>
    <path d="M85 450V219C85 100 182 3 301 3C420 3 517 100 517 219V450" stroke="#89A28D" stroke-opacity=".18" stroke-width="1.5"/>
    <path d="M115 450V224C115 121 198 38 301 38C404 38 487 121 487 224V450" stroke="#89A28D" stroke-opacity=".18" stroke-width="1.5"/>
    <path d="M145 450V228C145 141 215 71 302 71C389 71 459 141 459 228V450" stroke="#89A28D" stroke-opacity=".18" stroke-width="1.5"/>
    <g transform="rotate(8 423 281)" filter="url(#giftShadow)">
      <path d="M351 216L456 182L518 222L413 256L351 216Z" fill="#DAE2CB"/>
      <path d="M351 216L413 256V374L351 332V216Z" fill="#95A982"/>
      <path d="M413 256L518 222V339L413 374V256Z" fill="url(#giftGreen)"/>
      <path d="M387 204L448 244V362L468 355V237L407 198L387 204Z" fill="#F7F1DD"/>
      <path d="M354 273L413 310L518 276V294L413 328L354 291V273Z" fill="#F7F1DD"/>
      <path d="M447 231C418 216 399 172 419 167C440 162 449 210 447 231Z" stroke="#F7F1DD" stroke-width="10" stroke-linecap="round"/>
      <path d="M448 230C455 197 479 166 490 180C503 196 475 220 448 230Z" stroke="#F7F1DD" stroke-width="10" stroke-linecap="round"/>
    </g>
    <g transform="rotate(-8 271 357)" filter="url(#giftShadow)">
      <path d="M148 290L291 244L417 313L274 361L148 290Z" fill="#FFC1A9"/>
      <path d="M148 290L274 361V480L148 408V290Z" fill="#D87159"/>
      <path d="M274 361L417 313V432L274 480V361Z" fill="url(#giftCoral)"/>
      <path d="M142 286L291 237L423 309V332L274 382L142 309V286Z" fill="#F5A188"/>
      <path d="M142 286L274 360L423 309L291 237L142 286Z" fill="#FFC1A9"/>
      <path d="M218 261L350 334V454L376 445V325L245 252L218 261Z" fill="#F6EDDA"/>
      <path d="M223 451V331L364 281L338 267L198 317V437L223 451Z" fill="#FFF5E1"/>
      <path d="M291 307C243 302 213 252 233 236C255 220 283 268 291 307Z" stroke="#FFF5E1" stroke-width="16" stroke-linecap="round"/>
      <path d="M292 307C289 263 304 218 327 227C353 238 325 286 292 307Z" stroke="#FFF5E1" stroke-width="16" stroke-linecap="round"/>
      <path d="M289 303C306 316 313 337 309 353" stroke="#FFF5E1" stroke-width="15" stroke-linecap="round"/>
    </g>
    <g transform="rotate(-10 147 399)"><path d="M80 369L139 352L190 379L131 398L80 369Z" fill="#F8F0D8"/><path d="M80 369L131 398V460L80 432V369Z" fill="#D8CAA6"/><path d="M131 398L190 379V441L131 460V398Z" fill="#EDE1C3"/><path d="M111 360L162 388V450L172 447V385L121 357L111 360Z" fill="#6D8970"/><path d="M102 445V383L161 363L151 358L92 378V439L102 445Z" fill="#89A088"/><path d="M137 378C115 371 111 350 122 348C134 347 137 365 137 378Z" stroke="#89A088" stroke-width="6"/><path d="M137 378C136 359 151 340 157 350C164 362 150 372 137 378Z" stroke="#89A088" stroke-width="6"/></g>
    <path d="M184 139L188 151L200 155L188 159L184 171L180 159L168 155L180 151L184 139Z" fill="#D7DAB6"/>
    <path d="M476 401L479 409L488 412L479 415L476 424L473 415L464 412L473 409L476 401Z" fill="#F0A187"/>
    <path d="M376 107L378 113L384 115L378 117L376 123L374 117L368 115L374 113L376 107Z" fill="#F1C2A0"/>
    <circle cx="119" cy="252" r="4" fill="#F0A187"/><circle cx="455" cy="146" r="3" fill="#D7DAB6"/>
    <path d="M514 389C528 372 529 356 524 346" stroke="#B3C1A8" stroke-width="2" stroke-linecap="round"/>
    <path d="M96 324C86 311 82 297 84 287" stroke="#B3C1A8" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function welcome(state) {
  return `<div class="auth-page auth-welcome">${header(`<span class="auth-header-note">Já faz parte da brincadeira?</span>${button(`Entrar ${icon('arrow-right', 16)}`, 'login', 'ghost')}`)}
    <main id="main" class="auth-welcome-main">
      <section class="auth-welcome-copy">
        <p class="eyebrow"><span class="auth-small-star">✳</span> PEQUENOS GESTOS. BOAS HISTÓRIAS.</p>
        <h1>A melhor parte é<br>surpreender <em>alguém.</em></h1>
        <p class="auth-lede">Reúna quem você gosta, deixe o sorteio com a gente e cuide do que importa: o carinho por trás de cada presente.</p>
        <div class="auth-welcome-actions">${button(`Começar a brincadeira ${icon('arrow-right', 19)}`, 'register')}<span>Grátis. Simples. Cheio de afeto.</span></div>
        <div class="auth-social-proof"><div class="auth-avatar-stack">${avatar('Marina', 0)}${avatar('Pedro', 1)}${avatar('Ana', 2)}${avatar('Lucas', 3)}</div><p>Para a família, os amigos<br>e aquela turma de sempre.</p></div>
      </section>
      <section class="auth-welcome-visual" aria-label="Ilustração de presentes e amigos celebrando juntos">
        <div class="auth-visual-grain"></div><span class="auth-visual-label">TEM CARINHO CHEGANDO.</span>
        ${giftArt()}
        <div class="auth-floating-note auth-floating-note-top"><span class="auth-note-icon">${icon('shield', 18)}</span><div><strong>O segredo está seguro.</strong><span>Só você vê quem tirou.</span></div></div>
        <div class="auth-floating-note auth-floating-note-bottom"><div class="auth-note-avatar">${avatar('Ana', 2)}</div><div><strong>${state.production ? 'Sua turma, mais perto' : 'Ana entrou na brincadeira'}</strong><span>Mais um motivo para celebrar ${icon('heart', 11)}</span></div></div>
        <div class="auth-visual-bottom"><span>01 — REÚNA SUA TURMA</span><div><i class="is-active"></i><i></i><i></i></div></div>
      </section>
    </main>
    ${footer()}
  </div>`;
}

function editorial(kind = 'register') {
  const login = kind === 'login';
  return `<aside class="auth-editorial"><div class="auth-editorial-top"><span class="eyebrow">UM BOM ENCONTRO COMEÇA AQUI</span><span class="auth-editorial-star">✳</span></div><div class="auth-editorial-content"><div class="auth-mini-gift">${icon('gift', 38)}</div><h2>${login ? 'Que bom ter<br>você <em>por aqui.</em>' : 'O presente é só<br>uma parte<br><em>da história.</em>'}</h2><p>${login ? 'Sua turma, as boas ideias e aquele segredo bem guardado estão esperando por você.' : 'A outra é juntar as pessoas, criar boas memórias e descobrir a alegria de fazer alguém sorrir.'}</p></div><div class="auth-editorial-bottom"><div class="auth-avatar-stack">${avatar('Marina', 0)}${avatar('Pedro', 1)}${avatar('Ana', 2)}</div><span>Feito para celebrar<br>as suas pessoas.</span></div><svg class="auth-editorial-drawing" viewBox="0 0 300 140" aria-hidden="true"><path d="M10 130C58 20 184 10 251 86C285 125 247 151 221 106C180 36 267 13 297 57" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></aside>`;
}

function authShell(body, kind = 'register', right = '') {
  return `<div class="auth-page">${header(right)}<main id="main" class="auth-form-layout">${editorial(kind)}<section class="auth-form-area">${body}</section></main>${footer()}</div>`;
}

function register(state) {
  const invited = state.inviteContext;
  return authShell(`<div class="auth-form-card"><div class="auth-step-indicator"><span class="is-current"></span><span></span><p>SEU PRIMEIRO PASSO</p></div><h1>Vamos nos conhecer?</h1><p class="auth-form-intro">${invited ? 'Crie sua conta para entrar na brincadeira. Seu convite já está guardado.' : 'Crie sua conta e dê início a um novo encontro.'}</p>${invited ? `<div class="auth-context-note">${icon('gift', 18)}<span>Você vai participar de <strong>${escapeHtml(state.group.name)}</strong></span></div>` : ''}
    <form data-form="register" class="auth-form"><div class="signup-photo"><div class="signup-photo-preview"><img data-signup-avatar alt="Sua foto de perfil" hidden><span data-signup-avatar-placeholder>${icon('users', 27)}</span></div><div class="signup-photo-details"><strong>Sua foto <small>· opcional</small></strong><div class="signup-photo-actions"><button type="button" class="btn btn-secondary" data-action="choose-signup-photo">Adicionar foto</button><button type="button" class="profile-text-button" data-action="replace-signup-photo" hidden>Trocar</button><button type="button" class="profile-text-button" data-action="remove-signup-photo" hidden>Remover</button></div><p>JPG, PNG ou WebP. Até 5 MB.</p></div><input id="signup-photo-input" class="profile-file-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Escolher uma foto de perfil"></div><p class="signup-photo-error" data-signup-photo-error role="alert" hidden></p><div class="auth-field-row"><label class="field" for="register-first-name">Nome<input id="register-first-name" name="firstName" placeholder="Seu nome" autocomplete="given-name" required maxlength="60"></label><label class="field" for="register-last-name">Sobrenome<input id="register-last-name" name="lastName" placeholder="Seu sobrenome" autocomplete="family-name" required maxlength="80"></label></div><label class="field" for="register-email">E-mail<input id="register-email" name="email" type="email" placeholder="voce@exemplo.com" autocomplete="email" required></label><div class="auth-field-hint">${icon('lock', 14)}<span>Sem senha para lembrar. Você entra com um código por e-mail.</span></div><button class="btn btn-primary auth-submit" type="submit">Criar minha conta ${icon('arrow-right', 18)}</button><p class="auth-terms">Vamos enviar um código para confirmar que esse e-mail é seu.</p></form><div class="auth-form-divider"></div><p class="auth-switch">Já tem uma conta? <button type="button" class="auth-text-link" data-route="login">É só entrar ${icon('arrow-right', 14)}</button></p></div>`, 'register', `<span class="auth-header-note">Já tem uma conta?</span>${button('Entrar', 'login', 'ghost')}`);
}

function login(state) {
  return authShell(`<div class="auth-form-card"><span class="auth-form-symbol">${icon('mail', 24)}</span><p class="eyebrow">BOM TE VER DE NOVO</p><h1>Seu lugar está aqui.</h1><p class="auth-form-intro">Digite seu e-mail e a gente envia um código para você entrar. Simples assim.</p>${state.inviteContext ? `<div class="auth-context-note">${icon('gift', 18)}<span>O convite para <strong>${escapeHtml(state.group.name)}</strong> está esperando.</span></div>` : ''}<form class="auth-form" data-form="login"><label class="field" for="login-email">E-mail<input id="login-email" name="email" type="email" placeholder="voce@exemplo.com" autocomplete="email" required></label><button class="btn btn-primary auth-submit" type="submit">Receber meu código ${icon('arrow-right', 18)}</button><div class="auth-field-hint auth-login-hint">${icon('shield', 16)}<span>Seu acesso é seguro e não precisa de senha.</span></div></form><div class="auth-form-divider"></div><p class="auth-switch">É sua primeira vez? <button type="button" class="auth-text-link" data-route="register">Crie sua conta ${icon('arrow-right', 14)}</button></p></div>`, 'login', `<span class="auth-header-note">Ainda não tem conta?</span>${button('Começar agora', 'register', 'ghost')}`);
}

function verify(route, state) {
  const error = route === 'verify-error';
  const expired = route === 'verify-expired';
  const countdown = `<span class="auth-countdown${state.production ? ' auth-countdown-live' : ''}" data-countdown role="status" aria-live="polite"></span>`;
  return authShell(`<div class="auth-form-card"><button type="button" class="auth-back-link" data-route="${state.authMode === 'register' ? 'register' : 'login'}">${icon('arrow-left', 16)} Alterar e-mail</button><span class="auth-form-symbol ${expired ? 'auth-form-symbol-warm' : ''}">${icon(expired ? 'clock' : 'mail', 25)}</span><div class="auth-step-indicator"><span class="is-done"></span><span class="is-current"></span><p>SÓ MAIS UM DETALHE</p></div><h1>${expired ? 'Vamos tentar de novo?' : 'Olha a sua caixa de entrada.'}</h1><p class="auth-form-intro">${expired ? 'Seu código expirou. Acontece! Peça um novo para continuar de onde parou.' : `${state.production && state.authMode === 'login' ? 'Se este e-mail estiver cadastrado, você receberá um código de 6 dígitos em' : 'Enviamos um código de 6 dígitos para'}<br><strong class="auth-email">${escapeHtml(state.user.email)}</strong>`}</p>
    ${expired ? `<div class="auth-alert auth-alert-warm" role="status">${icon('clock', 18)}<div><strong>O tempo desse código acabou.</strong><p>Você pode receber outro no mesmo e-mail.</p></div></div><button class="btn btn-primary auth-submit" type="button" data-action="resend-code">Enviar um novo código ${icon('refresh', 17)}</button>` : `<form class="auth-form" data-form="verify"><label class="field auth-code-field" for="verification-code">Código de verificação<input id="verification-code" class="auth-code-input ${error ? 'has-error' : ''}" name="code" placeholder="000000" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="one-time-code" required ${error ? 'aria-invalid="true" aria-describedby="code-error"' : 'aria-describedby="code-hint"'}></label>${error ? `<div class="auth-code-error" id="code-error" role="alert">${icon('info', 16)} Esse código não confere. Revise os 6 dígitos e tente outra vez.</div>` : `<p class="auth-code-hint" id="code-hint">O código é válido por 10 minutos.</p>`}<button class="btn btn-primary auth-submit" type="submit">Confirmar e continuar ${icon('arrow-right', 18)}</button></form>`}
    <div class="auth-resend"><p>Não encontrou o e-mail? Dê uma olhada no spam.</p>${!expired ? `<button class="auth-text-link" type="button" data-action="resend-code">Reenviar código ${icon('refresh', 14)}</button>` : `<span>O novo código será enviado para <strong>${escapeHtml(state.user.email)}</strong>.</span>`}${countdown}</div></div>`, 'login');
}

function centeredShell(body, extra = '') {
  return `<div class="auth-page auth-centered-page">${header(extra)}<main id="main" class="auth-centered-main">${body}</main>${footer()}</div>`;
}

function accountReady(state) {
  return centeredShell(`<section class="auth-success-card"><div class="auth-success-burst"><span></span><span></span><span></span><div class="auth-success-icon">${icon('check', 32)}</div><span></span><span></span></div><p class="eyebrow">TUDO PRONTO POR AQUI</p><h1>Agora só falta<br><em>a sua turma.</em></h1><p>Que bom ter você com a gente, ${escapeHtml(state.user.firstName)}.<br>Sua conta está pronta para criar boas histórias.</p><div class="auth-success-profile">${avatar([state.user.firstName, state.user.lastName].filter(Boolean).join(' '), 0, '', state.user.avatar ?? null)}<div><strong>${escapeHtml(state.user.firstName)} ${escapeHtml(state.user.lastName)}</strong><span>${escapeHtml(state.user.email)}</span></div><span class="auth-profile-check">${icon('check', 15)}</span></div>${state.inviteContext ? `<button type="button" class="btn btn-primary auth-submit" data-action="accept-invite">Entrar em ${escapeHtml(state.group.name)} ${icon('arrow-right', 18)}</button>` : button(`Vamos começar ${icon('arrow-right', 18)}`, 'dashboard', 'primary', 'auth-submit')}<small>O próximo encontro começa com você.</small></section>`);
}

function formattedDate(value) {
  if (!value) return 'A combinar';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? 'A combinar' : new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long' }).format(date);
}

function inviteDetails(group) {
  return `<div class="invitation-details"><div><span class="invitation-detail-icon">${icon('calendar', 18)}</span><span>O encontro<strong>${formattedDate(group.date)}</strong></span></div><div><span class="invitation-detail-icon">${icon('gift', 18)}</span><span>Valor do presente<strong>${new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL', maximumFractionDigits:0}).format(group.budget ?? 0)}</strong></span></div><div class="invitation-location"><span class="invitation-detail-icon">${icon('heart', 18)}</span><span>Nosso lugar<strong>${escapeHtml(group.location || 'A combinar')}</strong></span></div></div>`;
}

function invitation(route, state) {
  const isNew = route === 'invitation-new';
  const accepted = route === 'invitation-accepted';
  const expired = route === 'invitation-expired';
  const closed = route === 'invitation-closed';
  const unavailable = expired || closed;
  const organizer = state.inviterName || state.group.organizerName || (state.production ? 'Quem organizou o grupo' : 'Ana');
  const organizerHtml = escapeHtml(organizer);
  const organizerPhoto = state.invitation?.inviterAvatar ?? state.group.organizerAvatar ?? state.participants?.find(person => person.isOrganizer)?.avatar ?? null;
  const participants = (Array.isArray(state.participants) ? state.participants : []).filter(person => !person.status || ['accepted', 'confirmed'].includes(person.status));
  const countValue = state.group.acceptedCount ?? state.group.participantCount ?? participants.length;
  const participantCount = Math.max(0, Number(countValue) || 0);
  const people = participants.slice(0, 3).map((person, index) => avatar(person.name || [person.firstName, person.lastName].filter(Boolean).join(' ') || 'Participante', index, '', person.avatar ?? null)).join('');
  const peopleExtra = participantCount > 3 ? `<span class="invitation-more-people">+${participantCount - 3}</span>` : '';
  const peopleLabel = accepted || !participantCount ? 'Sua turma está esperando por você.' : participantCount === 1 ? '1 pessoa já está nessa.' : `${participantCount} pessoas já estão nessa.`;
  const errorText = typeof state.invitationError === 'string' ? state.invitationError : state.invitationError?.message;
  const invitationNotice = errorText ? `<div class="auth-alert auth-alert-warm" role="alert">${icon('info', 18)}<p>${escapeHtml(errorText)}</p></div>` : '';
  const emailNotice = state.invitation?.emailMasked && !accepted && !unavailable ? `<p class="invitation-email-notice">${icon('mail', 15)} Este convite foi enviado para <strong>${escapeHtml(state.invitation.emailMasked)}</strong>.</p>` : '';
  const currentAccount = !isNew && !accepted && !unavailable
    ? `<div class="invitation-current-account">${avatar([state.user.firstName, state.user.lastName].filter(Boolean).join(' '), 0, '', state.user.avatar ?? null)}<p>Você está entrando como <strong>${escapeHtml(state.user.firstName)} ${escapeHtml(state.user.lastName)}</strong><span>${escapeHtml(state.user.email)}</span></p></div>`
    : '';
  const cover = `<div class="invitation-cover"><div class="invitation-cover-pattern"></div><div class="invitation-cover-icon">${icon(accepted ? 'check' : unavailable ? 'clock' : 'gift', 31)}</div><span class="eyebrow">${accepted ? 'VOCÊ FAZ PARTE DESSA HISTÓRIA' : unavailable ? 'CADA ENCONTRO TEM SEU TEMPO' : 'UM CONVITE CHEIO DE CARINHO'}</span><h1>${accepted ? 'A turma está<br>mais completa.' : expired ? 'Esse convite<br>já expirou.' : closed ? 'A lista de convidados<br>já está fechada.' : 'Tem um lugar<br>guardado para você.'}</h1><span class="invitation-cover-star invitation-cover-star-one">✳</span><span class="invitation-cover-star invitation-cover-star-two">✧</span></div>`;
  const heading = `<div class="invitation-group-heading"><div><p class="eyebrow">AMIGO SECRETO</p><h2>${escapeHtml(state.group.name)}</h2></div><span class="invitation-group-badge">${icon('gift', 22)}</span></div>`;
  let content;
  if (unavailable) {
    content = `${heading}<p class="invitation-description">${expired ? `Este link não está mais disponível. Peça um novo convite a ${organizerHtml} para entrar na brincadeira.` : `O grupo já encerrou a entrada de participantes. Fale com ${organizerHtml} para saber mais sobre o encontro.`}</p>${invitationNotice}<div class="auth-alert auth-alert-warm">${icon('info', 18)}<p>${expired ? 'Um novo convite pode resolver. Fale com quem organizou o grupo.' : 'O segredo já começou a circular por aqui.'}</p></div>${button(`Ir para meus grupos ${icon('arrow-right', 17)}`, 'dashboard')}<button type="button" class="auth-text-link invitation-help" data-action="help">Preciso de ajuda</button>`;
  } else {
    const from = !accepted ? `<div class="invitation-from">${avatar(organizer, 2, '', organizerPhoto)}<p><strong>${organizerHtml}</strong> te convidou para participar de</p></div>` : '';
    const description = accepted ? `Tudo certo, ${escapeHtml(state.user.firstName)}! Agora é só entrar no grupo e acompanhar os próximos passos.` : escapeHtml(state.group.description || 'Um encontro para celebrar sua turma e compartilhar bons momentos.');
    const action = accepted ? button(`Ver meu grupo ${icon('arrow-right', 18)}`, 'group') : `<button type="button" class="btn btn-primary auth-submit" data-action="${isNew ? 'register-invited' : 'accept-invite'}">${isNew ? 'Criar conta e participar' : 'Aceitar convite'} ${icon('arrow-right', 18)}</button>`;
    const next = isNew ? `<p class="auth-switch invitation-signin">Já tem uma conta? <button type="button" data-action="login-invited" class="auth-text-link">Entrar para participar</button></p>` : `<p class="invitation-privacy">${icon(accepted ? 'check' : 'lock', 14)} ${accepted ? 'Sua participação está confirmada.' : 'O sorteio continua sendo um segredo. Até para quem organiza.'}</p>`;
    content = `${from}${heading}<p class="invitation-description">${description}</p>${inviteDetails(state.group)}<div class="invitation-people">${people ? `<div class="auth-avatar-stack">${people}${peopleExtra}</div>` : ''}<span>${peopleLabel}</span></div>${emailNotice}${currentAccount}${invitationNotice}${action}${next}`;
  }
  return centeredShell(`<section class="invitation-card ${unavailable ? 'invitation-card-unavailable' : ''}">${cover}<div class="invitation-body">${content}</div></section>`, isNew ? '<button type="button" class="btn btn-ghost" data-action="login-invited">Entrar</button>' : '');
}

export function renderAuth(route, state = {}) {
  if (!AUTH_ROUTES.includes(route)) return null;
  const context = { ...state, user: { firstName: state.production ? '' : 'Fábio', lastName: state.production ? '' : 'Almeida', email: state.production ? '' : 'fabio@exemplo.com', ...state.user }, group: { name: state.production ? '' : 'Natal da família', date: state.production ? '' : '2026-12-24', budget: state.production ? null : 100, location: state.production ? '' : 'Casa da vó Lúcia', description: state.production ? '' : 'Uma noite para celebrar quem faz parte da nossa história.', ...state.group } };
  if (route === 'welcome') return welcome(context);
  if (route === 'register') return register(context);
  if (route === 'login') return login(context);
  if (route.startsWith('verify')) return verify(route, context);
  if (route === 'account-ready') return accountReady(context);
  return invitation(route, context);
}
