# 📘 MANUAL COMPLETO DE CONFIGURAÇÃO E RECUPERAÇÃO DO ZERO
### Bot Unificado: Governo Federal, Corregedoria-Geral, Polícia Federal, PM & RONE

Este documento contém o guia definitivo passo a passo para reconfigurar do zero todo o ecossistema do Bot em caso de reconstrução de servidores no Discord, perda de canais ou troca de infraestrutura.

---

## 📑 SUMÁRIO
1. [Configuração do Bot no Discord Developer Portal](#1-configuração-do-bot-no-discord-developer-portal)
2. [Estrutura Completa de Servidores e Canais](#2-estrutura-completa-de-servidores-e-canais)
3. [Estrutura de Cargos e Permissões Necessárias](#3-estrutura-de-cargos-e-permissões-necessárias)
4. [Execução dos Comandos de Setup Inicial](#4-execução-dos-comandos-de-setup-inicial)
5. [Configuração de Variáveis de Ambiente (.env)](#5-configuração-de-variáveis-de-ambiente-env)
6. [Hospedagem no Render (Disaster Recovery)](#6-hospedagem-no-render-disaster-recovery)
7. [Tabela Resumo de Todos os Comandos do Bot](#7-tabela-resumo-de-todos-os-comandos-do-bot)

---

## 1. 🤖 CONFIGURAÇÃO DO BOT NO DISCORD DEVELOPER PORTAL

Se o bot precisar ser recriado na sua conta de desenvolvedor do Discord:

1. Acesse o **[Discord Developer Portal](https://discord.com/developers/applications)**.
2. Clique em **New Application** e defina o nome do aplicativo (ex: `Governo Federal & Corregedoria`).
3. No menu lateral, acesse a aba **Bot**:
   - Clique em **Reset Token** e copie a chave gerada (ela será a sua variável `DISCORD_TOKEN`).
4. **Habilitação Obrigatória de Privileged Gateway Intents** (Seção *Privileged Gateway Intents*):
   - ⚠️ **SERVER MEMBERS INTENT** (Ativar: `ON`) - Necessário para ler membros de cargos e adicionar participantes a threads privadas.
   - ⚠️ **MESSAGE CONTENT INTENT** (Ativar: `ON`) - Necessário para ler comandos `!globo`, `!oficio`, `!adv`, `!reu`, `!intimar`, `!encerrar` e anexos no chat.
5. **Gerar Link de Convite do Bot (OAuth2)**:
   - Acesse **OAuth2** > **URL Generator**.
   - Em **Scopes**, marque: `bot` e `applications.commands`.
   - Em **Bot Permissions**, marque **Administrator** (ou permissões de `Manage Channels`, `Manage Threads`, `Manage Messages`, `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`).
   - Copie o URL gerado e utilize para adicionar o bot aos servidores do Governo Federal, Corregedoria, PF, PM e RONE.

---

## 2. 🏛️ ESTRUTURA COMPLETA DE SERVIDORES E CANAIS

O bot opera sincronizando múltiplos servidores. Para restaurar o ecossistema, crie os servidores e canais com a seguinte estrutura de nomes:

### 🏛️ Servidor 1: Governo Federal / Poder Judiciário
- **Restrição do Governo:** O canal restrito com ID padrão é `1142251068890304522`.
- **Canais Obrigatórios**:
  - `#peticionamento-eletrônico` ou `#petições` (Pode ser canal de Texto ou Fórum. Onde fica o painel de Peticionamento de processos).
  - `👮🏻・bnmp-prisões` ou `#bnmp-prisões` (Painel oficial do Banco Nacional de Mandados de Prisão. Onde juízes registram mandados e policiais solicitam prisão).
  - `🛠️・emitir-precatórios` ou `🛠️・execjud` (Painel oficial de emissão e baixa de precatórios judiciais).
  - `🛠️・comunicação-interna` ou `#comunicação-interna` (Canal de comunicação interna privativa para pedidos diretos de mandado triangulado sem notificar todos os juízes).
  - `⚖️・juízes` ou `#juizes` (Canal onde o bot mantém o **Relatório Dinâmico de Carga de Trabalho** dos Juízes de Direito).
  - `📁・arquivo-processos` (Canal restrito onde processos encerrados/arquivados são armazenados).
  - `📘・manual-de-uso` (Guia fixado das normas e operação do tribunal).

### 💬 Servidor 2: Corregedoria-Geral
- **Canais Obrigatórios**:
  - `#denuncias` ou `⚖️ CORREGEDORIA DENÚNCIAS` (Onde é executado o `!setup-denuncia` para abertura confidencial de denúncias).
  - `#pedido-de-mandado` (Onde é executado o `!setup-mandado` para solicitação triangulada com PF e Governo).
  - `「🚔」・avisos-all-corps` (Onde é executado o `!setup-repercussao` para comunicados a todas as corporações).
  - `「📢」・avisos` (Canal para onde os anúncios anônimos `!anuncio` são enviados por padrão).

### 🚨 Servidor 3: Polícia Federal (PF)
- **Guild ID Padrão Reconhecido:** `1524888239746318557`
- **Canais Obrigatórios**:
  - `「📑」solicitar-mandado` ou `#solicitar-mandado` (Canal de mandados da PF. Recebe a triangulação 3-Way e as transmissões de mandados expedidos no BNMP).
  - `「📣」anúncios` ou `#anuncios` (Recebe os anúncios de Repercussão Geral da Corregedoria).

### 🪖 Servidor 4: Polícia Militar (PM)
- **Guild ID Padrão Reconhecido:** `1526698673403072572`
- **Canal Obrigatório**: `「📢」・comunicados` ou `#comunicados` (Recebe transmissões de Repercussão Geral).

### ⚡ Servidor 5: RONE
- **Guild ID Padrão Reconhecido:** `1525137517710540860`
- **Canal Obrigatório**: `📣┃avisos-rone` ou `#avisos-rone` (Recebe transmissões de Repercussão Geral).

---

## 3. 👥 ESTRUTURA DE CARGOS E PERMISSÕES NECESSÁRIAS

Para que os comandos de controle funcionem, os seguintes cargos devem ser criados nos respectivos servidores:

### 🏛️ Cargos no Governo Federal:
- **`J. Dir. | Juiz de Direito`** *(Exato)*:
  - Cargo exigido para registrar mandados no BNMP, dar baixa em mandados/precatórios, expedir `!oficio`, decretar `!segredo` e arquivar processos (`!arquivar`).
- **`Prom. J | Promotor de Justiça`** *(Exato)*:
  - Cargo que recebe ofícios automáticos quando um mandado é expedido sem processo vinculado.

### 💬 Cargos na Corregedoria-Geral & Corporações:
- **`「CRRGD」・ Corregedoria Geral`** *(Exato)*:
  - Cargo exigido para utilizar os comandos `!anuncio`, `!adv`, `!reu` e `!intimar`.
- **`「CORP」Membro De Corporação`** *(Exato)*:
  - Cargo que recebe a menção `@` quando um anúncio de Repercussão Geral é publicado.
- **`Promotor de Justiça - MPPR`** *(Exato)*:
  - Cargo que é automaticamente adicionado às threads de Denúncias/PAD.
- **Cargos Autorizados em Mandados (PF & Corregedoria)**:
  - `「ESC」Escrivão`
  - `「DLG」Delegado`
  - `「DLG-G」Delegado Geral`
  - `「DRT」Diretor`
  - `「DRT-EX」Diretor Executivo`
  - `「DRT-G」Diretor Geral`

---

## 4. ⚙️ EXECUÇÃO DOS COMANDOS DE SETUP INICIAL

Após criar os canais e adicionar o bot aos servidores, abra cada canal e digite o comando de configuração correspondente (o bot criará os painéis institucionais com botões interativos e apagará a mensagem do comando):

1. **No canal de Denúncias da Corregedoria**:
   ```text
   !setup-denuncia
   ```
2. **No canal `#pedido-de-mandado` (Corregedoria) ou `「📑」solicitar-mandado` (PF)**:
   ```text
   !setup-mandado
   ```
3. **No canal `🛠️・comunicação-interna` (Governo Federal)**:
   ```text
   !setup-comunicacao
   ```
4. **No canal `「🚔」・avisos-all-corps` (Corregedoria)**:
   ```text
   !setup-repercussao
   ```

*Nota: Os painéis do BNMP (`bnmp-prisões`), Precatórios (`emitir-precatórios`), Relatório de Juízes (`juízes`) e Manual de Uso (`manual-de-uso`) são verificados e criados de forma 100% automática ao iniciar o bot.*

---

## 5. 🔑 CONFIGURAÇÃO DE VARIÁVEIS DE AMBIENTE (.env)

No diretório raiz do bot (`GovernoFederal_bot`), crie ou edite o arquivo `.env`:

```env
DISCORD_TOKEN=SEU_TOKEN_AQUI_DO_DISCORD_DEVELOPER_PORTAL
PORT=3000
```

---

## 6. 🌐 HOSPEDAGEM NO RENDER (DISASTER RECOVERY)

Para manter o bot online 24 horas por dia gratuitamente ou em nuvem no Render:

1. Suba o repositório para o GitHub: `https://github.com/renatolbprado-eng/corregedoriabot.git`.
2. Acesse o **[Render Dashboard](https://dashboard.render.com/)**.
3. Clique em **New +** > **Web Service**.
4. Conecte seu repositório GitHub (`corregedoriabot`).
5. Configure os seguintes parâmetros:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
6. Em **Environment Variables**, adicione:
   - Key: `DISCORD_TOKEN` | Value: *(Seu token do bot)*
   - Key: `PORT` | Value: `3000`
7. Clique em **Create Web Service**. O bot ficará online em poucos segundos.

---

## 7. 📋 TABELA RESUMO DE TODOS OS COMANDOS DO BOT

| Comando | Onde Usar | Cargo Exigido | Descrição |
| :--- | :--- | :--- | :--- |
| `!setup-denuncia` | Canal de Denúncias | Qualquer | Cria o painel confidencial de Denúncias da Corregedoria |
| `!setup-mandado` | Canal de Mandados | Qualquer | Cria o painel de solicitação triangulada de mandados de prisão |
| `!setup-comunicacao` | `comunicação-interna` | Qualquer | Cria o painel de mandados privativo no Governo Federal |
| `!setup-repercussao` | `avisos-all-corps` | Qualquer | Cria o painel de Anúncios Gerais transmitidos para PM, PF e RONE |
| `!anuncio` | Qualquer canal | Corregedoria | Abre o menu suspenso de seleção de canais para anúncio anônimo |
| `!adv @user1...` | Thread do Processo | Corregedoria | Vincula advogados/procuradores aos autos e concede acesso |
| `!reu @user1...` | Thread do Processo | Corregedoria | Inclui membros no polo passivo (réus) do processo |
| `!intimar` | Thread do Processo | Corregedoria | Envia notificação/intimação oficial em DM privada |
| `!encerrar` | Thread Triangulada | Juiz de Direito | Encerra e exclui simultaneamente as 3 salas integradas de mandado |
| `!globo` | Qualquer canal | Qualquer | Envia mensagem formatada para o Tupper no canal `💬・chat` |
| `!oficio` | Thread/Canal BNMP | Juiz de Direito | Abre o pop-up para expedir Ofício Judicial com notificação por DM |
| `!segredo` | Thread do Processo | Juiz de Direito | Converte o processo público em Segredo de Justiça privado |
| `!partes` | Thread do Processo | Qualquer | Altera/associa partes (Autor ou Réu) no card inicial do processo |
| `!arquivar` | Thread do Processo | Juiz de Direito | Transfere a causa para `#arquivo-processos` com restrição |
