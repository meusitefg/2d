'use strict';

const $ = (id) => document.getElementById(id);
const config = window.CENTRAL_CONFIG;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const dialog = $('dialog');
const sessionKey = 'minha-central:session:' + config?.url + ':' + config?.adminEmail;
const statuses = ['ON', 'OFF', 'RISCO'];
let encodedKey;
let session;
let vaultKey;
let db = { topics: [], accounts: [] };
let selected = '';
let busy = false;
let toastTimer;

function element(tag, className, label) {
  const node = document.createElement(tag);
  node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
}

function button(label, className, handler) {
  const node = element('button', className, label);
  node.type = 'button';
  node.onclick = handler;
  return node;
}

function notify(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4000);
}

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { apikey: config.publishableKey, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(new URL(path, config.url), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw Object.assign(new Error('Falha na conexão com o banco.'), {
      status: response.status, code: details.code,
    });
  }
  if ((response.status !== 204 && method === 'GET') || path.startsWith('/auth/v1/token?')) {
    return response.json();
  }
}

async function query(path, options = {}) {
  if (Date.now() >= session.expires_at * 1000 - 30000) {
    session = await request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: session.refresh_token },
    });
    saveSession();
  }
  return request('/rest/v1/' + path, { ...options, token: session.access_token });
}

async function deriveKey(password, userId) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'PBKDF2', salt: encoder.encode('minha-central-v1:' + userId),
    hash: 'SHA-256', iterations: 600000,
  }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function encrypt(email, password, id, status) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(id),
  }, vaultKey, encoder.encode(JSON.stringify({ email, password, status })));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(data)));
}

async function decrypt(row) {
  try {
    const bytes = Uint8Array.from(atob(row.payload), (character) => character.charCodeAt(0));
    const data = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(row.id),
    }, vaultKey, bytes.slice(12));
    return { ...row, ...JSON.parse(decoder.decode(data)) };
  } catch {
    return { ...row, locked: true };
  }
}

async function load() {
  const topics = await query('central_topics?select=id,name&order=created_at.asc,id.asc');
  const records = await query('central_accounts?select=id,topic_id,provider,payload&order=created_at.asc,id.asc');
  db = { topics, accounts: await Promise.all(records.map(decrypt)) };
}

function saveSession() {
  try {
    sessionStorage.setItem(sessionKey, JSON.stringify({ session, encodedKey }));
  } catch {
    // The dashboard also works in memory when browser storage is disabled.
  }
}

function showDashboard() {
  render();
  $('entry').hidden = true;
  $('dashboard').hidden = false;
}

async function restoreSession() {
  if (!config?.url || !config?.publishableKey || !globalThis.crypto?.subtle) return;
  const submit = $('signIn').querySelector('button');
  submit.disabled = busy = true;
  try {
    const stored = JSON.parse(sessionStorage.getItem(sessionKey));
    if (!stored?.session?.access_token || !stored.encodedKey) return;
    $('loginStatus').textContent = 'Restaurando sessão…';
    session = stored.session;
    encodedKey = stored.encodedKey;
    const bytes = Uint8Array.from(atob(encodedKey), (character) => character.charCodeAt(0));
    vaultKey = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    await load();
    showDashboard();
  } catch (error) {
    lock({ forget: !error.status ? error.name !== 'TypeError' && error.name !== 'TimeoutError' : error.status < 500 });
    $('loginStatus').textContent = 'Não foi possível restaurar a sessão. Entre novamente.';
  } finally {
    submit.disabled = busy = false;
  }
}

function lock({ forget = true } = {}) {
  if (forget) {
    try { sessionStorage.removeItem(sessionKey); } catch {}
  }
  encodedKey = undefined;
  session = undefined;
  vaultKey = undefined;
  db = { topics: [], accounts: [] };
  selected = '';
  dialog.close();
  $('lessonPlayer').close();
  $('playerContent').replaceChildren();
  activeView = 'accounts';
  $('fields').replaceChildren();
  $('search').value = '';
  $('sectionSearch').value = '';
  $('dispatchNumbersInput').value = '';
  $('dispatchMessagesInput').value = '';
  $('instaPassword').value = '';
  $('instaCurrent').replaceChildren();
  $('instaHistory').replaceChildren();
  $('documentList').replaceChildren();
  $('calendarBanner').hidden = true;
  $('calendarEntries').replaceChildren();
  $('calendarReminderList').replaceChildren();
  $('documentPreview').close();
  clearDocumentPreview();
  $('nav').replaceChildren();
  $('cards').replaceChildren();
  $('toast').classList.remove('show');
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  $('dashboard').hidden = true;
  $('entry').hidden = false;
  $('loginStatus').textContent = '';
}

$('signIn').onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  const status = $('loginStatus');
  const submit = form.querySelector('button');
  if (!config?.url || !config?.publishableKey) {
    status.textContent = 'Conexão pendente. Configure o Supabase conforme o guia do projeto.';
    return;
  }
  if (!globalThis.crypto?.subtle) {
    status.textContent = 'Abra o site em HTTPS para acessar suas contas.';
    return;
  }
  const email = form.elements.email.value.trim().toLowerCase();
  const password = form.elements.password.value;
  form.elements.password.value = '';
  if (email !== config.adminEmail.toLowerCase()) {
    status.textContent = 'E-mail ou senha inválidos.';
    return;
  }
  submit.disabled = busy = true;
  status.textContent = 'Entrando…';
  try {
    session = await request('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email, password },
    });
    const key = await deriveKey(password, session.user.id);
    const raw = await crypto.subtle.exportKey('raw', key);
    encodedKey = btoa(String.fromCharCode(...new Uint8Array(raw)));
    vaultKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    await load();
    saveSession();
    showDashboard();
  } catch (error) {
    lock();
    status.textContent = error.status === 400 || error.status === 401
      ? 'E-mail ou senha inválidos.' : 'Falha ao carregar a central. Verifique a conexão.';
  } finally {
    submit.disabled = busy = false;
  }
};

$('signOut').onclick = () => {
  if (busy) return;
  const token = session.access_token;
  lock();
  request('/auth/v1/logout?scope=local', { method: 'POST', token }).catch(() => {});
};

function selectTopic(id) {
  activeView = 'accounts';
  selected = id;
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  render();
}

function searchSections() {
  const normalize = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').trim();
  const search = normalize($('sectionSearch').value);
  let found = false;
  for (const row of $('nav').children) {
    row.hidden = !normalize(row.textContent || '').includes(search);
    if (!row.hidden) found = true;
  }
  $('sectionSearchEmpty').hidden = found;
}

function render() {
  $('accountsView').hidden = activeView !== 'accounts';
  $('lessonsView').hidden = activeView !== 'lessons';
  $('marketView').hidden = activeView !== 'market';
  const inInstagram = activeView === 'instaCreator' || activeView === 'instaTests';
  $('instaView').hidden = !inInstagram;
  $('documentsView').hidden = activeView !== 'documents';
  $('calendarView').hidden = activeView !== 'calendarPro';
  if (activeView !== 'calendarPro') refreshCalendarReminder();
  $('directoryView').hidden = activeView === 'calendarPro' || activeView === 'documents' || inInstagram || activeView === 'dispatchPro' || !directorySections.has(activeView);
  $('dispatchView').hidden = activeView !== 'dispatchPro';
  const topic = db.topics.find((item) => item.id === selected);
  if (!topic) selected = '';
  const nav = $('nav');
  nav.replaceChildren();
  const topicButton = (id, name) => {
    const control = button(name, activeView === 'accounts' && selected === id ? 'active' : '', () => selectTopic(id));
    control.setAttribute('aria-pressed', String(activeView === 'accounts' && selected === id));
    control.append(element('span', 'count', db.accounts.filter((account) => !id || account.topic_id === id).length));
    return control;
  };
  const lessonsButton = button('Aulas', activeView === 'lessons' ? 'active' : '', showLessons);
  lessonsButton.setAttribute('aria-pressed', String(activeView === 'lessons'));
  const marketButton = button('Face Marketplace', activeView === 'market' ? 'active' : '', showMarket);
  marketButton.setAttribute('aria-pressed', String(activeView === 'market'));
  nav.append(topicButton('', 'Todas as contas'), lessonsButton, marketButton);
  for (const [id, section] of directorySections) {
    const item = button(section.title, activeView === id ? 'active' : '', () => openSection(id));
    item.setAttribute('aria-pressed', String(activeView === id));
    nav.append(item);
  }
  for (const item of db.topics) {
    const row = element('div', 'topic-row');
    const remove = button('×', 'delete-topic', () => removeTopic(item));
    remove.setAttribute('aria-label', 'Excluir tópico ' + item.name);
    row.append(topicButton(item.id, item.name), remove);
    nav.append(row);
  }
  searchSections();
  $('pageTitle').textContent = topic?.name || 'Todas as contas';
  $('statAccounts').textContent = db.accounts.length;
  $('statTopics').textContent = db.topics.length;
  const visible = db.accounts.filter((account) => !selected || account.topic_id === selected);
  $('statFiltered').textContent = visible.length;
  const search = $('search').value.trim().toLocaleLowerCase('pt-BR');
  const cards = $('cards');
  cards.replaceChildren();
  for (const account of visible) {
    const topicName = db.topics.find((item) => item.id === account.topic_id)?.name || 'Sem tópico';
    if (![account.email, account.provider, topicName].join(' ').toLocaleLowerCase('pt-BR').includes(search)) continue;
    const card = element('article', 'card');
    const actions = element('div', 'card-actions');
    if (!account.locked) {
      actions.append(
        button('Copiar login', 'btn dark', () => copyLogin(account)),
        button('Editar', 'btn', () => openAccount(account)),
      );
    }
    actions.append(button('Excluir', 'btn', () => removeAccount(account)));
    card.append(element('span', 'tag', topicName), element('h3', '', account.provider));
    const details = element('div', 'account-details');
    details.append(element('div', 'login', account.locked ? 'Senha de acesso incompatível com este registro.' : account.email));
    if (!account.locked) details.append(statusControl(account));
    card.append(details);
    if (!account.locked) card.append(passwordControl(account));
    card.append(actions);
    cards.append(card);
  }
  if (!cards.childElementCount) {
    cards.append(element('div', 'empty', search ? 'Nenhum resultado.' : 'Nenhum login cadastrado aqui.'));
  }
}

