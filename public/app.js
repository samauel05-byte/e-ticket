const $ = (s) => document.querySelector(s);
// Si no existe logo.png, quitar la imagen (la CSP no permite onerror en línea)
const dropLogo = (img) => (img.closest('.logochip') || img).remove();
document.addEventListener('error', (e) => { if (e.target.matches && e.target.matches('img.logo-login, img.logo-top')) dropLogo(e.target); }, true);
document.querySelectorAll('img.logo-top').forEach((i) => { if (i.complete && !i.naturalWidth) dropLogo(i); });
const app = $('#app');
let me = null, meta = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (s) => esc(String(s).replace('_', ' '));
const badge = (v) => `<span class="badge b-${esc(v)}">${label(v)}</span>`;
const ICONS = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  alert: '<path d="m10.3 3.9-8.5 14.7A2 2 0 0 0 3.5 21.6h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
const ico = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const avatar = (n) => `<span class="avatar" title="${esc(n)}">${esc(initials(n))}</span>`;
const isBreached = (t) => !t.resolved_at && (t.sla_response_breached || t.sla_resolve_breached);
const isStaff = () => me && ['agent', 'coordinator', 'admin'].includes(me.role);   // TI: gestiona tickets
const canViewAll = () => me && (isStaff() || me.role === 'manager');               // TI y gerencia: ven todo
const canReports = () => me && ['coordinator', 'manager', 'admin'].includes(me.role); // el técnico no ve reportes
const isManager = () => me && me.role === 'manager';
const ROLE_NAMES = { user: 'Usuario', leader: 'Líder de departamento', agent: 'Técnico (TI)', coordinator: 'Encargado de TI', manager: 'Gerencia', admin: 'Administrador' };

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
    app.innerHTML = `<div class="split">
    <aside class="brandpanel"><span class="logochip"><img class="logo-login" src="logo-light.png" alt="Grupo Dupla"></span>
      <p class="tagline">Soporte de Tecnología · Grupo Dupla</p>
      <h1 class="big">ETIQUE</h1>
      <p>Pide ayuda en segundos y sigue cada solicitud hasta que queda resuelta.</p>
      <ul class="steps6">
        <li><b>E</b>Escribes tu solicitud</li>
        <li><b>T</b>Tecnología la recibe</li>
        <li><b>I</b>Interviene un técnico</li>
        <li><b>Q</b>Queda resuelta, con su solución</li>
        <li><b>U</b>Usuario informado en cada paso</li>
        <li><b>E</b>Evaluamos y mejoramos</li>
      </ul></aside>
    <section class="formside"><div class="card auth">
    <h2>${reg ? 'Crear cuenta' : 'Iniciar sesión'}</h2><p class="muted sub">${needDept ? 'Un último paso: dinos tu nombre y departamento' : 'Usa tu correo de la empresa'}</p>
    <form id="f">
      ${reg || needDept ? `<label>Nombre completo</label><input name="name" required>` : ''}
      <label>Correo de la empresa</label><input name="email" type="email" placeholder="usuario@${esc(meta.domain)}" required autocomplete="username" ${needDept ? 'readonly' : ''}>
      <label>Contraseña${meta.imap ? ' de tu correo' : ''}</label><input name="password" type="password" minlength="${reg ? 10 : 1}" required autocomplete="${reg ? 'new-password' : 'current-password'}" ${needDept ? 'readonly' : ''}>
      ${reg || needDept ? `<label>Departamento</label><select name="department_id">${options(meta.departments)}</select>` : ''}
      <button>${reg ? 'Registrarme' : needDept ? 'Continuar' : 'Entrar'}</button><div class="err" id="err" role="alert"></div>
    </form>
    ${meta.imap ? '<p class="muted" style="text-align:center;margin-top:14px">Usa tu correo y contraseña de la empresa.</p>'
      : `<p class="muted" style="text-align:center;margin-top:14px">${reg ? '¿Ya tienes cuenta? <a href="#/login">Inicia sesión</a>' : '¿Primera vez? <a href="#/register">Regístrate</a>'}</p>`}</div></section></div>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      try {
        const r = await api(reg ? '/register' : '/login', { method: 'POST', body });
        if (r.needs_department) { needDept = true; draw(); $('#f').email.value = body.email; $('#f').password.value = body.password; return; }
        if (r.needs_2fa) return codeStep();
        me = r; location.hash = canViewAll() ? '#/dashboard' : '#/tickets'; start();
      } catch (er) { $('#err').textContent = er.message; }
    };
  };
  // Segundo paso: código de la app autenticadora (o un código de recuperación)
  const codeStep = () => {
    $('.card.auth').innerHTML = `<h2>Verificación en dos pasos</h2><p class="muted sub">Escribe el código de 6 dígitos de tu app autenticadora, o uno de tus códigos de recuperación.</p>
      <form id="f2"><label>Código</label><input name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus maxlength="20">
      <button>Verificar</button><div class="err" id="err" role="alert"></div></form><p class="muted" style="text-align:center;margin-top:14px"><a href="#/login" id="back">← Volver</a></p>`;
    $('#back').onclick = (ev) => { ev.preventDefault(); draw(); };
    $('#f2').onsubmit = async (e) => {
      e.preventDefault();
      try { me = await api('/login/2fa', { method: 'POST', body: formData(e.target) }); location.hash = canViewAll() ? '#/dashboard' : '#/tickets'; start(); }
      catch (er) { $('#err').textContent = er.message; }
    };
  };
  draw();
}

// ---------- Tickets ----------
async function listView() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const onlySla = params.get('sla') === '1';
  const assigneeFilter = params.get('assignee_id');
  app.innerHTML = `<div class="pagehead"><div><h2>${canViewAll() ? 'Todos los tickets' : me.role === 'leader' ? 'Tickets de mi departamento' : `Hola, ${esc(me.name.split(' ')[0])} 👋`}</h2>
      <span class="muted">${canViewAll() ? 'Solicitudes de todos los departamentos' : me.role === 'leader' ? 'Tus solicitudes y las de tu departamento, y cómo se han resuelto' : 'Aquí ves todas tus solicitudes a Tecnología y cómo se han resuelto'}</span></div>
      <a class="btn" href="#/new" style="margin:0">+ Nuevo ticket</a></div>
    ${assigneeFilter ? `<div class="chipbar">Filtrado por responsable <a class="btn ghost" style="margin:0 0 0 8px;padding:3px 10px" href="#/tickets">✕ quitar</a></div>` : ''}
    <div id="tiles" class="tiles"></div>
    <div class="card"><form id="flt" class="filters">
      <input name="q" placeholder="Buscar…" value="${esc(params.get('q') || '')}">
      <select name="status"><option value="">Estado</option>${options(meta.statuses, params.get('status'))}</select>
      <select name="priority"><option value="">Prioridad</option>${options(meta.priorities, params.get('priority'))}</select>
      ${canViewAll() ? `<select name="department_id"><option value="">Departamento</option>${options(meta.departments, params.get('department_id'))}</select>` : ''}
      <button>Filtrar</button></form></div>
    <div id="tbl"><div class="card muted">Cargando…</div></div>`;
  $('#flt').onsubmit = (e) => {
    e.preventDefault();
    const p = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v));
    location.hash = '#/tickets?' + p;
  };
  const filtered = [...params.keys()].some((k) => params.get(k));
  const [shown, all] = await Promise.all([api('/tickets?' + params), filtered ? api('/tickets') : null]);
  const base = all || shown;
  const rows = onlySla ? shown.filter(isBreached) : shown;

  const count = (f) => base.filter(f).length;
  const tile = (key, cls, n, title, href, icon) => `<a class="tile ${cls} ${(key === 'sla' ? onlySla : params.get('status') === key) ? 'on' : ''}" href="${href}"><span class="ico">${ico(icon)}</span><div><div class="n">${n}</div><div class="t">${title}</div></div></a>`;
  $('#tiles').innerHTML =
    tile('abierto', 't-open', count((t) => t.status === 'abierto'), 'Abiertos', '#/tickets?status=abierto', 'inbox') +
    tile('en_progreso', 't-info', count((t) => t.status === 'en_progreso'), 'En progreso', '#/tickets?status=en_progreso', 'bolt') +
    tile('en_espera', 't-warn', count((t) => t.status === 'en_espera'), 'En espera', '#/tickets?status=en_espera', 'pause') +
    (canViewAll() ? tile('sla', 't-bad', count(isBreached), 'SLA vencido', '#/tickets?sla=1', 'alert') : '') +
    tile('resuelto', 't-ok', count((t) => t.status === 'resuelto'), 'Resueltos', '#/tickets?status=resuelto', 'check');

  $('#tbl').innerHTML = rows.length ? `<div class="card" style="padding:8px 12px"><table class="cards"><tr><th>#</th><th>Asunto</th><th>Solicitante</th><th>Depto.</th><th>Prioridad</th><th>Estado</th><th>Asignado</th></tr>
    ${rows.map((t) => `<tr class="row p-${esc(t.priority)}" data-id="${t.id}"><td class="tid" data-label="Ticket">#${t.id}</td><td class="ttl">${t.source === 'email' ? '<span class="src" title="Creado por correo">✉</span> ' : ''}${esc(t.title)}${t.resolution ? `<div class="sol">✔ ${esc(t.resolution.length > 110 ? t.resolution.slice(0, 110) + '…' : t.resolution)}</div>` : ''}</td>
    <td data-label="Solicitante"><span class="who-cell">${avatar(t.requester_name)}<span>${esc(t.requester_name)}</span></span></td>
    <td data-label="Depto.">${esc(t.department)}</td><td data-label="Prioridad">${badge(t.priority)}</td>
    <td data-label="Estado">${badge(t.status)}${isBreached(t) ? ' <span class="badge b-sla">SLA vencido</span>' : ''}</td>
    <td data-label="Asignado">${t.assignee_name ? `<span class="who-cell">${avatar(t.assignee_name)}<span>${esc(t.assignee_name)}</span></span>` : '<span class="muted">Sin asignar</span>'}</td></tr>`).join('')}</table></div>`
    : `<div class="card empty"><div class="big">🎫</div><h3>No hay tickets${filtered ? ' con esos filtros' : ' todavía'}</h3>
       <p class="muted">${filtered ? 'Prueba quitando algún filtro.' : 'Cuando necesites ayuda de Tecnología, crea tu primer ticket.'}</p>
       <a class="btn" href="${filtered ? '#/tickets' : '#/new'}">${filtered ? 'Ver todos' : 'Crear ticket'}</a></div>`;
  document.querySelectorAll('tr.row').forEach((r) => (r.onclick = () => (location.hash = '#/ticket/' + r.dataset.id)));
}


// Selector de categoría con la opción "Otra" para escribirla a mano
function categoryField(current) {
  const inList = !current || meta.categories.includes(current);
  return `<label>Categoría</label>
    <select name="category" class="cat">${options(meta.categories, inList ? current : '__otra__')}<option value="__otra__" ${inList ? '' : 'selected'}>Otra (escribir manualmente)…</option></select>
    <input name="category_other" class="catother" placeholder="Escribe la categoría" maxlength="60" list="catlist" value="${inList ? '' : esc(current)}" ${inList ? 'hidden' : ''} style="margin-top:8px">
    <datalist id="catlist">${(meta.extra_categories || []).map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;
}
function wireCategory(root) {
  const sel = root.querySelector('select.cat'), inp = root.querySelector('input.catother');
  if (!sel || !inp) return;
  const sync = (focus) => { const manual = sel.value === '__otra__'; inp.hidden = !manual; inp.required = manual; if (manual && focus) inp.focus(); };
  sel.addEventListener('change', () => sync(true)); sync(false);
}

