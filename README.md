# 🏛️ Bot de Peticionamento Eletrônico, Atos Judiciais, Precatórios & BNMP

Este bot para Discord foi desenvolvido em Node.js (Discord.js v14) para integrar e automatizar por completo os fluxos de trabalho de um Tribunal de Justiça/Poder Judiciário virtual.

---

## 📚 Visão Geral das Funcionalidades

O sistema é dividido em módulos operacionais específicos:

### ⚖️ 1. Peticionamento Eletrônico & Autuação Processual
- **Peticionamento via Pop-up (Modal):** No canal `#peticionamento-eletrônico`, o botão `Peticionar` abre o formulário `modal_peticionamento` para coleta instantânea do *Tipo de Processo*, *Nome do Autor*, *Nome do Réu* e *Texto/Fatos da Petição Inicial*.
- **Triagem na Thread Privada:** O bot cria uma thread privada exclusiva do processo (`Petição - NomeDoUsuario`), onde solicita interativamente a menção dos Discords do Autor e do Réu `(ex: @pessoa1)` e o envio de documentos/anexos.
- **Autuação Oficial:** Gera o Card Oficial do Processo com número de protocolo único `PROC-AAAA-XXXX` e realiza a citação direta por DM.

### 👥 2. Gestão de Partes e Procuradores
- **`!adv` (Registro de Procuradores):** Comando executado dentro da thread do processo. Abre seletores para vincular advogados ao polo ativo (Autor) ou passivo (Réu) e gera o Ato Ordinatório de Registro de Procuradores.
- **`!partes` (Vinculação de Partes):** Associa ou atualiza a conta do Discord do Autor ou do Réu na autuação do processo e concede acesso automático à thread.
- **`!intimar` (Citação e Intimação por DM):** Envia DMs diretas aos envolvidos cadastrados.

### 👨‍⚖️ 3. Ferramentas Exclusivas dos Juízes de Direito
- **`!segredo` (Decretar Segredo de Justiça):** Restrito a membros com cargo `J. Dir. | Juiz de Direito`. Converte a causa em sigilosa, criando uma thread privativa de Segredo de Justiça (`🔒 SEGREDO - PROC-XXXX`), adicionando apenas o Juiz, as partes e os advogados habilitados.
- **`!oficio` (Expedição de Ofício / Ato Ordinatório):** Funciona em threads de processos ou no canal `👮🏻・bnmp-prisões`. O Juiz clica em `Redigir Ofício` para abrir o formulário pop-up. Ao submeter, publica o Ato Ordinatório e pergunta no chat se deseja notificar usuários por DM privada `(ex: @pessoa1)`.
- **Despacho com o Juiz (Audiência Privada):** Cria sala privativa para audiências urgentes e despachos entre o solicitante e o Magistrado designado.

### 📜 4. Sistema Nacional de Precatórios
- **Painel Automático (`🛠️・emitir-precatórios` / `🛠️・execjud`):** Fixa mensagem institucional com botão `Emitir Precatório` (restrito a Juízes de Direito).
- **Formulário & Certidão:** Coleta o Roblox, Valor e Justificativa no Modal, e solicita a menção do beneficiário `(ex: @pessoa1)` no chat. Gera um **Embed Dourado** (`#d4af37`) oficial.
- **Dar Baixa por Pagamento:** Botão na certidão que permite ao Juiz dar baixa no título. Apaga a certidão original e emite uma nova certidão em tom **Vermelho** (`#e74c3c`) com status `PAGO / DADO BAIXA` e auditoria de quem pagou e a data.

### 👮 5. Banco Nacional de Mandados de Prisão (BNMP)
- **Painel Automático (`👮🏻・bnmp-prisões`):** Contém os botões `Registrar novo Mandado` (Juízes) e `Solicitar prisão (Autoridades Policiais)` (Qualquer membro).
- **Solicitar Prisão (Autoridades Policiais):** Abre instantaneamente uma thread privada de discussão sigilosa adicionando o policial solicitante e **todos os Juízes de Direito** do servidor.
- **Dar Baixa em Mandado:** Todos os mandados contêm o botão `Dar Baixa em Mandado` (Juízes). Ao revogar, converte o título para o status `REVOGADO / DADO BAIXA` em tom **Vermelho** (`#e74c3c`) com auditoria.

---

## 🛠️ Nomes de Canais Reconhecidos (Helper Resiliente)

O bot utiliza a função `matchChannel` que ignora maiúsculas/minúsculas, acentos e emojis para localizar os canais do servidor:

| Função do Canal | Exemplo de Nome no Discord |
| :--- | :--- |
| **Peticionamento** | `#peticionamento-eletrônico`, `#petições` |
| **Relatório de Juízes** | `⚖️・juízes`, `#juizes` |
| **Mandados de Prisão** | `👮🏻・bnmp-prisões`, `#bnmp-prisoes` |
| **Precatórios / Execução** | `🛠️・emitir-precatórios`, `🛠️・execjud`, `#precatórios` |
| **Manual de Uso** | `📘・manual-de-uso`, `#manual-de-uso` |

---

## 🔑 Cargos e Permissões

- **`J. Dir. | Juiz de Direito`**: Cargo exigido para expedir `!oficio`, decretar `!segredo`, emitir e dar baixa em precatórios e mandados de prisão.
- **Advogados & Partes**: Possuem acesso aos comandos `!adv` e `!partes` nas threads de seus processos.
- **Autoridades Policiais**: Possuem acesso ao botão `Solicitar prisão` no canal de BNMP.

---

## 🚀 Como Rodar o Projeto

1. Instalar dependências: `npm install`
2. Configurar o arquivo `.env`:
   ```env
   DISCORD_TOKEN=SeuTokenAqui
   PORT=3000
   ```
3. Iniciar o servidor: `npm start`
