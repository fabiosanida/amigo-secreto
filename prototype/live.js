import { icon, brand, avatar, escapeHtml, setAvatarDirectory } from './ui.js';
import { renderAuth, AUTH_ROUTES } from './auth.js';
import { renderGroups, GROUP_ROUTES } from './groups.js';
import { openProfileEditor, setupPhotoInputs, getSignupAvatar, resetSignupAvatar } from './profile.js';

const INVITE_KEY = 'amigo-secreto:invitation';
const CHALLENGE_KEY = 'amigo-secreto:challenge';
const storage = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { value == null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch {} },
};
function readChallenge() {
  try { const value = JSON.parse(storage.get(CHALLENGE_KEY)); return value?.challengeId && value?.email ? value : null; } catch { return null; }
}
const storedChallenge = readChallenge();
const state = {
  production: true, user: null, groups: [], group: null, participants: [],
  role: 'member', organizerEmail: '', drawn: false, revealed: false, match: null,
  invitation: null, inviteToken: storage.get(INVITE_KEY) || '',
  inviteContext: Boolean(storage.get(INVITE_KEY)), inviteEmails: [], inviteQueued: [],
  invitationError: '', invitationErrorCode: '', returnTo: '', challenge: storedChallenge, pendingUser: null,
  authMode: 'login', resendAt: Number(storedChallenge?.resendAt) || 0, requestPayload: null,
};
const groupRoutes = new Set(['group', 'group-member', 'invite', 'invites-sent', 'draw-confirm', 'draw-running', 'drawn', 'reveal']);
const organizerRoutes = new Set(['invite', 'invites-sent', 'draw-confirm', 'draw-running', 'drawn']);
const allowed = new Set([...AUTH_ROUTES, ...GROUP_ROUTES, 'verify-link']);
const signedRoutes = new Set([...GROUP_ROUTES, 'account-ready', 'invitation-accepted']);
let route = 'welcome', params = new URLSearchParams(), version = 0, toastTimer;
let busyDraw = false, sessionLoaded = false;
const pendingActions = new Set();
const titles = { welcome: 'Gente querida. Boas surpresas.', register: 'Criar conta', login: 'Entrar', verify: 'Confirmar e-mail', 'verify-error': 'Conferir código', 'verify-expired': 'Novo código', 'account-ready': 'Conta confirmada', dashboard: 'Meus grupos', 'dashboard-empty': 'Meus grupos', 'create-group': 'Criar grupo', group: 'Meu grupo', 'group-member': 'Meu grupo', invite: 'Convidar pessoas', 'invites-sent': 'Convites enviados', 'draw-confirm': 'Confirmar sorteio', 'draw-running': 'Realizando sorteio', drawn: 'Sorteio concluído', reveal: 'Meu amigo secreto', invitation: 'Seu convite', 'invitation-new': 'Seu convite', 'invitation-accepted': 'Participação confirmada', 'invitation-closed': 'Convite encerrado', 'invitation-expired': 'Convite indisponível' };

