// Formularios por categoría: campos extra que se piden al crear un ticket de esa categoría (p. ej. "Alta de usuario").
// Una categoría con formulario también aparece en la lista de categorías del sistema.
const db = require('./db');

const TYPES = ['text', 'textarea', 'select', 'date'];
const LIMITS = { text: 500, textarea: 3000, select: 100, date: 10 };
const MAX_FIELDS = 15;

const normName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'campo';

function all() {
  const out = {};
  for (const r of db.prepare('SELECT category, fields FROM category_forms ORDER BY category').all()) {
    try { out[r.category] = JSON.parse(r.fields); } catch { out[r.category] = []; }
  }
  return out;
}
const names = () => db.prepare('SELECT category FROM category_forms ORDER BY category').all().map((r) => r.category);
const find = (category) => names().find((n) => n.toLowerCase() === String(category || '').toLowerCase()) || null;

// Valida y normaliza la definición que llega del administrador. Lanza Error con mensaje en español.
function cleanFields(list) {
  if (!Array.isArray(list)) throw new Error('Los campos deben ser una lista');
  if (list.length > MAX_FIELDS) throw new Error(`Máximo ${MAX_FIELDS} campos por formulario`);
  const used = new Set();
  return list.map((f, i) => {
    const label = String(f?.label || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
    if (!label) throw new Error(`El campo ${i + 1} necesita un nombre`);
    const type = TYPES.includes(f.type) ? f.type : 'text';
    let options = [];
    if (type === 'select') {
      options = [...new Set((Array.isArray(f.options) ? f.options : String(f.options || '').split(','))
        .map((o) => String(o).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
      if (options.length < 2) throw new Error(`"${label}": una lista necesita al menos 2 opciones`);
    }
    let key = slug(label); let n = 2;
    while (used.has(key)) key = `${slug(label)}_${n++}`;
    used.add(key);
    return { key, label, type, required: f.required === true || f.required === 'true', options };
  });
}

function save(category, fields) {
  const name = normName(category);
  if (name.length < 2) throw new Error('El nombre de la categoría debe tener entre 2 y 60 caracteres');
  const clean = cleanFields(fields);
  const existing = find(name);
  db.prepare('INSERT INTO category_forms (category, fields) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET fields = excluded.fields')
    .run(existing || name.charAt(0).toUpperCase() + name.slice(1), JSON.stringify(clean));
  return { category: existing || name.charAt(0).toUpperCase() + name.slice(1), fields: clean };
}
const remove = (category) => db.prepare('DELETE FROM category_forms WHERE category = ?').run(find(category) || category).changes > 0;

// Valida las respuestas del solicitante. Devuelve [{ label, value }] (se guardan tal cual, aunque el formulario cambie después).
function validate(category, answers) {
  const name = find(category);
  if (!name) return [];
  const def = all()[name] || [];
  const a = answers && typeof answers === 'object' ? answers : {};
  const out = [];
  for (const f of def) {
    let v = a[f.key];
    v = typeof v === 'string' ? v.replace(/\u0000/g, '').trim() : v == null ? '' : String(v);
    if (!v) { if (f.required) throw Object.assign(new Error(`Completa el campo "${f.label}"`), { status: 400 }); continue; }
    if (v.length > LIMITS[f.type]) throw Object.assign(new Error(`"${f.label}" es demasiado largo`), { status: 400 });
    if (f.type === 'select' && !f.options.includes(v)) throw Object.assign(new Error(`Elige una opción válida en "${f.label}"`), { status: 400 });
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw Object.assign(new Error(`Fecha no válida en "${f.label}"`), { status: 400 });
    out.push({ label: f.label, value: v });
  }
  return out;
}

module.exports = { all, names, find, save, remove, validate, normName };
