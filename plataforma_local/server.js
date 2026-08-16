import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags
} from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tenta carregar o .env local primeiro, ou do projeto principal caso exista
const envPath = fs.existsSync(path.join(__dirname, '.env'))
  ? path.join(__dirname, '.env')
  : fs.existsSync(path.join(__dirname, '../governofederal_integracao-main/governofederal_integracao-main/.env'))
  ? path.join(__dirname, '../governofederal_integracao-main/governofederal_integracao-main/.env')
  : path.join(__dirname, '../.env');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Gerenciador de conexão do Bot Discord
let botClient = null;
let isConnecting = false;
let connectionError = null;

async function getDiscordClient(customToken = null) {
  const token = customToken || process.env.DISCORD_TOKEN;
  if (!token || token.trim() === '' || token.includes('seu_discord_bot_token')) {
    throw new Error("Token do Discord não configurado. Adicione seu token no arquivo .env ou na interface.");
  }

  // Se já houver um cliente pronto e logado com o mesmo token
  if (botClient && botClient.isReady()) {
    return botClient;
  }

  if (isConnecting) {
    // Aguarda conexão em andamento
    let waitCount = 0;
    while (isConnecting && waitCount < 20) {
      await new Promise(res => setTimeout(res, 500));
      waitCount++;
    }
    if (botClient && botClient.isReady()) return botClient;
  }

  isConnecting = true;
  connectionError = null;

  try {
    if (botClient) {
      try { await botClient.destroy(); } catch (e) {}
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildModeration
      ]
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout ao conectar ao Discord (15s)")), 15000);

      client.once('ready', () => {
        clearTimeout(timer);
        console.log(`[Plataforma Local] Bot conectado como: ${client.user.tag}`);
        resolve();
      });

      client.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      client.login(token).catch(err => {
        clearTimeout(timer);
        reject(err);
      });
    });

    botClient = client;
    isConnecting = false;
    return botClient;
  } catch (err) {
    isConnecting = false;
    connectionError = err.message;
    throw err;
  }
}

// Retorna Guild alvo
async function getTargetGuild(client, targetGuildId = null) {
  const guildId = targetGuildId || process.env.GUILD_ID;
  if (guildId && guildId.trim() !== '') {
    try {
      return await client.guilds.fetch(guildId);
    } catch (e) {
      console.warn(`[Plataforma Local] Não foi possível buscar guild ${guildId}, usando a primeira disponível.`);
    }
  }
  const firstGuild = client.guilds.cache.first();
  if (!firstGuild) {
    throw new Error("O Bot não está presente em nenhum servidor do Discord.");
  }
  return firstGuild;
}

// ROTAS DA API

// 1. Status da conexão
app.get('/api/status', async (req, res) => {
  try {
    const token = process.env.DISCORD_TOKEN;
    if (!token || token.includes('seu_discord_bot_token')) {
      return res.json({
        connected: false,
        configured: false,
        message: "Token não configurado. Defina no .env ou na interface."
      });
    }

    const client = await getDiscordClient();
    const guild = await getTargetGuild(client);

    return res.json({
      connected: true,
      configured: true,
      bot: {
        id: client.user.id,
        tag: client.user.tag,
        username: client.user.username,
        avatar: client.user.displayAvatarURL(),
        ping: client.ws.ping
      },
      guild: {
        id: guild.id,
        name: guild.name,
        memberCount: guild.memberCount,
        icon: guild.iconURL()
      }
    });
  } catch (err) {
    return res.json({
      connected: false,
      configured: !!process.env.DISCORD_TOKEN,
      error: err.message
    });
  }
});