class ApiError extends Error {
  constructor(code, message, status, payload) { super(message); this.code = code; this.status = status; this.payload = payload; }
}
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined });
  } catch { throw new ApiError('NETWORK_ERROR', 'Não foi possível conectar. Confira sua conexão e tente novamente.', 0); }
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const detail = data.error;
    const error = new ApiError(detail?.code || data.code || (typeof detail === 'string' ? detail : 'REQUEST_FAILED'), detail?.message || data.message || 'Não foi possível concluir agora. Tente novamente.', response.status, data);
    error.retryAfter = Number(response.headers.get('Retry-After')) || 0;
    throw error;
  }
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });
const segment = value => encodeURIComponent(String(value || ''));
function errorMessage(error) {
  const messages = { INVALID_CODE: 'Esse código não confere. Confira os 6 dígitos e tente novamente.', EXPIRED_CODE: 'Seu código expirou. Peça um novo para continuar.', EMAIL_MISMATCH: 'Este convite foi enviado para outro e-mail. Entre com o endereço que recebeu o convite.', INVITATION_EXPIRED: 'Este convite expirou. Peça um novo à pessoa que organiza o grupo.', INVITATION_CLOSED: 'Este grupo já realizou o sorteio e encerrou os convites.', CLOSED: 'Este grupo já realizou o sorteio e encerrou os convites.', UNAUTHORIZED: 'Sua sessão terminou. Entre novamente para continuar.', FORBIDDEN: 'Sua conta não tem acesso a esta ação.', RATE_LIMITED: 'Aguarde um pouco antes de tentar novamente.', TOO_MANY_REQUESTS: 'Aguarde um pouco antes de tentar novamente.', ACCOUNT_NOT_FOUND: 'Não encontramos uma conta com esse e-mail. Crie sua conta para continuar.', NOT_FOUND: 'Não encontramos esta página. Confira o link recebido.' };
  return messages[error?.code] || error?.message || 'Não foi possível concluir agora. Tente novamente.';
}
function currentUser() {
  return state.user || state.pendingUser || { firstName: '', lastName: '', email: state.challenge?.email || '', avatar: '' };
}
function viewState() {
  return { ...state, user: currentUser(), group: state.group || { name: '', date: '', budget: 0, location: '', description: '' }, inviterName: state.invitation?.inviterName || state.group?.organizerName || '', verified: Boolean(state.user) };
}
function shell(content) {
  const user = currentUser();
  return `<header class="app-header"><a class="app-brand-link" href="#dashboard" data-route="dashboard" aria-label="Amigo Secreto, meus grupos">${brand()}</a><nav class="app-nav" aria-label="Navegação principal"><button class="active" data-route="dashboard">Meus grupos</button><button data-action="help">Como funciona</button></nav><div class="app-account"><span class="account-name">${escapeHtml(user.firstName)}</span><button data-action="profile" aria-label="Minha conta">${avatar(`${user.firstName} ${user.lastName}`, 0, '', user.avatar ?? null)}</button></div></header><main id="main" class="app-main transition-in" tabindex="-1">${content}</main><footer class="app-footer"><span>${icon('heart', 13)} Gente querida. Boas surpresas.</span><button data-action="help">Feito para aproximar.</button></footer>`;
}
function loading() {
  const content = `<section class="auth-success-card" aria-live="polite"><span class="auth-form-symbol">${icon('gift', 27)}</span><h1>Um instante.</h1><p>Estamos preparando tudo para você.</p></section>`;
  document.querySelector('#app').innerHTML = state.user ? shell(content) : `<main id="main" class="auth-centered-main" tabindex="-1">${content}</main>`;
}
function renderError(error) {
  const content = `<section class="auth-success-card"><span class="auth-form-symbol">${icon('info', 27)}</span><h1>Vamos tentar de novo?</h1><p role="alert">${escapeHtml(errorMessage(error))}</p><button class="btn btn-primary" data-action="retry-route">Tentar novamente ${icon('refresh', 17)}</button><button class="btn btn-ghost" data-route="${state.user ? 'dashboard' : 'welcome'}">Voltar ao início</button></section>`;
  document.querySelector('#app').innerHTML = state.user ? shell(content) : `<main id="main" class="auth-centered-main" tabindex="-1">${content}</main>`;
}
function render() {
  const snapshot = viewState();
  setAvatarDirectory([...state.participants, ...state.groups.flatMap(group => group.participants || []), ...(state.match ? [state.match] : []), ...(state.user ? [{ ...state.user, name: `${state.user.firstName} ${state.user.lastName}` }] : [])]);
  const screen = route === 'dashboard' && !state.groups.length ? 'dashboard-empty' : route;
  const content = renderAuth(screen, snapshot) ?? renderGroups(screen, snapshot);
  document.querySelector('#app').innerHTML = GROUP_ROUTES.includes(screen) ? shell(content || '') : (content || '');
  document.body.dataset.screen = screen;
  document.title = `${titles[screen] || 'Amigo Secreto'} · Amigo Secreto`;
  document.querySelector('#review-tools')?.replaceChildren();
  document.querySelectorAll('a[data-route]').forEach(link => {
    const destination = link.dataset.route;
    const query = new URLSearchParams();
    if (groupRoutes.has(destination) && (link.dataset.groupId || state.group?.id)) query.set('id', link.dataset.groupId || state.group.id);
    if (destination.startsWith('invitation') && state.inviteToken) query.set('token', state.inviteToken);
    link.href = href(destination, query);
  });
  setupPhotoInputs(document);
  document.querySelectorAll('#app form[data-form]').forEach(form => form.addEventListener('submit', submit));
  document.querySelectorAll('input[name="code"]').forEach(input => input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); }));
  if (['register', 'login'].includes(route)) {
    const user = currentUser();
    for (const name of ['firstName', 'lastName', 'email']) { const input = document.querySelector(`form [name="${name}"]`); if (input && user[name]) input.value = user[name]; }
  }
  if (state.invitationErrorCode === 'EMAIL_MISMATCH' && state.user && route.startsWith('invitation')) {
    const body = document.querySelector('.invitation-body');
    if (body) body.insertAdjacentHTML('beforeend', '<button class="btn btn-secondary auth-submit" style="margin-top:12px" data-action="switch-account">Entrar com outro e-mail</button>');
  }
  if (state.invitation?.status === 'accepted' && ['invitation', 'invitation-new'].includes(route)) {
    const access = document.querySelector('[data-action="accept-invite"],[data-action="register-invited"]');
    if (access) { access.dataset.action = state.user ? 'accept-invite' : 'login-invited'; access.innerHTML = `${state.user ? 'Ver meu grupo' : 'Entrar para ver meu grupo'} ${icon('arrow-right', 18)}`; }
  }
  updateCountdown();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function setInvitationToken(token) {
  state.inviteToken = token || ''; state.inviteContext = Boolean(token);
  storage.set(INVITE_KEY, token || null);
}
function clearChallenge() {
  state.challenge = null; state.requestPayload = null; storage.set(CHALLENGE_KEY, null);
}
function saveChallenge(result) {
  const now = Date.now();
  state.resendAt = now + Math.max(30, Number(result.resendAfter) || 60) * 1000;
  const expiresAt = result.expiresAt ? new Date(result.expiresAt).getTime() : now + 10 * 60 * 1000;
  state.challenge = { challengeId: result.challengeId, email: result.email, resendAt: state.resendAt, expiresAt };
  storage.set(CHALLENGE_KEY, JSON.stringify(state.challenge));
}
function parseHash(hash = location.hash) {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  return { route: allowed.has(path) ? path : (state.user ? 'dashboard' : 'welcome'), params: new URLSearchParams(query) };
}
function href(next, query) {
  const text = query.toString(); return `#${next}${text ? `?${text}` : ''}`;
}
function rememberGroup(data) {
  const group = data.group || data;
  state.group = group;
  state.participants = data.participants || group.participants || [];
  state.role = data.role || group.role || (group.organizerId === state.user?.id ? 'organizer' : 'member');
  state.organizerEmail = data.organizerEmail || group.organizerEmail || state.participants.find(person => person.isOrganizer)?.email || '';
  state.drawn = Boolean(group.drawn || group.drawnAt);
  state.match = null; state.revealed = false;
}
async function loadGroup(id) {
  return api(`/groups/${segment(id)}`);
}
async function navigate(next, options = {}) {
  const parsed = parseHash(`#${next}`);
  next = parsed.route;
  const query = parsed.params;
  if (options.id) query.set('id', options.id);
  if (options.token) query.set('token', options.token);
  if (groupRoutes.has(next) && !query.get('id') && state.group?.id) query.set('id', state.group.id);
  if (next.startsWith('invitation') && next !== 'invitation-accepted' && !query.get('token') && state.inviteToken) query.set('token', state.inviteToken);
  if (signedRoutes.has(next) && !state.user) { state.returnTo = href(next, query).slice(1); next = 'login'; }
  if (groupRoutes.has(next) && !query.get('id')) next = 'dashboard';
  if (['verify', 'verify-error', 'verify-expired'].includes(next) && !state.challenge) next = state.user ? 'dashboard' : 'login';
  if (['verify', 'verify-error'].includes(next) && state.challenge?.expiresAt && Date.now() >= state.challenge.expiresAt) next = 'verify-expired';
  if (next === 'welcome' && state.user) next = 'dashboard';
  route = next; params = query;
  const navigation = ++version;
  state.invitationError = ''; state.invitationErrorCode = '';
  const destination = href(route, params);
  if (location.hash !== destination) history[options.replace ? 'replaceState' : 'pushState'](null, '', destination);
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  if (options.skipLoad) { render(); return; }
  loading();
  try {
    if (route === 'verify-link') {
      const token = params.get('token');
      if (params.get('invitation')) setInvitationToken(params.get('invitation'));
      if (!token) throw new ApiError('EXPIRED_CODE', 'Este link de confirmação não está disponível. Peça um novo código.');
      const result = await post('/auth/verify', { token });
      if (navigation !== version) return;
      await completeLogin(result.user, true); return;
    }
    if (route === 'dashboard' || route === 'dashboard-empty') {
      const result = await api('/groups');
      if (navigation !== version) return;
      state.groups = result.groups || [];
      state.group = null; state.participants = []; state.match = null; state.revealed = false;
    } else if (groupRoutes.has(route) || (route === 'invitation-accepted' && params.get('id'))) {
      const data = await loadGroup(params.get('id'));
      if (navigation !== version) return;
      rememberGroup(data);
      if (organizerRoutes.has(route) && state.role !== 'organizer') { await navigate('group', { id: state.group.id, replace: true }); return; }
      if (['invite', 'draw-confirm', 'draw-running'].includes(route) && state.drawn) { await navigate('group', { id: state.group.id, replace: true }); return; }
      if (['drawn', 'reveal'].includes(route) && !state.drawn) { await navigate('group', { id: state.group.id, replace: true }); return; }
      if (route === 'draw-running' && !busyDraw) { await navigate('draw-confirm', { id: state.group.id, replace: true }); return; }
    } else if (route.startsWith('invitation') && route !== 'invitation-accepted') {
      const token = params.get('token');
      if (!token) throw new ApiError('INVITATION_EXPIRED', 'Abra o link de convite que você recebeu por e-mail.');
      setInvitationToken(token);
      const invitation = await api(`/invitations/${segment(token)}`);
      if (navigation !== version) return;
      state.invitation = invitation; state.group = invitation.group; state.participants = invitation.participants || [];
      state.drawn = Boolean(invitation.group?.drawn);
      state.role = 'member'; state.organizerEmail = '';
      const status = String(invitation.status || '').toLowerCase();
      route = ['expired', 'revoked'].includes(status) ? 'invitation-expired' : (state.drawn && status !== 'accepted') || ['closed', 'drawn'].includes(status) ? 'invitation-closed' : state.user ? 'invitation' : 'invitation-new';
      if (['invitation-expired', 'invitation-closed'].includes(route)) setInvitationToken('');
      history.replaceState(null, '', href(route, params));
    } else if (['register', 'login'].includes(route) && state.inviteToken && !state.invitation) {
      const invitation = await api(`/invitations/${segment(state.inviteToken)}`);
      if (navigation !== version) return;
      state.invitation = invitation; state.group = invitation.group;
    }
    if (navigation === version) render();
  } catch (error) {
    if (navigation !== version) return;
    if (error.status === 401 || error.code === 'UNAUTHORIZED') {
      state.user = null; await navigate('login', { replace: true }); toast(errorMessage(error));
    } else if (route === 'verify-link') {
      await navigate('login', { replace: true }); toast(errorMessage(error));
    } else if (route.startsWith('invitation') && ['INVITATION_EXPIRED', 'INVITATION_CLOSED', 'CLOSED', 'NOT_FOUND'].includes(error.code)) {
      route = ['INVITATION_CLOSED', 'CLOSED'].includes(error.code) ? 'invitation-closed' : 'invitation-expired';
      setInvitationToken(''); state.invitationError = errorMessage(error); history.replaceState(null, '', href(route, params)); render();
    } else renderError(error);
  }
}
function toast(message) {
  const element = document.querySelector('#toast'); if (!element) return;
  element.textContent = message; element.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('show'), 5500);
}
function formError(form, message) {
  let element = form.querySelector('.form-error');
  if (!element) { element = document.createElement('div'); element.className = 'form-error'; element.setAttribute('role', 'alert'); form.prepend(element); }
  element.textContent = message; element.scrollIntoView({ block: 'nearest' });
}
function lockForm(form, locked) {
  form.setAttribute('aria-busy', String(locked));
  form.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = locked; });
}
async function completeLogin(user, fromLink = false) {
  if (!user?.id) throw new ApiError('INVALID_RESPONSE', 'Não foi possível confirmar sua conta. Tente entrar novamente.');
  state.user = user; state.pendingUser = null; clearChallenge(); resetSignupAvatar();
  if (state.inviteToken) await navigate('invitation', { token: state.inviteToken, replace: fromLink });
  else { const destination = state.returnTo || (state.authMode === 'register' ? 'account-ready' : 'dashboard'); state.returnTo = ''; await navigate(destination, { replace: fromLink }); }
}
function emailList(value) { return [...new Set(value.split(/[\s,;]+/).map(email => email.trim().toLowerCase()).filter(Boolean))]; }
function failureCount(value) { return Array.isArray(value) ? value.length : Number(value) || 0; }
function responseEmails(value) { return Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : item.email).filter(Boolean) : []; }
async function submit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.getAttribute('aria-busy') === 'true' || !form.reportValidity()) return;
  const data = new FormData(form);
  const value = name => String(data.get(name) || '').trim();
  const type = form.dataset.form;
  lockForm(form, true);
  try {
    if (type === 'register' || type === 'login') {
      const payload = { email: value('email').toLowerCase(), ...(state.inviteToken ? { inviteToken: state.inviteToken } : {}) };
      if (type === 'register') {
        if (!value('firstName') || !value('lastName')) throw new ApiError('INVALID_NAME', 'Preencha seu nome e sobrenome para continuar.');
        Object.assign(payload, { firstName: value('firstName'), lastName: value('lastName'), avatar: getSignupAvatar() || null });
      }
      const result = await post('/auth/request', payload);
      state.authMode = type; state.requestPayload = payload; state.pendingUser = { firstName: payload.firstName || '', lastName: payload.lastName || '', email: result.email || payload.email, avatar: payload.avatar || null };
      saveChallenge({ ...result, email: result.email || payload.email });
      await navigate('verify');
    } else if (type === 'verify') {
      const result = await post('/auth/verify', { challengeId: state.challenge.challengeId, code: value('code') });
      await completeLogin(result.user);
    } else if (type === 'create-group') {
      const payload = { name: value('name'), date: value('date'), budget: Number(value('budget')), location: value('location'), description: value('description') };
      if (!payload.name || !payload.date || !Number.isFinite(payload.budget) || payload.budget < 1) throw new ApiError('INVALID_GROUP', 'Confira o nome, a data e o valor do presente.');
      const result = await post('/groups', payload);
      state.group = result.group || result;
      await navigate('invite', { id: state.group.id }); toast('Seu grupo está pronto. Agora é hora de reunir a turma.');
    } else if (type === 'invite') {
      const emails = emailList(value('emails'));
      if (!emails.length || emails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new ApiError('INVALID_EMAIL', 'Confira os e-mails informados antes de enviar.');
      const result = await post(`/groups/${segment(state.group.id)}/invites`, { emails });
      const failures = responseEmails(result.failed);
      state.inviteQueued = responseEmails(result.queued);
      state.inviteEmails = [...responseEmails(result.sent), ...state.inviteQueued];
      if (!Array.isArray(result.sent)) state.inviteEmails = emails.filter(email => !failures.includes(email));
      if (!state.inviteEmails.length && responseEmails(result.skipped).length && !failures.length) { await navigate('group', { id: state.group.id }); toast('Essas pessoas já fazem parte da lista de convidados.'); return; }
      if (!state.inviteEmails.length) throw new ApiError('EMAIL_SEND_FAILED', 'Os convites não foram enviados. Confira os endereços e tente novamente.');
      await navigate('invites-sent', { id: state.group.id });
      if (failures.length) toast(`${failures.length} convite(s) não foram enviados. Confira o status no grupo e tente reenviar.`);
    }
  } catch (error) {
    if (type === 'verify' && error.code === 'INVALID_CODE') await navigate('verify-error');
    else if (type === 'verify' && error.code === 'EXPIRED_CODE') await navigate('verify-expired');
    else if (error.status === 401) { state.user = null; await navigate('login'); toast(errorMessage(error)); }
    else if (form.isConnected) formError(form, errorMessage(error));
    else toast(errorMessage(error));
  } finally { if (form.isConnected) lockForm(form, false); }
}
function updateCountdown() {
  const seconds = Math.max(0, Math.ceil((state.resendAt - Date.now()) / 1000));
  document.querySelectorAll('[data-countdown]').forEach(element => { element.textContent = seconds ? `Reenvio disponível em ${seconds}s.` : ''; });
  document.querySelectorAll('[data-action="resend-code"]').forEach(element => { element.disabled = seconds > 0 || pendingActions.has('resend-code'); });
  if (['verify', 'verify-error'].includes(route) && state.challenge?.expiresAt && Date.now() >= state.challenge.expiresAt && !pendingActions.has('resend-code')) void navigate('verify-expired', { replace: true });
}
function showHelp() {
  const dialog = document.querySelector('#help-dialog');
  dialog.innerHTML = `<div class="help-body"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:28px">${brand()}<button class="icon-button" data-action="close-dialog" aria-label="Fechar">${icon('x')}</button></div><span class="eyebrow">Simples do começo à surpresa</span><h2 id="help-title">Reúna. Convide. Surpreenda.</h2><div class="help-step"><span class="help-number">1</span><div><h3>Junte sua turma</h3><p>Crie seu grupo, combine a data e o valor do presente.</p></div></div><div class="help-step"><span class="help-number">2</span><div><h3>Convide por e-mail</h3><p>Cada pessoa confirma o próprio e-mail e aceita o convite. Quem organiza acompanha os envios e as confirmações.</p></div></div><div class="help-step"><span class="help-number">3</span><div><h3>Deixe a surpresa acontecer</h3><p>Com pelo menos 3 participantes confirmados, quem organiza pode fazer o sorteio. Uma única corrente conecta todo o grupo: ninguém tira a si mesmo, todos dão e recebem um presente.</p></div></div><p>Seu resultado é privado. Você pode consultá-lo na sua conta e recebe o nome por e-mail.</p><button class="btn btn-primary btn-block" data-action="close-dialog">Entendi ${icon('arrow-right', 16)}</button></div>`;
  dialog.showModal();
}
async function logout(keepInvitation = false) {
  const invite = keepInvitation ? state.inviteToken : '';
  await post('/auth/logout');
  state.user = null; state.groups = []; state.participants = []; state.match = null; state.revealed = false; state.drawn = false; state.pendingUser = null; state.role = 'member';
  clearChallenge(); resetSignupAvatar(); setInvitationToken(invite);
  if (!invite) { state.invitation = null; state.group = null; }
  await navigate(keepInvitation ? 'login' : 'welcome');
}
async function action(name, target) {
  switch (name) {
    case 'help': showHelp(); break;
    case 'close-dialog': target.closest('dialog')?.close(); break;
    case 'retry-route': if (!sessionLoaded) await start(); else await navigate(href(route, params).slice(1), { replace: true }); break;
    case 'profile': if (state.user) await openProfileEditor(state.user, user => { state.user = user; state.participants = state.participants.map(person => person.email === user.email ? { ...person, name: `${user.firstName} ${user.lastName}`, avatar: user.avatar } : person); render(); }); break;
    case 'logout': await logout(); break;
    case 'switch-account': await logout(true); break;
    case 'register-invited': state.authMode = 'register'; await navigate('register'); break;
    case 'login-invited': state.authMode = 'login'; await navigate('login'); break;
    case 'resend-code': {
      if (Date.now() < state.resendAt) return;
      const email = state.challenge?.email || state.pendingUser?.email;
      if (!email) { await navigate('login'); return; }
      const result = await post('/auth/request', { ...(state.requestPayload || { email }), ...(state.inviteToken ? { inviteToken: state.inviteToken } : {}) });
      saveChallenge({ ...result, email: result.email || email }); await navigate('verify'); toast(state.authMode === 'login' ? 'Se o e-mail estiver cadastrado, um novo código chegará em instantes.' : 'Um novo código está a caminho do seu e-mail.'); break;
    }
    case 'accept-invite': {
      if (!state.user) { await navigate('register'); return; }
      if (!state.inviteToken) throw new ApiError('INVITATION_EXPIRED', 'Abra novamente seu convite por e-mail.');
      try {
        const result = await post(`/invitations/${segment(state.inviteToken)}/accept`);
        state.group = result.group || result; state.invitationError = ''; setInvitationToken('');
        await navigate('invitation-accepted', { id: state.group.id });
      } catch (error) {
        if (error.code === 'EMAIL_MISMATCH') { state.invitationError = errorMessage(error); state.invitationErrorCode = error.code; render(); }
        else if (['INVITATION_CLOSED', 'CLOSED', 'INVITATION_EXPIRED'].includes(error.code)) { setInvitationToken(''); await navigate(error.code === 'INVITATION_EXPIRED' ? 'invitation-expired' : 'invitation-closed', { skipLoad: true }); toast(errorMessage(error)); }
        else throw error;
      }
      break;
    }
    case 'run-draw': {
      if (busyDraw || state.role !== 'organizer') return;
      const checkbox = document.querySelector('input[name="drawConsent"]');
      if (!checkbox?.checked) { checkbox?.reportValidity(); return; }
      const id = state.group.id;
      busyDraw = true; await navigate('draw-running', { id, skipLoad: true });
      try { const result = await post(`/groups/${segment(id)}/draw`); await navigate('drawn', { id, replace: true }); if (failureCount(result.notifications?.failed) || result.group?.notificationFailures) toast('O sorteio foi salvo. Alguns avisos por e-mail precisam de nova tentativa; os resultados já estão disponíveis na conta.'); }
      catch (error) { await navigate('draw-confirm', { id, replace: true }); toast(errorMessage(error)); }
      finally { busyDraw = false; }
      break;
    }
    case 'reveal': {
      if (!state.group?.id || !state.drawn) return;
      const groupId = state.group.id, requestVersion = version;
      const result = await api(`/groups/${segment(groupId)}/result`);
      if (requestVersion !== version || state.group?.id !== groupId || route !== 'reveal') return;
      if (!result.match?.name) throw new ApiError('RESULT_UNAVAILABLE', 'Seu resultado ainda não está disponível. Aguarde o sorteio.');
      state.match = result.match; state.revealed = true; render(); break;
    }
    case 'hide-result': state.revealed = false; state.match = null; render(); break;
    case 'refresh-group': await navigate('group', { id: state.group?.id }); toast('Lista atualizada.'); break;
    case 'retry-notifications': {
      if (state.role !== 'organizer' || !state.group?.id) return;
      const result = await post(`/groups/${segment(state.group.id)}/notifications/retry`);
      await navigate('group', { id: state.group.id });
      toast(failureCount(result.notifications?.failed) ? 'Alguns avisos ainda não puderam ser enviados. Tente novamente mais tarde.' : failureCount(result.notifications?.sent) ? 'Os avisos pendentes foram reenviados.' : 'A lista de envios foi atualizada.'); break;
    }
    case 'resend-invite': {
      const person = state.participants.find(item => item.email === target.dataset.email || item.id === target.dataset.id);
      if (!person || state.drawn || state.role !== 'organizer') return;
      const result = await post(`/groups/${segment(state.group.id)}/invites/${segment(person.invitationId || person.id)}/resend`);
      await navigate('group', { id: state.group.id }); toast(failureCount(result.notifications?.failed) ? 'Não foi possível enviar agora. O status no grupo mostra as novas tentativas necessárias.' : failureCount(result.notifications?.sent) ? 'Convite reenviado.' : 'Pedido de reenvio registrado. Confira o status na lista.'); break;
    }
  }
}
const handledActions = new Set(['help', 'close-dialog', 'retry-route', 'profile', 'logout', 'switch-account', 'register-invited', 'login-invited', 'resend-code', 'accept-invite', 'run-draw', 'reveal', 'hide-result', 'resend-invite', 'retry-notifications', 'refresh-group']);
document.addEventListener('click', async event => {
  const skip = event.target.closest('.skip-link');
  if (skip) { event.preventDefault(); const main = document.querySelector('#main'); main?.setAttribute('tabindex', '-1'); main?.focus(); main?.scrollIntoView(); return; }
  const target = event.target.closest('[data-route],[data-action]');
  if (!target || target.disabled) return;
  if (target.tagName === 'A' && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)) return;
  if (target.dataset.route) { event.preventDefault(); if (busyDraw) return; await navigate(target.dataset.route, { id: target.dataset.groupId || undefined }); return; }
  const name = target.dataset.action;
  if (!handledActions.has(name)) return;
  event.preventDefault();
  if (pendingActions.has(name)) return;
  pendingActions.add(name); target.disabled = true;
  try { await action(name, target); }
  catch (error) {
    if (name === 'resend-code' && error.retryAfter) { state.resendAt = Date.now() + error.retryAfter * 1000; if (state.challenge) { state.challenge.resendAt = state.resendAt; storage.set(CHALLENGE_KEY, JSON.stringify(state.challenge)); } }
    if (error.status === 401) { state.user = null; await navigate('login'); }
    toast(errorMessage(error));
  }
  finally { pendingActions.delete(name); if (target.isConnected) target.disabled = false; updateCountdown(); }
});
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); }));
window.addEventListener('popstate', () => { if (busyDraw) return; const next = parseHash(); void navigate(href(next.route, next.params).slice(1), { replace: true }); });
window.addEventListener('hashchange', () => { if (location.hash === '#main' || busyDraw) return; const next = parseHash(); if (href(next.route, next.params) !== href(route, params)) void navigate(href(next.route, next.params).slice(1), { replace: true }); });
setInterval(updateCountdown, 1000);
async function start() {
  document.body.dataset.live = 'true';
  document.body.style.paddingBottom = '0';
  document.querySelector('#review-tools')?.remove(); document.querySelector('#screen-picker')?.remove();
  loading();
  try { const result = await api('/session'); state.user = result.user || null; sessionLoaded = true; const next = parseHash(); await navigate(href(next.route, next.params).slice(1), { replace: true }); }
  catch (error) { renderError(error); }
}
void start();
