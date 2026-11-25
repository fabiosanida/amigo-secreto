import { avatar, icon, escapeHtml } from './ui.js';

const escape = escapeHtml;
const memberName = person => person?.name || 'Participante';
const displayName = name => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')
  .replace(/(?<![\p{L}\p{M}])\p{L}/gu, letter => letter.toLocaleUpperCase('pt-BR'));
const option = person => `<option value="${escape(person.id)}">${escape(memberName(person))}${person.isDependent || person.dependentId ? ` · dependente${person.responsibleName ? ` de ${escape(person.responsibleName)}` : ''}` : ''}</option>`;
const jar = (tone = 'berry', index = 0) => `<svg class="jam-character jam-${tone}" viewBox="0 0 230 270" aria-hidden="true"><g class="jam-arms"><path d="M48 143 21 116 10 127M181 143l25-29 13 10" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><path d="m21 116 5-17m-5 17L9 105m197 9-2-16m2 16 15-8" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/></g><path d="m79 218-9 27-20 1m100-28 10 27 20 1" fill="none" stroke="currentColor" stroke-width="13" stroke-linecap="round"/><rect x="49" y="55" width="132" height="166" rx="34" fill="var(--jam-fill)" stroke="currentColor" stroke-width="7"/><path d="M54 86h122v54c-12 17-26-17-39 0s-30-14-43 1-25-9-40 5Z" fill="var(--jam-drip)"/><rect x="43" y="35" width="145" height="38" rx="12" fill="var(--jam-lid)" stroke="currentColor" stroke-width="7"/><path d="M65 42v22m23-22v22m23-22v22m23-22v22m23-22v22" stroke="currentColor" stroke-width="4" opacity=".3"/><ellipse cx="90" cy="125" rx="17" ry="23" fill="#fff9e8"/><ellipse cx="142" cy="125" rx="17" ry="23" fill="#fff9e8"/><circle cx="${index % 2 ? 94 : 84}" cy="127" r="7" fill="currentColor"/><circle cx="${index % 2 ? 145 : 138}" cy="122" r="7" fill="currentColor"/><path d="M79 91q13-13 25 0m26-1q14-10 24 3" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><ellipse cx="115" cy="150" rx="9" ry="7" fill="var(--jam-drip)"/><path d="M87 164q28 39 58-2" fill="#fff9e8" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="m105 171 0 10m14-9 0 13m13-17 2 10" stroke="currentColor" stroke-width="3"/><path d="m67 181 8 8m82-4 6-10" stroke="var(--jam-drip)" stroke-width="7" stroke-linecap="round"/><path d="M76 206h78" stroke="#fff9e8" stroke-width="5" stroke-linecap="round" opacity=".65"/></svg>`;