function statusControl(account) {
  const control = element('select', 'status-select');
  const current = statuses.includes(account.status) ? account.status : '';
  const placeholder = new Option('Status', '');
  placeholder.disabled = true;
  control.add(placeholder);
  for (const status of statuses) control.add(new Option(status, status));
  control.value = current;
  control.dataset.status = current;
  control.setAttribute('aria-label', 'Status de ' + account.email);
  control.onchange = () => {
    const status = control.value;
    if (busy || !statuses.includes(status)) {
      control.value = current;
      return;
    }
    change(async () => {
      const payload = await encrypt(account.email, account.password, account.id, status);
      await query('central_accounts?id=eq.' + account.id, { method: 'PATCH', body: { payload } });
      account.status = status;
    }, control).then(() => {
      control.value = account.status || '';
      control.dataset.status = control.value;
    });
  };
  return control;
}

function passwordControl(account) {
  const row = element('div', 'password-row');
  const value = element('span', 'password-value');
  value.hidden = true;
  const toggle = button('Mostrar senha', 'btn password-toggle', () => {
    const show = value.hidden;
    value.textContent = show ? account.password : '';
    value.hidden = !show;
    toggle.textContent = show ? 'Ocultar senha' : 'Mostrar senha';
    toggle.setAttribute('aria-expanded', String(show));
  });
  value.id = 'password-' + account.id;
  toggle.setAttribute('aria-controls', value.id);
  toggle.setAttribute('aria-expanded', 'false');
  row.append(toggle, value);
  return row;
}

async function copyLogin(account) {
  try {
    await navigator.clipboard.writeText(account.email + '\n' + account.password);
    notify('E-mail e senha copiados.');
  } catch {
    notify('O navegador bloqueou a cópia.');
  }
}

function openForm(title, submit) {
  if (busy) return false;
  $('fields').replaceChildren();
  $('modalTitle').textContent = title;
  $('form').onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    change(async () => {
      await submit(data);
      dialog.close();
    }, $('save'));
  };
  return true;
}

function field(name, label, { type = 'text', value = '', options, maxLength, required = true } = {}) {
  const wrapper = element('label', 'field', label);
  const control = document.createElement(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  if (options) {
    for (const [key, title] of options) control.add(new Option(title, key));
  } else {
    if (type !== 'textarea') control.type = type;
    control.autocomplete = type === 'password' ? 'new-password' : 'off';
    if (maxLength) control.maxLength = maxLength;
  }
  control.name = name;
  control.value = value;
  control.required = required;
  wrapper.append(control);
  $('fields').append(wrapper);
}

function openTopic() {
  if (!openForm('Novo tópico', async (data) => {
    const name = data.get('name').trim();
    if (!name) throw new Error('Digite o nome do tópico.');
    await query('central_topics', { method: 'POST', body: { name } });
  })) return;
  field('name', 'Nome do tópico', { maxLength: 70 });
  dialog.showModal();
}

function openAccount(account) {
  if (!openForm(account ? 'Editar login' : 'Adicionar login', async (data) => {
    const id = account?.id || crypto.randomUUID();
    const body = {
      provider: data.get('provider'), topic_id: data.get('topic') || null,
      payload: await encrypt(data.get('email').trim(), data.get('password'), id, account?.status),
    };
    if (account) {
      await query('central_accounts?id=eq.' + id, { method: 'PATCH', body });
    } else {
      await query('central_accounts', { method: 'POST', body: { ...body, id } });
    }
  })) return;
  field('provider', 'Tipo de conta', { value: account?.provider || 'Gmail', options: [['Gmail', 'Gmail'], ['Outlook', 'Outlook']] });
  field('email', 'E-mail da conta', { type: 'email', value: account?.email, maxLength: 254 });
  field('password', 'Senha da conta', { type: 'password', value: account?.password, maxLength: 512 });
  field('topic', 'Tópico', {
    value: account ? account.topic_id || '' : selected, required: false,
    options: [['', 'Sem tópico'], ...db.topics.map((item) => [item.id, item.name])],
  });
  dialog.showModal();
}

async function change(write, submit) {
  if (busy) return;
  busy = true;
  if (submit) submit.disabled = true;
  let written = false;
  try {
    await write();
    written = true;
    await load();
    render();
    notify('Alteração salva.');
  } catch (error) {
    if (error.status === 401 || error.code === 'refresh_token_not_found') {
      lock();
      $('loginStatus').textContent = 'Sua sessão expirou. Entre novamente.';
    } else if (written) {
      notify('Alteração salva. Entre novamente para atualizar a lista.');
    } else {
      notify(error.code === '23505' ? 'Já existe um tópico com esse nome.' :
        error.message === 'Digite o nome do tópico.' ? error.message : 'Não foi possível salvar. Confira a conexão e as permissões.');
    }
  } finally {
    if (submit) submit.disabled = false;
    busy = false;
  }
}

function removeTopic(item) {
  if (!busy && confirm('Excluir o tópico “' + item.name + '”? Os logins ficarão em “Sem tópico”.')) {
    change(() => query('central_topics?id=eq.' + item.id, { method: 'DELETE' }));
  }
}

function removeAccount(account) {
  if (!busy && confirm('Excluir este login?')) {
    change(() => query('central_accounts?id=eq.' + account.id, { method: 'DELETE' }));
  }
}

$('newTopic').onclick = openTopic;
$('newAccount').onclick = () => openAccount();
$('cancel').onclick = () => { if (!busy) dialog.close(); };
dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
dialog.addEventListener('close', () => $('fields').replaceChildren());
$('search').oninput = render;
$('menuBtn').setAttribute('aria-controls', 'sidebar');
$('menuBtn').setAttribute('aria-expanded', 'false');
$('menuBtn').onclick = () => {
  $('menuBtn').setAttribute('aria-expanded', String($('sidebar').classList.toggle('mobile-open')));
};

let activeView = 'accounts';
let course = { modules: [], lessons: [] };
const courseStorageKey = 'minha-central:aulas:v1:' + config?.url + ':' + config?.adminEmail;

function youtubeId(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^(www\.|m\.)/, '');
    const [, route, item] = url.pathname.split('/');
    let id;
    if (host === 'youtu.be') id = route;
    if (['youtube.com', 'youtube-nocookie.com', 'music.youtube.com'].includes(host)) {
      if (route === 'watch') id = url.searchParams.get('v');
      if (['shorts', 'live', 'embed'].includes(route)) id = item;
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
  } catch {
    return null;
  }
}

function readCourse() {
  const data = JSON.parse(localStorage.getItem(courseStorageKey));
  return data || { modules: [], lessons: [] };
}

function showLessons() {
  activeView = 'lessons';
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  try {
    course = readCourse();
  } catch {
    notify('Não foi possível abrir as aulas salvas.');
  }
  render();
  renderCourse();
}

function saveCourse(update) {
  const next = readCourse();
  update(next);
  localStorage.setItem(courseStorageKey, JSON.stringify(next));
  course = next;
  renderCourse();
}

function renderCourse() {
  const { modules, lessons } = course;
  $('moduleCount').textContent = modules.length;
  $('lessonCount').textContent = lessons.length;
  const assigned = lessons.filter((lesson) => lesson.moduleId).length;
  $('lessonAverage').textContent = modules.length
    ? (assigned / modules.length).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '0';
  const grid = $('modules');
  const filter = $('lessonFilter');
  const previous = filter.value;
  filter.replaceChildren(new Option('Todos os módulos', ''));
  grid.replaceChildren();
  for (const module of modules) {
    filter.add(new Option(module.name, module.id));
    const card = element('article', 'card module-card');
    const actions = element('div', 'card-actions');
    const count = lessons.filter((lesson) => lesson.moduleId === module.id).length;
    actions.append(button('Ver aulas', 'btn dark', () => {
      filter.value = module.id;
      $('lessonSearch').value = '';
      renderLessons();
      filter.focus();
    }), button('Excluir', 'btn', () => removeModule(module)));
    card.append(element('h3', '', module.name), element('div', 'login', count + (count === 1 ? ' aula' : ' aulas')), actions);
    grid.append(card);
  }
  if (!modules.length) grid.append(element('div', 'empty', 'Nenhum módulo cadastrado.'));
  filter.add(new Option('Sem módulo', 'unassigned'));
  if ([...filter.options].some((option) => option.value === previous)) filter.value = previous;
  renderLessons();
}

