// Configuración compartida de adjuntos (subidas por la web y adjuntos recibidos por correo)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 10;
const MAX_FILES = 5;
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.txt', '.log', '.csv', '.doc', '.docx',
  '.xls', '.xlsx', '.ppt', '.pptx', '.zip']);
const extOf = (name) => path.extname(String(name || '')).toLowerCase();
const storedName = (original) => crypto.randomBytes(16).toString('hex') + extOf(original);

// El contenido real debe corresponder a la extensión (evita ejecutables o HTML renombrados como .pdf o .png).
const SIGS = {
  '.png': [[0x89, 0x50, 0x4e, 0x47]], '.jpg': [[0xff, 0xd8, 0xff]], '.jpeg': [[0xff, 0xd8, 0xff]], '.gif': [[0x47, 0x49, 0x46, 0x38]],
  '.pdf': [[0x25, 0x50, 0x44, 0x46]],
  '.zip': [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]], '.docx': [[0x50, 0x4b, 0x03, 0x04]], '.xlsx': [[0x50, 0x4b, 0x03, 0x04]], '.pptx': [[0x50, 0x4b, 0x03, 0x04]],
  '.doc': [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]], '.xls': [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]], '.ppt': [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
};
const TEXT = new Set(['.txt', '.log', '.csv']);
function sniffOk(ext, head) {
  if (TEXT.has(ext)) return !head.subarray(0, 4096).includes(0); // texto: sin bytes nulos (no es un binario)
  const sigs = SIGS[ext];
  return !sigs || sigs.some((sig) => sig.every((b, i) => head[i] === b));
}
function sniffFile(file, ext) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); return sniffOk(ext, buf.subarray(0, n)); } finally { fs.closeSync(fd); }
}

module.exports = { UPLOAD_DIR, MAX_MB, MAX_FILES, ALLOWED_EXT, extOf, storedName, sniffOk, sniffFile };
