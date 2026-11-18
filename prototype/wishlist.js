import { icon, avatar, escapeHtml } from './ui.js';

export const WISHLIST_ROUTES = ['wishlist'];
const escape = escapeHtml;
const personName = person => person?.name || [person?.firstName, person?.lastName].filter(Boolean).join(' ');
const groupRoute = state => `group?id=${encodeURIComponent(state.group?.id || '')}`;
const editorRoute = (state, dependentId = '') => `wishlist?${new URLSearchParams({ id: state.group?.id || '', ...(dependentId ? { dependentId } : {}) })}`;
const glyph = name => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${name === 'edit' ? '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z"/>' : name === 'external' ? '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>' : '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>'}</svg>`;

export function emptyWishlistItem() { return { id: crypto.randomUUID(), text: '', url: '' }; }
export function wishlistDirty(wishlist) {
  if (!wishlist) return false;
  return Boolean(wishlist.deletedIds?.length || wishlist.items?.some(item => {
    const previous = wishlist.originals?.[item.id];
    return wishlist.attemptedIds?.includes(item.id) || !previous || item.text !== previous.text || item.url !== previous.url;
  }));
}
export function validateWishlistItem(item) {
  if (!item.text?.trim()) return 'Descreva o presente ou remova este item antes de salvar.';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(item.text)) return 'A descrição tem caracteres inválidos. Digite o texto novamente.';
  if (item.text.trim().length > 2000) return 'Use até 2.000 caracteres para descrever este presente.';
  const value = item.url?.trim();
  if (value) {
    try {
      const url = new URL(value);
      if (value.length > 2048 || url.href.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\s\\\u0000-\u0020\u007f]/.test(value)) throw new Error();
    } catch { return 'Use um link completo começando com https:// ou http://.'; }
  }
  return '';
}

export function renderWishlistCard(state) {
  if (!state.production || !state.group?.id || !state.participants?.some(person => person.userId === state.user?.id && person.status === 'accepted')) return '';
  return `<section class="wl-own-card ${state.drawn ? 'is-featured' : ''}" aria-labelledby="wishlist-card-title"><span class="wl-own-symbol">${icon(state.drawn ? 'sparkles' : 'gift', 27)}</span><div class="wl-own-copy"><small>${state.drawn ? 'JÁ TEM ALGUÉM PENSANDO NO SEU PRESENTE' : 'PISTAS PARA UMA BOA SURPRESA'}</small><h2 id="wishlist-card-title">O que faria você sorrir?</h2><p>${state.drawn ? 'Ajude quem tirou você a escolher. Deixe suas sugestões para este grupo e faça a surpresa ter a sua cara.' : 'Conte o que gostaria de ganhar neste grupo. Você pode incluir quantas ideias quiser e adicionar um link em cada uma.'}</p></div><div class="wl-own-actions"><a class="btn ${state.drawn ? 'wl-btn-coral' : 'btn-secondary'}" href="#${editorRoute(state)}" data-route="${editorRoute(state)}">${glyph('edit')} Minhas sugestões</a><small>Uma lista só para este grupo.</small></div></section>`;
}

export function renderWishlists(route, state) {
  if (route !== 'wishlist') return null;
  const list = state.wishlist;
  if (!list) return '';
  const dependent = Boolean(list.dependentId), owner = personName(list.owner);
  // The personal catalog is paginated; the authorized roster contains every
  // dependent participating in this group, including those on later pages.
  const active = Array.isArray(state.participants)
    ? state.participants.filter(person => state.user?.id && person.dependentId && person.guardianId === state.user.id && person.status === 'accepted')
      .map(person => ({ id: person.dependentId, name: person.name }))
    : (state.ownDependents || []).filter(person => person.active);
  const disabled = list.busy ? 'disabled' : '';
  return `<section class="wl-editor-page"><a class="group-back" href="#${groupRoute(state)}" data-route="${groupRoute(state)}">${icon('arrow-left', 16)} Voltar para o grupo</a><div class="wl-editor-heading"><span class="eyebrow">${escape(state.group?.name)}</span><h1>${dependent ? `Os desejos de ${escape(list.owner?.firstName || owner)}` : 'O que faria você sorrir?'}${dependent ? '<span>.</span>' : ''}</h1><p>${dependent ? 'Deixe algumas pistas para quem vai presentear seu dependente.' : 'Um livro, uma cor, um tamanho, uma ideia. Conte o que você gostaria de ganhar.'} Esta lista vale apenas para este amigo secreto e pode ser atualizada a qualquer momento.</p></div>${active.length ? `<nav class="wl-person-switch" aria-label="Lista de presentes de quem"><a class="${dependent ? '' : 'is-active'}" href="#${editorRoute(state)}" data-route="${editorRoute(state)}" ${!dependent ? 'aria-current="page"' : ''}>${icon('heart', 16)} Minha lista</a>${active.map(person => `<a class="${list.dependentId === person.id ? 'is-active' : ''}" href="#${editorRoute(state, person.id)}" data-route="${editorRoute(state, person.id)}" ${list.dependentId === person.id ? 'aria-current="page"' : ''}>${icon('users', 16)} ${escape(personName(person))}</a>`).join('')}</nav>` : ''}<div class="wl-editor-grid"><form class="wl-form" data-form="wishlist-save" aria-busy="${Boolean(list.busy)}" novalidate><h2>${dependent ? `Sugestões de ${escape(list.owner?.firstName || owner)}` : 'Minhas sugestões'}</h2><p>Uma ideia por item. O link é opcional.</p>${list.error ? `<p class="wl-error" role="alert">${escape(list.error)}</p>` : ''}<div class="wl-items">${list.items.map((item, index) => renderWishlistItem(item, index, list)).join('')}</div>${!list.items.length ? `<div class="wl-empty-editor">${icon('gift', 29)}<h3>Seu primeiro desejo começa aqui.</h3><p>Adicione uma ideia para ajudar na escolha do presente.</p></div>` : ''}${list.nextCursor ? `<button type="button" class="btn btn-secondary wl-more" data-action="wishlist-more" ${list.busy || list.loadingMore ? 'disabled' : ''}>${icon('chevron-down', 17)} ${list.loadingMore ? 'Carregando…' : 'Mostrar mais sugestões salvas'}</button>` : ''}<button type="button" class="btn wl-add" data-action="wishlist-add" ${disabled}>${icon('plus', 18)} Adicionar sugestão</button><footer class="wl-editor-footer"><p>${icon('lock', 14)} ${dependent ? 'Quem tirar seu dependente poderá ver estas sugestões após o sorteio.' : 'Quem tirar você poderá ver estas sugestões após o sorteio.'}</p><a class="btn btn-secondary" href="#${groupRoute(state)}" data-route="${groupRoute(state)}">Voltar</a><button type="submit" class="btn btn-primary" ${disabled}>${icon(list.busy ? 'clock' : 'check', 18)} ${list.busy ? 'Salvando…' : 'Salvar sugestões'}</button></footer></form><aside class="wl-editor-aside"><div class="wl-tip-card">${icon('sparkles', 29)}<h2>Uma boa pista faz diferença.</h2><p>Vale indicar algo específico ou só dar uma direção.</p><ul><li>Seu tamanho, sua cor favorita ou um estilo que você gosta.</li><li>Um hobby, um autor ou algo que está na sua lista de desejos.</li><li>Um link para servir de referência, se achar útil.</li></ul></div><div class="wl-budget-note">${icon('gift', 23)}<p><strong>${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(state.group?.budget) || 0)}</strong>Este é o valor sugerido para os presentes do grupo. As suas ideias são uma inspiração.</p></div><div class="wl-private-note">${icon('shield', 18)}<p>As sugestões não revelam quem tirou quem. O sorteio continua em segredo.</p></div></aside></div></section>`;
}

function renderWishlistItem(item, index, list) {
  return `<article class="wl-item ${item.error ? 'is-invalid' : ''}" data-wishlist-item="${escape(item.id)}"><div class="wl-item-top"><span class="wl-number">${index + 1}</span><h3>Sugestão de presente</h3><button type="button" class="wl-remove" data-action="wishlist-remove" data-item-id="${escape(item.id)}" aria-label="Remover sugestão ${index + 1}" ${list.busy ? 'disabled' : ''}>${glyph('trash')} Remover</button></div><label class="field" for="wish-text-${escape(item.id)}">O que gostaria de ganhar?<textarea id="wish-text-${escape(item.id)}" data-wish-field="text" required maxlength="2000" placeholder="Ex.: um livro de mistério. Gosto de histórias com finais surpreendentes." ${item.error && item.errorField !== 'url' ? `aria-invalid="true" aria-describedby="wish-error-${escape(item.id)}"` : ''} ${list.busy ? 'disabled' : ''}>${escape(item.text)}</textarea></label><label class="field" for="wish-url-${escape(item.id)}">Link do presente <span>opcional</span><input id="wish-url-${escape(item.id)}" data-wish-field="url" type="url" inputmode="url" autocomplete="off" maxlength="2048" placeholder="https://" value="${escape(item.url)}" ${item.error && item.errorField === 'url' ? `aria-invalid="true" aria-describedby="wish-error-${escape(item.id)}"` : ''} ${list.busy ? 'disabled' : ''}></label>${item.error ? `<p class="wl-field-error" id="wish-error-${escape(item.id)}" role="alert">${escape(item.error)}</p>` : ''}</article>`;
}

export function setupWishlistFields(root, wishlist) {
  if (!wishlist) return;
  root?.querySelectorAll('[data-wish-field]').forEach(input => input.addEventListener('input', () => {
    const item = wishlist.items.find(candidate => candidate.id === input.closest('[data-wishlist-item]')?.dataset.wishlistItem);
    if (item) { item[input.dataset.wishField] = input.value; item.error = ''; }
  }));
}

export function renderRecipientWishlist(data, options = {}) {
  const owner = data?.owner, name = personName(owner), items = data?.items || [];
  const content = options.loading ? `<div class="wl-empty-state" aria-live="polite">${icon('gift', 34)}<h3>Preparando as pistas…</h3></div>` : options.error && !owner ? `<div class="wl-empty-state" role="alert">${icon('info', 34)}<h3>Não foi possível abrir a lista.</h3><p>${escape(options.error)}</p><button class="btn btn-secondary" data-action="wishlist-recipient" data-dependent-id="${escape(options.dependentId || '')}">Tentar novamente</button></div>` : !items.length ? `<div class="wl-empty-state">${icon('gift', 34)}<h3>As pistas ainda estão a caminho.</h3><p>${escape(owner?.firstName || name)} ainda não adicionou sugestões neste grupo. Volte mais tarde para conferir.</p></div>` : `<ol class="wl-gift-list">${items.map((item, index) => { const url = safeProductURL(item.url); return `<li class="wl-gift-card"><span class="wl-number">${index + 1}</span><p>${escape(item.text)}</p>${url ? `<a class="wl-product-link" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${glyph('external')} Ver referência <small>${escape(url.hostname.replace(/^www\./, ''))}</small></a>` : ''}</li>`; }).join('')}</ol>`;
  return `<header class="wl-dialog-header">${owner ? avatar(name, 2, '', owner.avatar ?? null) : icon('gift', 29)}<div><h2 id="wishlist-recipient-title">${owner ? `Os desejos de ${escape(owner.firstName || name)}` : 'Sugestões de presentes'}</h2><p>${escape(options.groupName || '')}</p></div><button class="wl-close" data-action="close-dialog" aria-label="Fechar sugestões">${icon('x', 22)}</button></header>${owner ? `<div class="wl-dialog-context">Ideias de <strong>${escape(name)}</strong> para inspirar o seu presente.</div>` : ''}<div class="wl-dialog-body">${content}${options.error && owner ? `<p class="wl-error" role="alert">${escape(options.error)}</p>` : ''}${data?.nextCursor ? `<button class="btn btn-secondary wl-more" data-action="wishlist-recipient-more" ${options.loadingMore ? 'disabled' : ''}>${icon('chevron-down', 17)} ${options.loadingMore ? 'Carregando…' : 'Mostrar mais sugestões'}</button>` : ''}</div><footer class="wl-dialog-footer"><p>São ideias para inspirar.<br>O carinho faz parte da surpresa.</p><button class="btn btn-primary" data-action="close-dialog">Voltar ao meu amigo secreto</button></footer>`;
}
function safeProductURL(value) {
  if (!value) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null; } catch { return null; }
}
export function showWishlistDiscard(onDiscard) {
  const dialog = document.querySelector('#wishlist-discard-dialog');
  if (!dialog) return;
  dialog.innerHTML = `<div class="wl-discard"><span class="wl-own-symbol">${icon('info', 26)}</span><h2 id="wishlist-discard-title">Guardar essas ideias?</h2><p>Você tem alterações que ainda não foram salvas. Continue editando para salvar ou saia e descarte as alterações.</p><div><button class="btn btn-secondary" data-action="close-dialog">Continuar editando</button><button class="btn btn-primary" data-discard-wishlist>Sair sem salvar</button></div></div>`;
  dialog.querySelector('[data-discard-wishlist]').addEventListener('click', () => { dialog.close(); onDiscard(); }, { once: true });
  dialog.showModal();
}
