# E-Ticket TI

Sistema de tickets de solicitud para el área de Tecnología. Node + Express + SQLite.

## Uso
```bash
npm install
cp .env.example .env   # luego exporta las variables (o defínelas al ejecutar)
ALLOWED_DOMAIN=tuempresa.com ADMIN_EMAIL=ti@tuempresa.com SESSION_SECRET=algo-largo npm start
```
Abre http://localhost:3000.

## Funcionamiento
- Solo se pueden registrar correos del dominio `ALLOWED_DOMAIN`; cada usuario elige su departamento.
- El correo `ADMIN_EMAIL` queda como **admin** al registrarse.
- Roles: `user` (crea y ve sus tickets), `agent` (personal de TI: ve todos, cambia estado/prioridad, asigna), `admin` (además gestiona usuarios, roles y departamentos).
- Los departamentos iniciales están en `src/db.js`; el admin puede agregar más desde la UI.
- Producción: define `SESSION_SECRET`, usa HTTPS con `COOKIE_SECURE=true`.
