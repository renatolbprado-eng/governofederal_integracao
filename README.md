# 🏛️ Bot de Peticionamento Eletrônico & Atos Judiciais

Este bot do Discord foi desenvolvido para automatizar o protocolo de petições judiciais, controle de privacidade de processos (Segredo de Justiça), citação/intimação automática de partes e procuradores via DM, e gerenciamento de permissões de cargos.

O código foi projetado para ser modular, facilitando a **transposição para qualquer outro contexto** de atendimento, RPG, ou fluxos administrativos.

---

## 📋 Como Transpor para Outros Contextos

O bot pode ser facilmente adaptado para outros cenários de triagem e notificações. Abaixo estão exemplos de adaptação e onde alterar no código:

### Exemplo 1: Ouvidoria ou Fale Conosco Municipal
* **Contexto**: Triagem de reclamações e denúncias de cidadãos para secretarias de uma prefeitura.
* **Onde adaptar no [index.js](file:///c:/Users/renat/Documents/Projeto_Roblox/index.js)**:
  1. No questionário `runPetitionWizard`, mude os botões para selecionar secretarias (ex: "Saúde", "Obras", "Segurança").
  2. Modifique os campos do Embed final para listar: *Cidadão*, *Secretaria Alvo*, *Descrição do Problema*.
  3. No startup, altere as `keywords` de cargos para liberar o canal a secretários e assessores (ex: `['secretário', 'assessor', 'prefeito', 'ouvidor']`).
  4. Modifique o comando `!intimar` para `!notificar` as secretarias envolvidas.

### Exemplo 2: Delegacia e Inquérito Policial (RPG Policial)
* **Contexto**: Registro de Boletins de Ocorrência (B.O.) e instauração de Inquéritos Policiais privados.
* **Onde adaptar no [index.js](file:///c:/Users/renat/Documents/Projeto_Roblox/index.js)**:
  1. No wizard, pergunte pelo *Tipo de Ocorrência* (ex: "Furto", "Agressão") e se o inquérito é sob sigilo.
  2. Altere os cargos marcados automaticamente na movimentação para `@Delegado` e `@Investigador`.
  3. Altere o prefixo `ADVOGADOS:` para `INVESTIGADORES:` ou `POLICIAIS:` para vincular os agentes que comandam a investigação ao embed de B.O.

---

## ⚙️ Estrutura de Configurações no Código

### 1. Palavras-Chave de Cargos (Permissões de Acesso)
No startup, o bot localiza e adiciona permissões ao canal para quem possui cargos judiciais.
Você pode configurar quais cargos devem ter acesso editando a lista `keywords` no evento `clientReady`:
```javascript
const keywords = [
  'juiz', 'promotor', 'magistrado', 'defensor', 'procurador', 
  'advogado', 'judiciário', 'desembargador', 'cartório', 'escrivão'
];
```
*Adicione ou remova termos em minúsculo para adequar ao seu servidor.*

### 2. Customizando as Perguntas do Wizard
Para adicionar, alterar ou remover campos de perguntas (como telefone, provas, etc.), edite a função `runPetitionWizard`:
1. Adicione a propriedade no objeto `data`:
   ```javascript
   const data = {
     type: '',
     myNewField: '', // Adicione aqui
     ...
   };
   ```
2. Crie a pergunta usando a função `askQuestion`:
   ```javascript
   const resMsg = await askQuestion('Digite a resposta para a nova pergunta:');
   if (!resMsg) return timeout();
   data.myNewField = resMsg.content.trim();
   ```
3. Exiba o novo dado inserindo-o nos campos (`fields`) do `EmbedBuilder`.

### 3. Sincronização Dinâmica (Comandos de Chat nas Threads)
* **`!adv`**: Abre o fluxo interativo no chat via botões para selecionar o polo (Autor ou Réu) e registrar os respectivos advogados na autuação inicial (Embed), limpando o chat em seguida.
* **`!intimar [todos/autores/requeridos]`**: Lê os envolvidos direto no Embed (incluindo advogados de cada polo) e envia DMs automáticas notificando-os de movimentações pendentes de atuação.
* **`!segredo`**: Comando exclusivo para Juízes de Direito em threads de processos. Transforma o processo em sigiloso, movendo a autuação para uma thread privada, adicionando apenas os envolvidos e advogados, e deletando a thread pública original.

---

## 🚀 Instalação e Execução

1. Certifique-se de que possui o **Node.js** (v16 ou superior) instalado.
2. Configure o arquivo `.env` na raiz do projeto com o seu Token do Discord:
   ```env
   DISCORD_TOKEN=seu_token_aqui
   ```
3. Instale as dependências:
   ```bash
   npm install
   ```
4. Execute o bot localmente:
   ```bash
   npm start
   ```