function renderLessons() {
  const grid = $('lessons');
  const filter = $('lessonFilter').value;
  const search = $('lessonSearch').value.trim().toLocaleLowerCase('pt-BR');
  grid.replaceChildren();
  for (const lesson of course.lessons) {
    if (filter && (lesson.moduleId || 'unassigned') !== filter) continue;
    if (!lesson.title.toLocaleLowerCase('pt-BR').includes(search)) continue;
    const id = youtubeId('https://youtu.be/' + lesson.videoId);
    if (!id) continue;
    const card = element('article', 'card lesson-card');
    const thumb = element('img', 'lesson-thumb');
    thumb.src = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.referrerPolicy = 'no-referrer';
    const module = course.modules.find((item) => item.id === lesson.moduleId);
    const actions = element('div', 'card-actions');
    actions.append(button('Assistir', 'btn dark', () => playLesson(lesson, id)),
      button('Editar', 'btn', () => openLesson(lesson)),
      button('Excluir', 'btn', () => removeLesson(lesson)));
    card.append(thumb, element('h3', '', lesson.title), element('span', 'tag', module?.name || 'Sem módulo'), actions);
    grid.append(card);
  }
  if (!grid.childElementCount) grid.append(element('div', 'empty', 'Nenhuma aula encontrada.'));
}

function openLocalForm(title, save) {
  if (busy) return false;
  $('fields').replaceChildren();
  $('modalTitle').textContent = title;
  $('form').onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      save(data);
      dialog.close();
      notify('Alteração salva.');
    } catch (error) {
      notify(error.inputMessage || 'Não foi possível salvar neste navegador.');
    }
  };
  return true;
}

function inputError(message) {
  throw Object.assign(new Error(message), { inputMessage: message });
}

function openModule() {
  if (!openLocalForm('Novo módulo', (data) => saveCourse((next) => {
    const name = data.get('name').trim();
    if (!name) inputError('Digite o nome do módulo.');
    if (next.modules.some((module) => module.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'))) {
      inputError('Já existe um módulo com esse nome.');
    }
    next.modules.push({ id: crypto.randomUUID(), name });
  }))) return;
  field('name', 'Nome do módulo', { maxLength: 90 });
  dialog.showModal();
}

function openLesson(lesson) {
  if (!openLocalForm(lesson ? 'Editar aula' : 'Adicionar aula', (data) => saveCourse((next) => {
    const title = data.get('title').trim();
    const videoId = youtubeId(data.get('url'));
    const moduleId = data.get('module') || null;
    if (!title) inputError('Digite o título da aula.');
    if (!videoId) inputError('Insira um link válido do YouTube.');
    if (moduleId && !next.modules.some((module) => module.id === moduleId)) inputError('Selecione um módulo disponível.');
    if (lesson && !next.lessons.some((item) => item.id === lesson.id)) inputError('A aula já foi excluída.');
    const changes = { title, videoId, moduleId };
    if (lesson) next.lessons = next.lessons.map((item) => item.id === lesson.id ? { ...item, ...changes } : item);
    else next.lessons.push({ id: crypto.randomUUID(), ...changes });
  }))) return;
  field('title', 'Título da aula', { value: lesson?.title, maxLength: 150 });
  field('url', 'Link do YouTube', { type: 'url', value: lesson ? 'https://youtu.be/' + lesson.videoId : '' });
  const filtered = $('lessonFilter').value;
  field('module', 'Módulo', {
    value: lesson ? lesson.moduleId || '' : filtered === 'unassigned' ? '' : filtered,
    required: false, options: [['', 'Sem módulo'], ...course.modules.map((module) => [module.id, module.name])],
  });
  dialog.showModal();
}

function removeModule(module) {
  if (!confirm('Excluir o módulo “' + module.name + '”? As aulas ficarão em “Sem módulo”.')) return;
  removeCourseItem((next) => {
    next.modules = next.modules.filter((item) => item.id !== module.id);
    next.lessons = next.lessons.map((lesson) => lesson.moduleId === module.id ? { ...lesson, moduleId: null } : lesson);
  });
}

function removeLesson(lesson) {
  if (!confirm('Excluir a aula “' + lesson.title + '”?')) return;
  removeCourseItem((next) => { next.lessons = next.lessons.filter((item) => item.id !== lesson.id); });
}

function removeCourseItem(update) {
  try {
    saveCourse(update);
    notify('Alteração salva.');
  } catch {
    notify('Não foi possível salvar as aulas neste navegador.');
  }
}

function playLesson(lesson, id) {
  const frame = element('iframe', '');
  frame.title = 'Vídeo da aula: ' + lesson.title;
  frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1';
  $('playerTitle').textContent = lesson.title;
  $('openYouTube').href = 'https://www.youtube.com/watch?v=' + id;
  $('playerContent').replaceChildren(frame);
  $('lessonPlayer').showModal();
}

$('addModule').onclick = openModule;
$('addLesson').onclick = () => openLesson();
$('lessonSearch').oninput = renderLessons;
$('lessonFilter').onchange = renderLessons;
$('closePlayer').onclick = () => $('lessonPlayer').close();
$('lessonPlayer').addEventListener('close', () => $('playerContent').replaceChildren());
window.addEventListener('storage', (event) => {
  if (activeView === 'lessons' && event.key === courseStorageKey) showLessons();
});

const marketStorageKey = 'minha-central:marketplace:v1:' + config?.url + ':' + config?.adminEmail;
const marketCategories = ['Veículo', 'Eletrônico', 'Terreno'];
const marketStatuses = [['called', 'Já chamei'], ['sold', 'Vendido'], ['waiting', 'Em Aguardo']];

function facebookUrl(value) {
  const input = value.trim();
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : 'https://' + input);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (host !== 'facebook.com' && !host.endsWith('.facebook.com') && host !== 'fb.me') return null;
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}

function readMarket() {
  const saved = JSON.parse(localStorage.getItem(marketStorageKey));
  return saved || [];
}

function showMarket() {
  activeView = 'market';
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  render();
  try {
    renderMarket(readMarket());
  } catch {
    $('marketLinks').replaceChildren(element('div', 'empty', 'Não foi possível abrir os links salvos.'));
  }
}

function updateMarket(update) {
  const next = update(readMarket());
  localStorage.setItem(marketStorageKey, JSON.stringify(next));
  renderMarket(next);
}

function saveMarketLink(raw, category, id) {
  const url = facebookUrl(raw);
  if (!url) inputError('Informe um link válido do Facebook.');
  if (!marketCategories.includes(category)) inputError('Selecione a categoria do anúncio.');
  updateMarket((list) => {
    if (!id) return [...list, { id: crypto.randomUUID(), url, category, status: 'waiting' }];
    if (!list.some((item) => item.id === id)) inputError('Este link já foi excluído.');
    return list.map((item) => item.id === id ? { ...item, url, category } : item);
  });
}

function renderMarket(list) {
  const grid = $('marketLinks');
  grid.replaceChildren();
  for (const item of list) {
    const url = facebookUrl(item.url);
    if (!url) continue;
    const card = element('article', 'card market-entry');
    const link = element('a', '', url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const actions = element('div', 'card-actions');
    const status = element('select', 'status-select');
    for (const [value, label] of marketStatuses) status.add(new Option(label, value));
    status.value = item.status;
    status.dataset.status = item.status;
    status.setAttribute('aria-label', 'Status do link ' + url);
    status.onchange = () => {
      try {
        updateMarket((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: status.value } : entry));
        notify('Status salvo.');
      } catch {
        status.value = item.status;
        notify('Não foi possível salvar o status.');
      }
    };
    actions.append(status, button('Editar', 'btn', () => editMarketLink(item)),
      button('Excluir', 'btn', () => removeMarketLink(item)));
    card.append(link);
    if (item.category) card.append(element('span', 'tag', item.category));
    card.append(actions);
    grid.append(card);
  }
  if (!grid.childElementCount) grid.append(element('div', 'empty', 'Nenhum link cadastrado.'));
}

function editMarketLink(item) {
  if (!openLocalForm('Editar link', (data) => saveMarketLink(data.get('url'), data.get('category'), item.id))) return;
  field('url', 'Link do Facebook', { value: item.url, maxLength: 4096 });
  field('category', 'Categoria', { value: item.category, options: [['', 'Selecione'], ...marketCategories.map((label) => [label, label])] });
  dialog.showModal();
}

function removeMarketLink(item) {
  if (!confirm('Excluir este link?')) return;
  try {
    updateMarket((list) => list.filter((entry) => entry.id !== item.id));
    notify('Link excluído.');
  } catch {
    notify('Não foi possível excluir o link.');
  }
}

$('marketForm').onsubmit = (event) => {
  event.preventDefault();
  try {
    saveMarketLink($('marketUrl').value, $('marketCategory').value);
    $('marketCategory').value = '';
    $('marketUrl').value = '';
    notify('Link adicionado.');
  } catch (error) {
    notify(error.inputMessage || 'Não foi possível salvar o link.');
  }
};

window.addEventListener('storage', (event) => {
  if (activeView === 'market' && event.key === marketStorageKey) showMarket();
});

