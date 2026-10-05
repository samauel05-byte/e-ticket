const $ = (s) => document.querySelector(s);
const app = $('#app');
let me = null, meta = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (s) => esc(String(s).replace('_', ' '));
const badge = (v) => `<span class="badge b-${esc(v)}">${label(v)}</span>`;
const isStaff = () => me && (me.role === 'agent' || me.role === 'admin');

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error');
  return data;
}
const formData = (f) => Object.fromEntries(new FormData(f));
const options = (list, sel) => list.map((o) => `<option value="${esc(o.id ?? o)}" ${(o.id ?? o) == sel ? 'selected' : ''}>${label(o.name ?? o)}</option>`).join('');

// ---------- Auth views ----------
function authView(mode) {
  const reg = mode === 'register';
  app.innerHTML = `<div class="card auth"><h2>${reg ? 'Crear cuenta' : 'Iniciar sesión'}</h2>
  <form id="f">
    ${reg ? '<label>Nombre completo</label><input name="name" required>' : ''}
    <label>Correo de la empresa</label><input name="email" type="email" placeholder="usuario@${esc(meta.domain)}" required>
    <label>Contraseña</label><input name="password" type="password" minlength="${reg ? 8 : 1}" required>
    ${reg ? `<label>Departamento</label><select name="department_id">${options(meta.departments)}</select>` : ''}
    <button>${reg ? 'Registrarme' : 'Entrar'}</button><div class="err" id="err"></div>
  </form>
  <p class="muted">${reg ? '¿Ya tienes cuenta? <a href="#/login">Inicia sesión</a>' : '¿Primera vez? <a href="#/register">Regístrate</a>'}</p></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      me = await api(reg ? '/register' : '/login', { method: 'POST', body: formData(e.target) });
      location.hash = '#/tickets'; start();
    } catch (er) { $('#err').textContent = er.message; }
  };
}

// ---------- Tickets ----------
async function listView() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  app.innerHTML = `<div class="card"><h2>${isStaff() ? 'Todos los tickets' : 'Mis tickets'}</h2>
    <form id="flt" class="filters">
      <input name="q" placeholder="Buscar…" value="${esc(params.get('q') || '')}">
      <select name="status"><option value="">Estado</option>${options(meta.statuses, params.get('status'))}</select>
      <select name="priority"><option value="">Prioridad</option>${options(meta.priorities, params.get('priority'))}</select>
      ${isStaff() ? `<select name="department_id"><option value="">Departamento</option>${options(meta.departments, params.get('department_id'))}</select>` : ''}
      <button>Filtrar</button></form>
    <div id="stats" class="muted"></div><div id="tbl">Cargando…</div></div>`;
  $('#flt').onsubmit = (e) => {
    e.preventDefault();
    const p = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v));
    location.hash = '#/tickets?' + p;
  };
  const rows = await api('/tickets?' + params);
  $('#tbl').innerHTML = rows.length ? `<table><tr><th>#</th><th>Asunto</th><th>Solicitante</th><th>Depto.</th><th>Prioridad</th><th>Estado</th><th>Asignado</th></tr>
    ${rows.map((t) => `<tr class="row" data-id="${t.id}"><td>${t.id}</td><td>${esc(t.title)}</td><td>${esc(t.requester_name)}</td>
    <td>${esc(t.department)}</td><td>${badge(t.priority)}</td><td>${badge(t.status)}</td><td>${esc(t.assignee_name || '—')}</td></tr>`).join('')}</table>`
    : '<p class="muted">No hay tickets.</p>';
  document.querySelectorAll('tr.row').forEach((r) => (r.onclick = () => (location.hash = '#/ticket/' + r.dataset.id)));
  if (isStaff()) {
    const s = await api('/stats');
    $('#stats').textContent = s.by_status.map((x) => `${x.status.replace('_', ' ')}: ${x.n}`).join(' · ');
  }
}

function newView() {
  app.innerHTML = `<div class="card"><h2>Nuevo ticket</h2><form id="f">
    <label>Asunto</label><input name="title" maxlength="150" required>
    <div class="grid2"><div><label>Categoría</label><select name="category">${options(meta.categories)}</select></div>
    <div><label>Prioridad</label><select name="priority">${options(meta.priorities, 'media')}</select></div></div>
    <label>Descripción</label><textarea name="description" required></textarea>
    <p class="muted">Se registrará a nombre de ${esc(me.name)} (${esc(me.department)}).</p>
    <button>Enviar ticket</button><div class="err" id="err"></div></form></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { const t = await api('/tickets', { method: 'POST', body: formData(e.target) }); location.hash = '#/ticket/' + t.id; }
    catch (er) { $('#err').textContent = er.message; }
  };
}

