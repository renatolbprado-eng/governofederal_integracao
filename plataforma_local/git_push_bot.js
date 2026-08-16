import { execSync } from 'child_process';
import fs from 'fs';

const gitExe = 'c:/Users/renan/OneDrive/Documentos/bot_discord_oficial/plataforma_local/mingit/cmd/git.exe';
const rootDir = 'c:/Users/renan/OneDrive/Documentos/projeto_esaj_render/projeto_esaj_render_1.0';

if (fs.existsSync(gitExe)) {
  try {
    execSync(`"${gitExe}" config user.name "Renato Prado"`, { cwd: rootDir });
    execSync(`"${gitExe}" config user.email "renato.prado@esaj.com"`, { cwd: rootDir });
    execSync(`"${gitExe}" remote set-url origin https://github.com/renatolbprado-eng/governofederal_integracao.git`, { cwd: rootDir });
    execSync(`"${gitExe}" branch -M main`, { cwd: rootDir, stdio: 'inherit' });
    
    console.log("🚀 Enviando alterações do governofederal_integracao-main/index.js para o Render...");
    const pushOut = execSync(`"${gitExe}" push -u origin main --force`, { cwd: rootDir, encoding: 'utf-8' });
    console.log("🎉 PUSH CONCLUÍDO COM SUCESSO!\n", pushOut);
  } catch (err) {
    console.error("Erro ao realizar push:", err.message);
  }
}