function newView() {
  app.innerHTML = `<div class="card" style="max-width:720px;margin-inline:auto"><h2>Nuevo ticket</h2><p class="muted">Cuéntanos qué necesitas; TI te responderá por aquí y por correo.</p><form id="f">
    <label>Asunto</label><input name="title" maxlength="150" required autocomplete="off">
    <div id="kbsug"></div>
    <div class="grid2"><div>${categoryField('')}</div>
    <div><label>Prioridad</label><select name="priority">${options(meta.priorities, 'media')}</select></div></div>
    <div id="catform"></div>
    <label>Descripción</label><textarea name="description" required></textarea>
    <label>Adjuntos (opcional)</label><input type="file" name="files" multiple>
    <p class="muted">Máx. 5 archivos de 10 MB: imágenes, PDF, Office, txt, log, csv, zip.</p>
    <p class="muted">Se registrará a nombre de ${esc(me.name)} (${esc(me.department)}).</p>
    <button>Enviar ticket</button><div class="err" id="err"></div></form></div>`;
  wireCategory($('#f'));
  // Mientras escribe el asunto, se sugieren artículos de Ayuda que quizá resuelvan el problema
  let kbTimer = null;
  $('#f input[name=title]').addEventListener('input', (e) => {
    clearTimeout(kbTimer);
    const v = e.target.value.trim();
    if (v.length < 4) { $('#kbsug').innerHTML = ''; return; }
    kbTimer = setTimeout(async () => {
      try {
        const r = await api('/kb?limit=3&q=' + encodeURIComponent(v));
        $('#kbsug').innerHTML = r.articles.length ? `<div class="kbsug"><b>💡 ¿Alguno de estos artículos te sirve?</b>${r.articles.map((a) => `<a href="#/kb/${a.id}" target="_blank" rel="noopener">${esc(a.title)}</a>`).join('')}<span class="muted">Si no resuelven tu problema, sigue con el ticket.</span></div>` : '';
      } catch { /* sin sugerencias */ }
    }, 350);
  });
  // Formulario propio de la categoría (p. ej. "Alta de usuario"): se pinta al elegirla
  const renderForm = () => {
    const def = (meta.forms || {})[$('#f select.cat').value] || [];
    $('#catform').innerHTML = def.length ? `<div class="catform"><h3>Datos de la solicitud</h3>${def.map((f) => {
      const n = `form__${esc(f.key)}`, req = f.required ? 'required' : '';
      const input = f.type === 'textarea' ? `<textarea name="${n}" ${req} maxlength="3000"></textarea>`
        : f.type === 'select' ? `<select name="${n}" ${req}><option value="">Elige…</option>${f.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`
        : f.type === 'date' ? `<input type="date" name="${n}" ${req}>` : `<input name="${n}" ${req} maxlength="500">`;
      return `<label>${esc(f.label)}${f.required ? ' *' : ''}</label>${input}`;
    }).join('')}</div>` : '';
  };
  $('#f select.cat').addEventListener('change', renderForm); renderForm();
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const files = e.target.files.files;
    const body = formData(e.target); delete body.files;
    body.form = {};
    for (const k of Object.keys(body)) if (k.startsWith('form__')) { body.form[k.slice(6)] = body[k]; delete body[k]; }
    let t;
    try { t = await api('/tickets', { method: 'POST', body }); } catch (er) { return ($('#err').textContent = er.message); }
    try { await upload(t.id, files); } catch (er) { alert('El ticket se creó, pero los adjuntos fallaron: ' + er.message); }
    location.hash = '#/ticket/' + t.id;
  };
}

const fmtH = (h) => (h < 1 ? Math.round(h * 60) + ' min' : (Math.round(h * 10) / 10) + ' h');
function slaBox(name, doneAt, usedH, targetH, due, breached, paused) {
  const goal = `objetivo ${targetH} h hábiles`;
  if (doneAt) return `<div class="slabox ${breached ? 'bad' : 'ok'}"><b>${name}</b>${fmtH(usedH)} hábiles · ${breached ? 'fuera de SLA' : 'cumplido'}<br><span class="muted">${goal}</span></div>`;
  if (breached) return `<div class="slabox bad"><b>${name}</b>Vencido<br><span>${goal}</span></div>`;
  if (paused) return `<div class="slabox"><b>${name}</b>Reloj en pausa<br><span class="muted">${goal}</span></div>`;
  return `<div class="slabox"><b>${name}</b>Límite: ${due ? esc(new Date(due).toLocaleString()) : '—'}<br><span class="muted">${goal}</span></div>`;
}
const stepOf = (s) => (s === 'abierto' ? 0 : s === 'en_progreso' || s === 'en_espera' ? 1 : 2);