export function renderMarmelada(state) {
  const data = state.marmeladaData || {}, group = data.group, people = data.participants || [], groups = data.groups || [];
  const page = data.pagination?.page || 1, totalPages = data.pagination?.totalPages || 1;
  const pageRoute = next => `admin-marmelada?${new URLSearchParams({ page: String(next), ...(state.marmeladaSearch ? { search: state.marmeladaSearch } : {}) })}`;
  return `<section class="admin-page marmelada-page"><a class="group-back" href="#admin" data-route="admin">${icon('arrow-left', 16)} Administração</a><div class="admin-title-row"><div><span class="eyebrow">O MOMENTO DA VERDADE</span><h1>Marmelada<span>?</span></h1><p>Uma conferência, uma revelação. E um pouco de diversão.</p></div><span class="admin-private-label">${icon('lock', 14)} Acesso exclusivo da sua conta</span></div><div class="marmelada-layout"><section class="panel marmelada-form-card">${group ? `<a class="marmelada-change" href="#admin-marmelada" data-route="admin-marmelada">${icon('arrow-left', 14)} Escolher outro grupo</a><div class="marmelada-current-group"><span>${icon('gift', 22)}</span><div><small>AMIGO SECRETO SELECIONADO</small><h2>${escape(group.name)}</h2><p>${people.length} participantes no sorteio</p></div></div><form data-form="marmelada-check" class="marmelada-check-form"><label class="field" for="marmelada-giver"><span class="marmelada-step">01</span> Quem vai revelar?<select id="marmelada-giver" name="giverId" required><option value="">Escolha uma pessoa</option>${people.map(option).join('')}</select></label><label class="field" for="marmelada-receiver"><span class="marmelada-step">02</span> Quem essa pessoa diz que tirou?<select id="marmelada-receiver" name="receiverId" required><option value="">Escolha o nome anunciado</option>${people.map(option).join('')}</select></label><div class="marmelada-check-note">${icon('info', 17)}<p>Selecione os dois nomes e clique em Conferir. O resultado será apresentado em tela cheia, sem revelar outros pares.</p></div><button type="submit" class="btn btn-primary btn-block marmelada-check-button">${icon('sparkles', 19)} Conferir</button></form>` : `<div class="marmelada-pick-title"><span class="marmelada-step">01</span><h2>Escolha o encontro.</h2><p>São exibidos apenas grupos com sorteio realizado.</p></div><form class="admin-search marmelada-search" data-form="marmelada-search"><label for="marmelada-search">Buscar grupo</label><div><span>${icon('search', 17)}</span><input id="marmelada-search" name="search" type="search" value="${escape(state.marmeladaSearch || '')}" maxlength="100" placeholder="Nome do amigo secreto"><button class="btn btn-primary" type="submit">Buscar</button></div></form><div class="marmelada-group-list">${groups.map(item => `<button class="marmelada-group-option" data-route="admin-marmelada" data-admin-id="${escape(item.id)}"><span class="marmelada-group-icon">${icon('gift', 20)}</span><span><strong>${escape(item.name)}</strong><small>${Number(item.participantCount || 0)} participantes no sorteio</small></span>${icon('arrow-right', 18)}</button>`).join('') || `<div class="admin-empty">${icon('gift', 26)}<p>${state.marmeladaSearch ? 'Nenhum grupo sorteado corresponde à busca.' : 'Os grupos aparecerão aqui depois do primeiro sorteio.'}</p></div>`}</div><div class="admin-pagination"><span>Página ${page} de ${totalPages}</span><div><button class="btn btn-secondary" data-route="${escape(pageRoute(page - 1))}" ${page <= 1 ? 'disabled' : ''}>Anterior</button><button class="btn btn-secondary" data-route="${escape(pageRoute(page + 1))}" ${page >= totalPages ? 'disabled' : ''}>Próxima</button></div></div>`}</section><aside class="marmelada-intro-art"><div class="marmelada-art-sticker">NÃO VALE<br>ENROLAR!</div><span class="marmelada-art-spark marmelada-art-spark-one">✳</span>${jar('berry', 0)}<span class="marmelada-art-spark marmelada-art-spark-two">✦</span><h2>Será que<br>é <em>marmelada?</em></h2><p>Se conferiu, é festa.<br>Se não conferiu… a gente avisa!</p><span class="marmelada-art-footnote">O SORTEIO ORIGINAL CONTINUA INTACTO</span></aside></div></section>`;
}

function participantTags(name, people) {
  return `<div class="marmelada-people">${people.map((person, index) => `<label class="marmelada-person">
    <input type="radio" name="${name}" value="${escape(person.id)}" data-person-name="${escape(person.name)}" required>
    <span class="marmelada-person-tag">
      <span class="marmelada-person-photo" aria-hidden="true">${avatar(person.name, index, '', person.avatar)}</span>
      <span>${escape(person.name)}</span>${icon('check', 15)}
    </span>
  </label>`).join('')}</div>`;
}