const siteField = ['url', 'Link do site'];
const contactField = ['contact', 'Link do site ou número do WhatsApp com DDD e código do país'];
const nameField = ['name', 'Nome'];
const offerField = ['description', 'O que fornece', { required: false, type: 'textarea' }];
const dispatchTypes = ['API oficial', 'Ferramenta', 'Automação'].map((label) => [label, label]);
const availabilityStatuses = [['ON', 'green'], ['OFF', 'red']];
const aiStatuses = [...availabilityStatuses, ['Caro', 'orange']];
const serviceFields = [contactField, offerField];
const serviceStatuses = [['Barato', 'green'], ['Caro', 'orange']];
const priceStatuses = [['Barato', 'green'], ['Caro', 'orange'], ['OFF', 'red']];
const directorySections = new Map([
  ['extensions', { title: 'Extensões mais Usadas', fields: [['name', 'Nome da extensão'], ['url', 'Link da extensão']] }],
  ['foreignSuppliers', { title: 'Fornecedores Gringos', fields: [contactField, offerField] }],
  ['dispatchPro', { title: 'Disparo Pro' }],
  ['brSuppliers', { title: 'Fornecedores Br', fields: [contactField, offerField] }],
  ['smm', { title: 'Painéis SMM', fields: serviceFields, statuses: serviceStatuses }],
  ['freeAI', { title: 'IAs Gratuitas', fields: [['name', 'Nome da ferramenta'], contactField] }],
  ['paidAI', { title: 'IAs Pagas', fields: [contactField] }],
  ['motionAI', { title: 'IAs Motion Control', fields: [nameField, siteField], statuses: aiStatuses }],
  ['depzinAI', { title: 'IAs Depzin 18', fields: [nameField, siteField], statuses: aiStatuses }],
  ['hosting', { title: 'Fornecedores Hosting', fields: [contactField], statuses: [...availabilityStatuses, ['CARO', 'orange']] }],
  ['cloudGaming', { title: 'Nuvem Jogar PC', fields: [siteField] }],
  ['sales', { title: 'Calculadora Pro', fields: [
    ['name', 'O que você vendeu'], ['amount', 'Valor da venda (R$)'], ['cost', 'Custo (R$, opcional)'], ['date', 'Data'],
  ], statuses: [['Orgânico', 'green'], ['Pago', 'blue']] }],
  ['fastPC', { title: 'PC rápido', fields: [['name', 'Nome da ferramenta'], ['description', 'O que a ferramenta faz'], siteField] }],
  ['pcParts', { title: 'Fornecedores Peças PC', fields: [['name', 'Nome do fornecedor'], siteField],
    statuses: [['Baratos', 'green'], ['Caros', 'red'], ['Duvidosos', 'orange']] }],
  ['cnpj', { title: 'CNPJ Válidos', fields: [siteField] }],
  ['freeCloud', { title: 'Nuvem Grátis', fields: [siteField, ['price', 'Valores ou condição do plano']] }],
  ['whatsappDev', { title: 'Disparo Wpp E Dev', fields: [siteField, ['kind', 'Tipo', { options: [['', 'Selecione'], ...dispatchTypes] }]] }],
  ['networking', { title: 'Grupos Networking', fields: [['url', 'Link do grupo de WhatsApp']],
    statuses: [['Ativo', 'green'], ['OFF', 'red']] }],
  ['news', { title: 'Sites Notícias', fields: [siteField] }],
  ['gateways', { title: 'Gateways', fields: [siteField, ['fees', 'Taxas'], ['ip', 'IP usado']],
    statuses: [['Gateway White', ''], ['Gateway Black ON', '']] }],
  ['cloakers', { title: 'Cloakers', fields: [siteField], statuses: availabilityStatuses }],
  ['supplier7', { title: 'Fornecedor Do 7', fields: [siteField] }],
  ['movieSites', { title: 'Sites De Filmes', fields: [siteField], statuses: [['FAST', 'green'], ['OFF', 'red']] }],
  ['proxies', { title: 'Proxys', fields: [siteField], statuses: priceStatuses }],
  ['buyBM', { title: 'Comprar Bm', fields: [siteField], statuses: priceStatuses }],
  ['minas', { title: 'Minas', fields: [['url', 'Link do Facebook']], facebookOnly: true,
    statuses: [['Chamar', 'orange'], ['Já chamei', 'green']] }],
  ['swipe', { title: 'Swipe', fields: [siteField], statuses: priceStatuses }],
  ['casinoScripts', { title: 'Scripts Cassino', fields: [siteField], statuses: priceStatuses }],
  ['iptv', { title: 'Iptv', fields: [siteField], statuses: priceStatuses }],
  ['raffles', { title: 'Rifas', fields: [siteField], statuses: priceStatuses }],
  ['htmlMinifiers', { title: 'Minificadores Html', fields: [siteField], statuses: [['Top', 'green'], ['Ruim', 'orange']] }],
  ['searchSites', { title: 'Buscas', fields: [siteField], statuses: priceStatuses }],
  ['metadataRemoval', { title: 'Retirar Metadados', fields: [siteField], statuses: priceStatuses }],
  ['smCensura', { title: 'Sm Censura', fields: [siteField], statuses: priceStatuses }],
  ['depixOn', { title: 'Depix On', fields: [siteField], statuses: priceStatuses }],
  ['warmedNumbers', { title: 'Números Aquecidos', fields: [
    ['phone', 'Número do WhatsApp com código do país e DDD', { type: 'tel' }],
    ['recoveryEmail', 'Gmail de recuperação', { type: 'email' }],
    ['date', 'Data de início'],
  ], statuses: [['Maturando', 'orange'], ['Pronto pra uso', 'green'], ['Ban', 'red']] }],
  ['bmNotes', { title: 'Verificar Bms', fields: [
    ['name', 'Título (opcional)', { required: false }],
    ['note', 'Anotação. Cole links no texto para deixá-los clicáveis.', { type: 'textarea', maxLength: 20000 }],
  ] }],
  ['savedContacts', { title: 'Salvar Contatos', fields: [
    ['name', 'Nome da pessoa'], ['contactPhone', 'Número com DDD ou código internacional', { type: 'tel' }],
  ], statuses: [['Salvar', 'red'], ['Já salvo', 'green']] }],
  ['vsl', { title: 'Vsl', fields: [siteField] }],
  ['siteHosting', { title: 'Hospedagem Sites', fields: [siteField] }],
  ['foreignClothing', { title: 'Fornecedores roupa gringos', fields: [siteField],
    statuses: [['Barato', 'green'], ['Caro', 'orange']] }],
  ['pixKeys', { title: 'Chaves Pix', fields: [
    ['name', 'Nome do titular'],
    ['pixKey', 'Chave Pix'],
    ['pixType', 'Tipo de chave', { options: [['', 'Selecione'], ['Aleatória', 'Aleatória'], ['CPF', 'CPF'], ['CNPJ', 'CNPJ'], ['Número', 'Número'], ['E-mail', 'E-mail']] }],
  ], statuses: availabilityStatuses }],
  ['instaCreator', { title: 'CRIADOR INSTAGRAM' }],
  ['instaTests', { title: 'LOGIN TESTES INSTA' }],
  ...[
    ['temporaryEmails', 'Emails Temporários'],
    ['encryptText', 'Criptografar Textos'],
    ['designers', 'Designers Do 7'],
    ['queryGroups', 'Grupos Consultas'],
    ['cloudGames', 'Jogos na nuvem'],
    ['pcEmulators', 'Emuladores Pc'],
    ['russianForums', 'Forum Russos'],
  ].map(([id, title]) => [id, { title, fields: serviceFields, statuses: serviceStatuses }]),
  ['documents', { title: 'Documentos Top' }],
  ['youtubeChannels', { title: 'Canais Acompanhar', youtubeChannelOnly: true, fields: [
    ['url', 'Link do canal no YouTube'],
    ['description', 'Sobre o que é o canal?', { type: 'textarea' }],
  ] }],
  ['calendarPro', { title: 'Calendário Pro' }],
]);

const directoryPrefix = 'minha-central:directory:v1:' + config?.url + ':' + config?.adminEmail + ':';
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function today() {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function directoryUrl(raw, allowPhone = false) {
  const input = raw.trim();
  if (!input) return null;
  if (allowPhone && /^\+?[\d\s().-]+$/.test(input)) {
    const digits = input.replace(/\D/g, '');
    return /^[1-9][0-9]{7,14}$/.test(digits) ? 'https://wa.me/' + digits : null;
  }
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : 'https://' + input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (!url.hostname.includes('.') || /\s/.test(input)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function moneyInCents(raw) {
  const text = raw.trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.replace(',', '.').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= 999999999999 ? cents : null;
}

function readDirectory(id) {
  const list = JSON.parse(localStorage.getItem(directoryPrefix + id));
  return Array.isArray(list) ? list : [];
}

function showDirectory(id) {
  activeView = id;
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  $('directoryTitle').textContent = directorySections.get(id).title;
  const addLabels = { sales: 'Adicionar venda', warmedNumbers: 'Adicionar número', bmNotes: 'Nova anotação', savedContacts: 'Adicionar contato', pixKeys: 'Adicionar chave Pix', youtubeChannels: 'Adicionar canal' };
  $('addDirectoryEntry').textContent = addLabels[id] || 'Adicionar registro';
  $('salesSummary').hidden = id !== 'sales';
  $('channelFilterField').hidden = id !== 'youtubeChannels';
  if (!$('salesDate').value) $('salesDate').value = today();
  render();
  refreshDirectory(id);
}

function refreshDirectory(id) {
  try {
    renderDirectory(id, readDirectory(id));
  } catch {
    $('directoryEntries').replaceChildren(element('div', 'empty', 'Não foi possível abrir os registros salvos.'));
  }
}

function updateDirectory(id, update) {
  const list = update(readDirectory(id));
  localStorage.setItem(directoryPrefix + id, JSON.stringify(list));
  return list;
}

function externalLink(url, label = url) {
  const link = element('a', '', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function renderNote(note) {
  const body = element('p', 'directory-note');
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let start = 0;
  for (const match of note.matchAll(pattern)) {
    const text = match[0].replace(/[.,;!?)}\]]+$/, '');
    const url = directoryUrl(text);
    if (!url) continue;
    body.append(note.slice(start, match.index), externalLink(url, text));
    start = match.index + text.length;
  }
  body.append(note.slice(start));
  return body;
}

function elapsedDays(start, end = today()) {
  return (Date.parse(end) - Date.parse(start)) / 86400000;
}

function channelUrl(input) {
  const link = directoryUrl(input);
  if (!link) return null;
  const url = new URL(link);
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) || url.port) return null;
  if (!/^\/(?:@[^/]+|(?:channel|user|c)\/[^/]+)(?:\/(?:featured|videos|shorts|streams|playlists|community|posts|about))?\/?$/.test(url.pathname)) return null;
  url.protocol = 'https:';
  return url.href;
}