async function detailView(id) {
  const t = await api('/tickets/' + id);
  const staff = isStaff() ? await api('/staff') : [];
  const templates = isStaff() ? await api('/templates') : [];
  const cur = stepOf(t.status);
  const steps = ['Abierto', 'En progreso', t.status === 'cerrado' ? 'Cerrado' : 'Resuelto'];
  app.innerHTML = `<div class="card"><a href="#/tickets">← Volver a tickets</a>
    <h2 style="margin-top:8px">#${t.id} · ${esc(t.title)}</h2>
    <div class="meta"><span>${avatar(t.requester_name)} ${esc(t.requester_name)}</span><span>${esc(t.requester_email)}</span><span>${esc(t.department)}</span><span>${esc(t.category)}</span><span>${esc(t.created_at)} UTC</span>${t.source === 'email' ? '<span class="badge b-info">✉ Creado por correo</span>' : ''}</div>
    <div>${badge(t.priority)} ${badge(t.status)}${t.status === 'en_espera' ? ' <span class="muted">· esperando respuesta</span>' : ''} <span class="muted">· Asignado: ${esc(t.assignee_name || 'sin asignar')}</span></div>
    <div class="stepper" aria-label="Progreso">${steps.map((n, i) => `<div class="step ${i < cur || (i === 2 && cur === 2) ? 'done' : ''} ${i === cur && cur < 2 ? 'now' : ''} ${i === 2 && cur === 2 ? 'final' : ''}">${n}</div>`).join('')}</div>
    <div class="sla">${slaBox('Primera respuesta', t.first_response_at, t.response_hours, t.sla_response_target_h, t.sla_response_due, t.sla_response_breached, t.sla_paused)}
    ${slaBox('Resolución', t.resolved_at, t.resolve_hours, t.sla_resolve_target_h, t.sla_resolve_due, t.sla_resolve_breached, t.sla_paused)}</div>
    <div class="desc">${esc(t.description)}</div>
    ${t.form && t.form.length ? `<div class="formdata"><b>Datos de la solicitud</b><dl>${t.form.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl></div>` : ''}
    ${t.resolution ? `<div class="solution"><b>Solución</b><div>${esc(t.resolution)}</div></div>` : ''}
    ${t.can_confirm || t.can_reopen ? `<div class="confirmbar">${t.can_confirm ? '<span>¿Quedó resuelto?</span><button id="confirm">✔ Sí, cerrar el ticket</button>' : ''}${t.can_reopen ? '<button id="reopen" class="ghost">↺ Reabrir ticket</button>' : ''}</div><div class="err" id="aerr" role="alert"></div>` : ''}</div>
    ${isStaff() ? `<div class="card"><h3>Gestionar</h3><form id="mgr" class="grid2">
      <div><label>Estado</label><select name="status">${options(meta.statuses, t.status)}</select></div>
      <div><label>Prioridad</label><select name="priority">${options(meta.priorities, t.priority)}</select></div>
      <div>${categoryField(t.category)}</div>
      <div><label>Asignar a</label><select name="assignee_id"><option value="">Sin asignar</option>${options(staff.map((s) => ({ id: s.id, name: s.name })), t.assignee_id)}</select></div>
      <div style="grid-column:1/-1"><label>Solución <span class="muted">(obligatoria para resolver o cerrar; el usuario la verá)</span></label>
        <textarea name="resolution" placeholder="¿Cómo se resolvió?">${esc(t.resolution || '')}</textarea></div>
      <div><button style="margin-top:0">Guardar cambios</button> ${t.resolution ? '<button type="button" id="mkkb" class="ghost" style="margin-top:0">📚 Convertir la solución en artículo de Ayuda</button>' : ''}<div class="err" id="merr" role="alert"></div></div></form></div>` : ''}
    <div class="card"><h3>Adjuntos (${t.attachments.length})</h3>
      ${t.attachments.map((a) => `<div class="attach">📎 <a href="/api/attachments/${a.id}">${esc(a.original_name)}</a>
        <span class="muted">${fmtSize(a.size)} · ${esc(a.author)} · ${esc(a.created_at)} UTC</span>
        ${a.user_id === me.id || me.role === 'admin' ? `<button class="link" data-del="${a.id}">eliminar</button>` : ''}</div>`).join('') || '<p class="muted">Sin adjuntos.</p>'}
      ${isManager() ? '' : `<form id="up"><input type="file" name="files" multiple required><button class="btn ghost" style="color:var(--fg)">Subir archivos</button><div class="err" id="uerr"></div></form>`}</div>
    <div class="card"><h3>Conversación (${t.comments.length})</h3>
      <div class="comments">${t.comments.map((c) => `<div class="comment ${c.role !== 'user' ? 'ti' : ''} ${c.internal ? 'internal' : ''}">${avatar(c.author)}<div class="bubble">
        <div class="head"><strong>${esc(c.author)}</strong>${c.role !== 'user' ? '<span class="tag">TI</span>' : ''}${c.internal ? '<span class="tag note">🔒 Nota interna</span>' : ''} <span class="muted">${esc(c.created_at)} UTC</span></div>
        <div class="body">${esc(c.body)}</div></div></div>`).join('') || '<p class="muted">Aún no hay mensajes.</p>'}</div>
      ${isManager() ? '<p class="muted">Gerencia tiene acceso de solo lectura.</p>' : `<form id="cm">${isStaff() && templates.length ? `<label>Respuesta rápida</label><select id="tpl"><option value="">Elegir una plantilla…</option>${templates.map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join('')}</select>` : ''}<textarea name="body" required placeholder="Escribe un comentario…"></textarea>${isStaff() ? '<label class="chk"><input type="checkbox" name="internal"> 🔒 Nota interna (solo la ve el equipo de TI, no el solicitante)</label>' : ''}<button>Enviar comentario</button></form>`}</div>
    ${t.can_rate ? `<div class="card rate"><h3>¿Cómo fue la atención?</h3><p class="muted">Tu opinión nos ayuda a mejorar.</p>
      <form id="rf2"><div class="starsel" role="radiogroup" aria-label="Calificación">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star ${t.rating_detail && t.rating_detail.rating >= n ? 'on' : ''}" data-n="${n}" aria-label="${n} de 5">★</button>`).join('')}</div>
      <textarea name="comment" maxlength="1000" placeholder="Cuéntanos más (opcional)">${esc(t.rating_detail?.comment || '')}</textarea>
      <button>${t.rating_detail ? 'Actualizar calificación' : 'Enviar calificación'}</button> <span class="saved" id="rok" role="status"></span><div class="err" id="rerr" role="alert"></div></form></div>`
      : t.rating_detail && (isStaff() || me.role === 'manager' || me.role === 'leader') ? `<div class="card rate"><h3>Calificación del solicitante</h3><div class="starsview" title="${t.rating_detail.rating} de 5">${stars(t.rating_detail.rating)}</div>${t.rating_detail.comment ? `<p>${esc(t.rating_detail.comment)}</p>` : ''}</div>` : ''}
    <details class="card"><summary>Historial del ticket (${t.history.length})</summary><ul class="history">${t.history.map((h) => `<li><span class="muted">${esc(h.at)} UTC</span> ${esc(h.text)}${h.actor ? ` <span class="muted">· ${esc(h.actor)}</span>` : ''}</li>`).join('')}</ul></details>`;
  if ($('#up')) $('#up').onsubmit = async (e) => {
    e.preventDefault();
    try { await upload(id, e.target.files.files); detailView(id); } catch (er) { $('#uerr').textContent = er.message; }
  };
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (confirm('¿Eliminar este adjunto?')) { await api('/attachments/' + b.dataset.del, { method: 'DELETE' }); detailView(id); }
  }));
  if ($('#rf2')) {
    let chosen = t.rating_detail ? t.rating_detail.rating : 0;
    const paint = () => document.querySelectorAll('.starsel .star').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) <= chosen));
    document.querySelectorAll('.starsel .star').forEach((b) => (b.onclick = () => { chosen = Number(b.dataset.n); paint(); }));
    $('#rf2').onsubmit = async (e) => {
      e.preventDefault();
      if (!chosen) { $('#rerr').textContent = 'Elige de 1 a 5 estrellas'; return; }
      try { await api(`/tickets/${id}/rating`, { method: 'POST', body: { rating: chosen, comment: e.target.comment.value } }); $('#rerr').textContent = ''; $('#rok').textContent = '✔ ¡Gracias por tu opinión!'; }
      catch (er) { $('#rerr').textContent = er.message; }
    };
  }
  if ($('#tpl')) $('#tpl').onchange = (e) => {
    const x = templates.find((q) => String(q.id) === e.target.value);
    if (!x) return;
    const text = x.body.replace(/\{\{\s*nombre\s*\}\}/gi, t.requester_name.split(' ')[0]).replace(/\{\{\s*ticket\s*\}\}/gi, `#${t.id}`).replace(/\{\{\s*tecnico\s*\}\}/gi, me.name);
    const ta = $('#cm textarea'); ta.value = ta.value ? ta.value + '\n\n' + text : text; ta.focus(); e.target.value = '';
  };
  if ($('#cm')) $('#cm').onsubmit = async (e) => { e.preventDefault(); const b = formData(e.target); b.internal = Boolean(e.target.internal?.checked); await api(`/tickets/${id}/comments`, { method: 'POST', body: b }); detailView(id); };
  if ($('#confirm')) $('#confirm').onclick = async () => { try { await api(`/tickets/${id}/confirm`, { method: 'POST', body: {} }); detailView(id); } catch (er) { $('#aerr').textContent = er.message; } };
  if ($('#reopen')) $('#reopen').onclick = async () => {
    const reason = prompt('¿Por qué reabres el ticket? (cuéntale a TI qué sigue fallando)');
    if (reason === null) return;
    try { await api(`/tickets/${id}/reopen`, { method: 'POST', body: { reason } }); detailView(id); } catch (er) { $('#aerr').textContent = er.message; }
  };
  if ($('#mkkb')) $('#mkkb').onclick = () => { try { sessionStorage.setItem('kbDraft', JSON.stringify({ title: t.title, body: t.resolution, category: t.category, published: 0 })); } catch { /* sin almacenamiento */ } location.hash = '#/kb/new'; };
  if (isStaff()) wireCategory($('#mgr'));
  if (isStaff()) $('#mgr').onsubmit = async (e) => {
    e.preventDefault();
    const b = formData(e.target); b.assignee_id = b.assignee_id || null;
    try { await api('/tickets/' + id, { method: 'PATCH', body: b }); detailView(id); } catch (er) { $('#merr').textContent = er.message; }
  };
}

// ---------- Admin ----------
async function adminView() {
  if (me.role !== 'admin') return (location.hash = '#/tickets');
  const tabParam = new URLSearchParams(location.hash.split('?')[1] || '').get('tab');
  const tab = ['mail', 'auto', 'sec'].includes(tabParam) ? tabParam : 'users';
  const tabs = `<div class="tabs"><a href="#/admin" class="${tab === 'users' ? 'on' : ''}">Usuarios</a><a href="#/admin?tab=auto" class="${tab === 'auto' ? 'on' : ''}">Automatización</a><a href="#/admin?tab=mail" class="${tab === 'mail' ? 'on' : ''}">Correo</a><a href="#/admin?tab=sec" class="${tab === 'sec' ? 'on' : ''}">Seguridad</a></div>`;
  if (tab === 'mail') return mailAdminView(tabs);
  if (tab === 'auto') return autoAdminView(tabs);
  if (tab === 'sec') return securityAdminView(tabs);
  const users = await api('/admin/users');
  app.innerHTML = `<div class="pagehead"><div><h2>Administración</h2><span class="muted">Usuarios, roles, departamentos y turnos de almuerzo</span></div></div>${tabs}
    <div class="card"><h3>Usuarios</h3><div class="tscroll"><table class="cards"><tr><th>Nombre</th><th>Correo</th><th>Departamento</th><th>Rol</th><th>Almuerzo (TI)</th><th>Activo</th><th>Seguridad</th></tr>
    ${users.map((u) => `<tr class="row static ${u.active ? '' : 'off'}" data-id="${u.id}"><td class="ttl" data-label="Nombre"><input class="inline" data-f="name" value="${esc(u.name)}" maxlength="100" aria-label="Nombre"></td>
    <td data-label="Correo"><input class="inline" data-f="email" type="email" value="${esc(u.email)}" maxlength="200" aria-label="Correo"></td>
    <td data-label="Departamento"><select data-f="department_id">${options(meta.departments, u.department_id)}</select></td>
    <td data-label="Rol"><select data-f="role">${options(Object.entries(ROLE_NAMES).map(([id, name]) => ({ id, name })), u.role)}</select></td>
    <td data-label="Almuerzo">${!['agent', 'admin'].includes(u.role) ? '<span class="muted">—</span>' : `<select data-f="lunch_shift"><option value="">Sin turno</option>${Object.entries(meta.sla.LUNCH_SHIFTS).map(([k, v]) => `<option value="${esc(k)}" ${u.lunch_shift === k ? 'selected' : ''}>Turno ${esc(k)} (${esc(v[0])}–${esc(v[1])})</option>`).join('')}</select>`}</td>
    <td data-label="Activo"><input type="checkbox" data-f="active" ${u.active ? 'checked' : ''} ${u.id === me.id ? 'disabled' : ''} title="Desmarca para desactivar la cuenta (no podrá entrar)" aria-label="Activo"></td>
    <td data-label="Seguridad"><span class="muted">2FA ${u.totp_enabled ? 'sí' : 'no'}</span> <button class="link ulogout" type="button">cerrar sesiones</button>${u.totp_enabled ? ' <button class="link u2fa" type="button">quitar 2FA</button>' : ''}</td></tr>`).join('')}</table></div>
    <div class="saved" id="saved" role="status"></div><div class="err" id="err" role="alert"></div><p class="muted">Puedes cambiar aquí el nombre, el correo, el departamento y el rol de cada persona: se guarda al terminar de escribir.</p><p class="muted">Horario laboral SLA: ${esc(String(meta.sla.START[0]).padStart(2, '0'))}:${esc(String(meta.sla.START[1]).padStart(2, '0'))}–${esc(String(meta.sla.END[0]).padStart(2, '0'))}:${esc(String(meta.sla.END[1]).padStart(2, '0'))} (${esc(meta.sla.TZ)}). El almuerzo pausa el SLA de los tickets asignados a esa persona.</p><p class="muted">Usuario = pide tickets · Líder = además ve los tickets de su departamento · Técnico (TI) = atiende tickets; su dashboard solo muestra lo suyo; sin reportes ni administración · Encargado de TI = ve todo, asigna, dashboard del equipo y reportes; sin administración · Gerencia = ve todo, dashboard y reportes, solo lectura · Administrador = TI + administra. Los tickets solo se asignan a Técnicos y Administradores. Desmarca «Activo» para quien ya no trabaja en la empresa: no podrá entrar ni recibirá tickets, pero se conserva su historial.</p></div>
    <div class="card"><h3>Nuevo departamento</h3><form id="dep" class="filters"><input name="name" required placeholder="Nombre del departamento"><button>Agregar</button></form></div>`;
  document.querySelectorAll('tr.static select, tr.static input').forEach((s) => (s.onchange = async () => {
    try { await api('/admin/users/' + s.closest('tr').dataset.id, { method: 'PATCH', body: { [s.dataset.f]: s.type === 'checkbox' ? s.checked : s.value } }); s.closest('tr').classList.toggle('off', s.type === 'checkbox' && !s.checked); $('#err').textContent = ''; $('#saved').textContent = '✔ Guardado'; setTimeout(() => { const el = $('#saved'); if (el) el.textContent = ''; }, 2500); }
    catch (er) { $('#err').textContent = er.message; $('#saved').textContent = ''; setTimeout(adminView, 2500); }
  }));
  document.querySelectorAll('.ulogout').forEach((b) => (b.onclick = async () => { if (!confirm('¿Cerrar todas las sesiones abiertas de esta persona?')) return; try { await api(`/admin/users/${b.closest('tr').dataset.id}/logout-all`, { method: 'POST', body: {} }); $('#saved').textContent = '✔ Sesiones cerradas'; $('#err').textContent = ''; } catch (er) { $('#err').textContent = er.message; } }));
  document.querySelectorAll('.u2fa').forEach((b) => (b.onclick = async () => { if (!confirm('¿Quitar la verificación en dos pasos a esta persona? Tendrá que volver a activarla.')) return; try { await api(`/admin/users/${b.closest('tr').dataset.id}/2fa-reset`, { method: 'POST', body: {} }); adminView(); } catch (er) { $('#err').textContent = er.message; } }));
  $('#dep').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/admin/departments', { method: 'POST', body: formData(e.target) }); meta = await api('/meta'); adminView(); }
    catch (er) { $('#err').textContent = er.message; }
  };
}

