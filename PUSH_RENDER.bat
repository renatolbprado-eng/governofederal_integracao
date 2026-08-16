@echo off
title Push do Bot para o Render (governofederal_integracao)
echo ========================================================
echo   🚀 ENVIANDO ATUALIZACOES PARA O RENDER (GITHUB)
echo ========================================================
echo.
cd /d "c:\Users\renan\OneDrive\Documentos\projeto_esaj_render\projeto_esaj_render_1.0"
plataforma_local\mingit\cmd\git.exe remote set-url origin https://github.com/renatolbprado-eng/governofederal_integracao.git
echo.
echo [INFO] Enviando arquivos para https://github.com/renatolbprado-eng/governofederal_integracao...
c:\Users\renan\OneDrive\Documentos\bot_discord_oficial\plataforma_local\mingit\cmd\git.exe push origin main --force
echo.
echo ========================================================
echo   🎉 PUSH CONCLUIDO! VERIFIQUE O PAINEL DO RENDER.
echo ========================================================
pause
