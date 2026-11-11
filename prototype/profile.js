import { icon, escapeHtml } from './ui.js';

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_BYTES = 256 * 1024;
let signupAvatar = null;
let activeProfileDialog = null;
const photoBindings = new WeakSet();

export function getSignupAvatar() { return signupAvatar; }
export function resetSignupAvatar() { signupAvatar = null; updateSignupPreview(document); }

function updateSignupPreview(container) {
  container.querySelectorAll('[data-signup-avatar]').forEach(image => {
    image.hidden = !signupAvatar;
    if (signupAvatar) image.src = signupAvatar;
    else image.removeAttribute('src');
  });
  container.querySelectorAll('[data-signup-avatar-placeholder]').forEach(element => { element.hidden = Boolean(signupAvatar); });
  container.querySelectorAll('[data-action="remove-signup-photo"]').forEach(element => { element.hidden = !signupAvatar; });
  container.querySelectorAll('[data-action="replace-signup-photo"]').forEach(element => { element.hidden = !signupAvatar; });
  container.querySelectorAll('[data-action="choose-signup-photo"]').forEach(element => { element.textContent = signupAvatar ? 'Ajustar foto' : 'Adicionar foto'; });
}

function validateFile(file) {
  if (!file || !ACCEPTED_TYPES.has(file.type)) throw new Error('Escolha uma foto JPG, PNG ou WebP.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Essa foto é grande demais. Escolha uma imagem de até 5 MB.');
  if (!file.size) throw new Error('Essa imagem está vazia. Escolha outra foto.');
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => image.naturalWidth && image.naturalHeight ? resolve(image) : reject(new Error('Não conseguimos abrir essa imagem. Escolha outra foto.'));
    image.onerror = () => reject(new Error('Não conseguimos abrir essa imagem. Escolha outra foto.'));
    image.src = source;
  });
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Não foi possível preparar a foto. Tente outra imagem.')), 'image/webp', quality));
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Não foi possível preparar a foto. Tente novamente.'));
    reader.readAsDataURL(blob);
  });
}

async function encodeCrop(image, frameSize, zoom, position) {
  const scale = Math.max(frameSize / image.naturalWidth, frameSize / image.naturalHeight) * zoom;
  const sourceSize = frameSize / scale;
  const sourceX = (image.naturalWidth - sourceSize) / 2 - position.x / scale;
  const sourceY = (image.naturalHeight - sourceSize) / 2 - position.y / scale;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Seu navegador não conseguiu preparar a foto. Tente novamente.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, Math.max(0, sourceX), Math.max(0, sourceY), sourceSize, sourceSize, 0, 0, 256, 256);
  let blob = await toBlob(canvas, .8);
  if (blob.size > MAX_AVATAR_BYTES) blob = await toBlob(canvas, .65);
  if (blob.size > MAX_AVATAR_BYTES) throw new Error('Não foi possível reduzir essa foto. Escolha outra imagem.');
  if (blob.type !== 'image/webp') throw new Error('Este navegador não suporta o formato da foto. Use uma versão atual do navegador.');
  return blobToDataURL(blob);
}

