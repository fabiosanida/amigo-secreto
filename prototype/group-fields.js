import { icon } from './ui.js';

const initialized = new WeakSet();
const weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const shortDays = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const iso = date => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
const fromISO = value => new Date(`${value}T12:00:00Z`);
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Maceio' }).format(new Date());
const longDate = value => new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(fromISO(value));
const dayLabel = value => new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(fromISO(value));
const addDays = (value, days) => { const date = fromISO(value); date.setUTCDate(date.getUTCDate() + days); return iso(date); };

export function parseBudget(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  if (/^\d+(?:[,.]\d{0,2})?$/.test(text)) return Number(text.replace(',', '.'));
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(text)) return Number(text.replaceAll('.', '').replace(',', '.'));
  return NaN;
}
function numericText(value) {
  const text = String(value).replace(/[^\d,.]/g, '');
  if (text.includes(',')) {
    const [integer, ...fraction] = text.split(',');
    return `${integer.replaceAll('.', '') || '0'},${fraction.join('').replaceAll('.', '').slice(0, 2)}`;
  }
  const separator = text.search(/[,.]/);
  if (separator < 0) return text;
  return `${text.slice(0, separator) || '0'},${text.slice(separator + 1).replace(/[,.]/g, '').slice(0, 2)}`;
}
function setupBudget(input) {
  const error = input.closest('.field').querySelector('[data-budget-error]');
  const validate = (show = false) => {
    const value = parseBudget(input.value);
    const message = !input.value.trim() ? 'Informe o valor sugerido.' : !Number.isFinite(value) ? 'Use apenas números e até duas casas decimais.' : value < 1 ? 'O valor deve ser de pelo menos R$ 1,00.' : value > 100000 ? 'O valor máximo é R$ 100.000,00.' : '';
    input.setCustomValidity(message);
    input.setAttribute('aria-invalid', message && show ? 'true' : 'false');
    if (error) error.textContent = show ? message : '';
    return !message;
  };
  input.addEventListener('beforeinput', event => {
    if (event.data && /[^\d,.]/.test(event.data) && event.inputType !== 'insertFromPaste') event.preventDefault();
  });
  input.addEventListener('input', () => {
    const clean = numericText(input.value);
    if (clean !== input.value) {
      const cursor = input.selectionStart || 0, difference = input.value.length - clean.length;
      input.value = clean; input.setSelectionRange(Math.max(0, cursor - difference), Math.max(0, cursor - difference));
    }
    validate(false);
  });
  input.addEventListener('paste', event => {
    const pasted = event.clipboardData?.getData('text');
    if (!pasted) return;
    const number = parseBudget(pasted.replace(/^\s*R\$\s*/i, '').trim());
    if (!Number.isFinite(number)) return;
    event.preventDefault();
    const insert = number.toLocaleString('pt-BR', { useGrouping: false, maximumFractionDigits: 2 });
    input.setRangeText(insert, input.selectionStart ?? 0, input.selectionEnd ?? input.value.length, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  input.addEventListener('blur', () => {
    if (validate(true)) input.value = parseBudget(input.value).toLocaleString('pt-BR', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  });
  input.addEventListener('invalid', () => validate(true));
  validate(false);
}

function setupCalendar(field) {
  const input = field.querySelector('input[name="date"]');
  const trigger = field.querySelector('[data-date-trigger]');
  const label = field.querySelector('[data-date-value]');
  const dialog = field.querySelector('[data-calendar-dialog]');
  const error = field.querySelector('[data-date-error]');
  let today = todayISO();
  let selected = /^\d{4}-\d{2}-\d{2}$/.test(input.value) && input.value >= today ? input.value : '';
  let focused = selected || today, visible = fromISO(focused), resizeController;
  const close = () => {
    if (!dialog.open) return;
    dialog.close(); trigger.setAttribute('aria-expanded', 'false');
    resizeController?.abort(); trigger.focus({ preventScroll: true });
  };
  const updateTrigger = () => {
    input.value = selected;
    label.textContent = selected ? longDate(selected) : 'Escolha uma data';
    trigger.classList.toggle('has-date', Boolean(selected));
    trigger.setAttribute('aria-label', selected ? `Data da troca: ${longDate(selected)}. Alterar data.` : 'Escolher a data da troca');
  };
  const choose = value => {
    if (value < today) return;
    selected = value; focused = value; updateTrigger();
    error.textContent = ''; trigger.removeAttribute('aria-invalid');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
  };
  const position = () => {
    if (!dialog.open) return;
    const anchor = trigger.getBoundingClientRect(), box = dialog.getBoundingClientRect();
    const width = window.innerWidth, height = window.innerHeight;
    const left = Math.max(16, Math.min(anchor.left, width - box.width - 16));
    const top = width <= 600 ? Math.max(16, (height - box.height) / 2) : anchor.bottom + box.height + 10 < height - 16 ? anchor.bottom + 10 : Math.max(16, Math.min(anchor.top - box.height - 10, height - box.height - 16));
    dialog.style.left = `${left}px`; dialog.style.top = `${top}px`;
  };
  const render = (moveFocus = false) => {
    const year = visible.getUTCFullYear(), month = visible.getUTCMonth();
    const first = new Date(Date.UTC(year, month, 1, 12));
    const start = new Date(first); start.setUTCDate(1 - first.getUTCDay());
    const monthTitle = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
    const pastMonth = iso(new Date(Date.UTC(year, month + 1, 0, 12))) < today;
    const previousDisabled = year === fromISO(today).getUTCFullYear() && month === fromISO(today).getUTCMonth() || pastMonth;
    const rows = Array.from({ length: 6 }, (_, week) => `<tr role="row">${Array.from({ length: 7 }, (_, day) => {
      const date = new Date(start); date.setUTCDate(start.getUTCDate() + week * 7 + day);
      const value = iso(date), disabled = value < today, outside = date.getUTCMonth() !== month;
      return `<td role="gridcell" aria-selected="${value === selected}"><button type="button" data-calendar-date="${value}" class="group-calendar-day${outside ? ' is-outside' : ''}${value === selected ? ' is-selected' : ''}${value === today ? ' is-today' : ''}" tabindex="${!disabled && value === focused ? '0' : '-1'}" ${disabled ? 'disabled' : ''} ${value === today ? 'aria-current="date"' : ''} aria-label="${dayLabel(value)}${value === today ? ', hoje' : ''}${value === selected ? ', selecionado' : ''}">${date.getUTCDate()}</button></td>`;
    }).join('')}</tr>`).join('');
    dialog.innerHTML = `<div class="group-calendar-content"><header class="group-calendar-heading"><div><span>UM DIA PARA ESTAR JUNTO</span><h2 id="group-calendar-title">Quando vamos nos encontrar?</h2></div><button type="button" class="group-calendar-close" data-calendar-close aria-label="Fechar calendário">${icon('x', 18)}</button></header><div class="group-calendar-navigation"><button type="button" data-calendar-month="-1" aria-label="Mês anterior" ${previousDisabled ? 'disabled' : ''}>${icon('arrow-left', 18)}</button><h3 id="group-calendar-month" aria-live="polite">${monthTitle}</h3><button type="button" data-calendar-month="1" aria-label="Próximo mês">${icon('arrow-right', 18)}</button></div><table class="group-calendar-grid" role="grid" aria-labelledby="group-calendar-month" aria-describedby="group-calendar-instructions"><thead><tr role="row">${weekdays.map((name, index) => `<th scope="col" role="columnheader" aria-label="${name}">${shortDays[index]}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table><div class="group-calendar-shortcuts"><button type="button" data-calendar-quick="today">Hoje</button><button type="button" data-calendar-quick="tomorrow">Amanhã</button><span>${icon('heart', 13)} Marque esse encontro.</span></div><p id="group-calendar-instructions" class="group-calendar-instructions">Use as setas para navegar e Enter para escolher.</p></div>`;
    position();
    if (moveFocus) dialog.querySelector(`[data-calendar-date="${focused}"]`)?.focus({ preventScroll: true });
  };
  const changeMonth = amount => {
    const year = visible.getUTCFullYear(), month = visible.getUTCMonth() + amount;
    const date = Math.min(fromISO(focused).getUTCDate(), new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate());
    focused = iso(new Date(Date.UTC(year, month, date, 12)));
    if (focused < today) focused = today;
    visible = fromISO(focused); render(true);
  };
  trigger.addEventListener('click', () => {
    today = todayISO();
    if (selected && selected < today) { selected = ''; updateTrigger(); }
    focused = selected || today; visible = fromISO(focused); render();
    dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); position();
    resizeController = new AbortController();
    window.addEventListener('resize', position, { signal: resizeController.signal });
    dialog.querySelector(`[data-calendar-date="${focused}"]`)?.focus({ preventScroll: true });
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button?.dataset.calendarDate) choose(button.dataset.calendarDate);
    else if (button?.dataset.calendarMonth) changeMonth(Number(button.dataset.calendarMonth));
    else if (button?.dataset.calendarQuick) choose(button.dataset.calendarQuick === 'today' ? today : addDays(today, 1));
    else if (button?.hasAttribute('data-calendar-close')) close();
    else if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); }
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (!event.target.matches('[data-calendar-date]')) return;
    focused = event.target.dataset.calendarDate;
    const directions = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in directions) focused = addDays(focused, directions[event.key]);
    else if (event.key === 'Home') focused = addDays(focused, -fromISO(focused).getUTCDay());
    else if (event.key === 'End') focused = addDays(focused, 6 - fromISO(focused).getUTCDay());
    else if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); changeMonth((event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1)); return; }
    else return;
    event.preventDefault(); if (focused < today) focused = today;
    visible = fromISO(focused); render(true);
  });
  field.closest('form').addEventListener('submit', event => {
    if (selected && selected >= todayISO()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    error.textContent = 'Escolha a data do encontro.'; trigger.setAttribute('aria-invalid', 'true'); trigger.focus();
  }, { capture: true });
  updateTrigger();
}

export function setupGroupFields(container = document) {
  container.querySelectorAll('[data-date-field]').forEach(field => {
    if (initialized.has(field)) return;
    initialized.add(field); setupCalendar(field);
  });
  container.querySelectorAll('input[data-budget-input]').forEach(input => {
    if (initialized.has(input)) return;
    initialized.add(input); setupBudget(input);
  });
}
