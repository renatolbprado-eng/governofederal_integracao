import fs from 'fs';
import path from 'path';
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
  PermissionFlagsBits
} from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carregar variáveis de ambiente
const envPath = fs.existsSync(path.join(__dirname, '.env'))
  ? path.join(__dirname, '.env')
  : fs.existsSync(path.join(__dirname, '../governofederal_integracao-main/governofederal_integracao-main/.env'))
  ? path.join(__dirname, '../governofederal_integracao-main/governofederal_integracao-main/.env')
  : path.join(__dirname, '../.env');

if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

const token = process.env.DISCORD_TOKEN;
if (!token || token.includes('seu_discord_bot_token')) {
  console.error("❌ ERRO: DISCORD_TOKEN não foi configurado!");
  console.error("Defina o token no arquivo plataforma_local/.env ou passe como variável de ambiente.");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("===============================================================");
  console.log("⚡ EXECUTOR CLI PONTUAL DO DISCORD BOT");
  console.log("===============================================================");
  console.log("Uso:");
  console.log("  node plataforma_local/executar_snippet.js <caminho_do_arquivo.js>");
  console.log("  node plataforma_local/executar_snippet.js \"console.log(guild.name)\"");
  console.log("===============================================================");
  process.exit(0);
}

let codeToExecute = '';
const firstArg = args[0];

if (fs.existsSync(firstArg)) {
  console.log(`[CLI] Lendo arquivo de snippet: ${firstArg}`);
  codeToExecute = fs.readFileSync(firstArg, 'utf-8');
} else {
  codeToExecute = args.join(' ');
}

async function runCli() {
  console.log("[CLI] Conectando ao Discord...");
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildPresences
    ]
  });

  await client.login(token);

  await new Promise(resolve => {
    client.once('ready', resolve);
  });

  console.log(`[CLI] Bot autenticado como: ${client.user.tag}`);

  let guild = null;
  if (process.env.GUILD_ID) {
    try { guild = await client.guilds.fetch(process.env.GUILD_ID); } catch (e) {}
  }
  if (!guild) guild = client.guilds.cache.first();

  console.log(`[CLI] Servidor Alvo: ${guild ? guild.name : 'Nenhum'}`);
  console.log("------------------ INÍCIO DA EXECUÇÃO ------------------");

  try {
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
      `"use strict";\n${codeToExecute}`
    );

    const result = await runner(
      client,
      guild,
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      ChannelType,
      PermissionFlagsBits,
      console
    );

    console.log("------------------ FIM DA EXECUÇÃO ------------------");
    if (result !== undefined) {
      console.log("[RETORNO]:", result);
    }
  } catch (err) {
    console.error("❌ ERRO NA EXECUÇÃO DO SNIPPET:", err);
  } finally {
    console.log("[CLI] Encerrando conexão...");
    await client.destroy();
    process.exit(0);
  }
}

runCli();