async function cropPhoto(source) {
  const image = await loadImage(source);
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'profile-dialog profile-crop-dialog';
    dialog.setAttribute('aria-labelledby', 'profile-crop-title');
    dialog.innerHTML = `<form class="profile-dialog-form" method="dialog"><div class="profile-dialog-heading"><div><p class="eyebrow">UM ROSTO CONHECIDO</p><h2 id="profile-crop-title">Ajustar foto</h2></div><button class="icon-button" type="button" data-photo-cancel aria-label="Cancelar recorte">${icon('x', 20)}</button></div><p class="profile-description" id="profile-crop-instructions">Arraste a foto para posicionar e ajuste o tamanho.</p><div class="profile-crop-surround"><div class="profile-crop-stage" tabindex="0" role="group" aria-label="Posição da foto. Arraste ou use as teclas de direção." aria-describedby="profile-crop-instructions"><img alt="Prévia do recorte da sua foto" draggable="false"></div></div><label class="profile-zoom-label" for="profile-photo-zoom"><span>Zoom</span><output data-photo-zoom-value for="profile-photo-zoom">1×</output></label><input class="profile-zoom" id="profile-photo-zoom" type="range" min="1" max="3" value="1" step="0.01"><p class="profile-small">Sua foto aparecerá em um círculo nos seus grupos.</p><p class="profile-error" role="alert" data-photo-error hidden></p><div class="profile-dialog-actions"><button type="button" class="btn btn-secondary" data-photo-cancel>Cancelar</button><button type="submit" class="btn btn-primary">Salvar recorte ${icon('check', 17)}</button></div></form>`;
    document.body.append(dialog);
    const stage = dialog.querySelector('.profile-crop-stage');
    const preview = stage.querySelector('img');
    preview.src = source;
    const slider = dialog.querySelector('.profile-zoom');
    const output = dialog.querySelector('[data-photo-zoom-value]');
    const error = dialog.querySelector('[data-photo-error]');
    let position = { x: 0, y: 0 };
    let zoom = 1;
    let frameSize = 280;
    let dragging = null;
    let result = null;
    let settled = false;
    let saving = false;
    function paint() {
      const nextSize = stage.getBoundingClientRect().width;
      if (nextSize > 0) {
        if (frameSize !== nextSize) position = { x: position.x * nextSize / frameSize, y: position.y * nextSize / frameSize };
        frameSize = nextSize;
      }
      const scale = Math.max(frameSize / image.naturalWidth, frameSize / image.naturalHeight) * zoom;
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      position.x = Math.max(-(width - frameSize) / 2, Math.min((width - frameSize) / 2, position.x));
      position.y = Math.max(-(height - frameSize) / 2, Math.min((height - frameSize) / 2, position.y));
      preview.style.width = `${width}px`;
      preview.style.height = `${height}px`;
      preview.style.transform = `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px))`;
      output.value = `${zoom.toFixed(1).replace('.', ',')}×`;
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(paint) : null;
    observer?.observe(stage);
    slider.addEventListener('input', () => { zoom = Number(slider.value); paint(); });
    stage.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      stage.setPointerCapture(event.pointerId);
      dragging = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: position.x, startY: position.y };
      stage.classList.add('is-dragging');
    });
    stage.addEventListener('pointermove', event => {
      if (!dragging || dragging.id !== event.pointerId) return;
      position = { x: dragging.startX + event.clientX - dragging.x, y: dragging.startY + event.clientY - dragging.y };
      paint();
    });
    const stopDragging = () => { dragging = null; stage.classList.remove('is-dragging'); };
    stage.addEventListener('pointerup', stopDragging);
    stage.addEventListener('pointercancel', stopDragging);
    stage.addEventListener('lostpointercapture', stopDragging);
    stage.addEventListener('keydown', event => {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction) return;
      event.preventDefault();
      const distance = event.shiftKey ? 20 : 5;
      position.x += direction[0] * distance; position.y += direction[1] * distance; paint();
    });
    dialog.querySelectorAll('[data-photo-cancel]').forEach(button => button.addEventListener('click', () => { if (!saving) dialog.close(); }));
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      const submit = dialog.querySelector('[type="submit"]');
      submit.disabled = true; submit.textContent = 'Preparando foto…'; error.hidden = true;
      try { result = await encodeCrop(image, frameSize, zoom, position); dialog.close(); }
      catch (failure) { error.textContent = failure.message; error.hidden = false; }
      finally { saving = false; submit.disabled = false; submit.textContent = 'Salvar recorte'; }
    });
    dialog.addEventListener('close', () => {
      if (settled) return;
      settled = true; observer?.disconnect(); dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(result);
    }, { once: true });
    dialog.showModal(); paint();
    slider.focus();
  });
}

