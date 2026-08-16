# 🤖 INSTRUÇÕES TÉCNICAS E GUIA DA PLATAFORMA LOCAL PARA IA / DESENVOLVEDOR

Este documento foi elaborado para que, caso o contexto da conversa seja resetado ou uma nova instância de IA precise dar manutenção, ela consiga ler, compreender perfeitamente a arquitetura e adaptar a **Plataforma Local de Execução do Bot Discord**.

> 💡 **Nota para a IA**: Consulte também o guia geral na raiz do projeto: [`GUIA_CONFIGURACAO_ZERO_IA.md`](../GUIA_CONFIGURACAO_ZERO_IA.md).

---

## 🎯 1. Objetivo da Plataforma

Esta plataforma local foi criada para resolver o seguinte problema:
- Permite ao desenvolvedor executar ações pontuais, scripts customizados, consultas ou modificações diretas no servidor do Discord **sem alterar o código principal no Git** e **sem precisar fazer push/deploy para o Render**.
- Executa trechos de código em formato **Single-Execution (Execução Única)** sob demanda.

---

## 📁 2. Arquitetura da Plataforma (`/plataforma_local`)

A plataforma está isolada na pasta `plataforma_local/` com a seguinte estrutura:

```
bot_discord_oficial/
├── INICIAR_PLATAFORMA_LOCAL.bat    # Script batch de 1-clique para Windows
└── plataforma_local/
    ├── package.json                 # Dependências (express, discord.js, dotenv)
    ├── .env.example                 # Exemplo de configuração de chaves
    ├── .env                         # Chaves locais (ignorado no Git)
    ├── server.js                    # Servidor Express & Motor de Conexão/Execução
    ├── executar_snippet.js          # Utilitário CLI para rodar scripts via terminal
    ├── INSTRUCOES_TECNICAS_IA.md    # Este manual técnico para IAs
    └── public/
        └── index.html               # Web Dashboard UI (http://localhost:4000)
```

---

## ⚙️ 3. Modelo de Execução e Contexto Injetado

Os scripts inseridos no Dashboard Web ou passados via CLI são executados dentro de um wrapper assíncrono isolado (`AsyncFunction`).

### Objeto e Variáveis Injetadas no Escopo do Snippet:
Quando o código do usuário é executado, ele tem acesso direto às seguintes variáveis globais e módulos:

| Variável | Tipo / Descrição |
|---|---|
| `client` | Instância ativa do `discord.js` `Client` logada no Bot |
| `guild` | Objeto `Guild` do servidor principal (buscado via `GUILD_ID` ou primeiro servidor disponível) |
| `EmbedBuilder` | Classe do `discord.js` para construção de Embeds |
| `ActionRowBuilder` | Classe do `discord.js` para fileiras de botões/componentes |
| `ButtonBuilder` | Classe do `discord.js` para botões interativos |
| `ButtonStyle` | Enum com estilos de botões (Primary, Secondary, Success, Danger, Link) |
| `ChannelType` | Enum com tipos de canais (GuildText, GuildVoice, GuildCategory, etc.) |
| `PermissionFlagsBits` | Enum com flags de permissões do Discord |
| `console` | Console interceptado que redireciona logs (`log`, `info`, `warn`, `error`) em tempo real para o Dashboard |

### Exemplo de Código Válido para o Executor:
```javascript
// Exemplo de snippet executável
const members = await guild.members.fetch();
console.log("Total de membros carregados:", members.size);

const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
console.log("Canais de texto:", textChannels.map(c => c.name).join(", "));

return {
  totalMembros: members.size,
  canaisTextoCount: textChannels.size
};
```

---

## 🛰️ 4. Endpoints da API HTTP Local (`server.js`)

- `GET /api/status`: Retorna se o bot está conectado, tag do bot, nome do servidor, ping e erro de conexão se houver.
- `POST /api/config`: Recebe `{ token, guildId }` e salva no `.env` local sem reiniciar o servidor manualmente.
- `GET /api/templates`: Retorna a lista de snippets predefinidos (Info Servidor, Listar Canais, Listar Cargos, Consultar Membro, Enviar Embed, Limpar Mensagens).
- `POST /api/execute`: Recebe `{ code, token, guildId }`, executa o snippet, intercepta `console.log`, mede o tempo de execução e retorna os logs + resultado formatado.

---

## 🛠️ 5. Instruções para IAs Futuras (Como Adaptar / Estender)

Se o usuário solicitar novas funcionalidades nesta plataforma local:

1. **Adicionar novos Templates Prontos**:
   - Edite a rota `GET /api/templates` em `plataforma_local/server.js`.
   - Adicione um objeto no array `templates` com `id`, `name`, `description` e `code`.

2. **Injetar Novas Dependências ou Módulos no Snippet**:
   - Caso precise injetar dependências adicionais no escopo do snippet, edite o construtor `AsyncFunction` no endpoint `POST /api/execute` em `plataforma_local/server.js` e passe a nova variável no `runner(...)`.

3. **Resolução de Erros Comuns de Conexão**:
   - **`DISCORD_TOKEN inválido`**: Verifique se o token foi inserido corretamente no `.env` local ou na modal de configurações.
   - **`Privileged Intents`**: O client solicita `GuildMembers` e `MessageContent`. Certifique-se de que no Portal do Desenvolvedor do Discord (Bot -> Privileged Gateway Intents) as opções **Server Members Intent** e **Message Content Intent** estejam ATIVADAS.
   - **Conflito de Porta (EADDRINUSE)**: Se a porta `4000` estiver ocupada, altere `PORT=4005` no arquivo `plataforma_local/.env`.

---

## 🚀 6. Como Inicializar a Plataforma

Para rodar a plataforma localmente:
1. Pelo Windows Explorer: Dê dois cliques em `INICIAR_PLATAFORMA_LOCAL.bat` na raiz do projeto.
2. Pelo Terminal (PowerShell / CMD):
   ```bash
   cd plataforma_local
   npm install
   node server.js
   ```
3. Acesse `http://localhost:4000` no seu navegador.