export function renderGroupMarmelada({ group, participants } = {}, { delegated = false } = {}) {
  if (!group) return '';
  const groupRoute = `group?${new URLSearchParams({ id: group.id })}`;
  const people = participants.map(person => ({ ...person, name: displayName(memberName(person)) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return `<section class="marmelada-page group-marmelada-page">
    <a class="group-back" href="#${groupRoute}" data-route="${groupRoute}">${icon('arrow-left', 16)} Voltar para o grupo</a>
    <div class="admin-title-row">
      <div><span class="eyebrow">${escape(group.name)}</span><h1>É Marmelada<span>?</span></h1><p>Confira a revelação na hora da entrega dos presentes.</p></div>
      <button type="button" class="btn btn-secondary" data-action="marmelada-tv">${icon('monitor', 18)} Tela cheia</button>
    </div>
    <div class="marmelada-layout">
      <section class="panel marmelada-form-card">
        <form data-form="group-marmelada-check" class="marmelada-check-form">
          <fieldset class="field marmelada-people-field" id="group-marmelada-giver">
            <legend><span class="marmelada-step">01</span> Quem vai revelar?</legend>
            ${participantTags('giverId', people)}
          </fieldset>
          <fieldset class="field marmelada-people-field" id="group-marmelada-receiver" disabled>
            <legend><span class="marmelada-step">02</span> Quem essa pessoa diz que tirou?</legend>
            ${participantTags('receiverId', people)}
          </fieldset>
          <div class="field">
            <label for="group-marmelada-token"><span class="marmelada-step">03</span> <span data-token-owner>Token da pessoa da etapa 2</span></label>
            <input id="group-marmelada-token" name="token" type="password" inputmode="numeric" pattern="[0-9]{8}"
              autocomplete="off" required disabled aria-describedby="group-marmelada-help">
          </div>
          <div class="marmelada-check-note" id="group-marmelada-help">${icon('info', 17)}
            <p>Peça à pessoa da etapa 2 o código de oito dígitos que aparece abaixo de <strong>Sorteio realizado</strong> na página do grupo.
              ${delegated ? '<strong>Esta conferência também consome o token.</strong>' : 'Cada token vale para uma conferência.'}</p>
          </div>
          <button type="submit" class="btn btn-primary btn-block marmelada-check-button" disabled>${icon('sparkles', 19)} Conferir</button>
        </form>
      </section>
      <aside class="marmelada-intro-art">${jar('berry')}<h2>Será que<br>é <em>marmelada?</em></h2><p>A tela mostra o veredito<br>sobre o nome anunciado.</p></aside>
    </div>
  </section>`;
}

export function syncGroupMarmeladaForm(form) {
  const { token } = form.elements;
  const giver = form.querySelector('input[name="giverId"]:checked');
  const receiver = form.querySelector('input[name="receiverId"]:checked');
  const busy = form.getAttribute('aria-busy') === 'true';
  form.querySelector('#group-marmelada-giver').disabled = busy;
  form.querySelector('#group-marmelada-receiver').disabled = busy || !giver;
  for (const choice of form.querySelectorAll('input[name="receiverId"]')) {
    choice.disabled = choice.value === giver?.value;
  }
  form.querySelector('[data-token-owner]').textContent = receiver
    ? `Token de ${receiver.dataset.personName}` : 'Token da pessoa da etapa 2';
  token.disabled = busy || !giver || !receiver || giver.value === receiver.value;
  form.querySelector('[type="submit"]').disabled = token.disabled || !/^\d{8}$/.test(token.value);
}

export function setupGroupMarmeladaForm(form) {
  if (!form) return;
  form.addEventListener('change', ({ target }) => {
    if (target.name !== 'giverId' && target.name !== 'receiverId') return;
    if (target.name === 'giverId') {
      const receiver = form.querySelector('input[name="receiverId"]:checked');
      if (receiver?.value === target.value) receiver.checked = false;
    }
    form.elements.token.value = '';
    form.querySelector('.form-error')?.remove();
    syncGroupMarmeladaForm(form);
  });
  form.elements.token.addEventListener('input', ({ target }) => {
    const digits = target.value.replace(/\D/g, '').slice(0, 8);
    if (target.value !== digits) target.value = digits;
    syncGroupMarmeladaForm(form);
  });
  syncGroupMarmeladaForm(form);
}

export function ownMarmeladaParticipants(state) {
  const userId = state.user?.id;
  if (!userId || !state.drawn) return [];
  return (state.participants || []).filter(person => person.status === 'accepted' && !person.isRemoved
    && (person.userId === userId || (person.isDependent && person.guardianId === userId)));
}

export function renderMarmeladaTokenValue(item) {
  if (item.used) return '<span class="marmelada-token-status">Token já usado</span>';
  const { token } = item;
  return `<strong class="marmelada-token-code">${escape(token.slice(0, 4))} ${escape(token.slice(4))}</strong>`;
}

export function renderMarmeladaTokenList(people, tokens) {
  const ordered = [...people].sort((a, b) => Number(Boolean(a.isDependent)) - Number(Boolean(b.isDependent)));
  return `<ul class="marmelada-token-list">${ordered.map((person, index) => {
    const name = displayName(memberName(person));
    return `<li>
      <span aria-hidden="true">${avatar(name, person.color ?? index, '', person.avatar)}</span>
      <span class="marmelada-token-person"><strong>${escape(name)}</strong><small>${person.isDependent ? 'Dependente' : 'Titular'}</small></span>
      ${renderMarmeladaTokenValue(tokens.get(person.id))}
    </li>`;
  }).join('')}</ul>`;
}

export function renderMarmeladaTokenDialog() {
  return `<section class="account-tool-panel">
    <span class="auth-form-symbol">${icon('lock', 23)}</span>
    <h2 id="marmelada-token-title">Meus tokens da troca</h2>
    <p>Cada código vale para uma conferência. Na hora da troca, informe o token da pessoa anunciada como destinatária do presente.</p>
    <div data-marmelada-tokens="list" aria-live="polite"><span class="marmelada-token-status">Carregando…</span></div>
    <div class="account-tool-actions">
      <button type="button" class="btn btn-secondary" data-action="close-dialog">Fechar</button>
    </div>
  </section>`;
}

export function renderMarmeladaResult(result) {
  const correct = result.matches === true;
  const confetti = Array.from({ length: 44 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--delay:${(i % 9) * -.6}s;--duration:${4 + i % 5}s;--turn:${i % 2 ? 125 : -75}deg;--color:${['#f5cd62', '#ed7d61', '#a7e6a6', '#fff8d5', '#63d9bb'][i % 5]}" aria-hidden="true"></i>`).join('');
  const balloons = Array.from({ length: 8 }, (_, i) => `<span class="marmelada-balloon" style="--x:${4 + (i * 13) % 96}%;--delay:${-i * .8}s;--balloon:${['#f5cd62', '#ed7d61', '#abdfb4', '#75cbb8'][i % 4]};--tilt:${i % 2 ? 12 : -12}deg" aria-hidden="true"></span>`).join('');
  return `<div class="marmelada-stage ${correct ? 'marmelada-correct' : 'marmelada-wrong'}"><div class="marmelada-presentation-top"><span>${icon('gift', 17)} amigo secreto<span class="marmelada-top-dot">.</span></span><button type="button" class="marmelada-stage-close" data-marmelada-action="close" aria-label="Fechar apresentação">${icon('x', 24)}</button></div>${correct ? `<div class="marmelada-confetti">${confetti}</div><div class="marmelada-balloons">${balloons}</div>` : `<div class="marmelada-stamp-row marmelada-stamp-top" aria-hidden="true"><span>É MARMELADA! · É MARMELADA! · É MARMELADA! ·</span></div><div class="marmelada-jam-crew" aria-hidden="true">${jar('peach', 1)}${jar('berry', 0)}${jar('lime', 1)}</div><div class="marmelada-stamp-row marmelada-stamp-bottom" aria-hidden="true"><span>É MARMELADA! · É MARMELADA! · É MARMELADA! ·</span></div>`}<main class="marmelada-presentation-content"><span class="marmelada-result-kicker">${correct ? 'PODE ENTREGAR O PRESENTE' : 'OPA, ESSE NOME NÃO CONFERE'}</span>${correct ? `<span class="marmelada-success-seal">${icon('check', 46)}</span>` : ''}<h1 id="marmelada-result-title">${correct ? 'É ISSO<span>MESMO!</span>' : 'É <span>MARMELADA!</span>'}</h1><p class="marmelada-result-line">${correct ? 'O amigo secreto é esse mesmo. Pode comemorar!' : 'Não confere com o sorteio original.'}</p><div class="marmelada-announced-pair"><span>${escape(memberName(result.giver))}</span>${icon('arrow-right', 20)}<span>${escape(memberName(result.receiver))}</span></div><p class="marmelada-result-group">${escape(result.group?.name || '')}</p>${correct ? '' : '<p class="marmelada-result-secret">O nome verdadeiro continua guardado.</p>'}</main><footer class="marmelada-presentation-controls"><button type="button" class="btn marmelada-fullscreen-button" data-marmelada-action="fullscreen">${icon('grid', 17)} Tela cheia</button><button type="button" class="btn marmelada-next-button" data-marmelada-action="again">Nova conferência ${icon('arrow-right', 18)}</button><p data-fullscreen-status aria-live="polite">Esc para sair · Pronto para compartilhar na TV</p></footer></div>`;
}

export function showMarmeladaResult(result) {
  const dialog = document.querySelector('#marmelada-result-dialog');
  if (!dialog) return;
  dialog.innerHTML = renderMarmeladaResult(result);
  const stage = dialog.querySelector('.marmelada-stage');
  const fullscreenButton = dialog.querySelector('[data-marmelada-action="fullscreen"]');
  const status = dialog.querySelector('[data-fullscreen-status]');
  const exit = async () => {
    if (document.fullscreenElement === stage) { try { await document.exitFullscreen(); } catch {} }
    dialog.close();
  };
  const fullscreenChanged = () => { fullscreenButton.innerHTML = `${icon('grid', 17)} ${document.fullscreenElement === stage ? 'Sair da tela cheia' : 'Tela cheia'}`; };
  const click = async event => {
    const button = event.target.closest('[data-marmelada-action]');
    if (!button) return;
    if (button.dataset.marmeladaAction !== 'fullscreen') { await exit(); return; }
    if (document.fullscreenElement === stage) { try { await document.exitFullscreen(); } catch {} return; }
    try {
      if (!stage.requestFullscreen) throw new Error('Unavailable');
      await stage.requestFullscreen();
      status.textContent = 'Esc para sair da tela cheia';
    } catch { status.textContent = 'A apresentação já ocupa toda a janela. A tela cheia não está disponível neste navegador.'; }
  };
  dialog.addEventListener('click', click);
  document.addEventListener('fullscreenchange', fullscreenChanged);
  dialog.addEventListener('close', () => {
    if (document.fullscreenElement === stage) void document.exitFullscreen().catch(() => {});
    dialog.removeEventListener('click', click); document.removeEventListener('fullscreenchange', fullscreenChanged);
    dialog.replaceChildren();
  }, { once: true });
  dialog.showModal();
  dialog.querySelector('[data-marmelada-action="again"]')?.focus();
}
