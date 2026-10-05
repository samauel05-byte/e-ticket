const session = require('express-session');

// Almacén de sesiones en SQLite: sobreviven a reinicios del servidor.
class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)');
    this.get_ = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
    this.set_ = db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?,?,?)');
    this.del_ = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.purge_ = db.prepare('DELETE FROM sessions WHERE expires <= ?');
    this.purge();
    this.timer = setInterval(() => this.purge(), 60 * 60 * 1000);
    this.timer.unref();
  }
  purge() { this.purge_.run(Date.now()); }
  get(sid, cb) {
    try {
      const row = this.get_.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 8 * 3600 * 1000;
      this.set_.run(sid, JSON.stringify(sess), exp);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this.del_.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

module.exports = SqliteStore;