function channelTopics(records) {
  return [...new Set(records.map(({ topic }) => topic))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function renderDirectory(id, records) {
  const section = directorySections.get(id);
  const grid = $('directoryEntries');
  let visible = records;
  if (id === 'youtubeChannels') {
    const filter = $('channelFilter');
    const selected = filter.value;
    const topics = channelTopics(records);
    filter.replaceChildren(new Option('Todos os tópicos', ''));
    for (const topic of topics) filter.add(new Option(topic, topic));
    filter.value = topics.includes(selected) ? selected : '';
    if (filter.value) visible = records.filter((record) => record.topic === filter.value);
  }
  if (id === 'sales') {
    visible = records.filter((record) => record.date === $('salesDate').value);
    const total = visible.reduce((sum, record) => sum + record.amount, 0);
    const cost = visible.reduce((sum, record) => sum + record.cost, 0);
    $('dailyCount').textContent = visible.length;
    $('dailyTotal').textContent = currency.format(total / 100);
    $('dailyProfit').textContent = currency.format((total - cost) / 100);
  }
  grid.replaceChildren();
  for (const record of visible) {
    const card = element('article', 'card directory-card');
    if (record.name) card.append(element('h3', '', record.name));
    const url = section.facebookOnly ? facebookUrl(record.url || '') : directoryUrl(record.url || record.contact || '');
    if (record.topic) card.append(element('span', 'tag', record.topic));
    if (url) card.append(externalLink(url));
    if (id === 'warmedNumbers') {
      const days = elapsedDays(record.date);
      const [year, month, day] = record.date.split('-');
      card.append(element('p', '', 'Desde ' + day + '/' + month + '/' + year + ' · ' + days + (days === 1 ? ' dia' : ' dias')));
    }
    if (record.note) card.append(renderNote(record.note));
    for (const [key, label] of section.fields) {
      if (['name', 'url', 'contact', 'date', 'note'].includes(key) || record[key] === undefined || record[key] === '') continue;
      const value = key === 'amount' || key === 'cost' ? currency.format(record[key] / 100) : record[key];
      card.append(element('p', '', label + ': ' + value));
    }
    const actions = element('div', 'card-actions');
    if (id === 'pixKeys') actions.append(button('Copiar chave', 'btn', async () => {
      try {
        await navigator.clipboard.writeText(record.pixKey);
        notify('Chave Pix copiada.');
      } catch {
        notify('Não foi possível copiar a chave Pix.');
      }
    }));
    if (section.statuses) actions.append(directoryStatus(id, record, section.statuses));
    actions.append(button('Editar', 'btn', () => editDirectory(id, record)),
      button('Excluir', 'btn', () => deleteDirectory(id, record)));
    card.append(actions);
    grid.append(card);
  }
  if (!grid.childElementCount) grid.append(element('div', 'empty', id === 'sales' ? 'Nenhuma venda nesta data.' : 'Nenhum registro cadastrado.'));
}

function directoryStatus(id, record, options) {
  const select = element('select', 'status-select');
  for (const [label] of options) select.add(new Option(label, label));
  if (!record.status) {
    const placeholder = new Option('Classificação', '');
    placeholder.disabled = true;
    select.add(placeholder);
  }
  select.value = record.status || '';
  select.dataset.status = options.find(([label]) => label === record.status)?.[1] || '';
  select.setAttribute('aria-label', 'Classificação de ' + (record.name || record.url || record.contact));
  select.onchange = () => {
    try {
      const status = select.value;
      if (!options.some(([label]) => label === status)) return;
      const records = updateDirectory(id, (list) => list.map((entry) => entry.id === record.id ? { ...entry, status } : entry));
      renderDirectory(id, records);
      notify('Classificação salva.');
    } catch {
      select.value = record.status || '';
      notify('Não foi possível salvar a classificação.');
    }
  };
  return select;
}

function contactNumber(input) {
  if (!/^\+?[\d\s().-]+$/.test(input)) return null;
  const digits = input.replace(/\D/g, '');
  if (input.startsWith('+') || digits.startsWith('00')) {
    const international = input.startsWith('+') ? digits : digits.slice(2);
    return /^[1-9]\d{7,14}$/.test(international) ? '+' + international : null;
  }
  const brazilian = /^[1-9][1-9](?:9\d{8}|[2-5]\d{7})$/;
  if (brazilian.test(digits)) return '+55' + digits;
  if (digits.startsWith('55') && brazilian.test(digits.slice(2))) return '+' + digits;
  return null;
}

function directoryFormValues(section, data) {
  const values = {};
  for (const [key, label, options] of section.fields) {
    const input = String(data.get(key) ?? '').trim();
    if (key === 'contactPhone') {
      values[key] = contactNumber(input);
      if (!values[key]) inputError('Informe um número brasileiro com DDD ou um número internacional começando com +.');
    } else if (key === 'phone') {
      if (!/^\+?[\d\s().-]+$/.test(input) || !directoryUrl(input, true)) inputError('Informe um número válido com código do país e DDD.');
      values[key] = '+' + input.replace(/\D/g, '');
    } else if (key === 'recoveryEmail') {
      if (!/^[^\s@]+@(?:gmail|googlemail)\.com$/i.test(input)) inputError('Informe um Gmail de recuperação válido.');
      values[key] = input;
    } else if (key === 'date' && section.fields.some(([fieldName]) => fieldName === 'phone')) {
      const days = elapsedDays(input);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || !Number.isFinite(days) || days < 0) inputError('Informe uma data de início válida até hoje.');
      values[key] = input;
    } else if (key === 'url' || key === 'contact') {
      if (section.youtubeChannelOnly) {
        values[key] = channelUrl(input);
        if (!values[key]) inputError('Informe o link de um canal do YouTube, por exemplo youtube.com/@Canal.');
      } else if (section.facebookOnly) {
        values[key] = facebookUrl(input);
        if (!values[key]) inputError('Informe um link válido do Facebook.');
      } else {
        values[key] = directoryUrl(input, key === 'contact');
      }
      if (!values[key]) inputError(key === 'contact' ? 'Informe um link válido ou um número com código do país e DDD.' : 'Informe um link válido.');
    } else if (key === 'amount' || key === 'cost') {
      values[key] = key === 'cost' && !input ? 0 : moneyInCents(input);
      if (values[key] === null) inputError('Informe um valor válido, por exemplo 49,90.');
    } else {
      if (!input && options?.required !== false) inputError('Preencha ' + label.toLocaleLowerCase('pt-BR') + '.');
      if (input && options?.options && !options.options.some(([value]) => value === input)) inputError('Selecione uma opção válida.');
      values[key] = input;
    }
  }
  if (section.statuses) {
    values.status = data.get('status');
    if (!section.statuses.some(([label]) => label === values.status)) inputError('Selecione uma classificação.');
  }
  return values;
}

function editDirectory(id, record) {
  const section = directorySections.get(id);
  if (!openLocalForm(record ? 'Editar registro' : $('addDirectoryEntry').textContent, (data) => {
    const values = directoryFormValues(section, data);
    if (id === 'youtubeChannels') {
      const topic = String(data.get('newTopic') || '').trim() || String(data.get('topic') || '').trim();
      if (!topic) inputError('Selecione ou escreva um tópico.');
      const topics = channelTopics(readDirectory(id));
      values.topic = topics.find((item) => item.toLocaleLowerCase('pt-BR') === topic.toLocaleLowerCase('pt-BR')) || topic;
    }
    const records = updateDirectory(id, (list) => {
      if (!record) return [...list, { id: crypto.randomUUID(), ...values }];
      if (!list.some((entry) => entry.id === record.id)) inputError('Este registro já foi excluído.');
      return list.map((entry) => entry.id === record.id ? { ...entry, ...values } : entry);
    });
    if (id === 'sales') $('salesDate').value = values.date;
    if (id === 'youtubeChannels' && $('channelFilter').value) {
      $('channelFilter').add(new Option(values.topic, values.topic));
      $('channelFilter').value = values.topic;
    }
    renderDirectory(id, records);
  })) return;
  for (const [key, label, options] of section.fields) {
    let value = record?.[key] ?? '';
    if (key === 'date' && !record) value = id === 'sales' ? $('salesDate').value || today() : today();
    if ((key === 'amount' || key === 'cost') && record) value = (value / 100).toFixed(2).replace('.', ',');
    field(key, label, { value, type: key === 'date' ? 'date' : 'text', maxLength: 4096, required: key !== 'cost', ...options });
  }
  if (id === 'youtubeChannels') {
    const topics = channelTopics(readDirectory(id));
    field('topic', 'Tópico existente', {
      value: record?.topic || $('channelFilter').value, required: false,
      options: [['', 'Selecione'], ...topics.map((topic) => [topic, topic])],
    });
    field('newTopic', 'Ou escreva um novo tópico', { required: false, maxLength: 90 });
  }
  if (section.statuses) {
    field('status', id === 'sales' ? 'Origem da venda' : id === 'gateways' ? 'Tipo de gateway' : 'Classificação', {
      value: record ? record.status || '' : section.statuses[0][0],
      options: [['', 'Selecione'], ...section.statuses.map(([label]) => [label, label])],
    });
  }
  dialog.showModal();
}

function deleteDirectory(id, record) {
  if (!confirm('Excluir este registro?')) return;
  try {
    const records = updateDirectory(id, (list) => list.filter((entry) => entry.id !== record.id));
    renderDirectory(id, records);
    notify('Registro excluído.');
  } catch {
    notify('Não foi possível excluir o registro.');
  }
}

$('addDirectoryEntry').onclick = () => editDirectory(activeView);
$('channelFilter').onchange = () => refreshDirectory('youtubeChannels');
$('salesDate').onchange = () => {
  if (!$('salesDate').value) $('salesDate').value = today();
  refreshDirectory('sales');
};
window.addEventListener('storage', (event) => {
  if (directorySections.has(activeView) && event.key === directoryPrefix + activeView) refreshDirectory(activeView);
});

$('sectionSearch').oninput = searchSections;
$('sectionSearch').onkeydown = (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const first = [...$('nav').children].find((row) => !row.hidden);
  (first?.matches('button') ? first : first?.querySelector('button'))?.click();
};

const dispatchPrefix = 'minha-central:disparo-pro:v1:' + config?.url + ':' + config?.adminEmail + ':';
const dispatchBusy = new Set();

function readDispatch(queue) {
  const saved = JSON.parse(localStorage.getItem(dispatchPrefix + queue));
  return saved || { items: [], cursor: 0 };
}

function saveDispatch(queue, state) {
  localStorage.setItem(dispatchPrefix + queue, JSON.stringify(state));
}

function renderDispatch(queue) {
  const progress = $('dispatch' + queue + 'Progress');
  const next = $('dispatch' + queue + 'Next');
  const copy = $('dispatch' + queue + 'Copy');
  try {
    const { items, cursor } = readDispatch(queue);
    copy.disabled = dispatchBusy.has(queue) || cursor >= items.length;
    progress.textContent = items.length ? cursor + ' de ' + items.length + ' copiados' : 'Fila vazia.';
    next.textContent = items[cursor] ?? (items.length ? 'Fim da fila.' : '');
  } catch {
    copy.disabled = true;
    progress.textContent = 'Não foi possível abrir a fila.';
    next.textContent = '';
  }
}

function showDispatch() {
  activeView = 'dispatchPro';
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  render();
  renderDispatch('Numbers');
  renderDispatch('Messages');
}

function appendDispatch(queue, items) {
  const state = readDispatch(queue);
  state.items = state.items.concat(items);
  saveDispatch(queue, state);
  renderDispatch(queue);
}

$('dispatchNumbersForm').onsubmit = (event) => {
  event.preventDefault();
  const input = $('dispatchNumbersInput');
  const links = [];
  const invalid = [];
  for (const line of input.value.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    const number = contactNumber(value);
    if (number) links.push('https://wa.me/' + number.slice(1));
    else invalid.push(line);
  }
  if (!links.length) {
    notify('Informe números brasileiros com DDD ou internacionais com código do país.');
    return;
  }
  try {
    appendDispatch('Numbers', links);
    input.value = invalid.join('\n');
    notify(invalid.length ? links.length + ' adicionados. Confira os números que ficaram no campo.' :
      links.length + (links.length === 1 ? ' número adicionado.' : ' números adicionados.'));
  } catch {
    notify('Não foi possível salvar a lista neste navegador.');
  }
};

$('dispatchMessagesForm').onsubmit = (event) => {
  event.preventDefault();
  const input = $('dispatchMessagesInput');
  if (!input.value.trim()) {
    notify('Escreva uma mensagem.');
    return;
  }
  try {
    appendDispatch('Messages', [input.value]);
    input.value = '';
    notify('Mensagem salva.');
  } catch {
    notify('Não foi possível salvar a mensagem neste navegador.');
  }
};

async function copyDispatch(queue) {
  if (dispatchBusy.has(queue)) return;
  dispatchBusy.add(queue);
  const wasSession = session;
  try {
    const { items, cursor } = readDispatch(queue);
    if (cursor >= items.length) return;
    await navigator.clipboard.writeText(items[cursor]);
    const latest = readDispatch(queue);
    if (latest.cursor === cursor) {
      try {
        saveDispatch(queue, { ...latest, cursor: cursor + 1 });
      } catch {
        if (session === wasSession) notify('Copiado. O navegador não conseguiu salvar o avanço.');
        return;
      }
    }
    if (session === wasSession) notify('Copiado.');
  } catch {
    if (session === wasSession) notify('Não foi possível copiar. Confira a permissão do navegador.');
  } finally {
    dispatchBusy.delete(queue);
    if (activeView === 'dispatchPro') renderDispatch(queue);
  }
}

$('dispatchNumbersCopy').onclick = () => copyDispatch('Numbers');
$('dispatchMessagesCopy').onclick = () => copyDispatch('Messages');
window.addEventListener('storage', (event) => {
  if (activeView !== 'dispatchPro') return;
  for (const queue of ['Numbers', 'Messages']) {
    if (event.key === dispatchPrefix + queue) renderDispatch(queue);
  }
});

const instaKey = 'minha-central:insta:v1:' + config?.url + ':' + config?.adminEmail;
const instaNames = ['marcely', 'amanda', 'bianca', 'camila', 'daniela', 'elisa', 'fernanda', 'gabriela', 'helena', 'isabela', 'julia', 'larissa', 'luana', 'mariana', 'natalia', 'renata', 'sabrina', 'vanessa'];
const instaSurnames = ['santos', 'lima', 'costa', 'souza', 'silva', 'rocha', 'mendes', 'alves', 'ribeiro', 'ferreira'];
const instaStatuses = [['Em análise', 'orange'], ['Ban', 'red'], ['ON', 'green']];
let instaBusy = false;
let instaRender = 0;

function openSection(id) {
  if (id === 'dispatchPro') showDispatch();
  else if (id === 'instaCreator' || id === 'instaTests') showInstagram(id);
  else if (id === 'documents') showDocuments();
  else if (id === 'calendarPro') showCalendar();
  else showDirectory(id);
}

function readInstagram() {
  return JSON.parse(localStorage.getItem(instaKey)) || { pending: [], history: [], step: 'username' };
}

function saveInstagram(state) {
  localStorage.setItem(instaKey, JSON.stringify(state));
}

function showInstagram(id) {
  activeView = id;
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  render();
  refreshInstagram();
}

async function refreshInstagram() {
  const revision = ++instaRender;
  const identity = session;
  const isCreator = activeView === 'instaCreator';
  $('instaTitle').textContent = directorySections.get(activeView).title;
  $('instaGenerator').hidden = !isCreator;
  $('instaHistory').hidden = isCreator;
  $('instaCurrent').replaceChildren();
  $('instaHistory').replaceChildren();
  $('instaCopy').disabled = true;
  $('instaGenerate').disabled = true;
  try {
    const state = readInstagram();
    const secret = state.secret ? await decrypt({ id: instaKey, payload: state.secret }) : null;
    if (revision !== instaRender || identity !== session) return;
    if (!isCreator) {
      renderInstagramHistory(state.history, secret?.password);
      return;
    }
    $('instaPasswordField').hidden = !!state.secret;
    $('instaGenerate').disabled = instaBusy || !!state.pending.length || !!secret?.locked;
    $('instaProgress').textContent = secret?.locked ? 'A senha fixa não pôde ser aberta.' :
      state.pending.length ? state.pending.length + ' logins na fila.' : 'Fila vazia.';
    if (!state.pending.length || !secret?.password) return;
    const current = state.pending[0];
    $('instaCurrent').append(element('div', 'insta-credential', current + '\n' + secret.password));
    $('instaCopy').textContent = state.step === 'password' ? 'Copiar senha' : 'Copiar usuário';
    $('instaCopy').disabled = instaBusy;
  } catch {
    if (revision === instaRender && identity === session) notify('Não foi possível abrir os logins de teste.');
  }
}

function renderInstagramHistory(history, password) {
  const grid = $('instaHistory');
  if (!history.length) grid.append(element('div', 'empty', 'Nenhum login de teste salvo.'));
  for (const account of history.slice().reverse()) {
    const card = element('article', 'card');
    const select = element('select', 'status-select');
    for (const [label] of instaStatuses) select.add(new Option(label, label));
    select.value = account.status;
    select.dataset.status = instaStatuses.find(([label]) => label === account.status)?.[1] || '';
    select.setAttribute('aria-label', 'Status de ' + account.username);
    select.onchange = () => {
      try {
        const state = readInstagram();
        state.history = state.history.map((item) => item.username === account.username ? { ...item, status: select.value } : item);
        saveInstagram(state);
        refreshInstagram();
      } catch {
        select.value = account.status;
        notify('Não foi possível salvar o status.');
      }
    };
    card.append(element('span', 'tag', 'LOGIN RECÉM CRIADO'),
      element('div', 'insta-credential', account.username + '\n' + (password || 'Senha indisponível')),
      select);
    grid.append(card);
  }
}

function generateInstagramNames(history) {
  const used = new Set(history.map((item) => item.username));
  const batch = [];
  while (batch.length < 50) {
    const random = crypto.getRandomValues(new Uint32Array(2));
    const first = instaNames[random[0] % instaNames.length];
    const surname = instaSurnames[random[1] % instaSurnames.length];
    const username = first + surname + 'x' + crypto.randomUUID().slice(0, 8);
    if (used.has(username)) continue;
    used.add(username);
    batch.push(username);
  }
  return batch;
}

$('instaBatchForm').onsubmit = async (event) => {
  event.preventDefault();
  if (instaBusy || !session) return;
  const identity = session;
  instaBusy = true;
  $('instaGenerate').disabled = true;
  const input = $('instaPassword');
  try {
    const state = readInstagram();
    if (state.pending.length) return;
    if (!state.secret) {
      if (!input.value.trim()) {
        notify('Informe a senha fixa do gerador.');
        return;
      }
      state.secret = await encrypt('', input.value, instaKey);
      input.value = '';
    }
    if (session !== identity) return;
    const current = readInstagram();
    if (current.pending.length || (current.secret && current.secret !== state.secret)) return;
    current.secret = state.secret;
    current.pending = generateInstagramNames(current.history);
    current.step = 'username';
    saveInstagram(current);
    notify('50 logins gerados.');
  } catch {
    if (session === identity) notify('Não foi possível salvar o lote.');
  } finally {
    instaBusy = false;
    if (session === identity && activeView === 'instaCreator') refreshInstagram();
  }
};

$('instaCopy').onclick = async () => {
  if (instaBusy || !session) return;
  const identity = session;
  instaBusy = true;
  $('instaCopy').disabled = true;
  try {
    const state = readInstagram();
    const username = state.pending[0];
    if (!username) return;
    const currentText = $('instaCurrent').children[0]?.textContent || '';
    const password = currentText.slice(username.length + 1);
    if (!currentText.startsWith(username + '\n') || !password) return;
    await navigator.clipboard.writeText(state.step === 'password' ? password : username);
    if (session !== identity) return;
    const current = readInstagram();
    if (current.pending[0] !== username || current.step !== state.step) return;
    if (current.step === 'password') {
      current.history.push({ username, status: 'Em análise' });
      current.pending = current.pending.slice(1);
      current.step = 'username';
    } else {
      current.step = 'password';
    }
    saveInstagram(current);
    notify(state.step === 'password' ? 'Senha copiada. Login salvo em análise.' : 'Usuário copiado.');
  } catch {
    if (session === identity) notify('Não foi possível concluir a cópia e salvar o progresso.');
  } finally {
    instaBusy = false;
    if (session === identity && ['instaCreator', 'instaTests'].includes(activeView)) refreshInstagram();
  }
};

window.addEventListener('storage', (event) => {
  if (event.key === instaKey && ['instaCreator', 'instaTests'].includes(activeView)) refreshInstagram();
});

let documentDatabase;
let documentPreviewUrl;

function documentsDatabase() {
  if (!documentDatabase) {
    documentDatabase = new Promise((resolve, reject) => {
      const name = 'minha-central:documentos:' + config.url + ':' + config.adminEmail;
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('metadata', { keyPath: 'id' });
        request.result.createObjectStore('files');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      documentDatabase = undefined;
      throw error;
    });
  }
  return documentDatabase;
}

async function documentsTransaction(stores, mode, run) {
  const database = await documentsDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(stores, mode);
    const result = run(transaction);
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onabort = () => reject(transaction.error || new Error('Operação interrompida.'));
  });
}

