# 🏛️ Bot Unificado: Poder Judiciário (Governo Federal), Corregedoria-Geral, Polícia Federal, PM & RONE

Este bot para Discord foi desenvolvido em Node.js (Discord.js v14) para integrar e automatizar por completo o ecossistema de Justiça e Segurança Pública virtual entre múltiplos servidores.

---

## 📚 Visão Geral das Funcionalidades

### ⚖️ 1. Peticionamento Eletrônico & Autuação Processual (Governo Federal)
- **Peticionamento via Pop-up (Modal):** No canal `#peticionamento-eletrônico` (ID `1142251068890304522`), o botão `Peticionar` abre o formulário `modal_peticionamento` para coleta instantânea do *Tipo de Processo*, *Nome do Autor*, *Nome do Réu* e *Texto/Fatos da Petição Inicial*.
- **Triagem na Thread Privada:** O bot cria uma thread privada exclusiva do processo (`Petição - NomeDoUsuario`), onde solicita interativamente a menção dos Discords do Autor e do Réu `(ex: @pessoa1)` e o envio de documentos/anexos.
- **Autuação Oficial & Sorteio de Juiz:** Gera o Card Oficial do Processo com número de protocolo único `PROC-AAAA-XXXX`, realiza a citação direta por DM e atualiza o relatório dinâmico de carga de trabalho dos Juízes de Direito.

---

### 🌐 2. Sistema Triangulado de Mandados de Prisão (3-Way Bridge)
- **Triangulação Automática:** Requisições de mandados iniciadas na Corregedoria (`#pedido-de-mandado`), Polícia Federal (`「📑」solicitar-mandado`) ou Governo Federal geram 3 salas privadas espelhadas simultaneamente.
- **Sincronização em Tempo Real:** Mensagens, prints e documentos enviados em qualquer uma das 3 salas são retransmitidos instantaneamente com badge de origem (`💬 [Corregedoria-Geral]`, `🚨 [Polícia Federal - PF]`, `⚖️ [Governo Federal / Magistratura]`).
- **Comunicação Interna Privativa (`!setup-comunicacao`):** Permite abrir mandados triangulados no canal `🛠️・comunicação-interna` marcando apenas o solicitante (sem notificar todos os juízes).
- **Encerramento Unificado (`!encerrar`):** Permite aos Magistrados/Autoridades encerrar e excluir simultaneamente as 3 salas integradas após conclusão.

---

### 👮 3. Banco Nacional de Mandados de Prisão (BNMP) & Transmissão Externa
- **Painel Automático (`👮🏻・bnmp-prisões`):** Contém os botões `Registrar novo Mandado` (Juízes de Direito) e `Solicitar prisão` (Autoridades Policiais).
- **Emissão & Transmissão Externa:** Mandados expedidos no Governo Federal publicam o cartão ativo no BNMP e transmitem automaticamente a cópia aos canais da **Polícia Federal** e **Corregedoria**.
- **Baixa no BNMP & Limpeza Externa:** Ao dar baixa no BNMP (Governo Federal), o bot gera a sombra/relatório de revogação no Governo e **deleta automaticamente** a cópia nos canais da PF e Corregedoria.

---

### 📢 4. Anúncios de Repercussão Geral & Anúncios Anônimos (Corregedoria)
- **Broadcast para Multi-Corporações (`!setup-repercussao`):** Anúncios de Repercussão Geral publicados na Corregedoria são transmitidos automaticamente para a **PM** (`「📢」・comunicados`), **PF** (`「📣」anúncios`) e **RONE** (`📣┃avisos-rone`) com imagens embutidas nativas.
- **Criador de Anúncios Anônimos (`!anuncio`):** Permite selecionar de 1 a 5 canais de destino via menu suspenso nativo e publicar mensagens secretas sem deixar rastro.

---

### 👥 5. Gestão Processual & Notificações (Corregedoria)
- **`!adv @usuario1...`**: Nomeia procuradores/advogados de defesa e concede acesso aos autos.
- **`!reu @usuario1...`**: Cadastra réus no polo passivo do processo.
- **`!intimar`**: Notifica oficialmente réus e advogados via DM privada com link direto do processo.

---

### 📜 6. Sistema Nacional de Precatórios & Relatório de Juízes
- **Precatórios Judiciais (`🛠️・emitir-precatórios`):** Emissão de títulos homologados e baixa por pagamento com auditoria.
- **Relatório de Juízes (`⚖️・juízes`):** Monitoramento em tempo real da distribuição de processos e agendamento de despachos em salas privadas.

---

## 🛠️ Nomes de Canais Reconhecidos (Helper Resiliente)

| Função do Canal | Exemplo de Nome no Discord |
| :--- | :--- |
| **Peticionamento (Governo)** | `#peticionamento-eletrônico` (ID: `1142251068890304522`) |
| **Relatório de Juízes** | `⚖️・juízes`, `#juizes` |
| **BNMP (Governo Federal)** | `👮🏻・bnmp-prisões`, `#bnmp-prisoes` |
| **Comunicação Interna** | `🛠️・comunicação-interna` |
| **Precatórios** | `🛠️・emitir-precatórios`, `#precatórios` |
| **Mandados (PF)** | `「📑」solicitar-mandado` (Guild ID: `1524888239746318557`) |
| **Mandados (Corregedoria)** | `#pedido-de-mandado` |
| **Denúncias (Corregedoria)** | `#denuncias`, `⚖️ CORREGEDORIA DENÚNCIAS` |
| **Comunicados PM** | `「📢」・comunicados` (Guild ID: `1526698673403072572`) |
| **Avisos RONE** | `📣┃avisos-rone` (Guild ID: `1525137517710540860`) |

---

## 📘 Guia de Restauração e Recuperação do Zero

Em caso de recriação de servidores ou perda de canais, consulte o guia passo a passo em:
📄 **[`MANUAL_CONFIGURACAO_COMPLETA.md`](file:///C:/Users/renat/Documents/GovernoFederal_bot/MANUAL_CONFIGURACAO_COMPLETA.md)**

---

## 🚀 Como Executar o Bot

1. Instalar dependências: `npm install`
2. Configurar o arquivo `.env`:
   ```env
   DISCORD_TOKEN=SeuTokenAqui
   PORT=3000
   ```
3. Iniciar o bot: `node index.js`