async function detailView(id) {
  const t = await api('/tickets/' + id);
  const staff = isStaff() ? await api('/staff') : [];
  app.innerHTML = `<div class="card"><a href="#/tickets">← Volver</a>
    <h2>#${t.id} · ${esc(t.title)}</h2>
    <p class="muted">${esc(t.requester_name)} (${esc(t.requester_email)}) · ${esc(t.department)} · ${esc(t.category)} · ${esc(t.created_at)} UTC</p>
    <p>${badge(t.priority)} ${badge(t.status)} · Asignado: ${esc(t.assignee_name || '—')}</p>
    <p style="white-space:pre-wrap">${esc(t.description)}</p></div>
    ${isStaff() ? `<div class="card"><h3>Gestionar</h3><form id="mgr" class="grid2">
      <div><label>Estado</label><select name="status">${options(meta.statuses, t.status)}</select></div>
      <div><label>Prioridad</label><select name="priority">${options(meta.priorities, t.priority)}</select></div>
      <div><label>Asignar a</label><select name="assignee_id"><option value="">Sin asignar</option>${options(staff.map((s) => ({ id: s.id, name: s.name })), t.assignee_id)}</select></div>
      <div><button>Guardar</button></div></form></div>` : ''}
    <div class="card"><h3>Comentarios</h3>
      ${t.comments.map((c) => `<div class="comment"><strong>${esc(c.author)}</strong> ${c.role !== 'user' ? '<span class="badge">TI</span>' : ''}
      <span class="muted">${esc(c.created_at)} UTC</span><div style="white-space:pre-wrap">${esc(c.body)}</div></div>`).join('') || '<p class="muted">Sin comentarios.</p>'}
      <form id="cm"><textarea name="body" required placeholder="Escribe un comentario…"></textarea><button>Comentar</button></form></div>`;
  $('#cm').onsubmit = async (e) => { e.preventDefault(); await api(`/tickets/${id}/comments`, { method: 'POST', body: formData(e.target) }); detailView(id); };
  if (isStaff()) $('#mgr').onsubmit = async (e) => {
    e.preventDefault();
    const b = formData(e.target); b.assignee_id = b.assignee_id || null;
    await api('/tickets/' + id, { method: 'PATCH', body: b }); detailView(id);
  };
}

// ---------- Admin ----------
async function adminView() {
  if (me.role !== 'admin') return (location.hash = '#/tickets');
  const users = await api('/admin/users');
  app.innerHTML = `<div class="card"><h2>Usuarios</h2><table><tr><th>Nombre</th><th>Correo</th><th>Departamento</th><th>Rol</th></tr>
    ${users.map((u) => `<tr data-id="${u.id}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
    <td><select data-f="department_id">${options(meta.departments, u.department_id)}</select></td>
    <td><select data-f="role">${options(['user', 'agent', 'admin'], u.role)}</select></td></tr>`).join('')}</table>
    <div class="err" id="err"></div><p class="muted">user = solicita tickets · agent = personal de TI · admin = administra todo</p></div>
    <div class="card"><h3>Nuevo departamento</h3><form id="dep"><input name="name" required><button>Agregar</button></form></div>`;
  document.querySelectorAll('tr[data-id] select').forEach((s) => (s.onchange = async () => {
    try { await api('/admin/users/' + s.closest('tr').dataset.id, { method: 'PATCH', body: { [s.dataset.f]: s.value } }); $('#err').textContent = ''; }
    catch (er) { $('#err').textContent = er.message; adminView(); }
  }));
  $('#dep').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/admin/departments', { method: 'POST', body: formData(e.target) }); meta = await api('/meta'); adminView(); }
    catch (er) { $('#err').textContent = er.message; }
  };
}

// ---------- Router ----------
async function route() {
  if (!meta) meta = await api('/meta');
  const h = location.hash.replace(/^#/, '') || '/tickets';
  if (!me) return authView(h === '/register' ? 'register' : 'login');
  try {
    if (h.startsWith('/ticket/')) await detailView(h.split('/')[2]);
    else if (h === '/new') newView();
    else if (h === '/admin') await adminView();
    else await listView();
  } catch (e) { app.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

function start() {
  $('#top').hidden = !me;
  if (me) { $('#who').textContent = `${me.name} · ${me.department}`; $('#adminLink').hidden = me.role !== 'admin'; }
  route();
}
$('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); me = null; location.hash = '#/login'; start(); };
window.addEventListener('hashchange', route);
(async () => { try { me = await api('/me'); } catch { me = null; } start(); })();
