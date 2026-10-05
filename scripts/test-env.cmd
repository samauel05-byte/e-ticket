@echo off
rem Ambiente de prueba para Windows (simbolo del sistema o PowerShell).
rem Uso: scripts\test-env.cmd up ^| down ^| reset ^| logs
setlocal
set F=-f docker-compose.test.yml
if "%1"=="up" goto up
if "%1"=="down" goto down
if "%1"=="reset" goto reset
if "%1"=="logs" goto logs
echo Uso: scripts\test-env.cmd up ^| down ^| reset ^| logs
exit /b 1

:up
docker compose %F% up -d --build
if errorlevel 1 exit /b 1
echo Esperando a que arranque...
set /a N=0
:wait
docker compose %F% exec -T eticket node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>&1
if not errorlevel 1 goto ready
set /a N+=1
if %N% GTR 60 goto fail
timeout /t 1 /nobreak >nul
goto wait

:ready
docker compose %F% exec -T eticket node src/seedDemo.js
echo.
echo   Sistema:           http://localhost:3000
echo   Bandeja de correo: http://localhost:8025   aqui llegan los avisos
echo.
echo   Usuarios, clave prueba1234:
echo     admin@empresa.com    administrador
echo     tecnico@empresa.com  personal de TI
echo     ana@, luis@ y marta@empresa.com   usuarios que piden tickets
exit /b 0

:fail
echo No arranco. Revisa con: scripts\test-env.cmd logs
exit /b 1

:down
docker compose %F% down
exit /b %errorlevel%

:reset
docker compose %F% down -v
call "%~f0" up
exit /b %errorlevel%

:logs
docker compose %F% logs -f eticket
exit /b 0
