import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sourceBotDir = path.join(__dirname, '../governofederal_integracao-main/governofederal_integracao-main');
const targetBotDir = 'c:/Users/renan/OneDrive/Documentos/bot_discord_oficial';

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      if (childItemName === 'node_modules') return; // ignora node_modules para fazer npm install limpo
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

async function setup() {
  console.log("🚀 Criando pasta limpa do Bot do Discord...");
  if (!fs.existsSync(targetBotDir)) {
    fs.mkdirSync(targetBotDir, { recursive: true });
  }

  // 1. Copiar arquivos fontes do Bot para a raiz do novo projeto
  console.log("📦 Copiando arquivos do Bot do Discord para:", targetBotDir);
  copyRecursiveSync(sourceBotDir, targetBotDir);

  // 2. Configurar o arquivo .env com todas as chaves
  const tokenVal = process.env.DISCORD_TOKEN || '';
  const envContent = `DISCORD_TOKEN=${tokenVal}\nGUILD_ID=1142251068890304522\nPORT=3000\n`;
  fs.writeFileSync(path.join(targetBotDir, '.env'), envContent, 'utf-8');
  console.log("🔑 Arquivo .env configurado com as chaves oficiais.");

  // 3. Copiar a Plataforma Local de Execução Única
  const targetPlataformaDir = path.join(targetBotDir, 'plataforma_local');
  copyRecursiveSync(path.join(__dirname), targetPlataformaDir);
  fs.writeFileSync(path.join(targetPlataformaDir, '.env'), `DISCORD_TOKEN=${tokenVal}\nGUILD_ID=1142251068890304522\nPORT=4000\n`, 'utf-8');

  // 4. Copiar script INICIAR_PLATAFORMA_LOCAL.bat
  const batPlataformaSource = path.join(__dirname, '../INICIAR_PLATAFORMA_LOCAL.bat');
  if (fs.existsSync(batPlataformaSource)) {
    fs.copyFileSync(batPlataformaSource, path.join(targetBotDir, 'INICIAR_PLATAFORMA_LOCAL.bat'));
  }

  // 5. Criar script INICIAR_BOT_LOCAL.bat (para rodar o bot principal com 1 clique)
  const batBotContent = `@echo off\ntitle Bot Discord Oficial - Governo Federal\necho ========================================================\necho   🚀 INICIANDO BOT DO DISCORD (PRODUCAO LOCAL)\necho ========================================================\necho.\ncd /d "%~dp0"\nif not exist node_modules (\n    echo [INFO] Instalando dependencias...\n    call npm install\n)\necho [INFO] Conectando Bot ao Discord...\nnode index.js\npause\n`;
  fs.writeFileSync(path.join(targetBotDir, 'INICIAR_BOT_LOCAL.bat'), batBotContent, 'utf-8');

  // 6. Configurar .gitignore limpo
  const gitIgnoreContent = `node_modules/\n.env\nplataforma_local/.env\nplataforma_local/node_modules/\nplataforma_local/mingit/\n*.log\n`;
  fs.writeFileSync(path.join(targetBotDir, '.gitignore'), gitIgnoreContent, 'utf-8');

  console.log("\n✅ ESTRUTURA LIMPA CRIADA COM SUCESSO EM:");
  console.log(`👉 ${targetBotDir}`);
}

setup();