// 2. Atualizar configurações temporárias (.env local)
app.post('/api/config', (req, res) => {
  const { token, guildId } = req.body;
  if (token) process.env.DISCORD_TOKEN = token.trim();
  if (guildId) process.env.GUILD_ID = guildId.trim();

  // Salva no .env local
  const envContent = `DISCORD_TOKEN=${process.env.DISCORD_TOKEN || ''}\nGUILD_ID=${process.env.GUILD_ID || ''}\nPORT=${PORT}\n`;
  try {
    fs.writeFileSync(path.join(__dirname, '.env'), envContent, 'utf-8');
  } catch (e) {
    console.error("Erro ao salvar .env local:", e);
  }

  // Reseta a conexão para recarregar se necessário
  if (botClient) {
    botClient.destroy().catch(() => {});
    botClient = null;
  }

  return res.json({ success: true, message: "Configurações salvas!" });
});

// 3. Obter templates prontos
app.get('/api/templates', (req, res) => {
  const templates = [
    {
      id: 'info_servidor',
      name: '📊 Informações Detalhadas do Servidor',
      description: 'Obtém estatísticas completas, contagem de cargos, canais e membros.',
      code: `// Template: Informações Detalhadas do Servidor
console.log("=== INFORMAÇÕES DO SERVIDOR ===");
console.log("Nome:", guild.name);
console.log("ID:", guild.id);
console.log("Dono ID:", guild.ownerId);
console.log("Total de Membros:", guild.memberCount);

const channels = await guild.channels.fetch();
console.log("Total de Canais:", channels.size);

const roles = await guild.roles.fetch();
console.log("Total de Cargos:", roles.size);

return {
  nome: guild.name,
  id: guild.id,
  membros: guild.memberCount,
  canaisTotal: channels.size,
  cargosTotal: roles.size
};`
    },
    {
      id: 'listar_canais',
      name: '📜 Listar Todos os Canais e Categorias',
      description: 'Exibe a lista completa de todos os canais de texto, voz e categorias com IDs.',
      code: `// Template: Listar Canais e Categorias
const channels = await guild.channels.fetch();
const result = [];

channels.forEach(ch => {
  if (!ch) return;
  const info = \`[\${ch.type}] \${ch.name} (ID: \${ch.id})\`;
  console.log(info);
  result.push({ id: ch.id, name: ch.name, type: ch.type, parentId: ch.parentId });
});

return { total: result.length, canais: result };`
    },
    {
      id: 'listar_cargos',
      name: '👑 Listar Cargos e Permissões',
      description: 'Lista os cargos do servidor em ordem de hierarquia com suas cores e IDs.',
      code: `// Template: Listar Cargos
const roles = await guild.roles.fetch();
const sortedRoles = Array.from(roles.values()).sort((a, b) => b.position - a.position);

console.log("=== LISTA DE CARGOS ===");
sortedRoles.forEach(r => {
  console.log(\`Pos \${r.position} | Nome: \${r.name} | ID: \${r.id} | Membros: \${r.members.size}\`);
});

return sortedRoles.map(r => ({ id: r.id, name: r.name, position: r.position, members: r.members.size }));`
    },
    {
      id: 'buscar_membro',
      name: '🔍 Consultar Membro (por ID ou Nome)',
      description: 'Pesquisa os detalhes, cargos e data de entrada de um membro.',
      code: `// Template: Consultar Membro
// ALERTA: Substitua o ID abaixo pelo ID do membro que deseja buscar
const targetMemberId = "SEU_ID_DE_USUARIO_AQUI";

try {
  const member = await guild.members.fetch(targetMemberId);
  console.log("Membro encontrado:", member.user.tag);
  console.log("Apelido:", member.nickname || "Nenhum");
  console.log("Entrou em:", member.joinedAt?.toLocaleString());
  console.log("Cargos:", member.roles.cache.map(r => r.name).join(", "));
  
  return {
    tag: member.user.tag,
    id: member.id,
    cargos: member.roles.cache.map(r => ({ id: r.id, name: r.name }))
  };
} catch (e) {
  console.error("Membro não encontrado ou ID inválido.");
  throw e;
}`
    },
    {
      id: 'enviar_embed',
      name: '💬 Enviar Mensagem / Embed para Canal',
      description: 'Cria e envia uma mensagem Embed personalizada em um canal por ID.',
      code: `// Template: Enviar Embed para Canal
// Insira o ID do canal onde a mensagem deve ser enviada:
const channelId = "SEU_CHANNEL_ID_AQUI";

const channel = await client.channels.fetch(channelId);
if (!channel) throw new Error("Canal não encontrado!");

const embed = new EmbedBuilder()
  .setTitle("📢 Comunicado Rápido via Plataforma Local")
  .setDescription("Esta mensagem foi enviada via execução pontual local!")
  .setColor(0x00ff99)
  .addFields(
    { name: "Executado em", value: new Date().toLocaleString('pt-BR'), inline: true },
    { name: "Servidor", value: guild.name, inline: true }
  )
  .setFooter({ text: "Ferramenta Local de Manutenção Discord" });

const msg = await channel.send({ embeds: [embed] });
console.log("Mensagem enviada com sucesso! ID:", msg.id);

return { messageId: msg.id, channelId: channel.id };`
    },
    {
      id: 'limpar_mensagens',
      name: '🧹 Limpeza de Mensagens Recentes',
      description: 'Apaga N mensagens de um determinado canal (até 100 por vez).',
      code: `// Template: Limpar Mensagens Recentes
// ALERTA: Defina o ID do canal e a quantidade
const channelId = "SEU_CHANNEL_ID_AQUI";
const quantidade = 5; // Máximo 100 por chamada

const channel = await client.channels.fetch(channelId);
if (!channel || !channel.isTextBased()) throw new Error("Canal de texto inválido!");

const deleted = await channel.bulkDelete(quantidade, true);
console.log(\`Foram deletadas \${deleted.size} mensagens do canal \${channel.name}\`);

return { deletadas: deleted.size, canal: channel.name };`
    }
  ];

  return res.json({ templates });
});

