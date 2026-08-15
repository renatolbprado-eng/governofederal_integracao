# ⚠️ MANUAL DE PECULIARIDADES DO SISTEMA E AMBIENTE DO USUÁRIO (PARA IAs FUTURAS)

Este documento foi criado para registrar todas as **peculiaridades técnicas, limitações de ambiente, caminhos e regras de execução específicas do computador do Dr. Renato**.

Qualquer Inteligência Artificial que for executar comandos, realizar automações, fazer deploys ou dar manutenção neste sistema **DEVE LER E SEGUIR ESTE MANUAL OBRIGATORIAMENTE** para evitar erros de execução.

---

## 📌 1. Visão Geral do Sistema
- **Sistema Operacional**: Windows 11 / 10 (x64)
- **Usuário**: Renato Prado (Dr. Renato)
- **Projeto Principal Ativo**: `c:\Users\renan\OneDrive\Documentos\bot_discord_oficial`
- **Projeto Legado (Apenas Leitura)**: `c:\Users\renan\OneDrive\Documentos\projeto_esaj_render\projeto_esaj_render_1.0`

---

## 🛠️ 2. PECULIARIDADE I: Git Não Está no %PATH% Global (MinGit Portátil)

### O Problema:
1. O comando `git` **NÃO está instalado no %PATH% global** do Windows. Executar `git status` ou `git push` diretamente no terminal resultará em `comando não reconhecido`.
2. A instalação do Git via `winget` ou instalador padrão falha em tarefas de IA em segundo plano por solicitar autorização de Administrador (Prompt UAC).

### A Solução / Como a IA Deve Executar o Git:
Existe uma versão funcional do **MinGit Portátil** baixada e pronta no sistema nos seguintes caminhos:
- **Caminho Principal**: `c:\Users\renan\OneDrive\Documentos\bot_discord_oficial\plataforma_local\mingit\cmd\git.exe`
- **Caminho Secundário**: `c:\Users\renan\OneDrive\Documentos\projeto_esaj_render\projeto_esaj_render_1.0\plataforma_local\mingit\cmd\git.exe`

Toda e qualquer chamada de comando Git deve apontar para o executável direto acima via Node.js ou CMD.

#### Exemplo em Node.js (`child_process`):
```javascript
import { execSync } from 'child_process';
const gitExe = 'c:/Users/renan/OneDrive/Documentos/bot_discord_oficial/plataforma_local/mingit/cmd/git.exe';
const rootDir = 'c:/Users/renan/OneDrive/Documentos/bot_discord_oficial';

// Exemplo de comando
execSync(`"${gitExe}" status --short`, { cwd: rootDir, encoding: 'utf-8' });
```

### Configurações Padrão do Git no Repositório:
- **Nome do Autor**: `Renato Prado`
- **E-mail do Autor**: `renato.prado@esaj.com`
- **Remote Origin**: `https://github.com/renatolbprado-eng/projeto_esaj_render_1.0.git`
- **Branch de Deploy (Render)**: `main`

---

## ⚡ 3. PECULIARIDADE II: Restrição de Execução do PowerShell (ExecutionPolicy)

### O Problema:
A política de execução de scripts do PowerShell no Windows do usuário está configurada como restrita (`PSSecurityException` / `UnauthorizedAccess`).
Tentar rodar scripts `.ps1` ou comandos `npm` diretamente via PowerShell pode gerar falhas de permissão ao carregar o `npm.ps1`.

### A Solução:
Sempre envolva a execução de comandos com `cmd /c`:
- `cmd /c "npm install"`
- `cmd /c "node server.js"`
- `cmd /c "INICIAR_BOT_LOCAL.bat"`

---

## 📜 4. PECULIARIDADE III: Codificação de Arquivos Batch (.bat) no CMD

### O Problema:
Se um arquivo `.bat` do Windows for salvo em formato UTF-8 com BOM ou contiver emojis Unicode antes da definição da página de código `chcp 65001`, o interpretador do CMD do Windows corrompe a palavra `echo` e tenta executar `'cho'` ou `'ho'`, gerando o erro:
`'cho' não é reconhecido como um comando interno ou externo`.

### A Solução:
Arquivos `.bat` criados pela IA devem ser gravados em **ASCII Puro / UTF-8 sem BOM**, usando caracteres de texto padrão nos comandos de controle do batch.

---

## 🔒 5. PECULIARIDADE IV: Bloqueio de Arquivos no Windows (File Locks)

### O Problema:
No Windows, se um script abre um stream de leitura/escrita em um arquivo (ex: `fs.createWriteStream('arquivo.zip')`), o arquivo fica **bloqueado exclusivamente** pelo sistema até o fechamento total do handle. Tentar descompactar ou apagar o arquivo antes de fechar o stream resulta em:
`New-Object : Exceção ao chamar ".ctor": O processo não pode acessar o arquivo porque ele está sendo usado por outro processo.`

### A Solução:
Em scripts Node.js de download/extração:
1. Sempre chame `file.close()` explicitamente.
2. Adicione um pequeno delay de pausa (`setTimeout(resolve, 1000)`) após o evento `finish` antes de tentar manipular ou descompactar o arquivo baixado.

---

## 🎯 6. PECULIARIDADE V: Regra de Push Seletivo para o Render

### Regra de Ouro:
O usuário costuma ter testes locais, pastas temporárias e rascunhos. **A IA NUNCA DEVE EXECUTAR `git add .` OU `git add -A`.**

### Como Fazer Push Corretamente:
Sempre adicione **exclusivamente** os arquivos que foram modificados para aquela demanda específica:

```bash
# Exemplo: Atualizar apenas o index.js do bot
"[caminho_mingit]/git.exe" add index.js
"[caminho_mingit]/git.exe" commit -m "feat: descricao da alteracao"
"[caminho_mingit]/git.exe" push origin main
```

---

## 🔑 7. PECULIARIDADE VI: Mapeamento Completo das Chaves (.env)

| Variável | Valor Configurado | Utilidade |
|---|---|---|
| `DISCORD_TOKEN` | `[CHAVE_CONFIGURADA_NO_ENV]` | Token do Bot no Discord |
| `GUILD_ID` | `1142251068890304522` | ID do Servidor Principal (GOV \| Governo) |
| `GEMINI_API_KEY` | `[CHAVE_CONFIGURADA_NO_ENV]` | Chave de API da IA Gemini (Comando `!ia`) |
| `PORT` (Bot) | `3000` | Porta do Bot Principal (Render / Roblox) |
| `PORT` (Plataforma) | `4000` | Porta da Plataforma Local de Snippets (`http://localhost:4000`) |

---

## 🚀 8. Resumo de Comandos Rápidos para a IA

- **Iniciar Bot Principal**: `cd c:\Users\renan\OneDrive\Documentos\bot_discord_oficial && cmd /c "node index.js"`
- **Iniciar Plataforma Local**: `cd c:\Users\renan\OneDrive\Documentos\bot_discord_oficial\plataforma_local && cmd /c "node server.js"`
- **Testar Execução de Snippet**: `cd c:\Users\renan\OneDrive\Documentos\bot_discord_oficial && cmd /c "node plataforma_local/executar_snippet.js meu_script.js"`
