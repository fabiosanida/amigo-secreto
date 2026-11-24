import { avatar, escapeHtml, icon } from './ui.js';

let webauthn;
export function supportsPasskeys() {
  return Boolean(window.isSecureContext && window.PublicKeyCredential && window.navigator?.credentials);
}

export async function usePasskey(post, kind, stillCurrent) {
  webauthn ||= await import('./webauthn/index.js');
  if (!stillCurrent()) return;
  const endpoint = `/auth/passkeys/${kind}`;
  const { options, challengeId } = await post(`${endpoint}/options`);
  if (!stillCurrent()) return;
  let credential;
  try {
    credential = kind === 'register' ? await webauthn.startRegistration({ optionsJSON: options })
      : await webauthn.startAuthentication({ optionsJSON: options });
  } catch {
    throw new Error(kind === 'register'
      ? 'O cadastro da chave não foi concluído. Você pode tentar novamente ou continuar.'
      : 'Não foi possível entrar com a chave de acesso. Tente novamente ou use sua senha.');
  }
  if (stillCurrent()) return post(`${endpoint}/verify`, { challengeId, credential });
}

export function cancelPasskey() {
  webauthn?.WebAuthnAbortService.cancelCeremony();
}

export function renderPasskeyOffer() {
  return `<section class="account-tool-panel">
    <span class="auth-form-symbol">${icon('lock', 23)}</span>
    <h2 id="passkey-offer-title">Cadastre uma chave de acesso</h2>
    <p>Na próxima vez, entre com a biometria, o PIN do dispositivo ou a chave salva no seu gerenciador de senhas.</p>
    <p class="account-tool-error" data-passkey-error role="alert" hidden></p>
    <div class="account-tool-actions">
      <button type="button" class="btn btn-secondary" data-action="close-dialog">Agora não</button>
      <button type="button" class="btn btn-primary" data-action="register-passkey">Cadastrar chave</button>
    </div>
  </section>`;
}

export function renderViewAsBanner(user) {
  if (!user) return '';
  return `<aside class="view-as-banner" aria-label="Modo de visualização">
    <span>${icon('monitor', 18)} <span>Visualizando como <strong>${escapeHtml(`${user.firstName} ${user.lastName}`)}</strong> · Somente leitura</span></span>
    <button type="button" class="btn btn-secondary" data-action="exit-view-as">Voltar à minha conta</button>
  </aside>`;
}

export function renderViewAsPicker() {
  return `<section class="account-tool-panel view-as-picker">
    <header class="view-as-picker-header">
      <span class="auth-form-symbol">${icon('monitor', 23)}</span>
      <button type="button" class="btn btn-secondary wl-close" data-action="close-dialog" aria-label="Fechar seleção">${icon('x', 19)}</button>
    </header>
    <h2 id="view-as-title">Visualizar como</h2>
    <p>Escolha uma conta para conferir como o aplicativo aparece para essa pessoa.</p>
    <form class="view-as-search">
      <label for="view-as-search">Nome ou e-mail</label>
      <div><input id="view-as-search" name="search" type="search" maxlength="100" placeholder="Buscar uma pessoa" autocomplete="off">
      <button class="btn btn-primary" type="submit">Buscar</button></div>
    </form>
    <div class="view-as-results" aria-live="polite"></div>
  </section>`;
}

export function renderViewAsResults(data, currentId) {
  const users = data.users.filter(user => user.id !== currentId);
  const { page, totalPages } = data.pagination;
  return `${users.length ? `<ul class="view-as-list">${users.map((user, index) => `<li>
    <button type="button" class="view-as-person" data-action="view-as-person" data-user-id="${escapeHtml(user.id)}">
      <span aria-hidden="true">${avatar(user.name, index, 'small', null)}</span>
      <span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></span>
      ${icon('arrow-right', 16)}
    </button></li>`).join('')}</ul>` : '<p>Nenhuma outra conta encontrada nesta página.</p>'}
    ${totalPages > 1 ? `<div class="view-as-pages">
      <button type="button" class="btn btn-secondary" data-action="view-as-page" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Anterior</button>
      <span>Página ${page} de ${totalPages}</span>
      <button type="button" class="btn btn-secondary" data-action="view-as-page" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>Próxima</button>
    </div>` : ''}`;
}
