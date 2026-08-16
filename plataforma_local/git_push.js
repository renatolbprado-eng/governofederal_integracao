import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

const mingitZipPath = path.join(__dirname, 'mingit.zip');
const mingitDir = path.join(__dirname, 'mingit');
const gitExe = path.join(mingitDir, 'cmd', 'git.exe');

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          setTimeout(resolve, 1000);
        });
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function setupGitAndPush() {
  try {
    if (!fs.existsSync(gitExe)) {
      console.log("📥 Baixando MinGit portátil...");
      const downloadUrl = "https://github.com/git-for-windows/git/releases/download/v2.45.2.windows.1/MinGit-2.45.2-64-bit.zip";
      await downloadFile(downloadUrl, mingitZipPath);
      console.log("📦 Descompactando MinGit...");

      const psCmd = `powershell -Command "Expand-Archive -Path '${mingitZipPath}' -DestinationPath '${mingitDir}' -Force"`;
      execSync(psCmd, { stdio: 'inherit' });
    }

    console.log("✅ Git portátil ativo em:", gitExe);

    // Configura identidade do Git localmente no repositório se necessário
    execSync(`"${gitExe}" config user.name "Renato Prado"`, { cwd: rootDir });
    execSync(`"${gitExe}" config user.email "renato.prado@esaj.com"`, { cwd: rootDir });

    // 1. Desfaz qualquer staged indesejado de outros arquivos (reseta a staging area)
    execSync(`"${gitExe}" reset`, { cwd: rootDir, stdio: 'inherit' });

    // 2. Stage EXCLUSIVO do index.js
    const targetFile = "governofederal_integracao-main/governofederal_integracao-main/index.js";
    console.log(`📌 Adicionando EXCLUSIVAMENTE o arquivo: ${targetFile}`);
    execSync(`"${gitExe}" add "${targetFile}"`, { cwd: rootDir, stdio: 'inherit' });

    // Verificação de staged files (garante que apenas o index.js está na staging area)
    const stagedStatus = execSync(`"${gitExe}" status --short`, { cwd: rootDir, encoding: 'utf-8' });
    console.log("📋 Arquivos na staging area:\n", stagedStatus);

    // 3. Commit
    console.log("💬 Criando commit para o Render...");
    execSync(`"${gitExe}" commit -m "feat: adiciona botao e handler de ticket para solicitar advogado"`, { cwd: rootDir, stdio: 'inherit' });

    // 4. Push
    console.log("🚀 Realizando git push origin main...");
    const pushOutput = execSync(`"${gitExe}" push origin main`, { cwd: rootDir, encoding: 'utf-8' });
    console.log("🎉 PUSH CONCLUÍDO COM SUCESSO!\n", pushOutput);

  } catch (err) {
    console.error("❌ RETORNO/ERRO:", err.message);
  }
}

setupGitAndPush();