function documentType(filename, bytes) {
  const head = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
  const signature = (expected) => expected.every((value, index) => head[index] === value);
  if (/\.png$/i.test(filename) && signature([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (/\.jpe?g$/i.test(filename) && signature([255, 216, 255])) return 'image/jpeg';
  if (/\.pdf$/i.test(filename) && signature([37, 80, 68, 70, 45])) return 'application/pdf';
  return null;
}

async function sealDocument(id, part, bytes, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(id + ':' + part),
  }, key, bytes);
  return { iv, ciphertext };
}

function openDocumentPart(id, part, sealed, key) {
  return crypto.subtle.decrypt({
    name: 'AES-GCM', iv: sealed.iv, additionalData: encoder.encode(id + ':' + part),
  }, key, sealed.ciphertext);
}

async function showDocuments() {
  activeView = 'documents';
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  render();
  await refreshDocuments();
}

async function refreshDocuments() {
  const key = vaultKey;
  const list = $('documentList');
  list.replaceChildren(element('p', 'login', 'Carregando documentos…'));
  try {
    const entries = await documentsTransaction(['metadata'], 'readonly', (transaction) =>
      transaction.objectStore('metadata').getAll());
    const documents = await Promise.all(entries.map(async ({ id, sealed }) => {
      try {
        const raw = await openDocumentPart(id, 'metadata', sealed, key);
        return { id, ...JSON.parse(decoder.decode(raw)) };
      } catch {
        return null;
      }
    }));
    if (vaultKey !== key || activeView !== 'documents') return;
    list.replaceChildren();
    for (const document of documents.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt)) {
      const card = element('article', 'card document-card');
      card.append(element('h3', '', document.owner));
      const files = document.attachments || [{ filename: document.filename, fileKey: document.id, part: 'file' }];
      for (const file of files) {
        const section = element('section', 'document-attachment');
        if (file.label) section.append(element('strong', '', file.label));
        const actions = element('div', 'card-actions');
        actions.append(
          button('Visualizar', 'btn dark', () => accessDocument(document.id, file, false)),
          button('Baixar', 'btn', () => accessDocument(document.id, file, true)),
        );
        section.append(element('p', 'login', file.filename), actions);
        card.append(section);
      }
      const actions = element('div', 'card-actions');
      actions.append(button(files.length > 1 ? 'Excluir conjunto' : 'Excluir', 'btn', () => deleteDocument(document, files)));
      card.append(actions);
      list.append(card);
    }
    if (!entries.length) list.append(element('div', 'empty', 'Nenhum documento salvo.'));
    if (documents.includes(null)) list.append(element('div', 'empty', 'Alguns documentos não puderam ser abertos com a senha atual.'));
  } catch {
    if (vaultKey === key && activeView === 'documents') {
      list.replaceChildren(element('div', 'empty', 'Não foi possível abrir os documentos deste navegador.'));
    }
  }
}

