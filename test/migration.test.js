const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

test('migración: una base anterior (sin rol manager, solución ni origen) se actualiza sin perder datos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const file = path.join(dir, 'old.db');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
      department_id INTEGER NOT NULL REFERENCES departments(id),
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','agent','admin')), created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'media', status TEXT NOT NULL DEFAULT 'abierto', requester_id INTEGER NOT NULL REFERENCES users(id),
      department_id INTEGER NOT NULL REFERENCES departments(id), assignee_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO departments (name) VALUES ('Tecnología');
    INSERT INTO users (email, name, password_hash, department_id, role) VALUES ('a@empresa.com','Ana','x',1,'admin'),('b@empresa.com','Beto','x',1,'user');
    INSERT INTO tickets (title, description, category, requester_id, department_id) VALUES ('Mi ticket','d','Otro',2,1);`);
  old.close();

  const code = `
    const db = require('./src/db');
    db.prepare("INSERT INTO users (email,name,password_hash,department_id,role) VALUES ('g@empresa.com','G','x',1,'manager')").run();
    console.log(JSON.stringify({
      users: db.prepare('SELECT email, role FROM users ORDER BY id').all(),
      ticket: db.prepare('SELECT title, requester_id, source, resolution FROM tickets').get(),
      fk: db.prepare('PRAGMA foreign_key_check').all().length,
    }));`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_PATH: file }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out.users.map((u) => u.role), ['admin', 'user', 'manager']);
  assert.deepEqual(out.ticket, { title: 'Mi ticket', requester_id: 2, source: 'web', resolution: null });
  assert.equal(out.fk, 0);
});
