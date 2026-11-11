import { icon } from './ui.js';

const MAX_INVITES = 50;
const bindings = new WeakMap();

export function setupInviteFields(container = document) {
  container.querySelectorAll('form[data-invite-fields]').forEach(form => {
    if (bindings.has(form)) return;
    const list = form.querySelector('[data-invite-list]');
    const add = form.querySelector('[data-invite-add]');
    const count = form.querySelector('[data-invite-count]');
    const status = form.querySelector('[data-invite-status]');
    if (!list || !add) return;
    let serial = list.querySelectorAll('[data-invite-row]').length;
    const rows = () => [...list.querySelectorAll('[data-invite-row]')];
    const isBusy = () => form.getAttribute('aria-busy') === 'true';
    function refresh() {
      const current = rows();
      const busy = isBusy();
      current.forEach((row, index) => {
        row.querySelector('[data-invite-label]').textContent = `E-mail do convidado ${index + 1}`;
        const remove = row.querySelector('[data-invite-remove]');
        remove.disabled = busy || current.length <= 1;
        remove.setAttribute('aria-label', `Remover e-mail do convidado ${index + 1}`);
        remove.title = current.length <= 1 ? 'Mantenha pelo menos um e-mail' : `Remover o e-mail ${index + 1}`;
        row.querySelector('input[name="emails"]').readOnly = busy;
      });
      add.disabled = busy || current.length >= MAX_INVITES;
      if (count) count.textContent = `${current.length} de ${MAX_INVITES}`;
    }
    function announce(message) { if (status) status.textContent = message; }
    add.addEventListener('click', () => {
      if (isBusy() || rows().length >= MAX_INVITES) return;
      const id = `invite-email-${++serial}`;
      const row = document.createElement('div');
      row.className = 'invite-email-row'; row.dataset.inviteRow = '';
      row.innerHTML = `<label class="invite-email-field" for="${id}"><span data-invite-label></span><input id="${id}" name="emails" type="email" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="254" pattern="[^ @]+@[^ @]+[.][^ @]+" required placeholder="nome@exemplo.com" aria-describedby="invite-email-help"></label><button class="invite-remove-email" type="button" data-invite-remove>${icon('x', 15)}<span>Remover</span></button>`;
      list.append(row); refresh();
      row.querySelector('input').focus();
      announce(rows().length === MAX_INVITES ? 'Você chegou ao limite de 50 e-mails por envio.' : `Campo de e-mail ${rows().length} adicionado.`);
    });
    list.addEventListener('click', event => {
      const button = event.target.closest('[data-invite-remove]');
      if (!button || !list.contains(button) || isBusy() || rows().length <= 1) return;
      const current = rows();
      const row = button.closest('[data-invite-row]');
      const index = current.indexOf(row);
      row.remove(); refresh();
      const remaining = rows();
      remaining[Math.min(index, remaining.length - 1)].querySelector('input').focus();
      announce(`Campo removido. ${remaining.length === 1 ? 'Resta um e-mail' : `Restam ${remaining.length} e-mails`} na lista.`);
    });
    list.addEventListener('focusout', event => {
      if (event.target.matches('input[name="emails"]') && !isBusy()) event.target.value = event.target.value.trim();
    });
    bindings.set(form, refresh); refresh();
  });
}

export function setInviteFieldsBusy(form, busy) {
  if (!form.matches('[data-invite-fields]')) return;
  form.setAttribute('aria-busy', String(busy));
  bindings.get(form)?.();
}