// ---------- Base de conocimiento ----------
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
// Texto del artículo: se escapa TODO y solo se permiten listas, **negrita** y enlaces https
function renderBody(text) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(https:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd(); let m;
    if ((m = /^\s*[-•*]\s+(.*)$/.exec(line))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('');
}
async function kbRouter(h) {
  const m = /^\/kb\/(new|\d+)(\/edit)?/.exec(h);
  if (!m) return kbView();
  if (m[1] === 'new') return kbEditView(null);
  return m[2] ? kbEditView(Number(m[1])) : kbArticleView(Number(m[1]));
}
async function kbView() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = params.get('q') || '', cat = params.get('category') || '';
  const r = await api('/kb?' + new URLSearchParams(Object.entries({ q, category: cat }).filter(([, v]) => v)));
  app.innerHTML = `<div class="pagehead"><div><h2>Ayuda</h2><span class="muted">Soluciones a los problemas más comunes, antes de crear un ticket</span></div>
      ${isStaff() ? '<a class="btn" href="#/kb/new" style="margin:0">+ Nuevo artículo</a>' : ''}</div>
    <div class="card"><form id="kf" class="filters"><input name="q" placeholder="¿Qué problema tienes? Ej.: VPN, impresora, contraseña…" value="${esc(q)}" autofocus><button>Buscar</button></form>
      <div class="chipbar"><a class="btn ghost ${cat ? '' : 'on'}" href="#/kb${q ? '?q=' + encodeURIComponent(q) : ''}">Todos</a>${r.categories.map((c) => `<a class="btn ghost ${cat === c.category ? 'on' : ''}" href="#/kb?${new URLSearchParams({ ...(q ? { q } : {}), category: c.category })}">${esc(c.category)} (${c.n})</a>`).join('')}</div></div>
    ${r.articles.length ? r.articles.map((a) => `<a class="card kbitem" href="#/kb/${a.id}"><div><strong>${esc(a.title)}</strong>${a.published ? '' : ' <span class="badge b-warn">Borrador</span>'}<div class="muted">${esc(a.category)} · ${a.views} visita(s)${a.helpful || a.not_helpful ? ` · 👍 ${a.helpful}` : ''}</div>
      <p class="snip">${esc(a.snippet.replace(/\*\*/g, ''))}${a.snippet.length >= 200 ? '…' : ''}</p></div></a>`).join('')
      : `<div class="card"><p>No encontramos artículos${q ? ` para «${esc(q)}»` : ''}.</p><p class="muted">Si no encuentras la solución, <a href="#/new">crea un ticket</a> y Tecnología te ayudará.</p></div>`}`;
  $('#kf').onsubmit = (e) => { e.preventDefault(); const v = e.target.q.value.trim(); location.hash = '#/kb' + (v || cat ? '?' + new URLSearchParams({ ...(v ? { q: v } : {}), ...(cat ? { category: cat } : {}) }) : ''); };
}
async function kbArticleView(id) {
  const a = await api('/kb/' + id);
  app.innerHTML = `<div class="card kbarticle"><a href="#/kb">← Volver a Ayuda</a>
    <h2 style="margin-top:8px">${esc(a.title)}${a.published ? '' : ' <span class="badge b-warn">Borrador</span>'}</h2>
    <div class="muted">${esc(a.category)} · actualizado ${esc(a.updated_at)} UTC · ${a.views} visita(s)</div>
    <div class="kbbody">${renderBody(a.body)}</div>
    <div class="vote" id="vote"><span>¿Te sirvió este artículo?</span>
      <button class="ghost ${a.my_vote === 1 ? 'on' : ''}" data-v="1">👍 Sí</button><button class="ghost ${a.my_vote === 0 ? 'on' : ''}" data-v="0">👎 No</button><span class="saved" id="vok" role="status"></span></div>
    <p class="muted">¿Sigue sin resolverse? <a href="#/new">Crea un ticket</a>.</p>
    ${isStaff() ? `<div class="factions"><a class="btn ghost" href="#/kb/${a.id}/edit" style="margin:0">Editar</a>${['admin', 'coordinator'].includes(me.role) ? ' <button class="link" id="kdel">eliminar</button>' : ''}</div>` : ''}</div>`;
  document.querySelectorAll('#vote button').forEach((b) => (b.onclick = async () => {
    await api(`/kb/${id}/vote`, { method: 'POST', body: { helpful: b.dataset.v === '1' } });
    document.querySelectorAll('#vote button').forEach((x) => x.classList.toggle('on', x === b));
    $('#vok').textContent = b.dataset.v === '1' ? '¡Gracias!' : 'Gracias, lo revisaremos.';
  }));
  if ($('#kdel')) $('#kdel').onclick = async () => { if (confirm('¿Eliminar este artículo?')) { await api('/kb/' + id, { method: 'DELETE' }); location.hash = '#/kb'; } };
}
async function kbEditView(id) {
  if (!isStaff()) return (location.hash = '#/kb');
  let a = { title: '', body: '', category: 'General', published: 1 };
  if (id) a = await api('/kb/' + id);
  else { try { const d = JSON.parse(sessionStorage.getItem('kbDraft') || 'null'); if (d) { a = { ...a, ...d }; sessionStorage.removeItem('kbDraft'); } } catch { /* sin borrador */ } }
  const cats = [...new Set([...meta.categories, ...((await api('/kb')).categories.map((c) => c.category))])];
  app.innerHTML = `<div class="card" style="max-width:820px;margin-inline:auto"><a href="#/kb${id ? '/' + id : ''}">← Cancelar</a><h2 style="margin-top:8px">${id ? 'Editar artículo' : 'Nuevo artículo'}</h2>
    <form id="ef"><label>Título</label><input name="title" required minlength="3" maxlength="150" value="${esc(a.title)}" placeholder="Ej.: No puedo conectarme a la VPN">
      <label>Categoría</label><input name="category" list="kcats" maxlength="60" value="${esc(a.category)}"><datalist id="kcats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <label>Contenido <span class="muted">(líneas con - o 1. forman listas; **negrita**; los enlaces https se vuelven clicables)</span></label>
      <textarea name="body" required minlength="10" maxlength="20000" style="min-height:260px">${esc(a.body)}</textarea>
      <label class="chk"><input type="checkbox" name="published" ${a.published ? 'checked' : ''}> Publicado (si no, queda como borrador que solo ve TI)</label>
      <button>Guardar artículo</button><div class="err" id="err" role="alert"></div></form></div>`;
  $('#ef').onsubmit = async (e) => {
    e.preventDefault();
    const b = formData(e.target); b.published = e.target.published.checked;
    try { const r = await api(id ? '/kb/' + id : '/kb', { method: id ? 'PATCH' : 'POST', body: b }); location.hash = '#/kb/' + (id || r.id); }
    catch (er) { $('#err').textContent = er.message; }
  };
}

