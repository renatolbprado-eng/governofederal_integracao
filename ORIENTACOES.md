# 📜 GUIA DE ORIENTAÇÕES E DOCUMENTAÇÃO OFICIAL DO BOT (GOVERNO FEDERAL / PODER JUDICIÁRIO)

Este documento centraliza todas as orientações operacionais, diretrizes de desenvolvimento e ferramentas de poder institucional integradas ao Bot Oficial do Discord (Governo Federal / Poder Judiciário).

---

## 📑 SUMÁRIO
1. [Diretrizes de Desenvolvimento & Deploy](#1-diretrizes-de-desenvolvimento--deploy)
2. [Sistema de Varredura e Inteligência (SECBASE)](#2-sistema-de-varredura-e-inteligência-secbase)
3. [Sistema de Restrições Judiciais e Políticas (!restringir)](#3-sistema-de-restrições-judiciais-e-políticas-restringir)
4. [Painel de Inscrições na OAB (!setup-oab)](#4-painel-de-inscrições-na-oab-setup-oab)
5. [Suspensão e Reabilitação de CNPJ (!restringir-cnpj)](#5-suspensão-e-reabilitação-de-cnpj-restringir-cnpj)
6. [Suspensão e Reabilitação de OAB (!restringir-oab)](#6-suspensão-e-reabilitação-de-oab-restringir-oab)
7. [Sistema de Tickets de Denúncias no Ministério Público (!setup-denuncia)](#7-sistema-de-tickets-de-denúncias-no-ministério-público-setup-denuncia)
8. [Tabela Resumo de Comandos](#8-tabela-resumo-de-comandos)

---

## 1. ⚙️ DIRETRIZES DE DESENVOLVIMENTO & DEPLOY

- **Ambiente Node.js**: ES Modules (`"type": "module"` em `package.json`). Nunca utilize `require()` ou `module.exports`. Use `import` e `export`.
- **Caminho do Projeto**: `c:\Users\renan\OneDrive\Documentos\bot_discord_oficial`
- **Repositório Git**: `https://github.com/renatolbprado-eng/governofederal_integracao.git` (`main`).
- **Scripts de Controle**:
  - `INICIAR_BOT_LOCAL.bat`: Executa o bot localmente via Node.js.
  - `PUSH_RENDER.bat`: Envia as alterações validadas para o repositório remoto (hospedagem Render).

---

## 2. 🛡️ SISTEMA DE VARREDURA E INTELIGÊNCIA (SECBASE)

- **Comando**: `!secbase @usuario` ou `!secbase ID_OU_NOME`
- **Canal de Execução**: `secbase` (Canal aberto para visualização de todos, comando restrito à Magistratura/Corregedoria).
- **Varredura Universal em Fóruns & Posts (`GuildForum`)**:
  - **Cartório - Contratos & Instrumentos**: Identifica acordos e contratos em `contratos` e `procurações`.
  - **Cartório - Registro de Empresas**: Mapeia empresas e CNPJs em `registro-de-empresas`.
  - **Cartório - Registro Civil & Atos Pessoais**: Varre `registro-de-pessoas`, `registro-de-assinaturas`, `dívidas-e-outros`, `filiações`, `desfiliações` e `servidores-partidários`.
  - **Escritórios de Advocacia (OAB)**: Varre o canal `escritórios`.
  - **Processos Judiciais**: Mapeia citações e petições em `peticionamento`, `processos`, `intimacoes`.
  - **BNMP / Ficha Criminal**: Varre mensagem por mensagem do canal `bnmp-prisões`.
- **Busca por Variações**: Mapeia ID, Username, Nickname On-RP e variações nominais.

---

## 3. 🛑 SISTEMA DE RESTRIÇÕES JUDICIAIS E POLÍTICAS (`!restringir`)

- **Comando**: `!restringir @usuario <minimo|medio|maximo> [motivo]`
- **Revogação**: `!revogar-restricao @usuario` ou `!desrestringir @usuario`
- **Garantia Off-RP**: **NUNCA** bloqueia o chat Off-RP (`💬・chat`), tickets de suporte/atendimento ou manuais de uso.
- **Níveis de Sanção**:
  1. **`minimo`**: Impede o envio/criação de registros em canais do Cartório, Contratos, Empresas e OAB.
  2. **`medio`**: Nível Mínimo + oculta visualização dos canais políticos/eleitorais (`eleições`, `moções`, `assembleia-legislativa`, `candidaturas`, `filiações`, `desfiliações`).
  3. **`maximo`**: Oculta todos os canais On-RP do servidor (preservando chat Off-RP, tickets e processos onde o usuário seja réu).
- **Persistência**: Registros gravados em `banco_restricoes_judiciais.json`.

---

## 4. 🏛️ PAINEL DE INSCRIÇÕES NA OAB (`!setup-oab`)

- **Comando de Configuração**: `!setup-oab` (Executado no canal `inscrições-à-ordem`).
- **Botão Interativo**: `⚖️ Inscrever-se na OAB` (Abre formulário Modal com Nome On-RP, Registro Desejado e Formação).
- **Comissão Avaliadora**: Solicitações geradas com botões `✅ Deferir (Atribuir Cargo)` e `❌ Indeferir`.
- **Autorização para Deferir/Indeferir**:
  - ⚖️ Juízes de Direito & Magistrados
  - 🏛️ `Pres. OAB | Presidente da Ordem dos Advogados do Brasil`
  - 🏛️ `Vice-Pres. OAB | Vice-Presidente da Ordem dos Advogados do Brasil`
- **Cargo Concedido**: Concede **exclusivamente** o cargo `@Adv. | Advogado`.

---

## 5. 🏢 SUSPENSÃO E REABILITAÇÃO DE CNPJ (`!restringir-cnpj`)

- **Comando de Suspensão**: `!restringir-cnpj <CNPJ> [motivo]`
- **Comando de Revogação**: `!revogar-cnpj <CNPJ>`
- **Efeitos**:
  - Marca o tópico do Cartório/Empresa como `[SUSPENSO]`.
  - Publica o edital de interdição comercial dentro do post da empresa.
  - Grava o registro em `banco_cnpjs_suspensos.json`.

---

## 6. ⚖️ SUSPENSÃO E REABILITAÇÃO DE OAB (`!restringir-oab`)

- **Comando de Suspensão**: `!restringir-oab @advogado [motivo]`
- **Comando de Revogação**: `!revogar-oab @advogado`
- **Efeitos**:
  - Remove o cargo `@Adv. | Advogado` do membro.
  - Impede a abertura de novos tickets jurídicos de atendimento.
  - Publica o **Edital Oficial de Suspensão da OAB**.
  - Grava o registro em `banco_oab_suspensas.json`.

---

## 7. 🚨 SISTEMA DE TICKETS DE DENÚNCIAS NO MINISTÉRIO PÚBLICO (`!setup-denuncia`)

- **Comando de Configuração**: `!setup-denuncia` (Executado no canal `🚨・fazer-denuncia`).
- **Botão Interativo**: `🚨 Fazer Denúncia`.
- **Funcionamento**:
  - Cria um canal/thread reservada sob a categoria `➲ MINISTÉRIO PÚBLICO`.
  - Notifica os Promotores de Justiça (`Prom. J | Promotor de Justiça` / `Promotor de Justiça - MPPR`).
  - Garante visibilidade **restrita** ao denunciante, promotores e bot.
  - Inclui botão `🔒 Fechar Denúncia` para arquivar a denúncia após análise.

---

## 8. 📊 TABELA RESUMO DE COMANDOS

| Comando | Permissão Exigida | Descrição |
| :--- | :--- | :--- |
| `!setup-backup` | Juiz / Admin | Replica categorias, fóruns e implanta todos os painéis no servidor BACKUP |
| `!secbase @usuario` | Juiz / Corregedoria | Executa a varredura e gera o dossiê individual SECBASE |
| `!restringir @user <nivel>` | Juiz / Corregedoria | Aplica restrições judiciais On-RP (mínimo, médio ou máximo) |
| `!revogar-restricao @user` | Juiz / Corregedoria | Revoga as restrições judiciais e restaura permissões |
| `!setup-oab` | Admin / OAB / Juiz | Envia o painel interativo de inscrições na OAB |
| `!restringir-cnpj <CNPJ>` | Juiz / Corregedoria | Suspende comercialmente o registro do CNPJ |
| `!revogar-cnpj <CNPJ>` | Juiz / Corregedoria | Reabilita o registro comercial do CNPJ |
| `!restringir-oab @user` | Juiz / Corregedoria | Suspende a licença da OAB e remove cargo de advogado |
| `!revogar-oab @user` | Juiz / Corregedoria | Restitui a licença da OAB e devolve cargo de advogado |
| `!setup-denuncia` | Admin / Corregedoria | Fixa o painel de denúncias integradas ao Ministério Público |