function addDocument() {
  if (busy || !vaultKey) return;
  $('fields').replaceChildren();
  $('modalTitle').textContent = 'Adicionar documento';
  field('owner', 'De quem é o documento?', { maxLength: 150 });
  const slots = [
    ['single', 'Arquivo avulso'],
    ['selfie', 'Selfie'],
    ['front', 'Frente'],
    ['back', 'Verso'],
  ];
  $('fields').append(element('p', '', 'Selecione pelo menos um arquivo PNG, JPG ou PDF.'));
  for (const [name, title] of slots) {
    const label = element('label', 'field', title);
    const input = document.createElement('input');
    input.name = name;
    input.type = 'file';
    input.accept = '.png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf';
    label.append(input);
    $('fields').append(label);
  }
  $('form').onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const files = slots.map(([name, label]) => ({ name, label, file: data.get(name) }))
      .filter(({ file }) => file?.name);
    saveDocument(data.get('owner').trim(), files);
  };
  dialog.showModal();
}

async function saveDocument(owner, files) {
  if (busy || !vaultKey) return;
  if (!owner || !files.length) {
    notify('Preencha o titular e selecione um arquivo.');
    return;
  }
  const key = vaultKey;
  busy = true;
  $('save').disabled = true;
  try {
    const id = crypto.randomUUID();
    const attachments = [];
    const contents = [];
    for (const { name, label, file } of files) {
      const type = documentType(file.name, await file.slice(0, 8).arrayBuffer());
      if (!type) {
        notify(label + ': selecione um arquivo PNG, JPG ou PDF válido.');
        return;
      }
      const part = 'file:' + name;
      const fileKey = id + ':' + name;
      attachments.push({ label, filename: file.name, fileKey, part });
      const bytes = await file.arrayBuffer();
      contents.push({ fileKey, sealed: await sealDocument(id, part, bytes, key) });
    }
    const metadata = { owner, attachments, createdAt: Date.now() };
    const sealed = await sealDocument(id, 'metadata', encoder.encode(JSON.stringify(metadata)), key);
    if (vaultKey !== key) return;
    await documentsTransaction(['metadata', 'files'], 'readwrite', (transaction) => {
      transaction.objectStore('metadata').put({ id, sealed });
      const store = transaction.objectStore('files');
      for (const content of contents) store.put(content.sealed, content.fileKey);
    });
    dialog.close();
    notify('Documento salvo.');
    await refreshDocuments();
  } catch {
    notify('Não foi possível salvar o documento. Verifique o espaço disponível no navegador.');
  } finally {
    busy = false;
    $('save').disabled = false;
  }
}

