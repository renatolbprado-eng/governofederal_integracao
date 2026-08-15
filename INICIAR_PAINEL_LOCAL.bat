@echo off
title Painel Web Local - Injetor de Comandos
echo ========================================================
echo   🌐 INICIANDO PAINEL WEB LOCAL (http://localhost:4000)
echo ========================================================
echo.
cd /d "%~dp0plataforma_local"
if not exist node_modules (
    echo [INFO] Instalando dependencias da plataforma local...
    call npm install
)

echo [INFO] Abrindo o painel no navegador (http://localhost:4000)...
timeout /t 2 >nul
start http://localhost:4000

echo [INFO] Servidor rodando na porta 4000...
node server.js
pause
