@echo off
title Plataforma Local Discord Bot

echo ========================================================
echo   INICIANDO PLATAFORMA LOCAL DO DISCORD BOT
echo ========================================================
echo.

cd /d "%~dp0plataforma_local"

if not exist node_modules (
    echo [INFO] Instalando dependencias da plataforma local...
    call npm install
    echo.
)

if not exist .env (
    if exist .env.example (
        echo [INFO] Criando arquivo .env local...
        copy .env.example .env > nul
    )
)

echo [INFO] Abrindo interface no navegador (http://localhost:4000)...
timeout /t 2 /nobreak > nul
start http://localhost:4000

echo [INFO] Iniciando servidor local...
echo Pressione Ctrl+C para encerrar o servidor.
echo.
node server.js

pause