// ---------- Mi perfil ----------
function profileView() {
  app.innerHTML = `<div class="pagehead"><div><h2>Mi perfil</h2><span class="muted">Tus datos, tu contraseña y la verificación en dos pasos</span></div></div>
    <div class="card"><form id="pf"><div class="grid2">
      <div><label>Nombre completo</label><input name="name" required minlength="2" maxlength="100" value="${esc(me.name)}"></div>
      <div><label>Departamento</label><select name="department_id">${options(meta.departments, me.department_id)}</select></div>
      <div><label>Correo</label><input value="${esc(me.email)}" disabled></div>
      <div><label>Rol</label><input value="${esc(ROLE_NAMES[me.role] || me.role)}" disabled></div></div>
      <button>Guardar</button> <span class="saved" id="saved" role="status"></span><div class="err" id="err" role="alert"></div>
      <p class="muted">El correo y el rol los cambia un administrador.</p></form></div>
    ${me.must_2fa ? '<div class="card warnbox"><b>Tu rol exige la verificación en dos pasos.</b> Actívala aquí abajo para seguir usando el sistema.</div>' : ''}
    <div class="card" id="sec2fa"></div>
    ${me.local_password ? `<div class="card"><h3>Cambiar mi contraseña</h3><form id="pw"><div class="grid2"><div><label>Contraseña actual</label><input name="current" type="password" required autocomplete="current-password"></div>
      <div><label>Contraseña nueva (mínimo 10 caracteres)</label><input name="next" type="password" required minlength="10" autocomplete="new-password"></div></div>
      <button>Cambiar contraseña</button> <span class="saved" id="pwok" role="status"></span><div class="err" id="pwerr" role="alert"></div>
      <p class="muted">Al cambiarla se cierran tus sesiones abiertas en otros equipos.</p></form></div>` : ''}`;
  const draw2fa = () => {
    const box = $('#sec2fa');
    box.innerHTML = me.totp_enabled
      ? `<h3>Verificación en dos pasos <span class="chip ok">Activada</span></h3><p class="muted">Al entrar, además de tu contraseña se pide un código de tu teléfono.</p>
         ${me.must_2fa === false && !['admin', 'coordinator'].includes(me.role) ? '' : ''}
         <label>Para desactivarla, escribe un código actual</label><div class="filters"><input id="offcode" inputmode="numeric" maxlength="20" placeholder="000000"><button id="off" class="ghost">Desactivar</button></div><div class="err" id="e2" role="alert"></div>`
      : `<h3>Verificación en dos pasos <span class="chip off">Desactivada</span></h3><p class="muted">Protege tu cuenta con un código que cambia cada 30 segundos (Google Authenticator, Microsoft Authenticator, Authy…).</p>
         <button id="on">Activar</button><div class="err" id="e2" role="alert"></div>`;
    if ($('#on')) $('#on').onclick = async () => {
      try {
        const r = await api('/me/2fa/setup', { method: 'POST', body: {} });
        box.innerHTML = `<h3>Activar verificación en dos pasos</h3><ol class="steps2fa"><li>En tu app autenticadora elige <b>Agregar cuenta → Ingresar clave de configuración</b> y escribe esta clave (cuenta: ${esc(me.email)}):<div class="secretbox">${esc(r.secret.match(/.{1,4}/g).join(' '))}</div></li>
          <li>Escribe aquí el código de 6 dígitos que muestra la app:<div class="filters"><input id="oncode" inputmode="numeric" maxlength="8" placeholder="000000"><button id="confirm2fa">Confirmar</button></div></li></ol><div class="err" id="e2" role="alert"></div>`;
        $('#confirm2fa').onclick = async () => {
          try {
            const x = await api('/me/2fa/enable', { method: 'POST', body: { code: $('#oncode').value } });
            me = await api('/me');
            box.innerHTML = `<h3>Verificación en dos pasos <span class="chip ok">Activada</span></h3><p><b>Guarda estos códigos de recuperación.</b> Cada uno sirve una sola vez si pierdes tu teléfono. No se vuelven a mostrar.</p>
              <div class="codes">${x.recovery_codes.map((c) => `<code>${esc(c)}</code>`).join('')}</div><button id="done" style="margin-top:12px">Ya los guardé</button>`;
            $('#done').onclick = () => { draw2fa(); start(); };
          } catch (er) { $('#e2').textContent = er.message; }
        };
      } catch (er) { $('#e2').textContent = er.message; }
    };
    if ($('#off')) $('#off').onclick = async () => {
      try { await api('/me/2fa/disable', { method: 'POST', body: { code: $('#offcode').value } }); me = await api('/me'); draw2fa(); } catch (er) { $('#e2').textContent = er.message; }
    };
  };
  draw2fa();
  if ($('#pw')) $('#pw').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/me/password', { method: 'POST', body: formData(e.target) }); e.target.reset(); $('#pwerr').textContent = ''; $('#pwok').textContent = '✔ Contraseña cambiada'; }
    catch (er) { $('#pwerr').textContent = er.message; $('#pwok').textContent = ''; }
  };
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      me = await api('/me', { method: 'PATCH', body: formData(e.target) });
      $('#who').innerHTML = `${esc(me.name)}<small>${esc(me.department)}</small>`; $('#avatar').textContent = initials(me.name);
      $('#err').textContent = ''; $('#saved').textContent = '✔ Guardado';
    } catch (er) { $('#err').textContent = er.message; $('#saved').textContent = ''; }
  };
}

// ---------- Administración: Seguridad ----------
const AUDIT_NAMES = { 'login.ok': 'Inicio de sesión', 'login.fail': 'Intento fallido', 'login.blocked': 'Bloqueo por intentos', 'login.disabled': 'Cuenta desactivada', 'login.2fa_fail': 'Código 2FA incorrecto', logout: 'Cierre de sesión',
  'user.register': 'Cuenta creada', 'user.update': 'Usuario modificado', 'admin.change': 'Cambio de configuración', '2fa.enable': '2FA activada', '2fa.disable': '2FA desactivada', '2fa.disable_fail': '2FA: error al desactivar', '2fa.reset': '2FA restablecida',
  'password.change': 'Contraseña cambiada', 'password.fail': 'Cambio de contraseña fallido', 'session.revoke': 'Sesiones cerradas', 'upload.rejected': 'Archivo rechazado', 'attachment.delete': 'Adjunto eliminado', 'audit.export': 'Bitácora exportada' };
