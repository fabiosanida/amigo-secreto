const boundGroups = new WeakSet();
const digitsOnly = value => String(value ?? '').replace(/\D/g, '');

export function setupOTP(container = document) {
  container.querySelectorAll('[data-otp]').forEach(group => {
    if (boundGroups.has(group)) return;
    const inputs = [...group.querySelectorAll('[data-otp-digit]')];
    const hidden = group.querySelector('[data-otp-value]');
    if (inputs.length !== 6 || !hidden) return;
    boundGroups.add(group);

    function sync() {
      hidden.value = inputs.map(input => digitsOnly(input.value).slice(0, 1)).join('');
    }
    function focus(index) {
      const input = inputs[Math.max(0, Math.min(inputs.length - 1, index))];
      input.focus(); input.select();
    }
    function distribute(value, index, moveFocus = true) {
      const digits = digitsOnly(value).slice(0, inputs.length);
      if (!digits) { inputs[index].value = ''; sync(); return; }
      const start = digits.length === inputs.length ? 0 : index;
      if (digits.length > 1) inputs.slice(start).forEach(input => { input.value = ''; });
      for (let offset = 0; offset < digits.length && start + offset < inputs.length; offset++) inputs[start + offset].value = digits[offset];
      sync();
      if (moveFocus) focus(start + digits.length);
    }
    function backspace(index) {
      if (inputs[index].value) inputs[index].value = '';
      else if (index > 0) { inputs[index - 1].value = ''; focus(index - 1); }
      sync();
    }

    inputs.forEach((input, index) => {
      input.addEventListener('focus', () => input.select());
      input.addEventListener('click', () => input.select());
      input.addEventListener('paste', event => {
        const text = event.clipboardData?.getData('text');
        if (text == null) return;
        event.preventDefault(); distribute(text, index);
      });
      input.addEventListener('beforeinput', event => {
        if (event.isComposing) return;
        if (event.inputType === 'deleteContentBackward' && !input.value) {
          event.preventDefault(); backspace(index); return;
        }
        if (!event.inputType?.startsWith('insert') || event.data == null) return;
        event.preventDefault();
        if (digitsOnly(event.data)) distribute(event.data, index);
      });
      input.addEventListener('input', event => {
        if (event.isComposing) return;
        const value = digitsOnly(event.data).length > 1 ? event.data : input.value;
        if (event.inputType?.startsWith('delete')) { input.value = digitsOnly(input.value).slice(0, 1); sync(); return; }
        distribute(value, index);
      });
      input.addEventListener('compositionend', () => distribute(input.value, index));
      input.addEventListener('keydown', event => {
        if (event.key === 'Backspace') { event.preventDefault(); backspace(index); }
        else if (event.key === 'Delete') { event.preventDefault(); input.value = ''; sync(); }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); focus(index - 1); }
        else if (event.key === 'ArrowRight') { event.preventDefault(); focus(index + 1); }
        else if (event.key === 'Home') { event.preventDefault(); focus(0); }
        else if (event.key === 'End') { event.preventDefault(); focus(inputs.length - 1); }
      });
    });

    const initial = digitsOnly(hidden.value);
    if (initial) distribute(initial, 0, false); else sync();
    group.closest('form')?.addEventListener('submit', sync, { capture: true });
    group.closest('form')?.addEventListener('formdata', event => { sync(); event.formData.set('code', hidden.value); });
  });
}