function clearDocumentPreview() {
  $('documentPreviewContent').replaceChildren();
  $('documentPreviewTitle').textContent = '';
  if (documentPreviewUrl) URL.revokeObjectURL(documentPreviewUrl);
  documentPreviewUrl = undefined;
}

async function deleteDocument(document, files) {
  if (busy || !vaultKey) return;
  const message = files.length > 1
    ? 'Excluir os ' + files.length + ' arquivos deste cadastro?'
    : 'Excluir este documento?';
  if (!confirm(message)) return;
  busy = true;
  try {
    await documentsTransaction(['metadata', 'files'], 'readwrite', (transaction) => {
      transaction.objectStore('metadata').delete(document.id);
      const store = transaction.objectStore('files');
      for (const file of files) store.delete(file.fileKey);
    });
    notify(files.length > 1 ? 'Conjunto excluído.' : 'Documento excluído.');
    await refreshDocuments();
  } catch {
    notify('Não foi possível excluir o documento.');
  } finally {
    busy = false;
  }
}

async function accessDocument(id, file, download) {
  const key = vaultKey;
  if (!key) return;
  try {
    const sealed = await documentsTransaction(['files'], 'readonly', (transaction) =>
      transaction.objectStore('files').get(file.fileKey));
    const bytes = await openDocumentPart(id, file.part, sealed, key);
    if (vaultKey !== key || activeView !== 'documents') return;
    const type = documentType(file.filename, bytes);
    if (!type) throw new Error('Formato inválido.');
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    if (download) {
      const link = element('a', '');
      link.href = url;
      link.download = file.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return;
    }
    clearDocumentPreview();
    const preview = element(type === 'application/pdf' ? 'iframe' : 'img', '');
    preview.src = url;
    preview.title = file.filename;
    if (type !== 'application/pdf') preview.alt = file.filename;
    documentPreviewUrl = url;
    $('documentPreviewTitle').textContent = file.filename;
    $('documentPreviewContent').append(preview);
    $('documentPreview').showModal();
  } catch {
    if (vaultKey === key) notify('Não foi possível abrir o documento.');
  }
}

$('addDocument').onclick = addDocument;
$('closeDocumentPreview').onclick = () => $('documentPreview').close();
$('documentPreview').addEventListener('close', clearDocumentPreview);

const calendarId = 'calendarPro';
const calendarMonthFormat = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const calendarDateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeZone: 'UTC' });
let calendarDate;
let calendarMonth;
let reminderDate;

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function upcomingObligations(records, date) {
  return records.filter((record) => {
    const days = elapsedDays(date, record.date);
    return !record.inactive && days >= 0 && days <= 3;
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function refreshCalendarReminder(records) {
  if (!session) return;
  try {
    reminderDate = today();
    const upcoming = upcomingObligations(records ?? readDirectory(calendarId), reminderDate);
    $('calendarBanner').hidden = !upcoming.length || activeView === calendarId;
    $('calendarBannerText').textContent = upcoming.length === 1
      ? '1 obrigação vence nos próximos 3 dias.'
      : upcoming.length + ' obrigações vencem nos próximos 3 dias.';
    const list = $('calendarReminderList');
    list.replaceChildren();
    for (const item of upcoming) {
      const days = elapsedDays(reminderDate, item.date);
      const when = days === 0 ? 'Hoje' : days === 1 ? 'Amanhã' : 'Em ' + days + ' dias';
      const link = button(when + ' · ' + item.name, 'btn', () => selectCalendarDate(item.date));
      const row = element('li', '');
      row.append(link);
      list.append(row);
    }
    $('calendarDueSoon').hidden = !upcoming.length;
  } catch {
    $('calendarBanner').hidden = true;
  }
}

function showCalendar(date = calendarDate || today()) {
  activeView = calendarId;
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  render();
  selectCalendarDate(date);
}

function selectCalendarDate(date) {
  calendarDate = date;
  calendarMonth = date.slice(0, 7);
  renderCalendar();
}

function moveCalendarMonth(delta) {
  const date = new Date(calendarMonth + '-01T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + delta);
  const next = date.toISOString().slice(0, 10);
  if (validCalendarDate(next)) selectCalendarDate(next);
}

function renderCalendar() {
  const grid = $('calendarDays');
  const entries = $('calendarEntries');
  let records;
  try {
    records = readDirectory(calendarId);
  } catch {
    entries.replaceChildren(element('div', 'empty', 'Não foi possível abrir as obrigações.'));
    return;
  }
  refreshCalendarReminder(records);
  const marked = new Set(records.filter((record) => !record.inactive).map((record) => record.date));
  const current = today();
  const first = new Date(calendarMonth + '-01T00:00:00Z');
  $('calendarMonth').textContent = calendarMonthFormat.format(first);
  $('calendarSelectedTitle').textContent = calendarDateFormat.format(new Date(calendarDate + 'T00:00:00Z'));
  grid.replaceChildren();
  for (let index = 0; index < first.getUTCDay(); index += 1) grid.append(element('span', ''));
  const date = new Date(first);
  while (date.getUTCMonth() === first.getUTCMonth()) {
    const key = date.toISOString().slice(0, 10);
    const control = button(String(date.getUTCDate()), 'calendar-day', () => {
      selectCalendarDate(key);
      [...grid.children].find((item) => item.dataset.date === key)?.focus();
    });
    control.dataset.date = key;
    control.dataset.marked = String(marked.has(key));
    control.setAttribute('aria-pressed', String(key === calendarDate));
    if (key === current) control.setAttribute('aria-current', 'date');
    control.setAttribute('aria-label', calendarDateFormat.format(date) + (marked.has(key) ? ', com obrigação' : ''));
    grid.append(control);
    date.setUTCDate(date.getUTCDate() + 1);
  }
  entries.replaceChildren();
  for (const record of records.filter((item) => item.date === calendarDate)) {
    const card = element('article', 'card calendar-entry');
    const actions = element('div', 'card-actions');
    actions.append(
      button('Editar', 'btn', () => editObligation(record)),
      button(record.inactive ? 'Reativar' : 'Desmarcar', 'btn', () => {
        changeObligation((list) => list.map((item) => item.id === record.id ? { ...item, inactive: !item.inactive } : item));
      }),
      button('Excluir', 'btn', () => {
        if (confirm('Excluir esta obrigação?')) changeObligation((list) => list.filter((item) => item.id !== record.id));
      }),
    );
    card.append(element('h3', '', record.name));
    if (record.amount !== null) card.append(element('p', '', currency.format(record.amount / 100)));
    if (record.note) card.append(element('p', '', record.note));
    if (record.inactive) card.append(element('span', 'tag', 'Desmarcada'));
    card.append(actions);
    entries.append(card);
  }
  if (!entries.childElementCount) entries.append(element('div', 'empty', 'Nenhuma obrigação nesta data.'));
}

function changeObligation(update) {
  try {
    updateDirectory(calendarId, update);
    renderCalendar();
    notify('Alteração salva.');
  } catch {
    notify('Não foi possível salvar a obrigação.');
  }
}

function editObligation(record) {
  if (!openLocalForm(record ? 'Editar obrigação' : 'Adicionar obrigação', (data) => {
    const name = String(data.get('name') || '').trim();
    const date = String(data.get('date') || '');
    const rawAmount = String(data.get('amount') || '').trim();
    const amount = rawAmount ? moneyInCents(rawAmount) : null;
    if (!name || !validCalendarDate(date)) inputError('Informe a obrigação e uma data válida.');
    if (rawAmount && amount === null) inputError('Informe um valor válido, por exemplo 49,90.');
    const values = { name, date, amount, note: String(data.get('note') || '').trim() };
    updateDirectory(calendarId, (list) => {
      if (!record) return [...list, { ...values, id: crypto.randomUUID(), inactive: false }];
      if (!list.some((item) => item.id === record.id)) inputError('Esta obrigação já foi excluída.');
      return list.map((item) => item.id === record.id ? { ...item, ...values } : item);
    });
    selectCalendarDate(date);
  })) return;
  field('name', 'Obrigação', { value: record?.name, maxLength: 150 });
  field('date', 'Data', { type: 'date', value: record?.date || calendarDate });
  field('amount', 'Valor (R$, opcional)', {
    required: false, value: record?.amount != null ? (record.amount / 100).toFixed(2).replace('.', ',') : '',
  });
  field('note', 'Observações (opcional)', { type: 'textarea', required: false, value: record?.note, maxLength: 4096 });
  dialog.showModal();
}

$('calendarPrevious').onclick = () => moveCalendarMonth(-1);
$('calendarNext').onclick = () => moveCalendarMonth(1);
$('calendarToday').onclick = () => selectCalendarDate(today());
$('addObligation').onclick = () => editObligation();
$('calendarBannerOpen').onclick = () => showCalendar(today());

window.addEventListener('focus', () => {
  if (activeView === calendarId) renderCalendar();
  else refreshCalendarReminder();
});
window.addEventListener('storage', (event) => {
  if (!session || event.key !== directoryPrefix + calendarId) return;
  if (activeView === calendarId) renderCalendar();
  else refreshCalendarReminder();
});
setInterval(() => {
  if (!session || reminderDate === today()) return;
  if (activeView === calendarId) renderCalendar();
  else refreshCalendarReminder();
}, 60000);

restoreSession();