async function chooseFile(file) {
  validateFile(file);
  const source = URL.createObjectURL(file);
  try { return await cropPhoto(source); }
  finally { URL.revokeObjectURL(source); }
}

export function setupPhotoInputs(container = document) {
  updateSignupPreview(container);
  const input = container.querySelector('#signup-photo-input');
  const error = container.querySelector('[data-signup-photo-error]');
  if (!input) return;
  const showError = message => { if (error) { error.textContent = message || ''; error.hidden = !message; } };
  container.querySelectorAll('[data-action="choose-signup-photo"]').forEach(button => {
    if (photoBindings.has(button)) return;
    photoBindings.add(button);
    button.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation(); showError('');
      if (!signupAvatar) { input.click(); return; }
      try { const cropped = await cropPhoto(signupAvatar); if (cropped) { signupAvatar = cropped; updateSignupPreview(document); } }
      catch (failure) { showError(failure.message); }
    });
  });
  container.querySelectorAll('[data-action="replace-signup-photo"]').forEach(button => {
    if (photoBindings.has(button)) return;
    photoBindings.add(button);
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); input.click(); });
  });
  container.querySelectorAll('[data-action="remove-signup-photo"]').forEach(button => {
    if (photoBindings.has(button)) return;
    photoBindings.add(button);
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); signupAvatar = null; updateSignupPreview(document); showError(''); });
  });
  if (photoBindings.has(input)) return;
  photoBindings.add(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0]; if (!file) return;
    showError('');
    try { const cropped = await chooseFile(file); if (cropped) { signupAvatar = cropped; updateSignupPreview(document); } }
    catch (failure) { showError(failure.message); }
    finally { input.value = ''; }
  });
}

