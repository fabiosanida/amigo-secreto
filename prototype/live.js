import { setupInviteFields, setInviteFieldsBusy } from './invite-fields.js';
import { setupGroupFields, parseBudget } from './group-fields.js';
import { setupOTP } from './otp.js';
import { icon, brand, avatar, escapeHtml, setAvatarDirectory } from './ui.js';
import { renderAuth, AUTH_ROUTES } from './auth.js';
import { renderGroups, GROUP_ROUTES } from './groups.js';
import { renderAdmin, renderAdminDeletePreview, ADMIN_ROUTES } from './admin.js';
import { showMarmeladaResult } from './marmelada.js';
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
  production: true, user: null, groups: [], pendingInvitations: [], acceptingInvitationId: '', dashboardInvitationErrors: {}, group: null, participants: [],
  marmeladaData: null, marmeladaSearch: '',
  adminOverview: null, adminData: null, adminTab: 'groups', adminSearch: '', adminCreatedPage: 1, adminParticipatingPage: 1,
  role: 'member', organizerEmail: '', drawn: false, revealed: false, match: null,
  invitation: null, inviteToken: storage.get(INVITE_KEY) || '',
  inviteContext: Boolean(storage.get(INVITE_KEY)), inviteEmails: [], inviteQueued: [],
  invitationError: '', invitationErrorCode: '', returnTo: '', challenge: storedChallenge, pendingUser: null,
  authMode: storedChallenge?.purpose === 'recover' ? 'recover' : storedChallenge ? 'register' : 'login', authEmail: storedChallenge?.email || '', accountCheck: null, resetToken: '', resendAt: Number(storedChallenge?.resendAt) || 0, requestPayload: null,
};
const groupRoutes = new Set(['group', 'group-member', 'invite', 'invites-sent', 'draw-confirm', 'draw-running', 'drawn', 'reveal']);
const organizerRoutes = new Set(['invite', 'invites-sent', 'draw-confirm', 'draw-running', 'drawn']);
const allowed = new Set([...AUTH_ROUTES, ...GROUP_ROUTES, ...ADMIN_ROUTES, 'verify-link']);
const signedRoutes = new Set([...GROUP_ROUTES, ...ADMIN_ROUTES, 'account-ready', 'invitation-accepted']);
let route = 'welcome', params = new URLSearchParams(), version = 0, toastTimer;
let busyDraw = false, sessionLoaded = false;
let pendingMagicVerification = null;
const pendingActions = new Set();
const titles = { 'admin-marmelada': 'Marmelada?', admin: 'Administração', 'admin-group': 'Detalhes do grupo', 'admin-user': 'Detalhes da pessoa', welcome: 'Gente querida. Boas surpresas.', register: 'Criar conta', login: 'Entrar', 'recover-password': 'Recuperar senha', 'reset-password': 'Nova senha', 'password-ready': 'Senha atualizada', verify: 'Confirmar e-mail', 'verify-error': 'Conferir código', 'verify-expired': 'Novo código', 'account-ready': 'Conta confirmada', dashboard: 'Meus grupos', 'dashboard-empty': 'Meus grupos', 'create-group': 'Criar grupo', group: 'Meu grupo', 'group-member': 'Meu grupo', invite: 'Convidar pessoas', 'invites-sent': 'Convites enviados', 'draw-confirm': 'Confirmar sorteio', 'draw-running': 'Realizando sorteio', drawn: 'Sorteio concluído', reveal: 'Meu amigo secreto', invitation: 'Seu convite', 'invitation-new': 'Seu convite', 'invitation-accepted': 'Participação confirmada', 'invitation-closed': 'Convite encerrado', 'invitation-expired': 'Convite indisponível' };

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
function verifyMagicLink(token) {
  if (pendingMagicVerification?.token === token) return pendingMagicVerification.promise;
  const request = { token, promise: post('/auth/verify', { token }) };
  pendingMagicVerification = request;
  request.promise = request.promise.finally(() => {
    if (pendingMagicVerification === request) pendingMagicVerification = null;
  });
  return request.promise;
}
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
  return `<header class="app-header"><a class="app-brand-link" href="#dashboard" data-route="dashboard" aria-label="Amigo Secreto, meus grupos">${brand()}</a><nav class="app-nav" aria-label="Navegação principal"><button class="${ADMIN_ROUTES.includes(route) ? '' : 'active'}" data-route="dashboard">Meus grupos</button>${state.user?.isAdmin ? `<button class="${ADMIN_ROUTES.includes(route) ? 'active' : ''}" data-route="admin">Administração</button>` : ''}<button data-action="help">Como funciona</button></nav><div class="app-account">${state.user?.isAdmin ? `<button class="btn btn-secondary admin-mobile-nav" data-route="admin" aria-label="Administração">${icon('shield', 17)}</button>` : ''}<span class="account-name">${escapeHtml(user.firstName)}</span><button data-action="profile" aria-label="Minha conta">${avatar(`${user.firstName} ${user.lastName}`, 0, '', user.avatar ?? null)}</button></div></header><main id="main" class="app-main transition-in" tabindex="-1">${content}</main><footer class="app-footer"><span>${icon('heart', 13)} Gente querida. Boas surpresas.</span><button data-action="help">Feito para aproximar.</button></footer>`;
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
  const screen = route === 'dashboard' && !state.groups.length && !state.pendingInvitations.length ? 'dashboard-empty' : route;
  const content = renderAuth(screen, snapshot) ?? renderGroups(screen, snapshot) ?? renderAdmin(screen, snapshot);
  document.querySelector('#app').innerHTML = (GROUP_ROUTES.includes(screen) || ADMIN_ROUTES.includes(screen)) ? shell(content || '') : (content || '');
  document.body.dataset.screen = screen;
  document.title = `${titles[screen] || 'Amigo Secreto'} · Amigo Secreto`;
  document.querySelector('#review-tools')?.replaceChildren();
  document.querySelectorAll('a[data-route]').forEach(link => {
    const destination = link.dataset.route;
    const query = new URLSearchParams();
    if (link.dataset.adminId) query.set('id', link.dataset.adminId);
    if (groupRoutes.has(destination) && (link.dataset.groupId || state.group?.id)) query.set('id', link.dataset.groupId || state.group.id);
    if (destination.startsWith('invitation') && state.inviteToken) query.set('token', state.inviteToken);
    link.href = href(destination, query);
  });
  setupPhotoInputs(document);
  document.querySelectorAll('#app form[data-form]').forEach(form => form.addEventListener('submit', submit));
  setupOTP(document.querySelector('#app'));
  setupInviteFields(document.querySelector('#app'));
  setupGroupFields(document.querySelector('#app'));
  if (['register', 'login', 'recover-password'].includes(route)) {
    const user = currentUser();
    for (const name of ['firstName', 'lastName', 'email']) { const input = document.querySelector(`form [name="${name}"]`); const value = name === 'email' ? state.authEmail || state.invitation?.recipientEmail || user.email : user[name]; if (input && value) input.value = value; }
  }
  if (route === 'register') {
    const emailInput = document.querySelector('#register-email');
    emailInput?.addEventListener('input', () => { state.accountCheck = null; updateEmailFeedback(emailInput.form); });
    emailInput?.addEventListener('blur', () => { if (emailInput.validity.valid && emailInput.value) void checkAccount(emailInput.form).catch(() => {}); });
    if (emailInput) { updateEmailFeedback(emailInput.form); if (emailInput.value) void checkAccount(emailInput.form).catch(() => {}); }
  }
  document.querySelectorAll('[name="passwordConfirm"]').forEach(input => {
    const check = () => input.setCustomValidity(input.value && input.value !== input.form.elements.password.value ? 'As senhas precisam ser iguais.' : '');
    input.addEventListener('input', check); input.form.elements.password.addEventListener('input', check);
  });
  updateCountdown();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function rememberAuthEmail() {
  const input = document.querySelector('.auth-form [name="email"]');
  if (input) state.authEmail = input.value.trim().toLowerCase();
}
function updateEmailFeedback(form, checking = false) {
  const feedback = form?.querySelector('[data-email-feedback]');
  if (!feedback) return;
  const email = form.elements.email.value.trim().toLowerCase();
  const result = state.accountCheck?.email === email ? state.accountCheck : null;
  const verified = Boolean(email && (result ? result.emailVerified : state.invitation?.emailVerified) && state.invitation.recipientEmail?.toLowerCase() === email && state.inviteToken);
  const badge = verified ? `<span class="auth-email-verified">${icon('check-circle', 15)} E-mail já validado pelo convite</span>` : '';
  feedback.innerHTML = `${badge}${checking ? '<span class="auth-email-checking"> Conferindo e-mail…</span>' : ''}${result?.exists ? `<div class="auth-email-existing"><p>Já existe uma conta com este e-mail.${result.hasPassword === false ? ' Para definir sua primeira senha, use Recuperar senha.' : ' Entre na sua conta para continuar.'}</p><div class="auth-email-actions"><button type="button" class="btn btn-primary" data-route="login">Entrar na minha conta</button><button type="button" class="btn btn-secondary" data-route="recover-password">Recuperar senha</button></div><button type="button" class="auth-text-link auth-email-other" data-action="use-other-email">Criar conta com outro e-mail</button></div>` : ''}`;
  const note = form.querySelector('[data-register-note]');
  if (note) note.textContent = verified ? 'O convite já confirmou seu e-mail. Basta concluir o cadastro com sua senha.' : state.inviteToken && email ? 'Se usar outro e-mail, será preciso validá-lo por código. Este convite continua vinculado ao destinatário original.' : 'Vamos enviar um código para confirmar que esse e-mail é seu.';
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = Boolean(result?.exists || form.getAttribute('aria-busy') === 'true');
}
async function checkAccount(form) {
  const input = form?.elements.email;
  if (!input || !input.value || !input.validity.valid) return null;
  const email = input.value.trim().toLowerCase();
  state.authEmail = email;
  updateEmailFeedback(form, true);
  let result;
  try { result = await post('/auth/account', { email, ...(state.inviteToken ? { inviteToken: state.inviteToken } : {}) }); }
  catch (error) { if (form.isConnected && input.value.trim().toLowerCase() === email) updateEmailFeedback(form); throw error; }
  if (!form.isConnected || input.value.trim().toLowerCase() !== email) return null;
  state.accountCheck = { ...result, email }; updateEmailFeedback(form);
  return state.accountCheck;
}
function checkPasswords(form) {
  const password = form.elements.password.value, passwordConfirm = form.elements.passwordConfirm.value;
  if (password.length < 12 || password.length > 128) throw new ApiError('INVALID_PASSWORD', 'Use uma senha com 12 a 128 caracteres.');
  if (password !== passwordConfirm) throw new ApiError('PASSWORD_MISMATCH', 'As senhas precisam ser iguais.');
  return { password, passwordConfirm };
}
function setInvitationToken(token) {
  state.inviteToken = token || ''; state.inviteContext = Boolean(token);
  storage.set(INVITE_KEY, token || null);
}
function clearAdmin() {
  state.marmeladaData = null; state.marmeladaSearch = '';
  document.querySelector('#marmelada-result-dialog')?.close();
  document.querySelector('#admin-delete-dialog')?.close();
  state.adminOverview = null; state.adminData = null; state.adminTab = 'groups'; state.adminSearch = ''; state.adminCreatedPage = 1; state.adminParticipatingPage = 1;
}
function clearPrivateState() {
  clearAdmin(); state.groups = []; state.pendingInvitations = []; state.acceptingInvitationId = ''; state.dashboardInvitationErrors = {}; state.group = null; state.participants = []; state.match = null; state.revealed = false; state.drawn = false; state.role = 'member'; state.inviteEmails = []; state.inviteQueued = []; setAvatarDirectory([]);
}
function clearChallenge() {
  state.challenge = null; state.requestPayload = null; storage.set(CHALLENGE_KEY, null);
}
function saveChallenge(result) {
  const now = Date.now();
  state.resendAt = now + Math.max(30, Number(result.resendAfter) || 60) * 1000;
  const expiresAt = result.expiresAt ? new Date(result.expiresAt).getTime() : now + 10 * 60 * 1000;
  state.challenge = { challengeId: result.challengeId, email: result.email, purpose: state.authMode === 'recover' ? 'recover' : 'register', resendAt: state.resendAt, expiresAt };
  storage.set(CHALLENGE_KEY, JSON.stringify(state.challenge));
}
function parseHash(hash = location.hash) {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  return { route: allowed.has(path) ? path : (state.user ? 'dashboard' : 'welcome'), params: new URLSearchParams(query) };
}
function href(next, query) {
  const text = query.toString(); return `#${next}${text ? `?${text}` : ''}`;
}
function rememberDashboard(data) {
  state.groups = data.groups || []; state.pendingInvitations = data.pendingInvitations || []; state.dashboardInvitationErrors = {};
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
  if (next === 'verify' && query.get('purpose') === 'recover' && /^[0-9a-f-]{36}$/i.test(query.get('challengeId') || '') && query.get('email')) {
    const invitation = query.get('invitation');
    if (/^[A-Za-z0-9_-]{43}$/.test(invitation || '')) setInvitationToken(invitation);
    state.authMode = 'recover'; state.authEmail = query.get('email'); state.pendingUser = { email: state.authEmail, firstName: '', lastName: '' };
    if (state.challenge?.challengeId !== query.get('challengeId')) saveChallenge({ challengeId: query.get('challengeId'), email: state.authEmail, resendAfter: 60 });
  }
  if (options.id) query.set('id', options.id);
  if (options.token) query.set('token', options.token);
  if (groupRoutes.has(next) && !query.get('id') && state.group?.id) query.set('id', state.group.id);
  if (next.startsWith('invitation') && next !== 'invitation-accepted' && !query.get('token') && state.inviteToken) query.set('token', state.inviteToken);
  if (signedRoutes.has(next) && !state.user) { state.returnTo = href(next, query).slice(1); next = 'login'; }
  if (ADMIN_ROUTES.includes(next) && !state.user?.isAdmin) { clearAdmin(); next = state.user ? 'dashboard' : 'login'; query.delete('id'); }
  if (['admin-group', 'admin-user'].includes(next) && !query.get('id')) next = 'admin';
  if (groupRoutes.has(next) && !query.get('id')) next = 'dashboard';
  if (['verify', 'verify-error', 'verify-expired'].includes(next) && !state.challenge) next = query.get('purpose') === 'recover' ? 'recover-password' : state.user ? 'dashboard' : 'login';
  if (next === 'reset-password' && !state.resetToken) next = 'recover-password';
  if (['verify', 'verify-error'].includes(next) && state.challenge?.expiresAt && Date.now() >= state.challenge.expiresAt) next = 'verify-expired';
  if (next === 'welcome' && state.user) next = 'dashboard';
  route = next; params = query;
  const navigation = ++version;
  state.invitationError = ''; state.invitationErrorCode = '';
  const destination = href(route, params);
  if (location.hash !== destination) history[options.replace ? 'replaceState' : 'pushState'](null, '', destination);
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  if (options.skipLoad) { render(); return; }
  if (ADMIN_ROUTES.includes(route)) { state.adminData = null; state.marmeladaData = null; }
  loading();
  try {
    if (route === 'verify-link') {
      const token = params.get('token');
      if (params.get('invitation')) setInvitationToken(params.get('invitation'));
      if (!token) throw new ApiError('EXPIRED_CODE', 'Este link de confirmação não está disponível. Peça um novo código.');
      const result = await verifyMagicLink(token);
      if (navigation !== version) return;
      await completeLogin(result.user, true); return;
    }
    if (ADMIN_ROUTES.includes(route)) {
      if (!state.user?.isAdmin) { clearAdmin(); await navigate('dashboard', { replace: true }); return; }
      const page = key => String(Math.min(10000, Math.max(1, Math.floor(Number(params.get(key)) || 1))));
      if (route === 'admin-marmelada') {
        state.marmeladaSearch = (params.get('search') || '').trim().slice(0, 100);
        const id = params.get('id');
        const query = new URLSearchParams({ page: page('page'), limit: '25', search: state.marmeladaSearch });
        const data = await api(id ? `/admin/marmelada/groups/${segment(id)}` : `/admin/marmelada/groups?${query}`);
        if (navigation !== version || !state.user?.isAdmin) return;
        state.marmeladaData = data;
      } else if (route === 'admin') {
        state.adminTab = params.get('tab') === 'users' ? 'users' : 'groups';
        state.adminSearch = (params.get('search') || '').trim().slice(0, 100);
        const query = new URLSearchParams({ page: page('page'), limit: '25', search: state.adminSearch });
        const [overview, data] = await Promise.all([state.adminOverview ? Promise.resolve(state.adminOverview) : api('/admin/overview'), api(`/admin/${state.adminTab}?${query}`)]);
        if (navigation !== version || !state.user?.isAdmin) return;
        state.adminOverview = overview; state.adminData = data;
      } else {
        const query = new URLSearchParams();
        if (route === 'admin-user') {
          state.adminCreatedPage = Number(page('createdPage')); state.adminParticipatingPage = Number(page('participatingPage'));
          query.set('createdPage', String(state.adminCreatedPage)); query.set('participatingPage', String(state.adminParticipatingPage)); query.set('limit', '25');
        }
        const data = await api(`/admin/${route === 'admin-group' ? 'groups' : 'users'}/${segment(params.get('id'))}${query.size ? `?${query}` : ''}`);
        if (navigation !== version || !state.user?.isAdmin) return;
        state.adminData = data;
      }
    } else if (route === 'dashboard' || route === 'dashboard-empty') {
      const result = await api('/groups');
      if (navigation !== version) return;
      rememberDashboard(result);
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
      route = ['expired', 'revoked'].includes(status) ? 'invitation-expired' : (state.drawn && status !== 'accepted' && !invitation.currentUserAccepted) || ['closed', 'drawn'].includes(status) ? 'invitation-closed' : state.user ? 'invitation' : 'invitation-new';
      if (['invitation-expired', 'invitation-closed'].includes(route)) setInvitationToken('');
      history.replaceState(null, '', href(route, params));
    } else if (['register', 'login', 'recover-password'].includes(route) && state.inviteToken) {
      const invitation = await api(`/invitations/${segment(state.inviteToken)}`);
      if (navigation !== version) return;
      state.invitation = invitation; state.group = invitation.group;
      if (!state.authEmail) state.authEmail = invitation.recipientEmail || '';
    }
    if (navigation === version) render();
  } catch (error) {
    if (navigation !== version) return;
    if (error.status === 401 || error.code === 'UNAUTHORIZED') {
      state.user = null; clearPrivateState(); await navigate('login', { replace: true }); toast(errorMessage(error));
    } else if (ADMIN_ROUTES.includes(route) && error.status === 403) {
      clearAdmin(); state.user = { ...state.user, isAdmin: false }; await navigate('dashboard', { replace: true }); toast(errorMessage(error));
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
  setInviteFieldsBusy(form, locked);
  if (['register', 'login', 'recover-password', 'reset-password', 'verify'].includes(form.dataset.form)) form.querySelectorAll('input').forEach(input => { input.disabled = locked; });
  if (form.dataset.form === 'register') updateEmailFeedback(form);
}
async function completeLogin(user, fromLink = false) {
  if (!user?.id) throw new ApiError('INVALID_RESPONSE', 'Não foi possível confirmar sua conta. Tente entrar novamente.');
  if (state.user?.id !== user.id || !user.isAdmin) clearPrivateState();
  state.user = user; state.pendingUser = null; clearChallenge(); resetSignupAvatar();
  if (state.inviteToken) await navigate('invitation', { token: state.inviteToken, replace: fromLink });
  else { const destination = state.returnTo || (state.authMode === 'register' ? 'account-ready' : 'dashboard'); state.returnTo = ''; await navigate(destination, { replace: fromLink }); }
}
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
    if (type === 'marmelada-search') {
      if (!state.user?.isAdmin) return;
      await navigate(`admin-marmelada?${new URLSearchParams({ search: value('search'), page: '1' })}`);
    } else if (type === 'marmelada-check') {
      if (!state.user?.isAdmin || !state.marmeladaData?.group?.id) return;
      const navigation = version, userId = state.user.id;
      const result = await post('/admin/marmelada/check', { groupId: state.marmeladaData.group.id, giverId: value('giverId'), receiverId: value('receiverId') });
      if (navigation !== version || state.user?.id !== userId || !state.user?.isAdmin) return;
      if (typeof result.matches !== 'boolean') throw new ApiError('INVALID_RESPONSE', 'Não foi possível conferir este resultado. Tente novamente.');
      showMarmeladaResult(result);
    } else if (type === 'admin-search') {
      if (!state.user?.isAdmin) return;
      await navigate(`admin?${new URLSearchParams({ tab: state.adminTab, search: value('search'), page: '1' })}`);
    } else if (type === 'register') {
      const credentials = checkPasswords(form);
      const payload = { email: value('email').toLowerCase(), firstName: value('firstName'), lastName: value('lastName'), avatar: getSignupAvatar() || null, ...credentials, ...(state.inviteToken ? { inviteToken: state.inviteToken } : {}) };
      if (!payload.firstName || !payload.lastName) throw new ApiError('INVALID_NAME', 'Preencha seu nome e sobrenome para continuar.');
      const account = await checkAccount(form);
      if (account?.exists) return;
      state.authMode = 'register'; state.authEmail = payload.email;
      const result = await post('/auth/register', payload);
      state.pendingUser = { firstName: payload.firstName, lastName: payload.lastName, email: result.email || payload.email, avatar: payload.avatar };
      if (result.user) { await completeLogin(result.user); return; }
      saveChallenge({ ...result, email: result.email || payload.email });
      await navigate('verify');
    } else if (type === 'login') {
      state.authMode = 'login'; state.authEmail = value('email').toLowerCase();
      const result = await post('/auth/login', { email: state.authEmail, password: String(data.get('password') || '') });
      await completeLogin(result.user);
    } else if (type === 'recover-password') {
      state.authMode = 'recover'; state.authEmail = value('email').toLowerCase(); state.resetToken = '';
      const result = await post('/auth/password/request', { email: state.authEmail, ...(state.inviteToken ? { inviteToken: state.inviteToken } : {}) });
      state.pendingUser = { firstName: '', lastName: '', email: state.authEmail };
      saveChallenge({ ...result, email: result.email || state.authEmail }); await navigate('verify');
    } else if (type === 'verify') {
      const payload = { challengeId: state.challenge.challengeId, code: value('code') };
      if (state.authMode === 'recover') {
        const result = await post('/auth/password/verify', payload);
        state.resetToken = result.resetToken; state.authEmail = result.email || state.challenge.email;
        clearChallenge(); await navigate('reset-password');
      } else { const result = await post('/auth/verify', payload); await completeLogin(result.user); }
    } else if (type === 'reset-password') {
      await post('/auth/password/reset', { resetToken: state.resetToken, ...checkPasswords(form) });
      state.resetToken = ''; state.user = null; clearPrivateState(); clearChallenge(); await navigate('password-ready');
    } else if (type === 'create-group') {
      const payload = { name: value('name'), date: value('date'), budget: parseBudget(value('budget')), location: value('location'), description: value('description') };
      if (!payload.name || !payload.date || !Number.isFinite(payload.budget) || payload.budget < 1) throw new ApiError('INVALID_GROUP', 'Confira o nome, a data e o valor do presente.');
      const result = await post('/groups', payload);
      state.group = result.group || result;
      await navigate('invite', { id: state.group.id }); toast('Seu grupo está pronto. Agora é hora de reunir a turma.');
    } else if (type === 'invite') {
      const entries = data.getAll('emails').map(email => String(email).trim().toLowerCase());
      if (!entries.length || entries.length > 50 || entries.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new ApiError('INVALID_EMAIL', 'Preencha um e-mail válido em cada campo. Envie de 1 a 50 e-mails por vez.');
      const emails = [...new Set(entries)];
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
    else if (type === 'verify' && error.code === 'ACCOUNT_EXISTS') { state.authEmail = state.challenge?.email || state.authEmail; clearChallenge(); await navigate('login'); toast(errorMessage(error)); }
    else if (type === 'register' && error.code === 'ACCOUNT_EXISTS') { state.accountCheck = { email: value('email').toLowerCase(), exists: true }; updateEmailFeedback(form); }
    else if (type === 'reset-password' && ['RESET_EXPIRED', 'INVALID_RESET_TOKEN', 'EXPIRED_CODE', 'INVALID_CODE'].includes(error.code)) { state.resetToken = ''; await navigate('recover-password'); toast(errorMessage(error)); }
    else if (error.status === 401 && !['login', 'recover-password', 'reset-password'].includes(type)) { state.user = null; clearPrivateState(); await navigate('login'); toast(errorMessage(error)); }
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
async function showAdminDelete(kind) {
  if (!state.user?.isAdmin) return;
  const subject = kind === 'user' ? state.adminData?.user : state.adminData?.group;
  if (!subject?.id) return;
  const navigation = version, adminId = state.user.id, id = subject.id;
  const endpoint = `/admin/${kind === 'user' ? 'users' : 'groups'}/${segment(id)}`;
  const preview = await api(`${endpoint}/delete-preview`);
  if (navigation !== version || !state.user?.isAdmin || state.user.id !== adminId) return;
  const dialog = document.querySelector('#admin-delete-dialog');
  if (!dialog) return;
  dialog.innerHTML = renderAdminDeletePreview(kind, preview);
  const form = dialog.querySelector('form'), input = form.elements.confirmation, button = form.querySelector('button[type="submit"]');
  if (preview.canDelete !== false && input && button) {
    const expected = kind === 'user' ? preview.user.email : preview.group.name;
    input.addEventListener('input', () => { button.disabled = input.value !== expected; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!state.user?.isAdmin || state.user.id !== adminId || form.getAttribute('aria-busy') === 'true' || input.value !== expected || !form.reportValidity()) return;
      form.setAttribute('aria-busy', 'true');
      form.querySelectorAll('button,input').forEach(element => { element.disabled = true; }); button.textContent = 'Apagando…';
      try {
        await post(`${endpoint}/delete`, { confirmation: input.value });
        clearPrivateState();
        dialog.close(); dialog.replaceChildren();
        await navigate(kind === 'user' ? 'admin?tab=users' : 'admin?tab=groups', { replace: true });
        toast(kind === 'user' ? 'Conta apagada. Os grupos e participações foram atualizados.' : 'Amigo secreto apagado.');
      } catch (error) {
        if (error.status === 401) { state.user = null; clearPrivateState(); dialog.close(); await navigate('login'); toast(errorMessage(error)); }
        else if (error.status === 403) { clearAdmin(); dialog.close(); toast(errorMessage(error)); await navigate('dashboard'); }
        else formError(form, error.code === 'NOTIFICATIONS_IN_PROGRESS' ? 'Há notificações em envio para os grupos envolvidos. Aguarde o envio terminar e tente novamente.' : errorMessage(error));
      } finally {
        if (form.isConnected) { form.setAttribute('aria-busy', 'false'); form.querySelectorAll('button,input').forEach(element => { element.disabled = false; }); button.textContent = 'Apagar definitivamente'; button.disabled = input.value !== expected; }
      }
    });
  }
  dialog.oncancel = event => { if (form.getAttribute('aria-busy') === 'true') event.preventDefault(); };
  dialog.showModal();
}
function showDeleteGroup() {
  if (state.role !== 'organizer' || !state.group?.id) return;
  const group = { id: state.group.id, name: state.group.name };
  const dialog = document.querySelector('#delete-group-dialog');
  if (!dialog) return;
  dialog.innerHTML = `<form class="delete-group-form"><div class="delete-group-heading"><span class="delete-group-symbol">${icon('alert', 23)}</span><button type="button" class="icon-button" data-action="close-dialog" aria-label="Fechar confirmação">${icon('x', 21)}</button></div><span class="eyebrow">ANTES DE SE DESPEDIR</span><h2 id="delete-group-title">Apagar este amigo secreto?</h2><p>O grupo <strong>${escapeHtml(group.name)}</strong> será apagado permanentemente, junto com seus convites, participações e resultados do sorteio. As contas das pessoas continuam na aplicação.</p><div class="delete-group-warning">${icon('info', 19)}<span>Essa ação não pode ser desfeita. Os e-mails já enviados não serão recolhidos.</span></div><label class="field" for="delete-group-confirmation">Para confirmar, digite o nome do grupo:<strong class="delete-group-name">${escapeHtml(group.name)}</strong><input id="delete-group-confirmation" name="confirmation" type="text" required autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Nome exato do amigo secreto"></label><div class="delete-group-actions"><button type="button" class="btn btn-secondary" data-action="close-dialog">Cancelar</button><button type="submit" class="btn btn-danger" disabled>Apagar definitivamente</button></div></form>`;
  const form = dialog.querySelector('form'), input = form.elements.confirmation, button = form.querySelector('button[type="submit"]');
  input.addEventListener('input', () => { button.disabled = input.value !== group.name; });
  dialog.oncancel = event => { if (form.getAttribute('aria-busy') === 'true') event.preventDefault(); };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.getAttribute('aria-busy') === 'true' || input.value !== group.name || !form.reportValidity()) return;
    form.setAttribute('aria-busy', 'true');
    form.querySelectorAll('button,input').forEach(element => { element.disabled = true; });
    button.textContent = 'Apagando…';
    try {
      await post(`/groups/${segment(group.id)}/delete`, { confirmation: input.value });
      if (state.invitation?.group?.id === group.id) { state.invitation = null; setInvitationToken(''); }
      clearPrivateState();
      dialog.close(); dialog.replaceChildren();
      await navigate('dashboard', { replace: true });
      toast('Amigo secreto apagado.');
    } catch (error) {
      if (error.status === 401) { state.user = null; clearPrivateState(); dialog.close(); await navigate('login'); toast(errorMessage(error)); }
      else formError(form, error.code === 'NOTIFICATIONS_IN_PROGRESS' ? 'Há notificações sendo enviadas para este grupo. Aguarde o envio terminar e tente apagar novamente.' : errorMessage(error));
    } finally {
      if (form.isConnected) { form.setAttribute('aria-busy', 'false'); form.querySelectorAll('button,input').forEach(element => { element.disabled = false; }); button.textContent = 'Apagar definitivamente'; button.disabled = input.value !== group.name; }
    }
  });
  dialog.showModal();
}
function showHelp() {
  const dialog = document.querySelector('#help-dialog');
  dialog.innerHTML = `<div class="help-body"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:28px">${brand()}<button class="icon-button" data-action="close-dialog" aria-label="Fechar">${icon('x')}</button></div><span class="eyebrow">Simples do começo à surpresa</span><h2 id="help-title">Reúna. Convide. Surpreenda.</h2><div class="help-step"><span class="help-number">1</span><div><h3>Junte sua turma</h3><p>Crie seu grupo, combine a data e o valor do presente.</p></div></div><div class="help-step"><span class="help-number">2</span><div><h3>Convide por e-mail</h3><p>Cada pessoa confirma o próprio e-mail e aceita o convite. Quem organiza acompanha os envios e as confirmações.</p></div></div><div class="help-step"><span class="help-number">3</span><div><h3>Deixe a surpresa acontecer</h3><p>Com pelo menos 3 participantes confirmados, quem organiza pode fazer o sorteio. Uma única corrente conecta todo o grupo: ninguém tira a si mesmo, todos dão e recebem um presente.</p></div></div><p>Seu resultado é privado. Você pode consultá-lo na sua conta e recebe o nome por e-mail.</p><button class="btn btn-primary btn-block" data-action="close-dialog">Entendi ${icon('arrow-right', 16)}</button></div>`;
  dialog.showModal();
}
async function logout(keepInvitation = false) {
  const invite = keepInvitation ? state.inviteToken : '';
  await post('/auth/logout');
  clearPrivateState(); state.user = null; state.pendingUser = null;
  clearChallenge(); resetSignupAvatar(); setInvitationToken(invite);
  if (!invite) { state.invitation = null; state.group = null; }
  state.invitation = null; state.authEmail = '';
  await navigate(keepInvitation ? 'invitation' : 'welcome', keepInvitation ? { token: invite } : {});
}
async function action(name, target) {
  switch (name) {
    case 'help': showHelp(); break;
    case 'delete-group': showDeleteGroup(); break;
    case 'admin-delete-group': await showAdminDelete('group'); break;
    case 'admin-delete-user': await showAdminDelete('user'); break;
    case 'refresh-admin': if (state.user?.isAdmin) { state.adminOverview = null; await navigate(href(route, params).slice(1), { replace: true }); } break;
    case 'close-dialog': { const dialog = target.closest('dialog'); if (dialog?.querySelector('[aria-busy="true"]')) break; dialog?.close(); break; }
    case 'retry-route': if (!sessionLoaded) await start(); else await navigate(href(route, params).slice(1), { replace: true }); break;
    case 'profile': if (state.user) await openProfileEditor(state.user, user => { if (state.user?.id !== user.id || !user.isAdmin) clearAdmin(); state.user = user; state.participants = state.participants.map(person => person.email === user.email ? { ...person, name: `${user.firstName} ${user.lastName}`, avatar: user.avatar } : person); render(); }); break;
    case 'logout': await logout(); break;
    case 'switch-account': await logout(true); break;
    case 'toggle-password': { const input = document.getElementById(target.dataset.passwordTarget); if (!input) break; const show = input.type === 'password'; input.type = show ? 'text' : 'password'; target.textContent = show ? 'Ocultar' : 'Mostrar'; target.setAttribute('aria-pressed', String(show)); target.setAttribute('aria-label', `${show ? 'Ocultar' : 'Mostrar'} senha`); break; }
    case 'use-other-email': { const form = target.closest('form'); const input = form?.elements.email; if (input) { input.value = ''; state.authEmail = ''; state.accountCheck = null; updateEmailFeedback(form); input.focus(); } break; }
    case 'register-invited': state.authMode = 'register'; state.authEmail = state.invitation?.recipientEmail || state.authEmail; await navigate('register'); break;
    case 'login-invited': state.authMode = 'login'; state.authEmail = state.invitation?.recipientEmail || state.authEmail; await navigate('login'); break;
    case 'resend-code': {
      if (Date.now() < state.resendAt) return;
      const email = state.challenge?.email || state.pendingUser?.email;
      if (!email) { await navigate('login'); return; }
      const recovering = state.authMode === 'recover';
      const result = await post(recovering ? '/auth/password/request' : '/auth/request', { email, ...(!recovering ? { challengeId: state.challenge.challengeId } : {}), ...(state.inviteToken ? { inviteToken: state.inviteToken } : {}) });
      saveChallenge({ ...result, email: result.email || email }); await navigate('verify'); toast(recovering ? 'Se o e-mail estiver cadastrado, um novo código chegará em instantes.' : 'Um novo código está a caminho do seu e-mail.'); break;
    }
    case 'accept-dashboard-invite': {
      const groupId = target.dataset.groupId;
      if (!state.user || state.acceptingInvitationId || !state.pendingInvitations.some(invitation => invitation.group?.id === groupId)) return;
      const navigation = version, userId = state.user.id;
      const stillCurrent = () => navigation === version && state.user?.id === userId;
      let accepted = false;
      state.acceptingInvitationId = groupId; delete state.dashboardInvitationErrors[groupId]; render();
      try {
        await post(`/groups/${segment(groupId)}/accept`);
        if (!stillCurrent()) return;
        accepted = true;
        state.pendingInvitations = state.pendingInvitations.filter(invitation => invitation.group?.id !== groupId);
        if (state.invitation?.group?.id === groupId) { state.invitation = null; setInvitationToken(''); }
        const dashboard = await api('/groups');
        if (!stillCurrent()) return;
        rememberDashboard(dashboard);
        await navigate('group', { id: groupId });
        toast('Convite aceito. Você já faz parte desse amigo secreto!');
      } catch (error) {
        if (!stillCurrent()) return;
        if (error.status === 401) { state.user = null; clearPrivateState(); await navigate('login', { replace: true }); toast(errorMessage(error)); return; }
        if (accepted) { await navigate('group', { id: groupId }); toast('Convite aceito. A lista será atualizada quando você voltar aos seus grupos.'); }
        else if (['INVITATION_EXPIRED', 'INVITATION_CLOSED', 'CLOSED', 'EMAIL_MISMATCH', 'NOT_INVITED'].includes(error.code)) { state.acceptingInvitationId = ''; await navigate('dashboard', { replace: true }); toast(errorMessage(error)); }
        else { state.dashboardInvitationErrors[groupId] = errorMessage(error); }
      } finally {
        if (state.user?.id === userId && state.acceptingInvitationId === groupId) {
          state.acceptingInvitationId = '';
          if (stillCurrent() && ['dashboard', 'dashboard-empty'].includes(route)) render();
          else document.querySelectorAll('[data-action="accept-dashboard-invite"]').forEach(button => { button.disabled = false; button.setAttribute('aria-busy', 'false'); button.innerHTML = `${icon('check', 17)} Aceitar convite`; });
        }
      }
      break;
    }
    case 'accept-invite': {
      if (!state.user) { await navigate('register'); return; }
      if (!state.inviteToken) throw new ApiError('INVITATION_EXPIRED', 'Abra novamente seu convite por e-mail.');
      try {
        const result = await post(`/invitations/${segment(state.inviteToken)}/accept`);
        state.group = result.group || result; state.invitationError = ''; setInvitationToken('');
        await navigate('invitation-accepted', { id: state.group.id });
      } catch (error) {
        if (['EMAIL_MISMATCH', 'NOT_INVITED'].includes(error.code)) { state.invitationError = errorMessage(error); state.invitationErrorCode = error.code; render(); }
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
const handledActions = new Set(['help', 'delete-group', 'admin-delete-group', 'admin-delete-user', 'refresh-admin', 'close-dialog', 'toggle-password', 'use-other-email', 'retry-route', 'profile', 'logout', 'switch-account', 'register-invited', 'login-invited', 'resend-code', 'accept-invite', 'accept-dashboard-invite', 'run-draw', 'reveal', 'hide-result', 'resend-invite', 'retry-notifications', 'refresh-group']);
document.addEventListener('click', async event => {
  const skip = event.target.closest('.skip-link');
  if (skip) { event.preventDefault(); const main = document.querySelector('#main'); main?.setAttribute('tabindex', '-1'); main?.focus(); main?.scrollIntoView(); return; }
  const target = event.target.closest('[data-route],[data-action]');
  if (!target || target.disabled) return;
  if (target.tagName === 'A' && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)) return;
  if (target.dataset.route) { event.preventDefault(); if (busyDraw) return; rememberAuthEmail(); await navigate(target.dataset.route, { id: target.dataset.adminId || target.dataset.groupId || undefined }); return; }
  const name = target.dataset.action;
  if (!handledActions.has(name)) return;
  event.preventDefault();
  if (pendingActions.has(name)) return;
  pendingActions.add(name); target.disabled = true;
  try { await action(name, target); }
  catch (error) {
    if (name === 'resend-code' && error.retryAfter) { state.resendAt = Date.now() + error.retryAfter * 1000; if (state.challenge) { state.challenge.resendAt = state.resendAt; storage.set(CHALLENGE_KEY, JSON.stringify(state.challenge)); } }
    if (error.status === 401) { state.user = null; clearPrivateState(); await navigate('login'); }
    toast(errorMessage(error));
  }
  finally { pendingActions.delete(name); if (target.isConnected) target.disabled = false; updateCountdown(); }
});
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target !== dialog || dialog.querySelector('[aria-busy="true"]')) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); }));
function navigateFromHistory() {
  // Bootstrap reads the latest hash after the session response arrives.
  if (!sessionLoaded || busyDraw || location.hash === '#main') return;
  const next = parseHash();
  const destination = href(next.route, next.params);
  if (destination === href(route, params)) return;
  void navigate(destination.slice(1), { replace: true });
}
window.addEventListener('popstate', navigateFromHistory);
window.addEventListener('hashchange', navigateFromHistory);
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
