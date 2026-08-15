# 🤖 GUIA COMPLETO DE CONFIGURAÇÃO E MANUTENÇÃO DO ZERO (PARA IA & DEVS)

Este documento foi criado para orientar qualquer Inteligência Artificial ou Desenvolvedor que assumir este projeto **do zero**, sem nenhum contexto prévio da conversa.

---

## 🎯 1. Visão Geral do Projeto

Este repositório (**Bot Discord Oficial - Governo Federal & Integração Roblox**) é o projeto que roda em produção no **Render**.

 Ele é responsável por:
- **Integração com o Roblox**: Envio de auditorias de votações do Plenário, notificação de início de sessões legislativas, consulta e expedição de mandados do BNMP (Banco Nacional de Mandados de Prisão) e registro de boletins de ocorrência.
- **Sistema Judiciário Discord**: Autuação de processos, sorteio e distribuição de carga entre juízes de direito, peticionamento eletrônico wizard, pauta de audiências e mandados.
- **Atendimento de Advocacia**: Sistema de tickets e solicitação de advogados (`btn_abrir_ticket_advogado`).
- **Assistente IA Gemini**: Respostas públicas e privadas via comando `!ia`.
- **Plataforma Local de Execução Única**: Dashboard web local (`http://localhost:4000`) para rodar scripts pontuais em `discord.js` sem precisar alterar o código do Git ou dar push para o Render.

---

## 📁 2. Estrutura de Pastas e Arquivos

```
bot_discord_oficial/
├── index.js                         # Código-fonte principal do Bot em produção
├── package.json                     # Dependências principais (discord.js, @google/genai, express, dotenv)
├── .env                             # Variáveis de ambiente locais (NUNCA SUBIR PRO GIT)
├── .env.example                     # Modelo de variáveis de ambiente
├── .gitignore                       # Configurado para ignorar .env e node_modules
├── INICIAR_BOT_LOCAL.bat            # Atalho 1-clique para iniciar o bot localmente
├── INICIAR_PLATAFORMA_LOCAL.bat     # Atalho 1-clique para iniciar o Dashboard Local no navegador
├── GUIA_CONFIGURACAO_ZERO_IA.md     # Este manual para IAs sem contexto
├── BNMP_prisão/                     # Módulo de armazenamento e suporte ao BNMP
└── plataforma_local/                # Plataforma local de execução pontual de scripts
    ├── server.js                    # Backend Express da plataforma local (porta 4000)
    ├── executar_snippet.js          # Executor de snippets via CLI/Terminal
    ├── INSTRUCOES_TECNICAS_IA.md    # Manual técnico específico da plataforma local
    ├── .env                         # Configuração de chave da plataforma local
    └── public/
        └── index.html               # Dashboard Web em Dark Mode
```

---

## ⚙️ 3. Passo a Passo para Configurar o Projeto do ZERO

Se uma IA ou Desenvolvedor estiver configurando este ambiente em uma nova máquina ou projeto zerado:

### Passo 1: Instalar Dependências do Bot Principal
No terminal da raiz do projeto (`bot_discord_oficial`):
```bash
npm install
```

### Passo 2: Configurar o Arquivo `.env` na Raiz
Crie um arquivo `.env` na raiz do projeto (copiando do `.env.example`) com a estrutura:
```env
DISCORD_TOKEN=seu_discord_bot_token_aqui
GUILD_ID=1142251068890304522
PORT=3000
GEMINI_API_KEY=sua_chave_gemini_opcional
```

### Passo 3: Instalar Dependências da Plataforma Local
Navegue para a pasta `plataforma_local` e instale as dependências:
```bash
cd plataforma_local
npm install
cd ..
```
E certifique-se de que o arquivo `plataforma_local/.env` possui:
```env
DISCORD_TOKEN=seu_discord_bot_token_aqui
GUILD_ID=1142251068890304522
PORT=4000
```

---

## 🚀 4. Como Executar os Serviços

### Para Iniciar o Bot Principal (Modo Produção/Local):
- **Opção A (Windows)**: Dê 2 cliques em `INICIAR_BOT_LOCAL.bat`.
- **Opção B (Terminal)**: Execute `node index.js`.

### Para Iniciar a Plataforma Local de Execução Única (Snippets/Testes):
- **Opção A (Windows)**: Dê 2 cliques em `INICIAR_PLATAFORMA_LOCAL.bat`.
- **Opção B (Terminal)**: Execute `cd plataforma_local && node server.js`.
- **Navegador**: Acesse `http://localhost:4000`.

---

## ⚡ 5. Como Usar a Plataforma Local de Snippets

A Plataforma Local permite rodar qualquer código `discord.js` instantaneamente no servidor sem alterar arquivos do projeto ou fazer deploy:

### Via Dashboard Web (`http://localhost:4000`):
1. Escreva ou escolha um template de ação rápida.
2. Variáveis injetadas automaticamente no escopo: `client`, `guild`, `EmbedBuilder`, `ActionRowBuilder`, `ButtonBuilder`, `ButtonStyle`, `ChannelType`, `PermissionFlagsBits`, `console`.
3. Clique em **🚀 Executar Código (Uma Vez)**.

### Via CLI / Linha de Comando:
```bash
node plataforma_local/executar_snippet.js "console.log(guild.name)"
```
Ou passando um arquivo `.js`:
```bash
node plataforma_local/executar_snippet.js caminho_do_script.js
```

---

## 📤 6. Como Fazer Push com Segurança para o Render

Caso a IA precise enviar atualizações para o Render **sem incluir arquivos em teste ou corrompidos**:

```bash
# 1. Adicionar APENAS o arquivo alterado (ex: index.js)
git add index.js

# 2. Criar o commit
git commit -m "feat: descricao_da_alteracao"

# 3. Enviar para a branch principal
git push origin main
```

---

## 🛡️ 7. Resolução de Problemas para a IA

- **Porta em uso (EADDRINUSE)**: Se a porta 3000 ou 4000 estiver ocupada, altere a variável `PORT` no `.env`.
- **Bot não responde a comandos de mensagem/membros**: Certifique-se de que no [Discord Developer Portal](https://discord.com/developers/applications) as opções **Message Content Intent** e **Server Members Intent** estejam HABILITADAS.