// 4. EXECUTAR CÓDIGO SNIPPET (UMA VEZ)
app.post('/api/execute', async (req, res) => {
  const startTime = Date.now();
  const logs = [];

  // Capturador de logs durante a execução do snippet
  const customConsole = {
    log: (...args) => {
      console.log('[Snippet LOG]', ...args);
      logs.push({ type: 'log', text: args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ') });
    },
    info: (...args) => {
      console.info('[Snippet INFO]', ...args);
      logs.push({ type: 'info', text: args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ') });
    },
    warn: (...args) => {
      console.warn('[Snippet WARN]', ...args);
      logs.push({ type: 'warn', text: args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ') });
    },
    error: (...args) => {
      console.error('[Snippet ERROR]', ...args);
      logs.push({ type: 'error', text: args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ') });
    }
  };

  try {
    const { code, token, guildId } = req.body;
    if (!code || code.trim() === '') {
      return res.status(400).json({ success: false, error: "Nenhum código foi fornecido para execução." });
    }

    const client = await getDiscordClient(token);
    const guild = await getTargetGuild(client, guildId);

    // Constrói a função assíncrona dinamicamente com o contexto injetado
    // Contexto: client, guild, discord (módulo), EmbedBuilder, console, etc.
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

    const runner = new AsyncFunction(
      'client',
      'guild',
      'EmbedBuilder',
      'ActionRowBuilder',
      'ButtonBuilder',
      'ButtonStyle',
      'ChannelType',
      'PermissionFlagsBits',
      'console',
      `"use strict";\n${code}`
    );

    // Executa a função
    const result = await runner(
      client,
      guild,
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      ChannelType,
      PermissionFlagsBits,
      customConsole
    );

    const durationMs = Date.now() - startTime;

    return res.json({
      success: true,
      logs,
      result: result !== undefined ? JSON.parse(JSON.stringify(result, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )) : null,
      durationMs
    });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logs.push({ type: 'error', text: `[EXCEPTION] ${err.stack || err.message}` });

    return res.json({
      success: false,
      error: err.message,
      stack: err.stack,
      logs,
      durationMs
    });
  }
});

// Inicialização do servidor Express
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 PLATAFORMA LOCAL DO DISCORD BOT INICIADA!`);
  console.log(`🌐 Acesse no navegador: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
