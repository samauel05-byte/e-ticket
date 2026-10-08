# Seguridad de ETIQUE

Qué protege el sistema, qué debe hacer quien lo administra y cómo reportar un problema.

## Qué trae el sistema

**Acceso y sesiones**
- Inicio de sesión con la contraseña del correo de la empresa (nunca se guarda) o contraseñas propias con *bcrypt*.
- Límite de intentos fallidos por IP y por correo, **persistente** (sobrevive a reinicios). Un login correcto no borra el contador de la IP.
- **Verificación en dos pasos (TOTP)** opcional para todos y **obligatoria por rol** con `REQUIRE_2FA_ROLES=admin,coordinator`. Con códigos de recuperación de un solo uso, los códigos no se pueden reutilizar y el secreto se guarda cifrado.
- Sesiones: cookie `HttpOnly`, `SameSite=Strict`, `Secure` (y prefijo `__Host-`) con HTTPS; se renueva el identificador al entrar; caducan por **inactividad** (`SESSION_IDLE_MIN`, 120 min) y por **duración máxima** (`SESSION_MAX_HOURS`, 12 h).
- Cambiar la contraseña, activar/quitar el 2FA o desactivar a una persona **cierra sus demás sesiones**. El administrador puede cerrar todas las sesiones de alguien.
- Política de contraseñas (mínimo 10, no comunes, sin el usuario) para cuentas propias.

**Protección de la aplicación**
- Cabeceras: CSP estricta (sin scripts en línea, sin iframes), HSTS con HTTPS, `nosniff`, `no-referrer`, `Permissions-Policy`, `Cross-Origin-*`; la API no se guarda en caché.
- Anti-CSRF (cookie `SameSite=Strict` + verificación de `Origin`).
- Límites de uso: peticiones por IP, tickets, comentarios y adjuntos por hora y registros por IP.
- Adjuntos: lista de extensiones permitidas, **verificación del contenido real** (un ejecutable o HTML renombrado como `.pdf` o `.png` se rechaza), nombres aleatorios en disco, descarga siempre como archivo y con `sandbox`.
- Consultas SQL parametrizadas; salida escapada en la interfaz; exportaciones CSV protegidas contra fórmulas.
- Permisos por rol comprobados en el servidor en cada petición (el rol se lee de la base, no de la sesión).
- Administración, Reportes y Dashboard se pueden limitar a la red interna (`INTERNAL_CIDRS`).

**Datos y secretos**
- Las contraseñas de correo guardadas desde Administración se cifran (AES-256-GCM) y nunca se devuelven al navegador.
- `SESSION_SECRET` es obligatorio en producción y el sistema **no arranca** si es débil o es el de ejemplo.
- **Bitácora**: accesos (correctos, fallidos, bloqueos), cambios de usuarios, roles y configuración, 2FA, contraseñas, adjuntos rechazados. Sin contraseñas ni códigos. Se conserva `AUDIT_DAYS` (365) días. Administración → Seguridad.
- Contenedor endurecido en Docker (sin privilegios, solo lectura, sin capacidades extra) y HTTPS con Caddy.
- CI con `npm audit` y Dependabot para dependencias.

## Lista de verificación para quien administra

Ejecuta `npm run security:check` (o mira **Administración → Seguridad**) y deja todo en ✔:

1. `SESSION_SECRET` largo y aleatorio (`openssl rand -hex 32`).
2. HTTPS (Caddy) con `COOKIE_SECURE=true` y `TRUST_PROXY=true`.
3. `REQUIRE_2FA_ROLES=admin,coordinator` y que todo el personal de TI active su 2FA.
4. Si lo publicas en Internet: `INTERNAL_CIDRS` con tu red interna (Administración, Reportes y Dashboard solo desde adentro) y el firewall abierto solo en 80/443.
5. `.env` solo legible por el dueño (`chmod 600 .env`) y **nunca** en el repositorio ni en chats.
6. Cambia la contraseña del buzón de soporte si alguna vez se compartió.
7. Respaldos: copia `data/backups` y `data/uploads` a **otro equipo**; cifra el disco del servidor (BitLocker / LUKS), porque la base y los adjuntos no están cifrados en reposo.
8. Mantén al día el sistema operativo, Docker y Node; atiende los PR de Dependabot.
9. Revisa la bitácora de vez en cuando: muchos «Intento fallido» desde una IP = alguien probando contraseñas.
10. Cuando alguien deje la empresa: desactívalo en Administración → Usuarios (cierra sus sesiones y deja de recibir tickets).

## Lo que NO cubre
- No hay recuperación de contraseña por correo para cuentas propias (con el login por correo no hace falta). Un administrador no puede ver contraseñas.
- El sistema no cifra la base de datos en reposo ni los adjuntos: usa cifrado de disco.
- Si alguien controla el servidor, controla los datos. Protege el acceso al servidor.

## Cómo reportar una vulnerabilidad
Avisa en privado al administrador del sistema (no abras un ticket público con los detalles). Incluye los pasos para reproducirla y qué esperabas que pasara.
