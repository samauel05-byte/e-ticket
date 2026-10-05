const $ = (s) => document.querySelector(s);
// Si no existe logo.png, quitar la imagen (la CSP no permite onerror en línea)
document.addEventListener('error', (e) => { if (e.target.matches && e.target.matches('img.logo-login, img.logo-top')) e.target.remove(); }, true);
document.querySelectorAll('img.logo-top').forEach((i) => { if (i.complete && !i.naturalWidth) i.remove(); });
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
async function upload(id, files) {
  if (!files.length) return;
  const fd = new FormData();
  [...files].forEach((f) => fd.append('files', f));
  const res = await fetch(`/api/tickets/${id}/attachments`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Error al subir archivos');
}
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const formData = (f) => Object.fromEntries(new FormData(f));
const options = (list, sel) => list.map((o) => `<option value="${esc(o.id ?? o)}" ${(o.id ?? o) == sel ? 'selected' : ''}>${label(o.name ?? o)}</option>`).join('');

// ---------- Auth views ----------
function authView(mode) {
  const reg = mode === 'register' && !meta.imap;
  let needDept = false;
  const draw = () => {
    app.innerHTML = `<div class="card auth"><img class="logo-login" src="logo.png" alt="Grupo Dupla"><h2>${reg ? 'Crear cuenta' : 'Iniciar sesión'}</h2>
    <form id="f">
      ${reg || needDept ? `<label>Nombre completo</label><input name="name" required>` : ''}
      <label>Correo de la empresa</label><input name="email" type="email" placeholder="usuario@${esc(meta.domain)}" required ${needDept ? 'readonly' : ''}>
      <label>Contraseña${meta.imap ? ' de tu correo' : ''}</label><input name="password" type="password" minlength="${reg ? 8 : 1}" required ${needDept ? 'readonly' : ''}>
      ${reg || needDept ? `<label>Departamento</label><select name="department_id">${options(meta.departments)}</select>` : ''}
      <button>${reg ? 'Registrarme' : needDept ? 'Continuar' : 'Entrar'}</button><div class="err" id="err"></div>
    </form>
    ${meta.imap ? '<p class="muted">Usa tu correo y contraseña de la empresa.</p>'
      : `<p class="muted">${reg ? '¿Ya tienes cuenta? <a href="#/login">Inicia sesión</a>' : '¿Primera vez? <a href="#/register">Regístrate</a>'}</p>`}</div>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      try {
        const r = await api(reg ? '/register' : '/login', { method: 'POST', body });
        if (r.needs_department) { needDept = true; draw(); $('#f').email.value = body.email; $('#f').password.value = body.password; return; }
        me = r; location.hash = '#/tickets'; start();
      } catch (er) { $('#err').textContent = er.message; }
    };
  };
  draw();
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
    <td>${esc(t.department)}</td><td>${badge(t.priority)}</td><td>${badge(t.status)}${!t.resolved_at && (t.sla_response_breached || t.sla_resolve_breached) ? ' <span class="badge b-urgente">SLA vencido</span>' : ''}</td><td>${esc(t.assignee_name || '—')}</td></tr>`).join('')}</table>`
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
    <label>Adjuntos (opcional)</label><input type="file" name="files" multiple>
    <p class="muted">Máx. 5 archivos de 10 MB: imágenes, PDF, Office, txt, log, csv, zip.</p>
    <p class="muted">Se registrará a nombre de ${esc(me.name)} (${esc(me.department)}).</p>
    <button>Enviar ticket</button><div class="err" id="err"></div></form></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const files = e.target.files.files;
    const body = formData(e.target); delete body.files;
    let t;
    try { t = await api('/tickets', { method: 'POST', body }); } catch (er) { return ($('#err').textContent = er.message); }
    try { await upload(t.id, files); } catch (er) { alert('El ticket se creó, pero los adjuntos fallaron: ' + er.message); }
    location.hash = '#/ticket/' + t.id;
  };
}

async function detailView(id) {
  const t = await api('/tickets/' + id);
  const staff = isStaff() ? await api('/staff') : [];
  app.innerHTML = `<div class="card"><a href="#/tickets">← Volver</a>
    <h2>#${t.id} · ${esc(t.title)}</h2>
    <p class="muted">${esc(t.requester_name)} (${esc(t.requester_email)}) · ${esc(t.department)} · ${esc(t.category)} · ${esc(t.created_at)} UTC</p>
    <p>${badge(t.priority)} ${badge(t.status)} · Asignado: ${esc(t.assignee_name || '—')}</p>
    <p class="muted">Primera respuesta: ${t.first_response_at ? esc(t.first_response_at) + ' UTC' : 'pendiente'} (límite ${new Date(t.sla_response_due).toLocaleString()}${t.sla_response_breached ? ' · <b class="err">vencido</b>' : ''})<br>
    Resolución: ${t.resolved_at ? esc(t.resolved_at) + ' UTC' : 'pendiente'} (límite ${new Date(t.sla_resolve_due).toLocaleString()}${t.sla_resolve_breached ? ' · <b class="err">vencido</b>' : ''})</p>
    <p style="white-space:pre-wrap">${esc(t.description)}</p></div>
    ${isStaff() ? `<div class="card"><h3>Gestionar</h3><form id="mgr" class="grid2">
      <div><label>Estado</label><select name="status">${options(meta.statuses, t.status)}</select></div>
      <div><label>Prioridad</label><select name="priority">${options(meta.priorities, t.priority)}</select></div>
      <div><label>Asignar a</label><select name="assignee_id"><option value="">Sin asignar</option>${options(staff.map((s) => ({ id: s.id, name: s.name })), t.assignee_id)}</select></div>
      <div><button>Guardar</button></div></form></div>` : ''}
    <div class="card"><h3>Adjuntos</h3>
      ${t.attachments.map((a) => `<div>📎 <a href="/api/attachments/${a.id}">${esc(a.original_name)}</a>
        <span class="muted">${fmtSize(a.size)} · ${esc(a.author)} · ${esc(a.created_at)} UTC</span>
        ${a.user_id === me.id || me.role === 'admin' ? `<button class="link" data-del="${a.id}">eliminar</button>` : ''}</div>`).join('') || '<p class="muted">Sin adjuntos.</p>'}
      <form id="up"><input type="file" name="files" multiple required><button>Subir</button><div class="err" id="uerr"></div></form></div>
    <div class="card"><h3>Comentarios</h3>
      ${t.comments.map((c) => `<div class="comment"><strong>${esc(c.author)}</strong> ${c.role !== 'user' ? '<span class="badge">TI</span>' : ''}
      <span class="muted">${esc(c.created_at)} UTC</span><div style="white-space:pre-wrap">${esc(c.body)}</div></div>`).join('') || '<p class="muted">Sin comentarios.</p>'}
      <form id="cm"><textarea name="body" required placeholder="Escribe un comentario…"></textarea><button>Comentar</button></form></div>`;
  $('#up').onsubmit = async (e) => {
    e.preventDefault();
    try { await upload(id, e.target.files.files); detailView(id); } catch (er) { $('#uerr').textContent = er.message; }
  };
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (confirm('¿Eliminar este adjunto?')) { await api('/attachments/' + b.dataset.del, { method: 'DELETE' }); detailView(id); }
  }));
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

// ---------- Reportes ----------
async function reportsView() {
  if (!isStaff()) return (location.hash = '#/tickets');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const r = await api('/reports?' + params);
  const h = (x) => (x == null ? '—' : x + ' h');
  const p = (x) => (x == null ? '—' : x + '%');
  const tbl = (title, rows) => `<div class="card"><h3>${title}</h3><table>
    <tr><th></th><th>Total</th><th>Abiertos</th><th>Resueltos</th><th>Resp. prom.</th><th>Resol. prom.</th><th>SLA resp.</th><th>SLA resol.</th></tr>
    ${rows.map((x) => `<tr><td>${label(x.name)}</td><td>${x.total}</td><td>${x.open}</td><td>${x.resolved}</td><td>${h(x.avg_response_h)}</td><td>${h(x.avg_resolve_h)}</td><td>${p(x.response_sla_pct)}</td><td>${p(x.resolve_sla_pct)}</td></tr>`).join('')}</table></div>`;
  const s = r.summary;
  app.innerHTML = `<div class="card"><h2>Reportes</h2>
    <form id="rf" class="filters"><div><label>Desde</label><input type="date" name="from" value="${esc(r.from || '')}"></div>
    <div><label>Hasta</label><input type="date" name="to" value="${esc(r.to || '')}"></div><button>Aplicar</button>
    <a href="/api/reports/export.csv?${esc(params)}" style="align-self:end;padding:8px">⬇ Exportar CSV</a></form></div>
    <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      ${[['Tickets', s.total], ['Abiertos', s.open], ['Resp. promedio', h(s.avg_response_h)], ['Resolución prom.', h(s.avg_resolve_h)],
        ['Cumple SLA resp.', p(s.response_sla_pct)], ['Cumple SLA resol.', p(s.resolve_sla_pct)], ['Abiertos vencidos', r.overdue_open]]
        .map(([k, v]) => `<div class="card kpi"><div class="muted">${k}</div><div class="num">${v}</div></div>`).join('')}</div>
    ${tbl('Por prioridad', r.by_priority)}${tbl('Por departamento', r.by_department)}${tbl('Por categoría', r.by_category)}${tbl('Por responsable', r.by_assignee)}${tbl('Por estado', r.by_status)}
    <p class="muted">Objetivos (horas corridas) — ${Object.entries(r.sla_targets).map(([k, v]) => `${k}: respuesta ${v.response} h / resolución ${v.resolve} h`).join(' · ')}</p>`;
  $('#rf').onsubmit = (e) => {
    e.preventDefault();
    location.hash = '#/reports?' + new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v));
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
    else if (h.startsWith('/reports')) await reportsView();
    else await listView();
  } catch (e) { app.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

function start() {
  $('#top').hidden = !me;
  if (me) { $('#who').textContent = `${me.name} · ${me.department}`; $('#adminLink').hidden = me.role !== 'admin'; $('#repLink').hidden = !isStaff(); }
  route();
}
$('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); me = null; location.hash = '#/login'; start(); };
window.addEventListener('hashchange', route);
(async () => { try { me = await api('/me'); } catch { me = null; } start(); })();
