@echo off
title Bot Discord Oficial & Painel Web Local
echo ========================================================
echo   🚀 INICIANDO BOT DO DISCORD E PAINEL WEB LOCAL
echo ========================================================
echo.
cd /d "%~dp0"
if not exist node_modules (
    echo [INFO] Instalando dependencias do Bot...
    call npm install
)

echo [INFO] Iniciando o Painel Web Local na porta 4000...
start "Painel Web Local (Porta 4000)" cmd /k "cd /d "%~dp0plataforma_local" && node server.js"

echo [INFO] Abrindo o painel no navegador (http://localhost:4000)...
timeout /t 2 >nul
start http://localhost:4000

echo [INFO] Conectando Bot ao Discord...
node index.js
pause