async function securityAdminView(tabs) {
  const params = new URLSearchParams((location.hash.split('?')[1] || '').replace(/(^|&)tab=sec/, ''));
  const f = { action: params.get('action') || '', q: params.get('q') || '', from: params.get('from') || '', to: params.get('to') || '' };
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  const [sec, rows] = await Promise.all([api('/admin/security'), api('/admin/audit?' + qs)]);
  const icon = { ok: '✔', warn: '⚠', bad: '✘' };
  app.innerHTML = `<div class="pagehead"><div><h2>Administración</h2><span class="muted">Revisión de seguridad y bitácora de actividad</span></div></div>${tabs}
    <div class="card"><h3>Estado de la configuración <span class="chip ${sec.summary.bad ? 'bad' : sec.summary.warn ? 'off' : 'ok'}">${sec.summary.ok} bien · ${sec.summary.warn} por mejorar · ${sec.summary.bad} crítico(s)</span></h3>
      <ul class="checks">${sec.checks.map((c) => `<li class="${c.level}"><b>${icon[c.level]}</b> <span>${esc(c.msg)}${c.fix && c.level !== 'ok' ? `<div class="muted">→ ${esc(c.fix)}</div>` : ''}</span></li>`).join('')}</ul>
      <p class="muted">Se cambian en el archivo <code>.env</code> del servidor y se reinicia el sistema. En una terminal: <code>npm run security:check</code>.</p></div>
    <div class="kpis">${[['Usuarios activos', sec.stats.users, ''], ['Con verificación en 2 pasos', sec.stats.with_2fa, ''], ['Personal de TI sin 2FA', sec.stats.staff_without_2fa, sec.stats.staff_without_2fa ? 'bad' : ''],
      ['Intentos fallidos (24 h)', sec.stats.failed_logins_24h, sec.stats.failed_logins_24h > 20 ? 'bad' : ''], ['Bloqueos (24 h)', sec.stats.blocked_24h, sec.stats.blocked_24h ? 'bad' : '']]
      .map(([k, v, c]) => `<div class="card kpi ${c}"><div class="muted">${k}</div><div class="num">${v}</div></div>`).join('')}</div>
    <div class="card"><h3>Bitácora <span class="muted">· se conserva ${sec.retention_days} días</span></h3>
      <form id="af" class="filters"><input name="q" placeholder="Buscar persona, IP, detalle…" value="${esc(f.q)}"><select name="action"><option value="">Toda la actividad</option>${[['login', 'Accesos'], ['user', 'Usuarios'], ['admin', 'Configuración'], ['2fa', 'Verificación en 2 pasos'], ['password', 'Contraseñas'], ['upload', 'Adjuntos rechazados']].map(([k, v]) => `<option value="${k}" ${f.action === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input type="date" name="from" value="${esc(f.from)}" aria-label="Desde"><input type="date" name="to" value="${esc(f.to)}" aria-label="Hasta"><button>Filtrar</button>
        <a class="btn ghost" style="margin:0" href="/api/admin/audit.csv?${esc(qs)}">⬇ CSV</a></form>
      <div class="tscroll"><table class="cards"><tr><th>Fecha (UTC)</th><th>Quién</th><th>IP</th><th>Acción</th><th>Sobre</th><th>Detalle</th></tr>
      ${rows.map((r) => `<tr class="static ${/fail|blocked|rejected|disabled/.test(r.action) ? 'warnrow' : ''}"><td data-label="Fecha">${esc(r.at)}</td><td data-label="Quién">${esc(r.actor || '—')}</td><td data-label="IP">${esc(r.ip || '')}</td>
        <td data-label="Acción">${esc(AUDIT_NAMES[r.action] || r.action)}</td><td data-label="Sobre">${esc(r.target || '')}</td><td data-label="Detalle">${esc(r.detail || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin actividad con esos filtros.</td></tr>'}</table></div>
      <p class="muted">Mostrando las últimas ${rows.length} entradas. Nunca se guardan contraseñas ni códigos.</p></div>`;
  $('#af').onsubmit = (e) => { e.preventDefault(); location.hash = '#/admin?' + new URLSearchParams([['tab', 'sec'], ...[...new FormData(e.target)].filter(([, v]) => v)]); };
}

// ---------- Administración: Automatización ----------
const COND = { no_response: 'no tiene primera respuesta', unassigned: 'no tiene responsable', not_resolved: 'no está resuelto' };
const ACT = { notify: 'avisar al encargado', priority_up: 'subir la prioridad y avisar', reassign: 'reasignar a otro técnico y avisar' };
async function autoAdminView(tabs) {
  const st = await api('/admin/automation');
  const catName = (c) => (c === '*' ? 'Todas las demás categorías' : c);
  const staffBox = (cat) => `<div class="chips">${st.staff.map((u) => `<label class="chk"><input type="checkbox" data-pool="${esc(cat)}" value="${u.id}" ${(st.pools[cat] || []).includes(u.id) ? 'checked' : ''}> ${esc(u.name)}${u.role === 'admin' ? ' <span class="muted">(admin)</span>' : ''}</label>`).join('') || '<span class="muted">No hay técnicos activos.</span>'}</div>`;
  const fieldRow = (f = {}) => `<div class="frow"><input class="fl" placeholder="Nombre del campo" value="${esc(f.label || '')}" maxlength="80">
    <select class="ft"><option value="text" ${f.type === 'text' ? 'selected' : ''}>Texto</option><option value="textarea" ${f.type === 'textarea' ? 'selected' : ''}>Texto largo</option><option value="select" ${f.type === 'select' ? 'selected' : ''}>Lista</option><option value="date" ${f.type === 'date' ? 'selected' : ''}>Fecha</option></select>
    <input class="fo" placeholder="Opciones separadas por coma" value="${esc((f.options || []).join(', '))}" ${f.type === 'select' ? '' : 'hidden'}>
    <label class="chk"><input type="checkbox" class="fr" ${f.required ? 'checked' : ''}> Obligatorio</label><button type="button" class="link frm">quitar</button></div>`;
  app.innerHTML = `<div class="pagehead"><div><h2>Administración</h2><span class="muted">Asignación automática, escalamiento, respuestas rápidas y formularios</span></div></div>${tabs}
    <div class="err" id="err" role="alert"></div><div class="saved" id="saved" role="status"></div>

    <div class="card"><h3>Asignación automática</h3><p class="muted">Cada ticket nuevo (por web o por correo) se asigna solo a un técnico. Si una categoría no tiene grupo propio se usa el grupo general; si tampoco, todos los técnicos activos.</p>
      <label>Modo</label><select id="mode"><option value="off" ${st.mode === 'off' ? 'selected' : ''}>Desactivada (asigna TI a mano)</option>
        <option value="round_robin" ${st.mode === 'round_robin' ? 'selected' : ''}>Por turnos (se reparte uno a cada técnico)</option>
        <option value="least_load" ${st.mode === 'least_load' ? 'selected' : ''}>Por carga (al que tiene menos tickets abiertos)</option></select>
      <details style="margin-top:12px"><summary>Quién recibe cada categoría (opcional)</summary>
        ${st.categories.map((c) => `<div class="poolrow"><b>${esc(catName(c))}</b>${staffBox(c)}</div>`).join('')}
        <p class="muted">Sin marcar a nadie = la categoría usa el grupo general. Para el grupo general, sin marcar = todos los técnicos.</p></details>
      <button id="saveAssign">Guardar asignación</button></div>

    <div class="card"><h3>Reglas de escalamiento</h3><p class="muted">Si un ticket abierto cumple la condición durante el tiempo indicado (en horas hábiles), el sistema actúa una sola vez y avisa al encargado de TI y a los correos de <code>NOTIFY_NEW_TO</code>. Solo aplica a tickets creados después de crear la regla.</p>
      ${st.rules.length ? `<table class="cards"><tr><th>Regla</th><th>Cuando</th><th>Hacer</th><th>Activa</th><th></th></tr>${st.rules.map((r) => `<tr data-rule="${r.id}"><td class="ttl" data-label="Regla">${esc(r.name)}</td>
        <td data-label="Cuando">${r.priority === '*' ? 'Cualquier ticket' : 'Prioridad ' + esc(r.priority)} ${esc(COND[r.condition])} tras ${r.minutes} min</td><td data-label="Hacer">${esc(ACT[r.action])}</td>
        <td data-label="Activa"><input type="checkbox" class="ren" ${r.enabled ? 'checked' : ''} aria-label="Activa"></td><td><button class="link rdel">eliminar</button></td></tr>`).join('')}</table>` : '<p class="muted">Aún no hay reglas.</p>'}
      <form id="ruleForm" class="grid2" style="margin-top:12px"><div><label>Nombre</label><input name="name" required maxlength="80" placeholder="Urgente sin respuesta"></div>
        <div><label>Prioridad</label><select name="priority"><option value="*">Cualquiera</option>${meta.priorities.map((p) => `<option>${esc(p)}</option>`).join('')}</select></div>
        <div><label>Condición</label><select name="condition">${Object.entries(COND).map(([k, v]) => `<option value="${k}">Si el ticket ${v}</option>`).join('')}</select></div>
        <div><label>Tras (minutos hábiles)</label><input name="minutes" type="number" min="1" required value="30"></div>
        <div><label>Acción</label><select name="action">${Object.entries(ACT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div><button style="margin-top:28px">Agregar regla</button></div></form></div>

    <div class="card"><h3>Respuestas rápidas</h3><p class="muted">Plantillas que TI inserta al comentar. Puedes usar <code>{{nombre}}</code> (del solicitante), <code>{{ticket}}</code> y <code>{{tecnico}}</code>.</p>
      ${st.templates.map((x) => `<div class="tplrow" data-tpl="${x.id}"><input class="tt" value="${esc(x.title)}" maxlength="80" aria-label="Título"><textarea class="tb" maxlength="3000" aria-label="Texto">${esc(x.body)}</textarea>
        <div><button class="tsave" type="button">Guardar</button> <button class="link tdel" type="button">eliminar</button></div></div>`).join('')}
      <form id="tplForm" style="margin-top:12px"><label>Nueva plantilla</label><input name="title" required maxlength="80" placeholder="Título"><textarea name="body" required maxlength="3000" placeholder="Texto de la respuesta"></textarea><button>Agregar plantilla</button></form></div>

    <div class="card"><h3>Formularios por categoría</h3><p class="muted">Campos extra que se piden al crear un ticket de esa categoría (por ejemplo «Alta de usuario»). Una categoría con formulario aparece en la lista al crear tickets.</p>
      ${Object.entries(st.forms).map(([cat, fields]) => `<details class="formedit" data-cat="${esc(cat)}"><summary>${esc(cat)} <span class="muted">· ${fields.length} campo(s)</span></summary>
        <div class="frows">${fields.map(fieldRow).join('')}</div><div class="factions"><button type="button" class="ghost fadd">+ Campo</button> <button type="button" class="fsave">Guardar formulario</button> <button type="button" class="link fdel">eliminar formulario</button></div></details>`).join('') || '<p class="muted">Aún no hay formularios.</p>'}
      <form id="newForm" class="filters" style="margin-top:12px"><input name="category" required minlength="2" maxlength="60" placeholder="Nueva categoría (p. ej. Baja de usuario)"><button>Crear categoría con formulario</button></form></div>`;
  const ok = (msg) => { $('#err').textContent = ''; $('#saved').textContent = '✔ ' + msg; setTimeout(() => { const el = $('#saved'); if (el) el.textContent = ''; }, 2500); };
  const fail = (er) => { $('#saved').textContent = ''; $('#err').textContent = er.message; };
  const go = async (fn, msg) => { try { await fn(); ok(msg); await autoAdminView(tabs); } catch (er) { fail(er); } };
  $('#saveAssign').onclick = () => go(() => {
    const pools = {};
    document.querySelectorAll('input[data-pool]:checked').forEach((c) => (pools[c.dataset.pool] ||= []).push(Number(c.value)));
    return api('/admin/automation/assign', { method: 'PUT', body: { mode: $('#mode').value, pools } });
  }, 'Asignación guardada');
  $('#ruleForm').onsubmit = (e) => { e.preventDefault(); go(() => api('/admin/escalation', { method: 'POST', body: formData(e.target) }), 'Regla creada'); };
  document.querySelectorAll('.ren').forEach((c) => (c.onchange = () => go(() => api('/admin/escalation/' + c.closest('tr').dataset.rule, { method: 'PATCH', body: { enabled: c.checked } }), 'Regla actualizada')));
  document.querySelectorAll('.rdel').forEach((b) => (b.onclick = () => confirm('¿Eliminar esta regla?') && go(() => api('/admin/escalation/' + b.closest('tr').dataset.rule, { method: 'DELETE' }), 'Regla eliminada')));
  $('#tplForm').onsubmit = (e) => { e.preventDefault(); go(() => api('/admin/templates', { method: 'POST', body: formData(e.target) }), 'Plantilla creada'); };
  document.querySelectorAll('.tsave').forEach((b) => (b.onclick = () => { const r = b.closest('.tplrow'); go(() => api('/admin/templates/' + r.dataset.tpl, { method: 'PATCH', body: { title: r.querySelector('.tt').value, body: r.querySelector('.tb').value } }), 'Plantilla guardada'); }));
  document.querySelectorAll('.tdel').forEach((b) => (b.onclick = () => confirm('¿Eliminar esta plantilla?') && go(() => api('/admin/templates/' + b.closest('.tplrow').dataset.tpl, { method: 'DELETE' }), 'Plantilla eliminada')));
  $('#newForm').onsubmit = (e) => { e.preventDefault(); go(() => api('/admin/forms', { method: 'PUT', body: { category: formData(e.target).category, fields: [] } }).then(async () => { meta = await api('/meta'); }), 'Categoría creada: agrega sus campos'); };
  const wireRow = (row) => { const sel = row.querySelector('.ft'); sel.onchange = () => (row.querySelector('.fo').hidden = sel.value !== 'select'); row.querySelector('.frm').onclick = () => row.remove(); };
  document.querySelectorAll('.formedit').forEach((d) => {
    d.querySelectorAll('.frow').forEach(wireRow);
    d.querySelector('.fadd').onclick = () => { const w = document.createElement('div'); w.innerHTML = fieldRow({ type: 'text' }); const row = w.firstElementChild; d.querySelector('.frows').appendChild(row); wireRow(row); };
    d.querySelector('.fsave').onclick = () => go(async () => {
      const fields = [...d.querySelectorAll('.frow')].map((r) => ({ label: r.querySelector('.fl').value, type: r.querySelector('.ft').value, options: r.querySelector('.fo').value, required: r.querySelector('.fr').checked }));
      await api('/admin/forms', { method: 'PUT', body: { category: d.dataset.cat, fields } }); meta = await api('/meta');
    }, 'Formulario guardado');
    d.querySelector('.fdel').onclick = () => confirm('¿Eliminar el formulario y la categoría de la lista? Los tickets existentes no cambian.') && go(async () => { await api('/admin/forms?category=' + encodeURIComponent(d.dataset.cat), { method: 'DELETE' }); meta = await api('/meta'); }, 'Formulario eliminado');
  });
}

// ---------- Administración: Correo ----------
async function mailAdminView(tabs) {
  const st = await api('/admin/mail');
  const c = st.config;
  const src = (k) => (c[k].source === 'database' ? '<span class="src db">guardado aquí</span>' : c[k].source === 'env' ? '<span class="src">del archivo .env</span>' : '');
  const txt = (k, lab, ph = '', type = 'text') => `<div><label>${lab} ${src(k)}</label><input name="${k}" type="${type}" value="${esc(c[k].value ?? '')}" placeholder="${esc(ph)}" maxlength="200" autocomplete="off"></div>`;
  const pw = (k, lab) => `<div><label>${lab} ${src(k)}</label><input name="${k}" type="password" placeholder="${c[k].set ? '•••••••• (dejar vacío para conservar)' : 'Contraseña'}" autocomplete="new-password"></div>`;
  const ssl = (k, lab) => `<div><label>${lab}</label><select name="${k}"><option value="true" ${c[k].value !== 'false' ? 'selected' : ''}>Sí (SSL directo)</option><option value="false" ${c[k].value === 'false' ? 'selected' : ''}>No (STARTTLS / sin cifrar)</option></select></div>`;
  const sslSmtp = `<div><label>SSL directo (puerto 465) ${src('SMTP_SECURE')}</label><select name="SMTP_SECURE"><option value="true" ${c.SMTP_SECURE.value === 'true' ? 'selected' : ''}>Sí</option><option value="false" ${c.SMTP_SECURE.value !== 'true' ? 'selected' : ''}>No (STARTTLS, puerto 587)</option></select></div>`;
  const last = st.inbox.last;
  const poll = !st.inbox.enabled ? '<span class="chip off">Desactivada</span>' : last && !last.ok ? `<span class="chip bad">Con error: ${esc(last.error)}</span>` : st.inbox.polling ? `<span class="chip ok">Activa${last ? ' · última revisión ' + esc(new Date(last.at).toLocaleTimeString()) : ''}</span>` : '<span class="chip off">Detenida</span>';
  const sect = (id, title, desc, body, extra = '') => `<div class="card mailcard" id="s-${id}"><h3>${title}</h3><p class="muted">${desc}</p><div class="grid2">${body}</div>${extra}
    <div class="testrow"><button type="button" class="ghost" data-test="${id}">Probar conexión</button><div class="result" id="r-${id}" role="status"></div></div></div>`;
  app.innerHTML = `<div class="pagehead"><div><h2>Administración</h2><span class="muted">Configura el correo y comprueba que conecta</span></div></div>${tabs}
    <form id="mailForm">
    ${sect('login', 'Inicio de sesión con el correo', 'Los usuarios entran con su correo y contraseña de la empresa (se validan contra este servidor IMAP; la contraseña no se guarda).',
      `${txt('IMAP_HOST', 'Servidor IMAP', 'mail.empresa.com')}${txt('IMAP_PORT', 'Puerto', '993')}${ssl('IMAP_SECURE', 'SSL')}
       <div><label>Usuario de entrada ${src('IMAP_USER_FORMAT')}</label><select name="IMAP_USER_FORMAT"><option value="email" ${c.IMAP_USER_FORMAT.value !== 'local' ? 'selected' : ''}>Correo completo (usuario@dominio)</option><option value="local" ${c.IMAP_USER_FORMAT.value === 'local' ? 'selected' : ''}>Solo la parte antes de @</option></select></div>`,
      `<div class="grid2"><div><label>Probar con el correo (no se guarda)</label><input id="t-email" type="email" autocomplete="off" placeholder="usuario@grupodupla.com"></div><div><label>Su contraseña (no se guarda)</label><input id="t-pass" type="password" autocomplete="new-password"></div></div>`)}
    ${sect('inbox', 'Bandeja de soporte (crea tickets)', `Cada correo que llegue aquí se convierte en ticket. Estado: ${poll}`,
      `${txt('INBOX_HOST', 'Servidor IMAP', 'mail.empresa.com')}${txt('INBOX_PORT', 'Puerto', '993')}${ssl('INBOX_SECURE', 'SSL')}${txt('INBOX_USER', 'Cuenta de soporte', 'soporte@empresa.com')}${pw('INBOX_PASS', 'Contraseña de la cuenta')}${txt('INBOX_POLL_SECONDS', 'Revisar cada (segundos)', '60')}`)}
    ${sect('smtp', 'Avisos por correo (SMTP)', 'Con este servidor se envían las confirmaciones y respuestas a los usuarios.',
      `${txt('SMTP_HOST', 'Servidor SMTP', 'mail.empresa.com')}${txt('SMTP_PORT', 'Puerto', '465')}${sslSmtp}${txt('SMTP_USER', 'Usuario', 'soporte@empresa.com')}${pw('SMTP_PASS', 'Contraseña')}${txt('SMTP_FROM', 'Remitente', 'ETIQUE <soporte@empresa.com>')}`,
      `<div class="grid2"><div><label>Enviar además un correo de prueba a (opcional)</label><input id="t-to" type="email" autocomplete="off" placeholder="tu.correo@grupodupla.com"></div></div>`)}
    <div class="actions"><button>Guardar configuración</button><span class="saved" id="saved" role="status"></span></div><div class="err" id="err" role="alert"></div>
    <p class="muted">Lo que guardes aquí tiene prioridad sobre el archivo .env (las contraseñas se guardan cifradas). Para volver a lo del .env, borra el campo y guarda. "Probar conexión" usa lo que está escrito en pantalla aunque aún no lo hayas guardado.</p></form>`;
  const values = () => Object.fromEntries([...new FormData($('#mailForm'))].map(([k, v]) => [k, v]));
  const show = (id, r) => { const el = $('#r-' + id); el.className = 'result ' + (r.ok ? 'ok' : 'bad'); el.innerHTML = `<b>${r.ok ? '✔ Conexión exitosa' : '✘ No se pudo conectar'}</b><div>${esc(r.message)}</div>${(r.hints || []).map((h) => `<div class="hint">→ ${esc(h)}</div>`).join('')}`; };
  document.querySelectorAll('[data-test]').forEach((b) => (b.onclick = async () => {
    const id = b.dataset.test; const el = $('#r-' + id);
    b.disabled = true; el.className = 'result'; el.textContent = 'Probando…';
    try {
      const body = { what: id, values: values() };
      if (id === 'login') { body.email = $('#t-email').value; body.password = $('#t-pass').value; }
      if (id === 'smtp') body.send_to = $('#t-to').value;
      show(id, await api('/admin/mail/test', { method: 'POST', body }));
    } catch (er) { el.className = 'result bad'; el.textContent = er.message; } finally { b.disabled = false; }
  }));
  $('#mailForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/admin/mail', { method: 'PUT', body: { values: values() } }); meta = await api('/meta'); $('#err').textContent = ''; $('#saved').textContent = '✔ Guardado'; setTimeout(mailAdminView, 900, tabs); }
    catch (er) { $('#err').textContent = er.message; $('#saved').textContent = ''; }
  };
}

// ---------- Reportes ----------
async function reportsView() {
  if (!canReports()) return (location.hash = '#/tickets');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const r = await api('/reports?' + params);
  const h = (x) => (x == null ? '—' : x + ' h');
  const p = (x) => (x == null ? '—' : x + '%');
  const tbl = (title, rows) => `<details class="card"><summary>${title}</summary><div style="overflow-x:auto"><table>
    <tr><th></th><th>Total</th><th>Abiertos</th><th>Resueltos</th><th>Resp. prom.</th><th>Resol. prom.</th><th>SLA resp.</th><th>SLA resol.</th><th>Satisf.</th></tr>
    ${rows.map((x) => `<tr><td>${label(x.name)}</td><td>${x.total}</td><td>${x.open}</td><td>${x.resolved}</td><td>${h(x.avg_response_h)}</td><td>${h(x.avg_resolve_h)}</td><td>${p(x.response_sla_pct)}</td><td>${p(x.resolve_sla_pct)}</td><td>${x.avg_rating == null ? '—' : x.avg_rating + ' ★'}</td></tr>`).join('')}</table></div></details>`;
  const bars = (title, rows, color) => {
    const max = Math.max(1, ...rows.map((x) => x.total));
    return `<div class="card"><h3>${title}</h3><div class="bars">${rows.length ? rows.map((x) => `<div class="bar" title="${esc(x.name)}: ${x.total}">
      <span class="lbl">${label(x.name)}</span><span class="track"><span class="fill ${typeof color === 'function' ? color(x.name) : color}" style="width:${Math.max(3, (x.total / max) * 100)}%"></span></span><span class="val">${x.total}</span></div>`).join('') : '<p class="muted">Sin datos en este periodo.</p>'}</div></div>`;
  };
  const pColor = (n) => ({ urgente: 'red', alta: 'amber', media: 'blue', baja: '' }[n] || '');
  const sColor = (n) => ({ abierto: '', en_progreso: 'blue', en_espera: 'amber', resuelto: 'green', cerrado: 'green' }[n] || '');
  const s = r.summary;
  app.innerHTML = `<div class="pagehead"><div><h2>Reportes</h2><span class="muted">Tiempos medidos en horas hábiles</span></div>
      <a class="btn ghost" style="margin:0" href="/api/reports/export.csv?${esc(params)}">⬇ Exportar CSV</a></div>
    <div class="card"><form id="rf" class="filters"><div><label>Desde</label><input type="date" name="from" value="${esc(r.from || '')}"></div>
      <div><label>Hasta</label><input type="date" name="to" value="${esc(r.to || '')}"></div><button>Aplicar</button></form></div>
    <div class="kpis">
      ${[['Tickets', s.total, ''], ['Abiertos', s.open, ''], ['Resp. promedio', h(s.avg_response_h), ''], ['Resolución prom.', h(s.avg_resolve_h), ''],
        ['Cumple SLA resp.', p(s.response_sla_pct), ''], ['Cumple SLA resol.', p(s.resolve_sla_pct), ''], ['Satisfacción', s.avg_rating == null ? '—' : s.avg_rating + ' ★', ''], ['Abiertos vencidos', r.overdue_open, r.overdue_open ? 'bad' : '']]
        .map(([k, v, c]) => `<div class="card kpi ${c}"><div class="muted">${k}</div><div class="num">${v}</div></div>`).join('')}</div>
    <div class="charts">${bars('Por estado', r.by_status, sColor)}${bars('Por prioridad', r.by_priority, pColor)}${bars('Por departamento', r.by_department, '')}${bars('Por categoría', r.by_category, 'blue')}</div>
    ${tbl('Detalle por prioridad', r.by_priority)}${tbl('Detalle por departamento', r.by_department)}${tbl('Detalle por categoría', r.by_category)}${tbl('Detalle por responsable', r.by_assignee)}${tbl('Detalle por estado', r.by_status)}
    <p class="muted">Objetivos en horas hábiles — ${Object.entries(r.sla_targets).map(([k, v]) => `${k}: respuesta ${v.response} h / resolución ${v.resolve} h`).join(' · ')}</p>`;
  $('#rf').onsubmit = (e) => {
    e.preventDefault();
    location.hash = '#/reports?' + new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v));
  };
}