export function openProfileEditor(user, onSaved) {
  if (activeProfileDialog?.isConnected) { activeProfileDialog.querySelector('input')?.focus(); return activeProfileDialog; }
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  activeProfileDialog = dialog;
  dialog.className = 'profile-dialog profile-editor-dialog';
  dialog.setAttribute('aria-labelledby', 'profile-editor-title');
  let currentAvatar = user.avatar || null;
  let saving = false;
  dialog.innerHTML = `<form class="profile-dialog-form" data-profile-form><div class="profile-dialog-heading"><div><p class="eyebrow">DO SEU JEITO</p><h2 id="profile-editor-title">Meu perfil</h2></div><button class="icon-button" type="button" data-profile-cancel aria-label="Fechar perfil">${icon('x', 20)}</button></div><p class="profile-description">É assim que sua turma encontra você.</p><div class="profile-photo-row"><div class="profile-photo-preview"><img data-profile-avatar alt="Sua foto de perfil" hidden><span data-profile-placeholder>${icon('users', 30)}</span></div><div class="profile-photo-options"><button class="btn btn-secondary btn-small" type="button" data-profile-adjust>Ajustar foto</button><div class="profile-photo-text-actions"><button class="profile-text-button" type="button" data-profile-replace>Escolher outra</button><button class="profile-text-button" type="button" data-profile-remove>Remover foto</button></div><span class="profile-small">JPG, PNG ou WebP. Até 5 MB.</span></div></div><input class="profile-file-input" type="file" accept="image/jpeg,image/png,image/webp" data-profile-file aria-label="Escolher uma foto de perfil"><div class="profile-name-fields"><label class="field" for="profile-first-name">Nome<input id="profile-first-name" name="firstName" autocomplete="given-name" maxlength="60" value="${escapeHtml(user.firstName || '')}" required></label><label class="field" for="profile-last-name">Sobrenome<input id="profile-last-name" name="lastName" autocomplete="family-name" maxlength="80" value="${escapeHtml(user.lastName || '')}" required></label></div><label class="field" for="profile-email">E-mail<input id="profile-email" value="${escapeHtml(user.email || '')}" type="email" readonly aria-describedby="profile-email-hint"></label><p id="profile-email-hint" class="profile-small">Seu e-mail identifica sua conta e permanece o mesmo.</p><p class="profile-error" role="alert" data-profile-error hidden></p><div class="profile-dialog-actions"><button type="button" class="btn btn-secondary" data-profile-cancel>Cancelar</button><button type="submit" class="btn btn-primary">Salvar perfil ${icon('check', 17)}</button></div><button type="button" class="btn btn-ghost btn-block" style="margin-top:14px" data-action="logout">${icon('logout', 17)} Sair da conta</button></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const input = dialog.querySelector('[data-profile-file]');
  const error = dialog.querySelector('[data-profile-error]');
  const showError = message => { error.textContent = message || ''; error.hidden = !message; };
  function previewPhoto() {
    const image = dialog.querySelector('[data-profile-avatar]');
    image.hidden = !currentAvatar;
    if (currentAvatar) image.src = currentAvatar; else image.removeAttribute('src');
    dialog.querySelector('[data-profile-placeholder]').hidden = Boolean(currentAvatar);
    dialog.querySelector('[data-profile-remove]').hidden = !currentAvatar;
    dialog.querySelector('[data-profile-replace]').hidden = !currentAvatar;
    dialog.querySelector('[data-profile-adjust]').textContent = currentAvatar ? 'Ajustar foto' : 'Adicionar foto';
  }
  dialog.querySelector('[data-profile-adjust]').addEventListener('click', async () => {
    if (saving) return;
    showError('');
    if (!currentAvatar) { input.click(); return; }
    try { const cropped = await cropPhoto(currentAvatar); if (cropped) { currentAvatar = cropped; previewPhoto(); } }
    catch (failure) { showError(failure.message); }
  });
  dialog.querySelector('[data-profile-replace]').addEventListener('click', () => { if (!saving) input.click(); });
  dialog.querySelector('[data-profile-remove]').addEventListener('click', () => { if (!saving) { currentAvatar = null; previewPhoto(); } });
  input.addEventListener('change', async () => {
    const file = input.files?.[0]; if (!file) return;
    showError('');
    try { const cropped = await chooseFile(file); if (cropped) { currentAvatar = cropped; previewPhoto(); } }
    catch (failure) { showError(failure.message); }
    finally { input.value = ''; }
  });
  dialog.querySelectorAll('[data-profile-cancel]').forEach(button => button.addEventListener('click', () => { if (!saving) dialog.close(); }));
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving || !form.reportValidity()) return;
    const firstName = form.elements.firstName.value.trim(); const lastName = form.elements.lastName.value.trim();
    if (!firstName || !lastName) { showError('Preencha seu nome e sobrenome.'); return; }
    saving = true; showError('');
    form.setAttribute('aria-busy', 'true');
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true; submit.textContent = 'Salvando…';
    const logoutButton = form.querySelector('[data-action="logout"]');
    if (logoutButton) logoutButton.disabled = true;
    try {
      const response = await fetch('/api/profile', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName, lastName, avatar: currentAvatar }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || (response.status === 401 ? 'Sua sessão terminou. Entre novamente para atualizar seu perfil.' : 'Não conseguimos salvar agora. Tente novamente.'));
      const savedUser = payload?.user || payload;
      if (!savedUser || typeof savedUser !== 'object') throw new Error('Não conseguimos confirmar a atualização. Tente novamente.');
      await onSaved?.(savedUser);
      dialog.close();
    } catch (failure) { showError(failure instanceof TypeError ? 'Não foi possível conectar. Confira sua conexão e tente novamente.' : failure.message); }
    finally { saving = false; form.removeAttribute('aria-busy'); submit.disabled = false; submit.textContent = 'Salvar perfil'; if (logoutButton) logoutButton.disabled = false; }
  });
  dialog.addEventListener('close', () => { dialog.remove(); activeProfileDialog = null; if (previousFocus?.isConnected) previousFocus.focus(); }, { once: true });
  previewPhoto(); dialog.showModal(); dialog.querySelector('#profile-first-name').focus();
  return dialog;
}