// ---------- Dashboard (TI y gerencia) ----------
async function dashboardView() {
  if (!canViewAll()) return (location.hash = '#/tickets');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const days = [7, 30, 90, 365].includes(Number(params.get('days'))) ? Number(params.get('days')) : 30;
  const d = await api('/dashboard?days=' + days);
  const h = (x) => (x == null ? '—' : (x < 1 ? Math.round(x * 60) + ' min' : x + ' h'));
  const p = (x) => (x == null ? '—' : x + '%');
  const tone = (x) => (x == null ? '' : x >= 80 ? 'good' : x >= 50 ? 'mid' : 'low');
  const s = d.summary;

  const person = (t, extra = '') => `<div class="techcard ${extra}">
    <div class="th">${extra === 'unassigned' ? '<span class="avatar">?</span>' : avatar(t.name)}<div><strong>${esc(t.name)}</strong>
      <div class="muted">${extra === 'unassigned' ? 'Tickets que nadie ha tomado' : esc(ROLE_NAMES[t.role] || '')}</div></div>
      ${extra === 'unassigned' ? '' : `<div class="gauge ${tone(t.pct_resolved)}" style="--p:${t.pct_resolved == null ? 0 : t.pct_resolved}" title="${t.pct_resolved == null ? 'Sin tickets asignados' : t.pct_resolved + '% resuelto'}"><b>${t.pct_resolved == null ? '—' : Math.round(t.pct_resolved) + '%'}</b></div>`}</div>
    <div class="tnums"><span><b>${t.total}</b> ${t.total === 1 ? 'asignado' : 'asignados'}</span><span><b>${t.resolved}</b> ${t.resolved === 1 ? 'resuelto' : 'resueltos'}</span><span><b>${t.open}</b> ${t.open === 1 ? 'abierto' : 'abiertos'}</span>
      ${t.overdue_open ? `<span class="badge b-sla">${t.overdue_open} ${t.overdue_open === 1 ? 'vencido' : 'vencidos'}</span>` : ''}</div>
    <div class="tmeta"><span>SLA respuesta <b>${p(t.response_sla_pct)}</b></span><span>SLA solución <b>${p(t.resolve_sla_pct)}</b></span>
      <span>Respuesta prom. <b>${h(t.avg_response_h)}</b></span><span>Solución prom. <b>${h(t.avg_resolve_h)}</b></span>
      <span>Satisfacción <b>${t.avg_rating == null ? '—' : t.avg_rating + ' ★'}</b>${t.rating_count ? ` <span class="muted">(${t.rating_count})</span>` : ''}</span></div>
    ${t.total ? `<a href="#/tickets?assignee_id=${extra === 'unassigned' ? 'none' : t.id}">Ver sus tickets →</a>` : ''}</div>`;

  const maxT = Math.max(1, ...d.trend.map((x) => Math.max(x.created, x.resolved)));
  const maxD = Math.max(1, ...d.by_department.map((x) => x.total));
  const first = esc(me.name.split(' ')[0]);
  app.innerHTML = `<section class="hero"><div class="seg" role="group" aria-label="Periodo">${[7, 30, 90, 365].map((n) => `<a href="#/dashboard?days=${n}" class="${n === days ? 'on' : ''}">${n === 365 ? '1 año' : n + ' días'}</a>`).join('')}</div>
      <h2>Hola, ${first} 👋</h2>
      <p>${d.scope === 'own' ? 'Así van tus tickets' : 'Así va Tecnología'} desde ${esc(d.from || 'el inicio')}. Tiempos en horas hábiles.</p>
      <div class="hstats"><div><b>${s.total}</b><span>Tickets</span></div><div><b>${p(s.pct_resolved)}</b><span>Resueltos</span></div>
        <div><b>${s.open}</b><span>Abiertos</span></div><div class="${s.overdue_open ? 'warnb' : ''}"><b>${s.overdue_open}</b><span>Vencidos</span></div></div></section>
    <div class="kpis">
      ${[['Cumple SLA respuesta', p(s.response_sla_pct), tone(s.response_sla_pct)], ['Cumple SLA solución', p(s.resolve_sla_pct), tone(s.resolve_sla_pct)],
        ['Respuesta promedio', h(s.avg_response_h), ''], ['Solución promedio', h(s.avg_resolve_h), ''],
        ['Satisfacción', s.avg_rating == null ? '—' : s.avg_rating + ' ★', s.avg_rating == null ? '' : s.avg_rating >= 4 ? 'good' : s.avg_rating >= 3 ? 'mid' : 'low']]
        .map(([k, v, c]) => `<div class="card kpi ${c}"><div class="muted">${k}</div><div class="num">${v}</div></div>`).join('')}</div>
    <h3 style="margin:18px 0 10px">${d.scope === 'own' ? 'Mi desempeño' : 'Equipo de Tecnología'}</h3>
    <div class="team">${d.team.map((t) => person(t)).join('') || '<div class="card muted">Aún no hay personal de TI. Asigna el rol en Administración.</div>'}
      ${d.unassigned && d.unassigned.total ? person(d.unassigned, 'unassigned') : ''}</div>
    <div class="charts" style="margin-top:16px">
      <div class="card"><h3>Tickets creados y resueltos · últimos 14 días</h3>
        <div class="trend" role="img" aria-label="Tickets creados y resueltos por día">${d.trend.map((x) => `<div class="tcol" title="${esc(x.day)}: ${x.created} creados, ${x.resolved} resueltos">
          <div class="tbars"><span class="c" style="height:${(x.created / maxT) * 100}%"></span><span class="r" style="height:${(x.resolved / maxT) * 100}%"></span></div>
          <div class="tlbl">${esc(x.day.slice(8))}</div></div>`).join('')}</div>
        <div class="legend"><span><i class="c"></i> Creados</span><span><i class="r"></i> Resueltos</span></div></div>
      <div class="card"><h3>Por departamento que pide</h3><div class="bars">${d.by_department.map((x) => `<div class="bar" title="${esc(x.name)}: ${x.total}">
        <span class="lbl">${label(x.name)}</span><span class="track"><span class="fill" style="width:${Math.max(3, (x.total / maxD) * 100)}%"></span></span><span class="val">${x.total}</span></div>`).join('') || '<p class="muted">Sin datos en este periodo.</p>'}</div></div>
    </div>
    <p class="muted">${canReports() ? 'Más detalle y exportación en <a href="#/reports">Reportes</a>.' : ''} “% resuelto” = tickets resueltos o cerrados entre los tickets asignados a esa persona en el periodo.</p>`;
}

// ---------- Router ----------
async function route() {
  if (!meta || (me && !meta.statuses)) meta = await api('/meta'); // sin sesión el servidor da solo lo mínimo
  const h = location.hash.replace(/^#/, '') || (canViewAll() ? '/dashboard' : '/tickets');
  document.body.classList.toggle('login', !me);
  if (me && me.must_2fa && h !== '/profile') { location.hash = '#/profile'; return; }
  if (!me) return authView(h === '/register' ? 'register' : 'login');
  const cur = h.startsWith('/ticket/') ? 'tickets' : h.startsWith('/kb') ? 'kb' : h.split('?')[0].replace('/', '') || 'tickets';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === cur));
  window.scrollTo(0, 0);
  try {
    if (h.startsWith('/ticket/')) await detailView(h.split('/')[2]);
    else if (h === '/new') newView();
    else if (h.startsWith('/kb')) await kbRouter(h);
    else if (h === '/profile') profileView();
    else if (h.startsWith('/admin')) await adminView();
    else if (h.startsWith('/reports')) await reportsView();
    else if (h.startsWith('/dashboard')) await dashboardView();
    else if (h === '/' || h === '') await (canViewAll() ? dashboardView() : listView());
    else await listView();
  } catch (e) { app.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// ---------- Actualización automática: revisa tickets nuevos o cambiados cada 30 s ----------
const REFRESH_MS = 30000;
let watchSig = null; let watchIds = null; let baseTitle = document.title;
function toast(msg) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 6000);
}
async function watchTickets() {
  if (!me || document.hidden) return;
  try {
    const list = await api('/tickets');
    const sig = JSON.stringify(list.map((t) => [t.id, t.status, t.assignee_id, t.priority]));
    const ids = new Set(list.map((t) => t.id));
    if (watchIds && sig !== watchSig) {
      const fresh = list.filter((t) => !watchIds.has(t.id) && t.requester_id !== me.id);
      if (fresh.length && canViewAll()) {
        toast(`🔔 ${fresh.length === 1 ? 'Nuevo ticket' : fresh.length + ' tickets nuevos'}: ${fresh[0].title}`);
        document.title = `(${fresh.length}) ${baseTitle}`;
      }
      const h = location.hash.replace(/^#/, '');
      const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      const y = window.scrollY;
      if (!typing && (h.startsWith('/tickets') || h === '' || h === '/')) { await (canViewAll() && (h === '' || h === '/') ? dashboardView() : listView()); window.scrollTo(0, y); }
      else if (!typing && h.startsWith('/dashboard')) { await dashboardView(); window.scrollTo(0, y); }
    }
    watchSig = sig; watchIds = ids;
  } catch { /* sin conexión o sesión vencida: se reintenta */ }
}
setInterval(watchTickets, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { document.title = baseTitle; watchTickets(); } });

function start() {
  $('#top').hidden = !me;
  watchSig = null; watchIds = null;
  if (me) { $('#who').innerHTML = `${esc(me.name)}<small>${esc(me.department)}</small>`; $('#avatar').textContent = initials(me.name); $('#adminLink').hidden = me.role !== 'admin'; $('#repLink').hidden = !canReports(); $('#dashLink').hidden = !canViewAll();
    $('#ticketsLink').textContent = canViewAll() ? 'Tickets' : me.role === 'leader' ? 'Mi departamento' : 'Mis tickets'; }
  route();
}
$('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); me = null; meta = null; location.hash = '#/login'; start(); };
window.addEventListener('hashchange', route);
(async () => { try { me = await api('/me'); } catch { me = null; } start(); })();
