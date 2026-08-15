import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Collection, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

function getCleanApiKey() {
  const rawKey = process.env.GEMINI_API_KEY || '';
  return rawKey.trim().replace(/^["']|["']$/g, '');
}

// Inicialização da IA Gemini (se a chave estiver no .env)
let genAI = null;
const cleanApiKey = getCleanApiKey();
if (cleanApiKey) {
  try {
    genAI = new GoogleGenerativeAI(cleanApiKey);
  } catch (e) {
    console.error('Erro ao inicializar o cliente GoogleGenerativeAI:', e);
  }
}

// Cache global em memória para a carga de trabalho dos juízes
const juizWorkloadsCache = {};

// Cache global em memória para o último mandado de prisão expedido
let latestWarrant = {
  id: "",
  nome: "",
  motivo: "",
  emissor: "",
  timeStamp: "",
  processUrl: ""
};

// Lista de todos os mandados de prisão em aberto
let openWarrants = [];

// Sessões de alteração de permissões pendentes no módulo de moderação
const pendingRoleSelections = new Map();
const pendingManualRoleInput = new Map();

// Cache de respostas privadas da IA (!ia privada)
const privateIaResponses = new Map();

// Controle de suspensão temporária de 1h para uso da IA fora do contexto do RP
const iaBannedUsers = new Map();

// --- CONSTANTES E MAPAS DA CORREGEDORIA & TRIANGULAÇÃO ---
const ROLE_CORREGEDORIA_NOME = '「CRRGD」・ Corregedoria Geral';
const ROLE_CORP_NOME = '「CORP」Membro De Corporação';
const ROLE_PROMOTOR_NOME = 'Promotor de Justiça - MPPR';
const GOVERNO_CHANNEL_ID = '1142251068890304522';

const ALLOWED_MANDADO_ROLES = [
  '「CRRGD」・ Corregedoria Geral',
  '「ESC」Escrivão',
  '「DLG」Delegado',
  '「DLG-G」Delegado Geral',
  '「DRT」Diretor',
  '「DRT-EX」Diretor Executivo',
  '「DRT-G」Diretor Geral'
];

function isAuthorizedForMandado(member) {
  if (!member || !member.roles) return false;
  return member.roles.cache.some(r => {
    const nameLower = r.name.trim().toLowerCase();
    return nameLower.includes('corregedoria') ||
           nameLower.includes('escrivão') ||
           nameLower.includes('escrivao') ||
           nameLower.includes('delegado') ||
           nameLower.includes('diretor') ||
           ALLOWED_MANDADO_ROLES.some(allowed => nameLower.includes(allowed.toLowerCase()));
  });
}

function isGovernoChannelOrGuild(interactionOrMessage) {
  if (!interactionOrMessage) return false;
  const channelId = interactionOrMessage.channelId || interactionOrMessage.channel?.id;
  if (channelId === GOVERNO_CHANNEL_ID) return true;
  const guildName = interactionOrMessage.guild?.name?.toLowerCase() || '';
  return guildName.includes('governo');
}

const threadBridges = new Map();
const userSelectedChannels = new Map();
const pendingRepercussaoAnnouncements = new Map();

const EXTERNAL_CORP_SERVERS = [
  {
    name: 'PM (Polícia Militar)',
    guildId: '1526698673403072572',
    channelNameKeywords: ['comunicados', '「📢」・comunicados']
  },
  {
    name: 'PF (Polícia Federal)',
    guildId: '1524888239746318557',
    channelNameKeywords: ['anúncios', 'anuncios', '「📣」anúncios']
  },
  {
    name: 'RONE',
    guildId: '1525137517710540860',
    channelNameKeywords: ['avisos-rone', 'rone', '📣┃avisos-rone']
  }
];

function isImageUrl(url, contentType = '') {
  if (contentType && contentType.startsWith('image/')) return true;
  if (!url || typeof url !== 'string') return false;
  const cleanUrl = url.split('?')[0].toLowerCase();
  return cleanUrl.endsWith('.png') ||
         cleanUrl.endsWith('.jpg') ||
         cleanUrl.endsWith('.jpeg') ||
         cleanUrl.endsWith('.gif') ||
         cleanUrl.endsWith('.webp') ||
         cleanUrl.endsWith('.bmp');
}

// Função auxiliar para dividir textos longos preservando palavras e quebras de linha completas
function splitTextPreservingWords(text, maxLength = 1600) {
  if (!text || text.length <= maxLength) return [text];

  const chunks = [];
  let currentChunk = '';
  const lines = text.split('\n');

  for (const line of lines) {
    if ((currentChunk + '\n' + line).length <= maxLength) {
      currentChunk += (currentChunk ? '\n' : '') + line;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      if (line.length > maxLength) {
        const words = line.split(' ');
        for (const word of words) {
          if ((currentChunk + ' ' + word).length <= maxLength) {
            currentChunk += (currentChunk ? ' ' : '') + word;
          } else {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = word;
          }
        }
      } else {
        currentChunk = line;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// --- BASE DE CONHECIMENTO DINÂMICA: ENTENDIMENTOS DO TRIBUNAL (INDEXAÇÃO DE ALTA PERFORMANCE) ---
const KNOWLEDGE_BASE_PATH = path.resolve('banco_entendimentos_tribunal.json');
let tribunalEntendimentosCache = '';
let lastEntendimentosFetch = 0;

// Busca TODAS as mensagens do canal navegando pelas páginas da API do Discord
async function fetchAllChannelMessages(channel, limit = 500) {
  let allMessages = [];
  let lastId = null;

  while (allMessages.length < limit) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const msgs = await channel.messages.fetch(options).catch(() => null);
    if (!msgs || msgs.size === 0) break;

    const msgsArray = safeGetArray(msgs);
    allMessages = allMessages.concat(msgsArray);
    lastId = msgsArray[msgsArray.length - 1].id;

    if (msgs.size < 100) break;
  }

  return allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function getEntendimentosTribunalContext(guild, query = '') {
  if (!guild) return '';
  const now = Date.now();

  // 1. Tenta carregar do cache em disco se a memória estiver vazia
  if (!tribunalEntendimentosCache && fs.existsSync(KNOWLEDGE_BASE_PATH)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(KNOWLEDGE_BASE_PATH, 'utf8'));
      if (fileData && fileData.text) {
        tribunalEntendimentosCache = fileData.text;
        lastEntendimentosFetch = fileData.timestamp || 0;
      }
    } catch (e) {}
  }

  // 2. Re-indexa todas as mensagens do canal no Discord a cada 30 minutos (1.800.000 ms)
  if (!tribunalEntendimentosCache || (now - lastEntendimentosFetch > 1800000)) {
    try {
      const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
      const channelsArray = safeGetArray(channels);
      const targetChannel = channelsArray.find(c => 
        c && c.isTextBased() && (
          matchChannel(c.name, 'entendimentos-do-tribunal') ||
          matchChannel(c.name, 'entendimentos')
        )
      );

      if (targetChannel) {
        const sortedMsgs = await fetchAllChannelMessages(targetChannel, 500);

        const textList = sortedMsgs.map(m => {
          let body = m.content || '';
          if (m.embeds && m.embeds.length > 0) {
            const embedContent = m.embeds.map(e => {
              let t = '';
              if (e.title) t += `[${e.title}] `;
              if (e.description) t += `${e.description} `;
              if (e.fields && e.fields.length > 0) {
                t += e.fields.map(f => `${f.name}: ${f.value}`).join(' | ');
              }
              return t;
            }).join(' ');
            body += ` ${embedContent}`;
          }
          return body.trim() ? `• ${body.trim()}` : null;
        }).filter(Boolean);

        if (textList.length > 0) {
          tribunalEntendimentosCache = textList.join('\n');
          lastEntendimentosFetch = now;

          // Gravação permanente em arquivo JSON para respostas instantâneas
          try {
            fs.writeFileSync(KNOWLEDGE_BASE_PATH, JSON.stringify({
              timestamp: now,
              count: textList.length,
              text: tribunalEntendimentosCache
            }, null, 2), 'utf8');
          } catch (errWrite) {}
        }
      }
    } catch (err) {
      console.warn('Erro ao indexar entendimentos do tribunal:', err);
    }
  }

  if (!tribunalEntendimentosCache) return '';

  // 3. FILTRO INTELIGENTE DE RELEVÂNCIA (Economia Máxima de Tokens)
  // Se o usuário fez uma pergunta com palavras-chave, injeta preferencialmente os entendimentos correspondentes
  if (query && query.length > 3) {
    const terms = query.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .split(/\s+/)
      .filter(t => t.length > 3 && !['qual', 'quais', 'como', 'sobre', 'para', 'onde', 'quem'].includes(t));

    if (terms.length > 0) {
      const lines = tribunalEntendimentosCache.split('\n');
      const matchedLines = lines.filter(line => {
        const lineLow = line.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return terms.some(term => lineLow.includes(term));
      });

      if (matchedLines.length > 0) {
        return `\n\n--- ENTENDIMENTOS DO TRIBUNAL DIRETA MENTE RELEVANTES PARA A CONSULTA ---\n` + matchedLines.join('\n');
      }
    }
  }

  // 4. Se for consulta geral, envia a síntese tratada com limite seguro de caracteres
  const safeText = tribunalEntendimentosCache.length > 5000 
    ? tribunalEntendimentosCache.substring(0, 5000) + '\n[... Base de entendimentos sintetizada ...]' 
    : tribunalEntendimentosCache;

  return `\n\n--- BASE DE CONHECIMENTO & ENTENDIMENTOS OFICIAIS DO TRIBUNAL DE JUSTIÇA ---\n${safeText}`;
}

// --- SISTEMA DE REGISTRO DE EMPRESAS E ESCRITÓRIOS (CARTÓRIO & OAB - CNPJ ÚNICO AUTOMÁTICO) ---
const registeredCNPJs = new Set();

function generateUniqueCNPJ() {
  let cnpj = '';
  do {
    const r = (n) => Math.floor(Math.random() * n);
    const n1 = r(9), n2 = r(9), n3 = r(9);
    const n4 = r(9), n5 = r(9), n6 = r(9);
    const n7 = r(9), n8 = r(9);
    const d1 = r(9), d2 = r(9);
    cnpj = `${n1}${n2}.${n3}${n4}${n5}.${n6}${n7}${n8}/0001-${d1}${d2}`;
  } while (registeredCNPJs.has(cnpj));

  registeredCNPJs.add(cnpj);
  return cnpj;
}

async function checkAndAssignEntityCNPJ(thread, isLawOffice = false) {
  if (!thread || !thread.isThread()) return;
  // Ignora posts de MODELO fixados ou criados como template
  if (thread.name && thread.name.toUpperCase().includes('MODELO')) return;

  try {
    const msgs = await thread.messages.fetch({ limit: 50 }).catch(() => null);
    if (!msgs) return;

    const msgsArray = safeGetArray(msgs);

    // Verifica se QUALQUER mensagem da thread já possui CNPJ atribuído e registra no Set de controle
    let existingCNPJ = null;
    msgsArray.forEach(m => {
      const text = (m.content || '').toUpperCase();
      const match = text.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
      if (match) {
        existingCNPJ = match[0];
        registeredCNPJs.add(existingCNPJ);
      }
      if (m.embeds && m.embeds.length > 0) {
        const fullEmb = JSON.stringify(m.embeds).toUpperCase();
        const matchEmb = fullEmb.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
        if (matchEmb) {
          existingCNPJ = matchEmb[0];
          registeredCNPJs.add(existingCNPJ);
        }
      }
    });

    if (existingCNPJ) {
      // Já possui CNPJ designado: devidamente mantido e registrado no controle de unicidade
      return;
    }

    // Não possui CNPJ: gera um novo CNPJ estritamente ÚNICO
    const ownerId = thread.ownerId || (msgsArray.length > 0 ? msgsArray[0].author.id : null);
    const ownerMention = ownerId ? `<@${ownerId}>` : 'Requerente';
    const newCNPJ = generateUniqueCNPJ();
    const timeStamp = getFormattedDateTime();

    const titleText = isLawOffice 
      ? `🏛️ **REGISTRO DE ESCRITÓRIOS DE ADVOCACIA - OAB & CARTÓRIO**\n*Averbação e Constituição de Sociedade de Advogados*`
      : `🏛️ **CARTÓRIO REGISTRO DE EMPRESAS**\n*Averbação e Constituição de Pessoa Jurídica*`;

    const descriptionText = isLawOffice
      ? `Certificamos que a presente sociedade/escritório de advocacia foi devidamente registrada e averbada junto à Ordem dos Advogados e ao Cartório do Governo Federal.`
      : `Certificamos que a presente instituição/empresa foi devidamente registrada e averbada junto ao Cartório do Governo Federal.`;

    const certidaoMsg = 
      `-----------------------------------------\n` +
      `${titleText}\n\n` +
      `> **Titular / Requerente:** ${ownerMention}\n` +
      `> **CNPJ Designado:** \`${newCNPJ}\`\n` +
      `> **Data de Registro:** ${timeStamp}\n\n` +
      `${descriptionText}\n` +
      `-----------------------------------------`;

    await thread.send({ content: certidaoMsg }).catch(() => null);
    console.log(`[Cartório CNPJ] CNPJ Único ${newCNPJ} atribuído a "${thread.name}" (${thread.id}) [Escritório: ${isLawOffice}]`);
  } catch (err) {
    console.error(`[Cartório CNPJ] Erro ao verificar/atribuir CNPJ para thread ${thread.id}:`, err);
  }
}

async function auditAndRegisterCompaniesAndLawOffices(guild) {
  if (!guild) return;
  try {
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const channelsArray = safeGetArray(channels);

    // 1. Canal Registro de Empresas
    const empChannel = channelsArray.find(c => 
      c && (
        matchChannel(c.name, 'registro-de-empresas') ||
        matchChannel(c.name, 'empresas')
      )
    );

    // 2. Canal Escritórios de Advocacia (OAB)
    const officeChannel = channelsArray.find(c => 
      c && (
        matchChannel(c.name, 'escritorios') ||
        matchChannel(c.name, 'escritórios')
      )
    );

    const targetChannels = [
      { channel: empChannel, isLawOffice: false },
      { channel: officeChannel, isLawOffice: true }
    ];

    for (const item of targetChannels) {
      if (item.channel && item.channel.threads) {
        const activeThreads = await item.channel.threads.fetchActive().catch(() => null);
        if (activeThreads && activeThreads.threads) {
          for (const [id, thread] of activeThreads.threads) {
            await checkAndAssignEntityCNPJ(thread, item.isLawOffice);
          }
        }

        const archivedThreads = await item.channel.threads.fetchArchived().catch(() => null);
        if (archivedThreads && archivedThreads.threads) {
          for (const [id, thread] of archivedThreads.threads) {
            await checkAndAssignEntityCNPJ(thread, item.isLawOffice);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Cartório CNPJ] Erro na auditoria de empresas e escritórios no servidor:', err);
  }
}

async function publishRepercussaoAnnouncement(guild, channel, conteudo, attachments = [], textNotes = '') {
  const avisoEmbed = new EmbedBuilder()
    .setTitle('📢 ANÚNCIO DE REPERCUSSÃO GERAL - TODAS AS CORPS')
    .setDescription(conteudo)
    .setColor('#e74c3c')
    .setFooter({ text: 'Corregedoria-Geral • Comunicação Geral de Corporações' })
    .setTimestamp();

  if (textNotes && textNotes.trim().length > 0 && textNotes.trim().toLowerCase() !== 'nenhum') {
    avisoEmbed.addFields({ name: '📝 Observações / Links', value: textNotes.trim(), inline: false });
  }

  const normalizedAttachments = attachments.map(item => {
    if (typeof item === 'string') {
      return { url: item, name: 'Arquivo', contentType: '' };
    }
    return item;
  });

  const imageAttachments = normalizedAttachments.filter(a => isImageUrl(a.url, a.contentType));
  const docAttachments = normalizedAttachments.filter(a => !isImageUrl(a.url, a.contentType));

  if (imageAttachments.length > 0) {
    avisoEmbed.setImage(imageAttachments[0].url);
  }

  if (docAttachments.length > 0) {
    const docLinks = docAttachments.map(d => `📄 [${d.name || 'Documento'}](${d.url})`).join('\n');
    avisoEmbed.addFields({ name: '📎 Documentos Anexados', value: docLinks, inline: false });
  }

  const payloadLocal = { embeds: [avisoEmbed] };

  const roleCorp = guild.roles.cache.find(
    r => r.name.trim().toLowerCase() === ROLE_CORP_NOME.trim().toLowerCase() ||
         r.name.includes('Membro De Corporação') ||
         r.name.includes('CORP')
  );

  if (roleCorp) {
    payloadLocal.content = `<@&${roleCorp.id}>`;
  }

  await channel.send(payloadLocal).catch(err => console.error('Erro ao enviar na Corregedoria:', err));

  const payloadExternal = { embeds: [avisoEmbed] };

  for (const corp of EXTERNAL_CORP_SERVERS) {
    try {
      const corpGuild = client.guilds.cache.get(corp.guildId) || await client.guilds.fetch(corp.guildId).catch(() => null);
      if (!corpGuild) continue;

      const channels = await corpGuild.channels.fetch().catch(() => corpGuild.channels.cache);
      const targetCh = safeGetArray(channels).find(c => c && c.isTextBased() && (
        corp.channelNameKeywords.some(kw => c.name.toLowerCase().includes(kw))
      ));

      if (targetCh) {
        await targetCh.send(payloadExternal).catch(err => console.error(`Erro ao enviar na ${corp.name}:`, err));
      }
    } catch (e) {
      console.error(`Erro ao transmitir repercussão para ${corp.name}:`, e);
    }
  }
}

// Helper para comparar nomes de canais de forma robusta e tolerante a emojis e acentos
function matchChannel(channelName, targetKeyword) {
  if (!channelName) return false;
  const normalizedChannel = channelName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const normalizedTarget = targetKeyword.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  
  if (normalizedTarget === 'bo') {
    return new RegExp('\\bbo\\b').test(normalizedChannel);
  }
  
  return normalizedChannel.includes(normalizedTarget);
}

// Inicializa o cliente do Discord com as intenções necessárias
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// Função auxiliar para obter data/hora formatada no fuso brasileiro
function getFormattedDateTime() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `[${day}/${month}/${year} ${hours}:${minutes}]`;
}

// Helper universal para converter coleções, maps, arrays e objetos paginados em Arrays convencionais JS
function safeGetArray(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.items)) return obj.items;
  
  if (typeof obj.values === 'function') {
    return Array.from(obj.values());
  }
  
  if (obj.items && typeof obj.items.values === 'function') {
    return Array.from(obj.items.values());
  }
  
  if (obj.items) {
    return Object.values(obj.items);
  }
  
  return Object.values(obj);
}

// Helper robusto para localizar o Embed Inicial de Autuação do Processo (independente de quantas mensagens a thread tenha)
async function getProcessStarterMessage(thread) {
  try {
    if (!thread || typeof thread.messages?.fetch !== 'function') return null;

    // 1. Tenta buscar a mensagem inicial/starter nativa da thread (Discord API)
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter && starter.author.id === client.user.id && starter.embeds && starter.embeds.length > 0) {
      return starter;
    }

    // 2. Tenta buscar a mensagem cujo ID é igual ao id da thread
    const idMsg = await thread.messages.fetch(thread.id).catch(() => null);
    if (idMsg && idMsg.author.id === client.user.id && idMsg.embeds && idMsg.embeds.length > 0) {
      return idMsg;
    }

    // 3. Pega mensagens a partir do início da criação da thread (after: thread.id)
    const firstMsgs = await thread.messages.fetch({ after: thread.id, limit: 30 }).catch(() => null);
    if (firstMsgs && firstMsgs.size > 0) {
      const msgsArray = safeGetArray(firstMsgs);
      const botMsg = msgsArray
        .filter(m => m && m.author && m.author.id === client.user.id && m.embeds && m.embeds.length > 0)
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0];
      if (botMsg) return botMsg;
    }

    // 4. Varredura no histórico completo desde o início (em lotes de 100 da mais antiga para a mais recente)
    let allMsgs = [];
    let lastId = null;
    for (let i = 0; i < 5; i++) { // Varre até 500 mensagens
      const fetchOptions = { limit: 100 };
      if (lastId) fetchOptions.before = lastId;
      const batch = await thread.messages.fetch(fetchOptions).catch(() => null);
      if (!batch || batch.size === 0) break;
      allMsgs.push(...safeGetArray(batch));
      lastId = batch.last().id;
      if (batch.size < 100) break;
    }

    if (allMsgs.length > 0) {
      allMsgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const botMsg = allMsgs.find(m => m && m.author && m.author.id === client.user.id && m.embeds && m.embeds.length > 0);
      if (botMsg) return botMsg;
    }

    return null;
  } catch (err) {
    console.error('Erro ao buscar mensagem inicial do processo:', err);
    return null;
  }
}

// Helper dinâmico para buscar envolvidos (incluindo advogados de ambos os lados) a partir do Embed Inicial
async function getProcessParties(thread) {
  try {
    const botEmbedMsg = await getProcessStarterMessage(thread);
    if (!botEmbedMsg || !botEmbedMsg.embeds || botEmbedMsg.embeds.length === 0) return null;

    const embed = botEmbedMsg.embeds[0];
    const processIdField = embed.fields ? embed.fields.find(f => f.name.includes('Número do Processo')) : null;
    const processId = processIdField ? processIdField.value.replace(/`/g, '') : 'Não identificado';
    
    const typeField = embed.fields ? embed.fields.find(f => f.name.includes('Classe Processual')) : null;
    const type = typeField ? typeField.value : 'Ação judicial';

    const authorField = embed.fields ? embed.fields.find(f => f.name.includes('Discord do Autor')) : null;
    const defendantField = embed.fields ? embed.fields.find(f => f.name.includes('Discord do Réu')) : null;

    const parseUserId = (fieldValue) => {
      if (!fieldValue) return null;
      const match = fieldValue.match(/<@!?(\d+)>/);
      return match ? match[1] : null;
    };

    const authorId = parseUserId(authorField?.value);
    const defendantId = parseUserId(defendantField?.value);

    const authorUser = authorId ? await client.users.fetch(authorId).catch(() => null) : null;
    const defendantUser = defendantId ? await client.users.fetch(defendantId).catch(() => null) : null;

    // Busca Advogados do Autor
    const authorLawyersField = embed.fields ? embed.fields.find(f => f.name.includes('Advogado(s) do Autor')) : null;
    const authorLawyers = [];
    if (authorLawyersField) {
      const matches = [...authorLawyersField.value.matchAll(/<@!?(\d+)>/g)];
      for (const match of matches) {
        const user = await client.users.fetch(match[1]).catch(() => null);
        if (user) authorLawyers.push(user);
      }
    }

    // Busca Advogados do Réu
    const defendantLawyersField = embed.fields ? embed.fields.find(f => f.name.includes('Advogado(s) do Réu')) : null;
    const defendantLawyers = [];
    if (defendantLawyersField) {
      const matches = [...defendantLawyersField.value.matchAll(/<@!?(\d+)>/g)];
      for (const match of matches) {
        const user = await client.users.fetch(match[1]).catch(() => null);
        if (user) defendantLawyers.push(user);
      }
    }

    return { processId, type, authorUser, defendantUser, authorLawyers, defendantLawyers };
  } catch (err) {
    console.error('Erro ao decodificar partes do processo:', err);
    return null;
  }
}

// Auxiliar para obter ou criar a categoria TRIBUNAL DE JUSTIÇA DO PARANÁ
async function getOrCreateTribunalCategory(guild) {
  try {
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const channelsArray = safeGetArray(channels);

    // Busca prioritária por Tribunal de Justiça do Paraná (TJPR) excluindo STF / Supremo
    let category = channelsArray.find(c => c && c.type === ChannelType.GuildCategory && (
      (c.name.toLowerCase().includes('paraná') ||
       c.name.toLowerCase().includes('parana') ||
       c.name.toLowerCase().includes('tjpr') ||
       c.name.toLowerCase().includes('tribunal de justiça') ||
       c.name.toLowerCase().includes('tribunal de justica')) &&
      !c.name.toLowerCase().includes('stf') &&
      !c.name.toLowerCase().includes('supremo')
    ));

    if (!category) {
      category = await guild.channels.create({
        name: '🏛️ TRIBUNAL DE JUSTIÇA DO PARANÁ',
        type: ChannelType.GuildCategory
      }).catch(() => null);
    }

    return category;
  } catch (err) {
    console.error('Erro ao buscar/criar categoria Tribunal de Justiça do Paraná:', err);
    return null;
  }
}

// Inicializa a contagem de processos em cache na inicialização do bot
async function initializeJuizesWorkload(guild) {
  try {
    const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
    const rolesArray = safeGetArray(roles);
    const juizRole = rolesArray.find(r => r && r.name === 'J. Dir. | Juiz de Direito');
    if (!juizRole) return;

    let members = await guild.members.fetch({ force: true }).catch(() => null);
    if (!members) members = juizRole.members;
    if (!members) members = guild.members.cache;

    const membersArray = safeGetArray(members);
    const juizes = membersArray.filter(m => m && m.roles && m.roles.cache && m.roles.cache.has(juizRole.id));

    // Zera o cache antes da varredura
    for (const member of juizes) {
      juizWorkloadsCache[member.id] = 0;
    }

    // Localiza especificamente o canal de petições (📜・petições)
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const channelsArray = safeGetArray(channels);
    const peticoesChannel = channelsArray.find(c => c && c.name && (
      matchChannel(c.name, 'petições') ||
      matchChannel(c.name, 'peticoes')
    ));

    if (!peticoesChannel) {
      console.log(`[Juízes Relatório] Canal "petições" não encontrado no servidor: ${guild.name}`);
      return;
    }

    // Coleta APENAS as threads ativas pertencentes exclusivamente ao canal 📜・petições
    let activeThreads = [];
    if (typeof peticoesChannel.threads?.fetchActive === 'function') {
      const active = await peticoesChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
      activeThreads = safeGetArray(active.threads);
    } else {
      const allActive = await guild.channels.fetchActiveThreads().catch(() => ({ threads: new Map() }));
      activeThreads = safeGetArray(allActive.threads).filter(t => t && t.parentId === peticoesChannel.id);
    }

    const processThreads = activeThreads.filter(t => t && (t.name.includes('PROC-') || t.name.includes('SEGREDO')));

    // Varre cada thread ativa em petições para contabilizar a carga de trabalho do juiz sorteado
    for (const thread of processThreads) {
      try {
        const msgs = await thread.messages.fetch({ limit: 10 }).catch(() => null);
        if (!msgs) continue;
        const msgsArray = safeGetArray(msgs);
        
        for (const m of msgsArray) {
          if (m && m.content) {
            const matches = m.content.match(/<@!?(\d+)>/g);
            if (matches) {
              for (const match of matches) {
                const jId = match.replace(/<@!?/, '').replace('>', '');
                if (jId in juizWorkloadsCache && (
                  m.content.includes('Juiz') ||
                  m.content.includes('Magistrado') ||
                  m.content.includes('Sorteio') ||
                  m.content.includes('Autuação')
                )) {
                  juizWorkloadsCache[jId]++;
                  break; // Conta apenas 1 vez por processo
                }
              }
            }
          }
        }
      } catch (err) {}
    }
    console.log(`[Juízes Relatório] Cache de carga de trabalho inicializado:`, juizWorkloadsCache);
  } catch (err) {
    console.error('Erro ao inicializar workload dos juízes:', err);
  }
}

// Atualiza o relatório de carga de trabalho dos Juízes no canal "Juízes" (Luz e rápido)
async function updateJuizesWorkload(guild) {
  try {
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const channelsArray = safeGetArray(channels);
    const juizesChannel = channelsArray.find(c => c && c.name && matchChannel(c.name, 'juízes'));
    if (!juizesChannel || !juizesChannel.isTextBased()) {
      console.log(`[Juízes Relatório] Canal "Juízes" não encontrado no servidor: ${guild.name}`);
      return;
    }

    const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
    const rolesArray = safeGetArray(roles);
    const juizRole = rolesArray.find(r => r && r.name === 'J. Dir. | Juiz de Direito');
    if (!juizRole) {
      console.log(`[Juízes Relatório] Cargo "J. Dir. | Juiz de Direito" não encontrado no servidor: ${guild.name}`);
      return;
    }

    // Busca ativa dos juízes com fallbacks
    let members = await guild.members.fetch({ force: true }).catch(() => null);
    if (!members) members = juizRole.members;
    if (!members) members = guild.members.cache;

    const membersArray = safeGetArray(members);
    const juizes = membersArray.filter(m => m && m.roles && m.roles.cache && m.roles.cache.has(juizRole.id));

    // Sincroniza cache (remove demitidos, adiciona novos)
    const activeJuizesIds = new Set(juizes.map(m => m.id));
    for (const cachedId of Object.keys(juizWorkloadsCache)) {
      if (!activeJuizesIds.has(cachedId)) {
        delete juizWorkloadsCache[cachedId];
      }
    }
    for (const member of juizes) {
      if (!(member.id in juizWorkloadsCache)) {
        juizWorkloadsCache[member.id] = 0;
      }
    }

    // 1. Relatório de Carga de Trabalho
    const timeStamp = getFormattedDateTime();
    let reportContent = `🏛️ **RELATÓRIO DE DISTRIBUIÇÃO E CARGA DE TRABALHO - MAGISTRATURA**\n` +
                        `📅 *Atualizado em: ${timeStamp}*\n\n` +
                        `Abaixo está a carga horária e processos ativos sob a condução dos Magistrados designados:\n\n`;

    for (const member of juizes) {
      const count = juizWorkloadsCache[member.id] || 0;
      reportContent += `👤 **Juiz de Direito:** <@${member.id}>\n` +
                       `📂 Processos designados: **${count}**\n\n`;
    }

    reportContent += `-----------------------------------------\n` +
                     `*Este relatório é atualizado dinamicamente pelo Cartório Judicial a cada novo processo autuado.*`;

    // Atualiza a mensagem no canal "Juízes" (busca mensagens recentes e mensagens fixadas para evitar duplicações ao reiniciar)
    const [channelMsgs, pinnedMsgs] = await Promise.all([
      juizesChannel.messages.fetch({ limit: 50 }).catch(() => null),
      juizesChannel.messages.fetchPinned().catch(() => null)
    ]);

    const channelMsgsArray = safeGetArray(channelMsgs);
    const pinnedMsgsArray = safeGetArray(pinnedMsgs);
    const allMsgsMap = new Map();
    [...pinnedMsgsArray, ...channelMsgsArray].forEach(m => {
      if (m && m.id) allMsgsMap.set(m.id, m);
    });
    const allMsgs = Array.from(allMsgsMap.values());

    const botMsg = allMsgs.find(m => m && m.author && m.author.id === client.user.id && m.content && m.content.includes('RELATÓRIO DE DISTRIBUIÇÃO'));

    // Cria as ActionRows dos botões para cada juiz cadastrado
    const rows = [];
    let currentRow = new ActionRowBuilder();
    let btnCount = 0;

    for (const member of juizes) {
      const juizName = member.user.username.substring(0, 18);
      const btn = new ButtonBuilder()
        .setCustomId(`btn_despacho_${member.id}`)
        .setLabel(`Despacho c/ ${juizName}`)
        .setStyle(ButtonStyle.Secondary);
      
      currentRow.addComponents(btn);
      btnCount++;

      if (btnCount === 5) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder();
        btnCount = 0;
      }
    }
    if (btnCount > 0) {
      rows.push(currentRow);
    }

    if (botMsg) {
      await botMsg.edit({ content: reportContent, components: rows }).catch(() => null);
    } else {
      await juizesChannel.send({ content: reportContent, components: rows }).catch(() => null);
    }

    // 2. Painel Fixado de Marcação de Audiências em #juízes
    // Encontra TODAS as mensagens do painel de audiências enviadas pelo bot (fixadas ou recentes)
    const matchingAudienciaMsgs = allMsgs.filter(m => 
      m && m.author && m.author.id === client.user.id && 
      m.embeds && m.embeds[0] && m.embeds[0].title && 
      m.embeds[0].title.includes('MARCAÇÃO') && m.embeds[0].title.includes('AUDIÊNCIAS')
    );

    // Se houver mais de uma mensagem duplicada gerada em reinicializações passadas, remove as duplicadas
    let botMsgAudiencias = null;
    if (matchingAudienciaMsgs.length > 0) {
      botMsgAudiencias = matchingAudienciaMsgs[0];
      if (matchingAudienciaMsgs.length > 1) {
        for (let i = 1; i < matchingAudienciaMsgs.length; i++) {
          await matchingAudienciaMsgs[i].delete().catch(() => null);
        }
      }
    }

    const audienciasEmbed = new EmbedBuilder()
      .setTitle('⚖️ MARCAÇÃO E AGENDA DE AUDIÊNCIAS JUDICIAIS')
      .setDescription(
        `Central de agendamento de sessões de conciliação e audiências de instrução e julgamento do Tribunal.\n\n` +
        `📌 **COMO AGENDAR UMA AUDIÊNCIA:**\n` +
        `1. Clique no botão **"📅 Agendar Audiência"** abaixo.\n` +
        `2. Preencha o **Número do Processo**, informe se é **Conciliação** ou **Instrução e Julgamento** e a **Data/Horário**.\n` +
        `3. O bot criará um **Card da Audiência** e a **Sala de Áudio Oficial** na seção do *Tribunal de Justiça*.\n` +
        `4. Para encerrar a sessão, utilize o botão **"🗑️ Excluir Audiência"** no card da audiência criada.`
      )
      .setColor(0xd4af37)
      .setFooter({ text: 'Poder Judiciário • Gestão de Pauta de Audiências' })
      .setTimestamp();

    const btnMarcarAud = new ButtonBuilder()
      .setCustomId('btn_marcar_audiencia')
      .setLabel('📅 Agendar Audiência')
      .setStyle(ButtonStyle.Primary);

    const rowAudienciaMsg = new ActionRowBuilder().addComponents(btnMarcarAud);

    if (!botMsgAudiencias) {
      const sentAud = await juizesChannel.send({ embeds: [audienciasEmbed], components: [rowAudienciaMsg] }).catch(() => null);
      if (sentAud) await sentAud.pin().catch(() => null);
    } else {
      await botMsgAudiencias.edit({ embeds: [audienciasEmbed], components: [rowAudienciaMsg] }).catch(() => null);
    }

    console.log(`[Juízes Relatório] Relatório e Painel de Audiências atualizados em #${juizesChannel.name} (${guild.name}).`);
  } catch (err) {
    console.error('Erro ao atualizar carga de trabalho dos juízes:', err);
  }
}

// Inicializa o canal do BNMP no servidor
async function initializeBNMP(guild) {
  try {
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const channelsArray = safeGetArray(channels);
    const bnmpChannel = channelsArray.find(c => c && c.name && matchChannel(c.name, 'bnmp-prisoes'));

    if (!bnmpChannel || !bnmpChannel.isTextBased()) {
      console.log(`[BNMP] Canal "bnmp-prisões" não encontrado no servidor: ${guild.name}`);
      return;
    }

    // Busca mensagens fixadas
    const pinnedMessages = await bnmpChannel.messages.fetchPinned().catch(() => null);
    
    // Procura por mensagem enviada por este bot que contém o botão de registrar mandado
    let setupMessage = null;
    if (pinnedMessages) {
      setupMessage = safeGetArray(pinnedMessages).find(m => 
        m.author.id === client.user.id && 
        m.components && 
        m.components.some(row => row.components.some(c => c.customId === 'btn_registrar_mandado'))
      );
    }

    if (!setupMessage) {
      console.log(`[BNMP] Painel de controle não encontrado no canal #${bnmpChannel.name} de ${guild.name}. Criando novo...`);
      
      const embed = new EmbedBuilder()
        .setTitle('🏛️ BANCO NACIONAL DE MANDADOS DE PRISÃO (BNMP)')
        .setDescription('Painel de controle para emissão de Mandados de Prisão.\n\nApenas **Juízes de Direito** possuem permissão para registrar mandados. Autoridades Policiais podem solicitar a prisão no canal privativo.')
        .setColor(0x2f3136)
        .setTimestamp()
        .setFooter({ text: 'Tribunal de Justiça - Governo Federal' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_registrar_mandado')
          .setLabel('Registrar novo Mandado')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🚨'),
        new ButtonBuilder()
          .setCustomId('btn_solicitar_prisao')
          .setLabel('Solicitar prisão (Autoridades Policiais)')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('👮')
      );

      const sentMsg = await bnmpChannel.send({ embeds: [embed], components: [row] });
      await sentMsg.pin().catch(() => null);

      // Aguarda 2 segundos e tenta limpar as mensagens de sistema sobre a fixação
      setTimeout(async () => {
        try {
          const sysMsgs = await bnmpChannel.messages.fetch({ limit: 10 }).catch(() => null);
          if (sysMsgs) {
            const pinMsg = safeGetArray(sysMsgs).find(m => m.type === 6); // 6 = ChannelPinMessage em d.js v14
            if (pinMsg) {
              await pinMsg.delete().catch(() => null);
              console.log('[BNMP] Mensagem de sistema da fixação de mensagem foi removida.');
            }
          }
        } catch (e) {
          console.error('[BNMP] Erro ao tentar apagar mensagem de sistema da fixação:', e);
        }
      }, 2000);
    } else {
      console.log(`[BNMP] Painel de controle já está presente e fixado no canal #${bnmpChannel.name} de ${guild.name}. Atualizando botões...`);
      // Garante que o painel possui ambos os botões atualizados
      const embed = EmbedBuilder.from(setupMessage.embeds[0])
        .setDescription('Painel de controle para emissão de Mandados de Prisão.\n\nApenas **Juízes de Direito** possuem permissão para registrar mandados. Autoridades Policiais podem solicitar a prisão no canal privativo.');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_registrar_mandado')
          .setLabel('Registrar novo Mandado')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🚨'),
        new ButtonBuilder()
          .setCustomId('btn_solicitar_prisao')
          .setLabel('Solicitar prisão (Autoridades Policiais)')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('👮')
      );
      await setupMessage.edit({ embeds: [embed], components: [row] }).catch(() => null);
    }
  } catch (err) {
    console.error('[BNMP] Erro ao inicializar canal do BNMP:', err);
  }
}
// Inicializa o painel de Precatórios no canal "emitir-precatórios"
async function initializePrecatorios(guild) {
  try {
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const channelsArray = safeGetArray(channels);
    const precatoriosChannel = channelsArray.find(c => c && c.name && (
      matchChannel(c.name, 'emitir-precatorios') ||
      matchChannel(c.name, 'emitir-precatórios') ||
      matchChannel(c.name, 'precatorios') ||
      matchChannel(c.name, 'precatórios')
    ));

    if (!precatoriosChannel || !precatoriosChannel.isTextBased()) {
      console.log(`[Precatórios] Canal "emitir-precatórios" não encontrado no servidor: ${guild.name}`);
      return;
    }

    // Busca se já existe o painel enviado pelo bot
    const messages = await precatoriosChannel.messages.fetch({ limit: 50 }).catch(() => []);
    const messagesArray = safeGetArray(messages);
    const botButtonMsg = messagesArray.find(m => 
      m && m.author && m.author.id === client.user.id && 
      m.components && m.components.length > 0 && 
      m.components[0].components.some(comp => comp.customId === 'btn_iniciar_precatorio')
    );

    if (!botButtonMsg) {
      console.log(`[Precatórios] Enviando painel de precatórios no canal #${precatoriosChannel.name} de ${guild.name}...`);
      
      const embed = new EmbedBuilder()
        .setTitle('🏛️ SISTEMA NACIONAL DE PRECATÓRIOS')
        .setDescription(
          'Utilize o painel abaixo para emitir e certificar ordens de pagamento de precatórios judiciais.\n\n' +
          '**Instruções:**\n' +
          '1. Clique no botão **Emitir Precatório**.\n' +
          '2. Preencha os dados do beneficiário (Discord e Roblox), o valor e a justificativa legal.\n' +
          '3. A certidão oficial em formato HTML será gerada e anexada automaticamente no canal.'
        )
        .setColor(0xd4af37) // Dourado
        .setTimestamp()
        .setFooter({ text: 'Tribunal do Governo Federal' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_iniciar_precatorio')
          .setLabel('Emitir Precatório')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('📜')
      );

      const sentMsg = await precatoriosChannel.send({ embeds: [embed], components: [row] }).catch(() => null);
      if (sentMsg) {
        // Fixa a mensagem e depois apaga a notificação automática de fixação
        await sentMsg.pin().catch(() => null);
        
        setTimeout(async () => {
          try {
            const msgsAfterPin = await precatoriosChannel.messages.fetch({ limit: 10 });
            const pinSystemMsg = safeGetArray(msgsAfterPin).find(m => m && m.type === 6 && m.reference && m.reference.messageId === sentMsg.id);
            if (pinSystemMsg) {
              await pinSystemMsg.delete().catch(() => null);
            }
          } catch (e) {
            console.error('[Precatórios] Erro ao apagar notificação de fixação:', e);
          }
        }, 2000);
      }
    } else {
      console.log(`[Precatórios] Painel de precatórios já está presente no canal #${precatoriosChannel.name} de ${guild.name}.`);
    }
  } catch (err) {
    console.error('[Precatórios] Erro ao inicializar canal de precatórios:', err);
  }
}

// Inicializa e mantém atualizado o manual completo no canal "manual-de-uso"
async function initializeManualDeUso(guild) {
  try {
    const channels = await guild.channels.fetch().catch(() => guild.roles.cache);
    const channelsArray = safeGetArray(channels);
    const manualChannel = channelsArray.find(c => c && c.name && (
      matchChannel(c.name, 'manual-de-uso') ||
      matchChannel(c.name, 'manual') ||
      matchChannel(c.name, 'manual-uso')
    ));

    if (!manualChannel || !manualChannel.isTextBased()) {
      return;
    }

    // Busca mensagens fixadas ou recentes enviadas pelo bot no canal
    const pinnedMessages = await manualChannel.messages.fetchPinned().catch(() => null);
    let setupMessage = null;
    if (pinnedMessages) {
      setupMessage = safeGetArray(pinnedMessages).find(m => 
        m.author.id === client.user.id && 
        m.embeds && 
        m.embeds.some(e => e.title && e.title.includes('MANUAL OFICIAL'))
      );
    }

    // Construção dos Embeds do Manual
    const embedHeader = new EmbedBuilder()
      .setTitle('📘 MANUAL OFICIAL DE USO DO BOT JUDICIAL')
      .setDescription(
        `Bem-vindo ao sistema integrado do Poder Judiciário!\n` +
        `Este canal traz o guia completo de utilização do bot, com todas as funções disponíveis divididas por perfil de usuário.\n\n` +
        `---`
      )
      .setColor(0x1a365d);

    const embedAdvogados = new EmbedBuilder()
      .setTitle('⚖️ 1. MANUAL DOS ADVOGADOS & PROCURADORES')
      .setColor(0x2f3136)
      .addFields(
        { 
          name: '📝 Peticionamento Eletrônico', 
          value: `• **Onde:** Canal \`#peticionamento-eletrônico\`.\n` +
                 `• **Quem pode usar:** Qualquer Advogado/Procurador.\n` +
                 `• **Como funciona:** Clique no botão **"Peticionar"**. Preencha o Modal com o *Tipo de Processo*, *Parte Autora* e *Parte Ré*. O bot criará a thread do processo automaticamente no fórum e notificará as partes.`
        },
        { 
          name: '🤝 Audiência de Despacho', 
          value: `• **Onde:** Painel de Magistrados / Despachos.\n` +
                 `• **Quem pode usar:** Advogados e Solicitantes.\n` +
                 `• **Como funciona:** Clique no botão de despacho e selecione o Juiz designado. O bot abrirá uma sala privativa temporária para alinhar providências urgentes e despachos.`
        }
      );

    const embedPartes = new EmbedBuilder()
      .setTitle('👤 2. MANUAL DAS PARTES (AUTOR & RÉU)')
      .setColor(0x2f3136)
      .addFields(
        { 
          name: '🔗 Cadastro e Vinculação de Partes (!partes)', 
          value: `• **Onde:** Dentro da thread do processo.\n` +
                 `• **Quem pode usar:** Partes ou Advogados.\n` +
                 `• **Como funciona:** Digite \`!partes\` na thread. Selecione se é Parte Autora ou Ré e mencione o Discord da parte \`(ex: @cliente1)\`. O bot atualiza a autuação inicial e concede acesso à thread.`
        },
        { 
          name: '🔔 Citação e Intimação Automática', 
          value: `• **Como funciona:** Ao ser citado no processo, o bot envia uma notificação direta por mensagem privada (DM) contendo o número do processo, link da thread e orientações de defesa.`
        }
      );

    const embedJuizes = new EmbedBuilder()
      .setTitle('👨‍⚖️ 3. MANUAL DOS JUÍZES DE DIREITO & MAGISTRADOS')
      .setColor(0xd4af37)
      .addFields(
        { 
          name: '🔒 Segredo de Justiça (!segredo)', 
          value: `• **Onde:** Na thread do processo.\n` +
                 `• **Quem pode usar:** Apenas Juízes de Direito.\n` +
                 `• **Como funciona:** Digite \`!segredo\`. O bot converterá a causa em sigilosa, criando uma thread privativa de Segredo de Justiça, adicionando apenas o Juiz, as partes e os advogados cadastrados.`
        },
        { 
          name: '📜 Expedição de Ofício / Ato Ordinatório (!oficio)', 
          value: `• **Onde:** Em threads de processos ou no canal \`👮🏻・bnmp-prisões\`.\n` +
                 `• **Quem pode usar:** Apenas Juízes de Direito.\n` +
                 `• **Como funciona:** Digite \`!oficio\` e clique em **"Redigir Ofício"**. Digite a determinação no formulário. Ao enviar, o bot publica a movimentação oficial e pergunta no chat se deseja notificar usuários via DM privada \`(ex: @pessoa1)\`.`
        },
        { 
          name: '💰 Emissão e Baixa de Precatórios', 
          value: `• **Onde:** Canal \`🛠️・emitir-precatórios\` (ou \`🛠️・execjud\` / \`precatórios\`).\n` +
                 `• **Quem pode usar:** Apenas Juízes de Direito.\n` +
                 `• **Como funciona:** Clique em **"Emitir Precatório"**, preencha o formulário e informe o Discord do beneficiário no chat. Gera uma certidão dourada. Para registrar pagamento, clique em **"Dar Baixa por Pagamento"** (converte a certidão para tom vermelho com status PAGO e auditoria).`
        },
        { 
          name: '🚨 Mandados de Prisão (BNMP)', 
          value: `• **Onde:** Canal \`👮🏻・bnmp-prisões\`.\n` +
                 `• **Quem pode usar:** Apenas Juízes de Direito.\n` +
                 `• **Como funciona:** Clique em **"Registrar novo Mandado"**, selecione o processo ou informe o acusado e leis. Publica o mandado com botão de baixa. Ao revogar, o botão **"Dar Baixa em Mandado"** converte a ordem para o status REVOGADO em tom vermelho.`
        }
      );

    const embedPolicia = new EmbedBuilder()
      .setTitle('👮 4. AUTORIDADES POLICIAIS & SOLICITAÇÃO DE PRISÃO')
      .setColor(0xd9534f)
      .addFields(
        { 
          name: '🚔 Solicitar Prisão (Autoridades Policiais)', 
          value: `• **Onde:** Canal \`👮🏻・bnmp-prisões\`.\n` +
                 `• **Quem pode usar:** Autoridades Policiais / Qualquer membro.\n` +
                 `• **Como funciona:** Clique em **"Solicitar prisão (Autoridades Policiais)"**. O bot criará uma thread privada adicionando o policial solicitante e **todos os Juízes de Direito** do servidor para debate sigiloso e envio de provas.`
        }
      )
      .setFooter({ text: 'Tribunal de Justiça • Manual Oficial do Bot' })
      .setTimestamp();

    const embedsArray = [embedHeader, embedAdvogados, embedPartes, embedJuizes, embedPolicia];

    if (!setupMessage) {
      const sentMsg = await manualChannel.send({ embeds: embedsArray }).catch(() => null);
      if (sentMsg) {
        await sentMsg.pin().catch(() => null);
        setTimeout(async () => {
          try {
            const sysMsgs = await manualChannel.messages.fetch({ limit: 10 });
            const pinMsg = safeGetArray(sysMsgs).find(m => m && m.type === 6 && m.reference && m.reference.messageId === sentMsg.id);
            if (pinMsg) await pinMsg.delete().catch(() => null);
          } catch (e) {}
        }, 2000);
      }
    } else {
      await setupMessage.edit({ embeds: embedsArray }).catch(() => null);
    }
  } catch (err) {
    console.error('[Manual de Uso] Erro ao inicializar canal do manual:', err);
  }
}

// Função auxiliar para restringir o canal #arquivo-processos exclusivamente para Juízes de Direito
async function ensureArchiveChannelPermissions(guild) {
  try {
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const channelsArray = safeGetArray(channels);
    const archiveChannel = channelsArray.find(c => c && c.isTextBased() && (
      matchChannel(c.name, 'arquivo-processos') ||
      matchChannel(c.name, 'processos-arquivados') ||
      matchChannel(c.name, 'arquivo')
    ));

    if (!archiveChannel) return;

    const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
    const rolesArray = safeGetArray(roles);
    const juizRole = rolesArray.find(r => r && r.name === 'J. Dir. | Juiz de Direito');

    const permissionOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
      }
    ];

    if (juizRole) {
      permissionOverwrites.push({
        id: juizRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessages
        ]
      });
    }

    if (client.user) {
      permissionOverwrites.push({
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory
        ]
      });
    }

    await archiveChannel.permissionOverwrites.set(permissionOverwrites).catch(() => null);
  } catch (err) {
    console.error('Erro ao configurar permissões do canal de arquivo:', err);
  }
}

client.once('ready', async () => {
  console.log(`\n=========================================`);
  console.log(`🚀 BOT DE INTEGRAÇÃO OPERACIONAL`);
  console.log(`🤖 Conectado como: ${client.user.tag}`);
  console.log(`=========================================\n`);
  
  try {
    const targetGuildId = process.env.GUILD_ID || '1142251068890304522';
    let guild = null;
    try {
      guild = await client.guilds.fetch(targetGuildId);
    } catch (e) {
      guild = client.guilds.cache.first();
    }

    if (guild) {
      console.log(`⚙️  Inicializando serviços para o servidor: ${guild.name}`);
      const logs = [];

      // 1. Juízes Workload
      try {
        await initializeJuizesWorkload(guild);
        await updateJuizesWorkload(guild);
        logs.push(`  ├─ ⚖️  [Juízes Relatório] Cache e Painel sincronizados com sucesso.`);
      } catch (e) {
        logs.push(`  ├─ ❌ [Juízes Relatório] Falha na inicialização: ${e.message}`);
      }

      // 2. Módulo BNMP
      try {
        await initializeBNMP(guild);
        logs.push(`  ├─ 👮 [BNMP] Módulo de Mandados de Prisão verificado/operacional.`);
      } catch (e) {
        logs.push(`  ├─ ❌ [BNMP] Falha na inicialização: ${e.message}`);
      }

      // 3. Módulo Precatórios
      try {
        await initializePrecatorios(guild);
        logs.push(`  ├─ 📜 [Precatórios] Painel de Precatórios verificado/operacional.`);
      } catch (e) {
        logs.push(`  ├─ ❌ [Precatórios] Falha na inicialização: ${e.message}`);
      }

      // 4. Módulo Manual de Uso
      try {
        await initializeManualDeUso(guild);
        logs.push(`  ├─ 📘 [Manual de Uso] Guia Oficial verificado/atualizado com sucesso.`);
      } catch (e) {
        logs.push(`  ├─ ❌ [Manual de Uso] Falha na inicialização: ${e.message}`);
      }

      // 5. Módulo Arquivo de Processos (Restrição para Juízes)
      try {
        await ensureArchiveChannelPermissions(guild);
        logs.push(`  ├─ 📁 [Arquivo-Processos] Permissões restringidas exclusivamente a Juízes de Direito.`);
      } catch (e) {
        logs.push(`  ├─ ❌ [Arquivo-Processos] Falha na restrição de permissões: ${e.message}`);
      }

      // 6. Módulo Gestão de Permissões (#moderator-only)
      try {
        await initializeGestaoPermissoes(guild);
        logs.push(`  ├─ 🛡️ [Gestão-Permissões] Painel de Controle de Acessos verificado/atualizado.`);
      } catch (e) {
        logs.push(`  ├─ ❌ [Gestão-Permissões] Falha na inicialização: ${e.message}`);
      }

      // 7. Módulo Cartório Registro de Empresas & Escritórios de Advocacia (CNPJs Únicos)
      try {
        await auditAndRegisterCompaniesAndLawOffices(guild);
        logs.push(`  └─ 🏛️ [Cartório & OAB] Auditoria de empresas e escritórios concluída e CNPJs verificados.`);
      } catch (e) {
        logs.push(`  └─ ❌ [Cartório & OAB] Falha na auditoria de CNPJs: ${e.message}`);
      }

      console.log(logs.join('\n'));
      console.log(`\n=========================================\n`);
    }
  } catch (err) {
    console.error('Erro na inicialização do servidor:', err);
  }
});

// EVENTO THREADCREATE: AGENDAMENTO AUTOMÁTICO DE CNPJ DE 5 MINUTOS PARA EMPRESAS E ESCRITÓRIOS
client.on('threadCreate', async (thread) => {
  try {
    if (!thread || !thread.name) return;
    // Ignora posts de MODELO
    if (thread.name.toUpperCase().includes('MODELO')) return;
    const parentChannel = thread.parent || (thread.parentId ? await thread.guild?.channels.fetch(thread.parentId).catch(() => null) : null);
    const channelName = parentChannel ? parentChannel.name.toLowerCase() : thread.name.toLowerCase();

    const isEmpresas = matchChannel(channelName, 'registro-de-empresas') || matchChannel(channelName, 'empresas');
    const isEscritorios = matchChannel(channelName, 'escritorios') || matchChannel(channelName, 'escritórios');

    if (isEmpresas || isEscritorios) {
      console.log(`[Cartório/OAB CNPJ] Novo registro detectado em "${channelName}": "${thread.name}". CNPJ será agendado em 5 minutos.`);
      setTimeout(async () => {
        try {
          const freshThread = await thread.guild.channels.fetch(thread.id).catch(() => null);
          if (freshThread) {
            await checkAndAssignEntityCNPJ(freshThread, isEscritorios);
          }
        } catch (e) {
          console.error('[Cartório/OAB CNPJ] Erro no processamento agendado de CNPJ:', e);
        }
      }, 300000);
    }
  } catch (err) {
    console.error('[Cartório/OAB CNPJ] Erro ao escutar threadCreate:', err);
  }
});

// MÓDULO DE GESTÃO INSTITUCIONAL DE PERMISSÕES & ACESSOS (#moderator-only)
async function initializeGestaoPermissoes(guild) {
  try {
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const channelsArray = safeGetArray(channels);
    const modChannel = channelsArray.find(c => c && c.isTextBased() && (
      matchChannel(c.name, 'moderator-only') ||
      matchChannel(c.name, 'moderador') ||
      matchChannel(c.name, 'mod-only') ||
      matchChannel(c.name, 'gestao-permissoes') ||
      matchChannel(c.name, 'permissoes')
    ));

    if (!modChannel) return;

    // Busca histórico recente para não duplicar o painel
    const msgs = await modChannel.messages.fetch({ limit: 20 }).catch(() => null);
    const msgsArray = safeGetArray(msgs);
    let setupMessage = msgsArray.find(m => m && m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title && m.embeds[0].title.includes('GESTÃO DE PERMISSÕES'));

    const panelEmbed = new EmbedBuilder()
      .setTitle('🛡️ PAINEL INSTITUCIONAL DE GESTÃO DE PERMISSÕES & ACESSOS')
      .setDescription(
        `Bem-vindo à Central de Controle e Auditoria de Acessos dos Canais do Servidor.\n\n` +
        `📌 **COMO UTILIZAR ESTE PAINEL:**\n` +
        `1. **Selecione o Canal ou Bloco (Categoria):** Escolha qualquer canal de texto, voz, fórum ou categoria no menu suspenso abaixo.\n` +
        `2. **Inspecione os Acessos Existentes:** O bot exibirá um relatório com todos os cargos que possuem permissões customizadas naquele local.\n` +
        `3. **Modifique Permissões por Quesito:** Escolha um cargo para conceder (🟢), negar (🔴) ou restaurar para o padrão (⚪) permissões de **Visualização**, **Envio de Mensagens**, **Anexo de Arquivos** ou **Gerenciamento**.`
      )
      .setColor(0x34495e)
      .setFooter({ text: 'Sistema de Moderação e Controle Institucional • Acesso Restrito' })
      .setTimestamp();

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId('select_canal_gestao')
      .setPlaceholder('🔍 Selecione um canal de texto ou bloco de canais (categoria)...');

    const row = new ActionRowBuilder().addComponents(channelSelect);

    if (!setupMessage) {
      const sentMsg = await modChannel.send({ embeds: [panelEmbed], components: [row] }).catch(() => null);
      if (sentMsg) {
        await sentMsg.pin().catch(() => null);
        setTimeout(async () => {
          try {
            const sysMsgs = await modChannel.messages.fetch({ limit: 10 });
            const pinMsg = safeGetArray(sysMsgs).find(m => m && m.type === 6 && m.reference && m.reference.messageId === sentMsg.id);
            if (pinMsg) await pinMsg.delete().catch(() => null);
          } catch (e) {}
        }, 2000);
      }
    } else {
      await setupMessage.edit({ embeds: [panelEmbed], components: [row] }).catch(() => null);
    }
  } catch (err) {
    console.error('[Gestão Permissões] Erro ao inicializar painel de gestão:', err);
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // --- Verificação de Anexos do Anúncio de Repercussão Geral ---
  if (pendingRepercussaoAnnouncements.has(message.author.id)) {
    const pending = pendingRepercussaoAnnouncements.get(message.author.id);
    if (message.channel.id === pending.channelId) {
      pendingRepercussaoAnnouncements.delete(message.author.id);

      if (message.deletable) {
        await message.delete().catch(() => {});
      }

      const attachmentsList = Array.from(message.attachments.values()).map(a => ({
        url: a.url,
        name: a.name,
        contentType: a.contentType
      }));
      const textNotes = message.content.trim();

      await publishRepercussaoAnnouncement(message.guild, message.channel, pending.conteudo, attachmentsList, textNotes);

      const tempAck = await message.channel.send(`✅ **Anúncio de Repercussão Geral publicado com sucesso por <@${message.author.id}>!**`);
      setTimeout(() => tempAck.delete().catch(() => {}), 5000);
      return;
    }
  }

  // --- Sincronização da Ponte de Mensagens (Message Bridge Triangulada: Corregedoria, PF e Governo Federal) ---
  if (message.channel.isThread() && threadBridges.has(message.channel.id)) {
    const connectedGroup = threadBridges.get(message.channel.id);
    const targetIds = Array.isArray(connectedGroup) ? connectedGroup : Array.from(connectedGroup);
    const senderName = message.member?.displayName || message.author.username;

    const parentName = message.channel.parent?.name.toLowerCase() || '';
    const guildName = message.guild?.name.toLowerCase() || '';

    let originTag = '💬 [Corregedoria-Geral]';

    if (parentName.includes('bnmp') || guildName.includes('governo')) {
      originTag = '⚖️ [Governo Federal / Magistratura]';
    } else if (parentName.includes('pedidos') || parentName === 'pedido-de-mandados' || guildName.includes('pf') || guildName.includes('polícia federal') || guildName.includes('policia federal')) {
      originTag = '🚨 [Polícia Federal - PF]';
    } else if (parentName.includes('pedido-de-mandado') || guildName.includes('corregedoria')) {
      originTag = '💬 [Corregedoria-Geral]';
    }

    const payload = {
      content: `**${originTag} ${senderName}:** ${message.content}`
    };

    if (message.attachments.size > 0) {
      payload.files = Array.from(message.attachments.values()).map(a => a.url);
    }

    for (const targetId of targetIds) {
      if (targetId === message.channel.id) continue;
      try {
        const targetThread = client.channels.cache.get(targetId) || await client.channels.fetch(targetId).catch(() => null);
        if (targetThread && targetThread.isTextBased()) {
          await targetThread.send(payload).catch(() => {});
        }
      } catch (err) {
        console.error('Erro no Message Bridge Triangulado:', err);
      }
    }
  }

  const contentLower = message.content.trim().toLowerCase();

  const deleteCommandMessage = async () => {
    if (message.deletable) {
      await message.delete().catch(() => {});
    }
  };

  const isCorregedoria = message.member?.roles.cache.some(
    r => r.name.trim().toLowerCase() === ROLE_CORREGEDORIA_NOME.trim().toLowerCase() ||
         r.name.includes('Corregedoria Geral')
  );

  // --- COMANDOS DA CORREGEDORIA ---

  // Comando !setup-denuncia
  if (contentLower === '!setup-denuncia') {
    await deleteCommandMessage();
    const embed = new EmbedBuilder()
      .setTitle('⚖️ CORREGEDORIA GERAL - CANAL DE DENÚNCIAS')
      .setDescription(
        'Bem-vindo ao sistema oficial de denúncias da Corregedoria.\n\n' +
        'Clique no botão abaixo para iniciar uma nova denúncia contra um membro.\n' +
        '🔒 **Sua denúncia é confidencial** e será tratada em uma thread privada apenas com a equipe da Corregedoria Geral.'
      )
      .setColor('#7289da')
      .setFooter({ text: 'Corregedoria Geral • Sistema Automático' })
      .setTimestamp();

    const button = new ButtonBuilder()
      .setCustomId('btn_iniciar_denuncia')
      .setLabel('Iniciar denúncia contra membro')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);
    await message.channel.send({ embeds: [embed], components: [row] });
    return;
  }

  // Comando !setup-mandado
  if (contentLower === '!setup-mandado') {
    await deleteCommandMessage();
    const embed = new EmbedBuilder()
      .setTitle('⚖️ CORREGEDORIA GERAL - SOLICITAÇÃO DE MANDADO DE PRISÃO')
      .setDescription(
        'Bem-vindo ao canal oficial de requisições de Mandado de Prisão da Corregedoria.\n\n' +
        'Clique no botão abaixo para preencher os dados do acusado e enviar a solicitação.\n' +
        '🔗 **Integração Automática:** A solicitação criará uma sala de análise e será enviada diretamente ' +
        'para a Magistratura no Governo Federal.'
      )
      .setColor('#9b59b6')
      .setFooter({ text: 'Corregedoria Geral • Banco de Mandados' })
      .setTimestamp();

    const button = new ButtonBuilder()
      .setCustomId('btn_solicitar_mandado')
      .setLabel('Solicitar Mandado de Prisão')
      .setEmoji('⚖️')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);
    await message.channel.send({ embeds: [embed], components: [row] });
    return;
  }

  // Comando !setup-comunicacao (Canal comunicação-interna no Governo)
  if (contentLower === '!setup-comunicacao' || contentLower === '!setup-comunicacao-interna') {
    await deleteCommandMessage();
    const embed = new EmbedBuilder()
      .setTitle('🛠️ TRIBUNAL DO GOVERNO FEDERAL - COMUNICAÇÃO INTERNA')
      .setDescription(
        'Bem-vindo ao canal de Comunicação Interna do Governo Federal.\n\n' +
        'Clique no botão abaixo para preencher os dados do acusado e solicitar um Mandado de Prisão.\n' +
        '🔒 **Modo Privativo:** A sala no Governo Federal será aberta aqui neste canal vinculando apenas você (sem notificar todos os juízes), ' +
        'mantendo a triangulação em tempo real com a Polícia Federal e a Corregedoria.'
      )
      .setColor('#3498db')
      .setFooter({ text: 'Governo Federal • Comunicação Interna & Mandados' })
      .setTimestamp();

    const button = new ButtonBuilder()
      .setCustomId('btn_solicitar_mandado_interno')
      .setLabel('Solicitar Mandado (Comunicação Interna)')
      .setEmoji('⚖️')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);
    const sentMsg = await message.channel.send({ embeds: [embed], components: [row] });
    await sentMsg.pin().catch(() => {});
    return;
  }

  // Comando !setup-repercussao
  if (contentLower === '!setup-repercussao') {
    await deleteCommandMessage();
    const embed = new EmbedBuilder()
      .setTitle('📢 ANÚNCIO DE REPERCUSSÃO GERAL - TODAS AS CORPS')
      .setDescription(
        'Bem-vindo ao canal oficial de Anúncios de Repercussão Geral da Corregedoria-Geral.\n\n' +
        'Clique no botão **Anunciar** abaixo para publicar um novo comunicado oficial destinado a todas as corporações.\n\n' +
        '📝 **Instruções:** No formulário, insira o texto do aviso e, se desejado, os links de imagens ou documentos em anexo.'
      )
      .setColor('#c0392b')
      .setFooter({ text: 'Corregedoria Geral • Repercussão Geral' })
      .setTimestamp();

    const button = new ButtonBuilder()
      .setCustomId('btn_anunciar_repercussao')
      .setLabel('Anunciar')
      .setEmoji('📢')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);
    const pinnedMsg = await message.channel.send({ embeds: [embed], components: [row] });
    await pinnedMsg.pin().catch(() => {});
    return;
  }

  // Comando !anuncio
  if (contentLower === '!anuncio') {
    await deleteCommandMessage();
    if (!isCorregedoria) return;

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId('select_canais_anuncio')
      .setPlaceholder('Selecione os canais de destino (opcional)...')
      .setMinValues(1)
      .setMaxValues(5)
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    const btnAnuncio = new ButtonBuilder()
      .setCustomId('btn_abrir_modal_anuncio')
      .setLabel('📢 Preencher Anúncio Secreto')
      .setStyle(ButtonStyle.Success);

    const rowSelect = new ActionRowBuilder().addComponents(channelSelect);
    const rowButton = new ActionRowBuilder().addComponents(btnAnuncio);

    const tempMsg = await message.channel.send({
      content: '🔒 **Criador de Anúncios Anônimos da Corregedoria**\n' +
               '1️⃣ *(Opcional)* **Escolha o(s) canal(is)** no menu abaixo (ou deixe sem selecionar para enviar em `「📢」・avisos`).\n' +
               '2️⃣ Clique em **📢 Preencher Anúncio Secreto** para digitar a mensagem.',
      components: [rowSelect, rowButton]
    });

    setTimeout(() => { tempMsg.delete().catch(() => {}); }, 120000);
    return;
  }





  // Comando !encerrar
  if (contentLower === '!encerrar') {
    await deleteCommandMessage();
    if (!message.channel.isThread() || !threadBridges.has(message.channel.id)) {
      return message.channel.send('❌ O comando `!encerrar` só pode ser executado dentro de uma thread ativa de mandado de prisão!');
    }
    const isJuiz = message.member?.roles.cache.some(
      r => r.name.includes('Juiz') || r.name.includes('Magistratura') || r.name === 'J. Dir. | Juiz de Direito'
    ) || isAuthorizedForMandado(message.member) || message.member?.permissions.has(PermissionFlagsBits.Administrator);

    if (!isJuiz) {
      return message.channel.send('❌ **Acesso Negado:** Apenas Juízes de Direito, Magistrados ou autoridades autorizadas podem encerrar os autos.');
    }

    const connectedGroup = threadBridges.get(message.channel.id);
    const targetIds = Array.isArray(connectedGroup) ? connectedGroup : Array.from(connectedGroup);

    const closeEmbed = new EmbedBuilder()
      .setTitle('🔒 CONEXÃO ENCERRADA • AUTOS ARQUIVADOS')
      .setDescription(
        `O processo de solicitação de mandado de prisão foi **oficialmente encerrado** pelo Juiz de Direito <@${message.author.id}> (\`${message.author.tag}\`).\n\n` +
        `🌐 **Status da Conexão:** \`🔴 ENCERRADA / ARQUIVADA\`\n` +
        `⏱️ Todas as salas privadas integradas serão encerradas e removidas em 5 segundos.`
      )
      .setColor('#7f8c8d')
      .setFooter({ text: 'Banco Nacional de Mandados de Prisão • Encerramento Oficial' })
      .setTimestamp();

    for (const tid of targetIds) {
      try {
        const t = client.channels.cache.get(tid) || await client.channels.fetch(tid).catch(() => null);
        if (t && t.isTextBased()) {
          await t.send({ embeds: [closeEmbed] }).catch(() => {});
        }
      } catch (e) {}
      threadBridges.delete(tid);
    }

    setTimeout(async () => {
      for (const tid of targetIds) {
        try {
          const t = client.channels.cache.get(tid) || await client.channels.fetch(tid).catch(() => null);
          if (t && typeof t.delete === 'function') {
            await t.delete('Encerrado por Juiz de Direito').catch(() => {});
          }
        } catch (e) {}
      }
    }, 5000);
    return;
  }

  const content = message.content.trim();

  // --- CAPTURA DE ENTRADA MANUAL DE CARGOS PARA GESTÃO DE PERMISSÕES ---
  const pendingRoleInput = pendingManualRoleInput.get(message.author.id);
  if (pendingRoleInput) {
    pendingManualRoleInput.delete(message.author.id);

    // Deleta imediatamente a mensagem digitada pelo usuário no chat para manter o canal limpo
    await message.delete().catch(() => null);

    let foundRoles = [];
    if (message.mentions && message.mentions.roles.size > 0) {
      foundRoles = Array.from(message.mentions.roles.values());
    } else {
      const text = message.content.toLowerCase();
      const allRoles = await message.guild.roles.fetch().catch(() => message.guild.roles.cache);
      const rolesArr = safeGetArray(allRoles);
      foundRoles = rolesArr.filter(r => r && (text.includes(r.name.toLowerCase()) || text.includes(r.id)));
    }

    if (foundRoles.length === 0) {
      const promptError = await message.channel.send({
        content: `⚠️ <@${message.author.id}> **Nenhum cargo válido foi encontrado na sua mensagem.**\nPor favor, tente novamente clicando em **➕ Adicionar Permissões** e mencionando os cargos *(ex: @Cargo1 @Cargo2)*.`,
        allowedMentions: { parse: [] }
      }).catch(() => null);
      if (promptError) setTimeout(() => promptError.delete().catch(() => {}), 8000);
      return;
    }

    const roleIds = foundRoles.map(r => r.id);
    const { channelId, direito } = pendingRoleInput;
    pendingRoleSelections.set(message.author.id, { channelId, direito, roleIds });

    const targetChannel = await message.guild.channels.fetch(channelId).catch(() => null);
    const quesitoLabel = direito === 'view' ? 'Visualizar Canal' : (direito === 'send' ? 'Enviar Mensagens' : (direito === 'files' ? 'Anexar Arquivos/Mídia' : 'Gerenciar Canal'));
    const roleNamesText = foundRoles.map(r => `\`@${r.name}\``).join(', ');

    const embedApply = new EmbedBuilder()
      .setTitle(`⚖️ DEFINIR PERMISSÃO: ${quesitoLabel.toUpperCase()}`)
      .setDescription(
        `Você identificou **${foundRoles.length} cargo(s)** para o recurso **${targetChannel ? targetChannel.name : channelId}**:\n\n` +
        `• **Cargos identificados:** ${roleNamesText}\n` +
        `• **Quesito:** \`${quesitoLabel}\`\n\n` +
        `Escolha a ação a ser aplicada aos cargos:`
      )
      .setColor(0xe67e22)
      .setTimestamp();

    const btnAllow = new ButtonBuilder().setCustomId('btn_apply_multi_allow').setLabel('🟢 Conceder (Permitir)').setStyle(ButtonStyle.Success);
    const btnDeny = new ButtonBuilder().setCustomId('btn_apply_multi_deny').setLabel('🔴 Restringir (Negar)').setStyle(ButtonStyle.Danger);
    const btnCancel = new ButtonBuilder().setCustomId('btn_cancelar_gestao').setLabel('❌ Cancelar').setStyle(ButtonStyle.Secondary);

    const rowAction = new ActionRowBuilder().addComponents(btnAllow, btnDeny, btnCancel);

    const promptReply = await message.channel.send({
      content: `<@${message.author.id}>`,
      embeds: [embedApply],
      components: [rowAction],
      allowedMentions: { parse: [] }
    }).catch(() => null);

    if (promptReply) {
      setTimeout(() => promptReply.delete().catch(() => {}), 90000);
    }
    return;
  }

  // COMANDO !SETUP-PERMISSOES / !SETUP-MODERADOR
  if (content.toLowerCase() === '!setup-permissoes' || content.toLowerCase() === '!setup-moderador') {
    const member = message.member;
    const isAuthorized = member && (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      member.roles.cache.some(r => {
        const name = r.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return name.includes('moderad') || name.includes('administrad') || name.includes('juiz') || name.includes('corregedoria') || name.includes('staff');
      })
    );

    if (!isAuthorized) {
      await message.reply('⚠️ **Acesso Negado:** Apenas Administradores e Moderadores autorizados podem criar o painel de gestão de permissões.').catch(() => null);
      return;
    }

    message.delete().catch(() => null);

    const panelEmbed = new EmbedBuilder()
      .setTitle('🛡️ PAINEL INSTITUCIONAL DE GESTÃO DE PERMISSÕES & ACESSOS')
      .setDescription(
        `Bem-vindo à Central de Controle e Auditoria de Acessos dos Canais do Servidor.\n\n` +
        `📌 **COMO UTILIZAR ESTE PAINEL:**\n` +
        `1. **Selecione o Canal ou Bloco (Categoria):** Escolha qualquer canal de texto, voz, fórum ou categoria no menu suspenso abaixo.\n` +
        `2. **Inspecione os Acessos Existentes:** O bot exibirá um relatório com todos os cargos que possuem permissões customizadas naquele local.\n` +
        `3. **Modifique Permissões por Quesito:** Escolha um cargo para conceder (🟢), negar (🔴) ou restaurar para o padrão (⚪) permissões de **Visualização**, **Envio de Mensagens**, **Anexo de Arquivos** ou **Gerenciamento**.`
      )
      .setColor(0x34495e)
      .setFooter({ text: 'Sistema de Moderação e Controle Institucional • Acesso Restrito' })
      .setTimestamp();

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId('select_canal_gestao')
      .setPlaceholder('🔍 Selecione um canal de texto ou bloco de canais (categoria)...');

    const row = new ActionRowBuilder().addComponents(channelSelect);

    const sentMsg = await message.channel.send({ embeds: [panelEmbed], components: [row] }).catch(() => null);
    if (sentMsg) {
      await sentMsg.pin().catch(() => null);
    }
    return;
  }

  // COMANDO !GLOBO (Envio de mensagem formatada para Tupper no canal 💬・chat)
  if (content.toLowerCase().startsWith('!globo')) {
    const textArg = content.slice(6).trim();
    const channels = await message.guild?.channels.fetch().catch(() => message.guild?.channels.cache);
    const channelsArray = safeGetArray(channels);
    const chatChannel = channelsArray.find(c => c && c.isTextBased() && (
      c.name === '💬・chat' ||
      c.name === 'chat' ||
      matchChannel(c.name, 'chat')
    ));

    if (!chatChannel) {
      await message.reply('❌ **Erro:** Canal `💬・chat` não foi encontrado no servidor.').catch(() => null);
      return;
    }

    if (textArg) {
      await chatChannel.send(`globo:${textArg}`).catch(err => {
        console.error('Erro ao enviar mensagem globo:', err);
      });

      const confirmMsg = await message.reply(`✅ Mensagem enviada para o canal <#${chatChannel.id}>!`).catch(() => null);
      setTimeout(() => {
        message.delete().catch(() => null);
        if (confirmMsg) confirmMsg.delete().catch(() => null);
      }, 4000);
      return;
    } else {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_abrir_globo')
          .setLabel('Redigir Mensagem Globo')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('📺')
      );

      await message.reply({
        content: `📺 **Mensagem Globo:** Clique no botão abaixo para abrir a caixa de redação e enviar sua mensagem para o canal <#${chatChannel.id}>:`,
        components: [row]
      }).catch(() => null);
      return;
    }
  }

  // COMANDO !SETUP-DENUNCIA ou !ANEXAR-BOTAO-DENUNCIA
  if (content.toLowerCase().startsWith('!setup-denuncia') || content.toLowerCase().startsWith('!anexar-botao-denuncia')) {
    try {
      const channels = await message.guild.channels.fetch().catch(() => message.guild.channels.cache);
      const channelsArray = safeGetArray(channels);
      const targetChannel = channelsArray.find(c => 
        c && c.isTextBased() && (
          matchChannel(c.name, 'fazer-denuncia') ||
          matchChannel(c.name, 'fazer-denúncia') ||
          matchChannel(c.name, 'denuncia') ||
          matchChannel(c.name, 'denúncias')
        )
      ) || message.channel;

      const fetchedMsgs = await targetChannel.messages.fetch({ limit: 30 }).catch(() => null);
      const msgsArray = fetchedMsgs ? safeGetArray(fetchedMsgs) : [];
      const pinnedMsgs = await targetChannel.messages.fetchPinned().catch(() => null);
      const pinnedArray = pinnedMsgs ? safeGetArray(pinnedMsgs) : [];

      const allMsgs = [...pinnedArray, ...msgsArray];
      const embedMsg = allMsgs.find(m => m.embeds && m.embeds.length > 0) || msgsArray[0];

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_abrir_ticket_denuncia')
          .setLabel('🚨 Fazer Denúncia')
          .setStyle(ButtonStyle.Danger)
      );

      if (embedMsg && embedMsg.author.id === client.user.id) {
        await embedMsg.edit({ components: [row] });
        await message.reply(`✅ **Sucesso!** O botão **🚨 Fazer Denúncia** foi anexado à mensagem fixada/existente no canal <#${targetChannel.id}>.`).catch(() => null);
      } else if (embedMsg) {
        await targetChannel.send({
          content: `🚨 **ATENDIMENTO E RECEPTÁCULO DE DENÚNCIA - MINISTÉRIO PÚBLICO**\nClique no botão abaixo para abrir uma denúncia privada diretamente com os Promotores de Justiça:`,
          components: [row]
        });
        await message.reply(`✅ **Sucesso!** O botão **🚨 Fazer Denúncia** foi enviado no canal <#${targetChannel.id}>.`).catch(() => null);
      } else {
        const defaultEmbed = new EmbedBuilder()
          .setTitle('🚨 MINISTÉRIO PÚBLICO - CANAL DE DENÚNCIAS')
          .setDescription(
            `Bem-vindo ao canal oficial de denúncias do **Governo Federal e Poder Judiciário**.\n\n` +
            `Clique no botão **🚨 Fazer Denúncia** abaixo para abrir um atendimento estritamente confidencial diretamente com os **Promotores de Justiça**.`
          )
          .setColor(0xc0392b)
          .setFooter({ text: 'Ministério Público • Governo Federal' });

        await targetChannel.send({ embeds: [defaultEmbed], components: [row] });
        await message.reply(`✅ **Sucesso!** O painel de denúncia com o botão foi publicado no canal <#${targetChannel.id}>.`).catch(() => null);
      }
    } catch (errSetup) {
      console.error('[Denúncia Setup] Erro ao configurar botão de denúncia:', errSetup);
      await message.reply('❌ Ocorreu um erro ao configurar o botão de denúncia. Verifique os logs.').catch(() => null);
    }
    return;
  }

  // COMANDO !IA ou !GEMINI
  if (content.toLowerCase().startsWith('!ia') || content.toLowerCase().startsWith('!gemini')) {
    const authorTag = message.author.tag ? message.author.tag.toLowerCase() : '';
    const usernameLower = message.author.username.toLowerCase();
    const displayNameLower = message.member?.displayName?.toLowerCase() || '';

    const isDrRenato = usernameLower.includes('renat') || 
                       displayNameLower.includes('renat') || 
                       usernameLower.includes('dr.renato') || 
                       displayNameLower.includes('dr.renato') ||
                       authorTag.includes('renat');

    // Se NÃO for o Dr. Renato, verifica se o usuário está suspenso temporariamente por 1h
    if (!isDrRenato) {
      const banExpiry = iaBannedUsers.get(message.author.id);
      if (banExpiry && banExpiry > Date.now()) {
        const remainingMs = banExpiry - Date.now();
        const remainingMins = Math.ceil(remainingMs / 60000);
        await message.reply(`⚠️ **Acesso Suspenso:** Seu acesso ao comando \`!ia\` está temporariamente bloqueado por mais **${remainingMins} minuto(s)** devido a solicitações fora do contexto de RP/Judiciário.`).catch(() => null);
        return;
      }
    }

    const prompt = content.replace(/^!(ia|gemini)/i, '').trim();
    if (!prompt) {
      await message.reply('⚠️ **Uso do Comando:** `!ia <sua pergunta ou instrução>`').catch(() => null);
      return;
    }

    const promptLower = prompt.toLowerCase();

    // 1. Verificação ESTRITA de pedido de exclusão de mensagens (Exclusivo do Dr. Renato)
    const hasDeleteIntent = (promptLower.includes('apague') || 
                             promptLower.includes('delete') || 
                             promptLower.includes('limpe') || 
                             promptLower.includes('exclua') || 
                             promptLower.includes('remova') || 
                             promptLower.includes('remover')) && 
                            (promptLower.includes('mensagem') || promptLower.includes('mensagens') || promptLower.includes('chat') || promptLower.includes('historico') || promptLower.includes('histórico'));

    if (hasDeleteIntent) {
      if (!isDrRenato) {
        await message.reply('⚠️ **Acesso Negado:** Apenas o Dr. Renato possui permissão para solicitar exclusão de mensagens via IA.').catch(() => null);
        return;
      }

      const numberMatch = promptLower.match(/(\d+)/);
      let count = numberMatch ? parseInt(numberMatch[1], 10) : 1;
      if (isNaN(count) || count < 1) count = 1;
      if (count > 100) count = 100;

      try {
        await message.delete().catch(() => null);
        const msgsToDelete = await message.channel.messages.fetch({ limit: count }).catch(() => null);
        if (msgsToDelete && msgsToDelete.size > 0) {
          const deletable = safeGetArray(msgsToDelete);
          for (const m of deletable) {
            await m.delete().catch(() => null);
          }
        }

        const confirmText = `🗑️ **IA Assistente:** ${count} mensagem(ns) excluída(s) com sucesso a pedido do Dr. Renato.`;
        const tempMsg = await message.channel.send(confirmText).catch(() => null);
        if (tempMsg) setTimeout(() => tempMsg.delete().catch(() => null), 4000);
        return;
      } catch (errDelete) {
        console.error('Erro ao excluir mensagens a pedido do usuário:', errDelete);
      }
    }

    // 2. Verificação de resposta Privada vs Pública
    const isPrivate = promptLower.includes('privad') || 
                      promptLower.includes('só pra mim') || 
                      promptLower.includes('so pra mim') || 
                      promptLower.includes('apenas pra mim') || 
                      promptLower.includes('apenas para mim') || 
                      promptLower.includes('secreto') || 
                      promptLower.includes('em segredo');

    await message.channel.sendTyping().catch(() => null);

    const apiKey = getCleanApiKey();

    if (!genAI && apiKey) {
      try {
        genAI = new GoogleGenerativeAI(apiKey);
      } catch (e) {
        console.error('Erro ao instanciar Gemini:', e);
      }
    }

    if (!apiKey) {
      await message.reply(
        '🤖 **IA Assistente:** Para conectar com o modelo Gemini ao vivo, configure a variável `GEMINI_API_KEY` no seu arquivo `.env` ou Render.'
      ).catch(() => null);
      return;
    }

    // Suporte a mensagens respondidas (reply no Discord)
    let referencedText = '';
    if (message.reference && message.reference.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (refMsg) {
          if (refMsg.content) {
            referencedText += `\n\n--- MENSAGEM / DECISÃO RESPONDIDA ---\n${refMsg.content}`;
          }
          if (refMsg.embeds && refMsg.embeds.length > 0) {
            const embedTexts = refMsg.embeds.map(e => {
              let t = '';
              if (e.title) t += `[Título: ${e.title}]\n`;
              if (e.description) t += `${e.description}\n`;
              if (e.fields && e.fields.length > 0) {
                t += e.fields.map(f => `• ${f.name}: ${f.value}`).join('\n');
              }
              return t;
            }).join('\n\n');
            referencedText += `\n\n--- CARD / EMBED DA DECISÃO RESPONDIDA ---\n${embedTexts}`;
          }
        }
      } catch (err) {
        console.error('Erro ao buscar mensagem respondida:', err);
      }
    }

    // Coleta automaticamente o histórico recente de mensagens do canal ou thread (até 35 mensagens)
    let channelHistoryText = '';
    try {
      const recentMsgs = await message.channel.messages.fetch({ limit: 35 }).catch(() => null);
      if (recentMsgs && recentMsgs.size > 0) {
        const msgsArr = safeGetArray(recentMsgs)
          .filter(m => m && m.id !== message.id)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        const formattedMsgs = msgsArr.map(m => {
          const authorName = m.author ? (m.author.username || m.author.tag) : 'Usuário';
          let body = m.content || '';
          if (m.embeds && m.embeds.length > 0) {
            const embedContent = m.embeds.map(e => {
              let t = '';
              if (e.title) t += `[${e.title}] `;
              if (e.description) t += `${e.description} `;
              if (e.fields && e.fields.length > 0) {
                t += e.fields.map(f => `${f.name}: ${f.value}`).join(' | ');
              }
              return t;
            }).join(' ');
            body += ` ${embedContent}`;
          }
          return body.trim() ? `• [${authorName}]: ${body.substring(0, 500)}` : null;
        }).filter(Boolean);

        if (formattedMsgs.length > 0) {
          channelHistoryText = `\n\n--- HISTÓRICO DE MENSAGENS E PROCESSOS RECENTES DO CANAL/THREAD ---\n` + formattedMsgs.join('\n');
        }
      }
    } catch (errHistory) {
      console.warn('Erro ao buscar histórico recente para IA:', errHistory);
    }

    // Coleta a Base de Conhecimento dinâmica do canal ⚖️・entendimentos-do-tribunal
    let entendimentosContext = '';
    if (message.guild) {
      entendimentosContext = await getEntendimentosTribunalContext(message.guild, prompt);
    }

    const fullPrompt = prompt + referencedText + channelHistoryText + entendimentosContext;

    let replyText = null;
    let lastError = null;

    // Instruções diferenciadas conforme a autoridade do usuário
    const systemInstruction = isDrRenato
      ? "Você é o assistente virtual jurídico do Dr. Renato. Responda de forma AMPLA, COMPLETA, DETALHADA E IRRESTRITA à solicitação ou pergunta do usuário, utilizando e fundamentando sua resposta nos entendimentos e jurisprudências oficiais do Tribunal de Justiça sempre que aplicável. NUNCA exiba rascunhos, planos, ou raciocínio interno. Entregue apenas a resposta final limpa e direta em português."
      : "Você é o assistente virtual do Poder Judiciário / Governo RP. Suas respostas devem ser EXCLUSIVAMENTE focadas em assuntos relacionados a Roleplay (RP), Governo, Processos Judiciais, Direito ou Atuação no Servidor, devendo ser fundamentadas nos entendimentos e jurisprudências oficiais do Tribunal de Justiça sempre que aplicável. Responda de forma DENSA, DIRETA E BEM ESTRUTURADA, sem rodeios ou repetições desnecessárias, de modo que toda a explicação caiba perfeitamente em no máximo 1 ou 2 blocos de mensagem (~2.500 a 3.000 caracteres no total). ATENÇÃO CRÍTICA: Se a pergunta ou assunto do usuário NÃO tiver qualquer relação com Roleplay, Governo, Direito, Justiça ou o contexto do servidor (por exemplo: dúvidas escolares/acadêmicas fora do RP, tarefas de matemática, código de programação genérico, notícias do mundo real sem relação com o jogo), responda EXATAMENTE E APENAS O TEXTO: [FORA_DO_RP]. NUNCA responda perguntas fora do universo do RP/Judiciário para este perfil.";

    // Modelos ativos e operacionais no Google AI Studio
    const modelCandidates = [
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-flash-latest'
    ];

    // 1. Tenta a geração via SDK oficial
    if (genAI) {
      for (const modelName of modelCandidates) {
        try {
          const model = genAI.getGenerativeModel({ 
            model: modelName,
            systemInstruction: systemInstruction 
          });
          const result = await model.generateContent(fullPrompt);
          const response = await result.response;
          const text = response.text();
          if (text) {
            replyText = text;
            break;
          }
        } catch (errModel) {
          lastError = errModel;
        }
      }
    }

    // 2. Fallback via REST HTTP caso necessário
    if (!replyText && apiKey) {
      for (const mName of modelCandidates) {
        try {
          const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${mName}:generateContent`;
          const genRes = await fetch(targetUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-goog-api-key': apiKey
            },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemInstruction }] },
              contents: [{ parts: [{ text: fullPrompt }] }]
            })
          });

          if (genRes.ok) {
            const genData = await genRes.json();
            const txt = genData?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (txt) {
              replyText = txt;
              break;
            }
          }
        } catch (eGen) {}
      }
    }

    if (!replyText) {
      console.error('Erro ao gerar resposta com Gemini:', lastError);
      const errDetail = lastError?.message ? lastError.message.substring(0, 300) : 'Nenhum modelo Gemini ativado para a chave';
      await message.reply(`❌ **Erro ao processar a requisição da IA:** \`${errDetail}\``).catch(() => null);
      return;
    }

    // Algoritmo estrito de extração para descartar rascunhos ("Draft 1:", "Self-Correction:", etc.)
    let cleanReplyText = replyText;

    if (cleanReplyText.includes('Constraint Checklist') || cleanReplyText.includes('Self-Correction') || cleanReplyText.includes('User input:')) {
      const quoteMatches = [...cleanReplyText.matchAll(/"([^"]{10,})"/g)];
      if (quoteMatches.length > 0) {
        cleanReplyText = quoteMatches[quoteMatches.length - 1][1];
      } else {
        const parts = cleanReplyText.split(/Self-Correction:|Draft \d+:|Standard professional response:/i);
        cleanReplyText = parts[parts.length - 1].replace(/^[^\w\s\d"'\`]+/, '').trim();
      }
    }

    cleanReplyText = cleanReplyText.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
    cleanReplyText = cleanReplyText.replace(/^User input:[\s\S]*?Drafting the response:?/gi, '');
    cleanReplyText = cleanReplyText.trim();

    if (!cleanReplyText) cleanReplyText = replyText;

    // Detecta se a IA marcou o uso como desrelacionado ao RP para aplicar bloqueio de 1 hora
    if (!isDrRenato && cleanReplyText.includes('[FORA_DO_RP]')) {
      const oneHourMs = 60 * 60 * 1000;
      iaBannedUsers.set(message.author.id, Date.now() + oneHourMs);
      await message.reply('⚠️ **Acesso Suspenso:** O uso do comando `!ia` é restrito exclusivamente ao contexto do RP, Governo e Sistema Judiciário. Foi detectada uma solicitação não relacionada ao RP. Seu acesso ao comando `!ia` foi bloqueado pelo período de **1 hora**.').catch(() => null);
      return;
    }

    // Envio Privado vs Público
    if (isPrivate) {
      const btnId = `btn_ia_private_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      privateIaResponses.set(btnId, { text: cleanReplyText, userId: message.author.id });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(btnId)
          .setLabel('🔒 Ver Resposta Privada')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🔒')
      );

      await message.channel.send({
        content: `🔒 **IA Assistente:** Resposta privativa gerada exclusivamente para <@${message.author.id}>.`,
        components: [row]
      }).catch(() => null);
    } else {
      const headerText = isDrRenato ? '🤖 **IA Assistente (Dr. Renato):**\n' : '🤖 **IA Assistente:**\n';
      let chunks = splitTextPreservingWords(cleanReplyText, 1850);

      // Para cidadãos (usuários comuns), limita estritamente a no máximo 2 blocos de mensagem
      if (!isDrRenato && chunks.length > 2) {
        chunks = chunks.slice(0, 2);
      }

      if (chunks.length === 1) {
        await message.reply(`${headerText}${chunks[0]}`).catch(() => null);
      } else {
        for (let i = 0; i < chunks.length; i++) {
          if (i === 0) {
            await message.reply(`${headerText}(Parte 1/${chunks.length}):\n${chunks[i]}`).catch(() => null);
          } else {
            await message.channel.send(`🤖 **(Parte ${i + 1}/${chunks.length}):**\n${chunks[i]}`).catch(() => null);
          }
        }
      }
    }
    return;
  }

  // COMANDO !OFICIO (Pode ser ativado em qualquer canal ou thread, desde que por um Juiz de Direito)
  if (content.toLowerCase() === '!oficio') {
    const guild = message.guild;
    if (!guild) return;

    const juizRole = guild.roles.cache.find(r => r.name === 'J. Dir. | Juiz de Direito');
    
    // Verifica se quem chamou o comando é Juiz de Direito
    if (!juizRole || !message.member.roles.cache.has(juizRole.id)) {
      await message.reply('⚠️ **Acesso Negado:** Apenas Juízes de Direito com o cargo adequado podem expedir ofícios.').catch(() => null);
      return;
    }

    // Apaga o comando !oficio digitado para não deixar vestígios no chat
    message.delete().catch(() => null);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('btn_abrir_oficio')
        .setLabel('Redigir Ofício')
        .setStyle(ButtonStyle.Primary)
    );

    await message.channel.send({
      content: '🏛️ **Ofício Judicial:** Clique no botão abaixo para abrir a caixa de redação do Ofício/Ato Ordinatório.',
      components: [row]
    }).catch(() => null);
    return;
  }

  // LÓGICA DE REGISTRO DE ADVOGADOS & COMANDOS EM THREADS DE PROCESSO
  if (message.channel.isThread()) {
    // Adição automática de membros em threads de Autos Sigilosos por menção (silenciosa)
    if (message.channel.name.includes('AUTOS SIGILOSOS')) {
      if (message.mentions && message.mentions.users.size > 0) {
        for (const [userId, user] of message.mentions.users) {
          if (!user.bot && userId !== client.user.id) {
            await message.channel.members.add(userId).catch(() => null);
          }
        }
      }
    }

    const content = message.content.trim();

    // COMANDO !AUTOS-SIGILOSOS
    if (content.toLowerCase() === '!autos-sigilosos') {
      const guild = message.guild;
      const member = message.member;

      // Permite Juízes de Direito e Advogados
      const isJuiz = member.roles.cache.some(r => r.name === 'J. Dir. | Juiz de Direito' || r.name.toLowerCase().includes('juiz'));
      const isAdv = member.roles.cache.some(r => r.name.toLowerCase().includes('advogad') || r.name.toLowerCase().includes('procurador') || r.name.toLowerCase().includes('defensor') || r.name.toLowerCase().includes('oab'));

      if (!isJuiz && !isAdv) {
        await message.reply('⚠️ **Acesso Negado:** Apenas Juízes de Direito e Advogados habilitados podem criar salas de Autos Sigilosos.').catch(() => null);
        return;
      }

      // Deleta a mensagem do comando para não poluir o chat
      message.delete().catch(() => null);

      try {
        const processThread = message.channel;
        const processName = processThread.name;

        // Encontra um canal de texto válido (GuildText) para criar a thread privada, já que canais de Fórum não aceitam PrivateThread
        const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
        const channelsArray = safeGetArray(channels);

        let targetParent = channelsArray.find(c => c && c.type === ChannelType.GuildText && matchChannel(c.name, 'peticionamento-eletrônico'));

        if (!targetParent) {
          if (processThread.parent && processThread.parent.type === ChannelType.GuildText) {
            targetParent = processThread.parent;
          } else {
            targetParent = channelsArray.find(c => c && c.type === ChannelType.GuildText);
          }
        }

        if (!targetParent) {
          await message.channel.send('⚠️ **Erro:** Não foi possível encontrar um canal de texto adequado para criar a thread privada de autos sigilosos.').catch(() => null);
          return;
        }

        const secretAutosName = `AUTOS SIGILOSOS - ${processName}`.substring(0, 100);

        // Cria a thread privada de autos sigilosos no canal de texto selecionado
        const secretThread = await targetParent.threads.create({
          name: secretAutosName,
          autoArchiveDuration: 1440,
          type: ChannelType.PrivateThread,
          reason: `Autos sigilosos iniciados por ${message.author.tag} no processo ${processName}`
        });

        // Adiciona o autor do comando
        await secretThread.members.add(message.author.id).catch(() => null);

        // Adiciona todos os Juízes de Direito
        const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
        const rolesArray = safeGetArray(roles);
        const juizRole = rolesArray.find(r => r && r.name === 'J. Dir. | Juiz de Direito');
        if (juizRole) {
          const members = await guild.members.fetch().catch(() => guild.members.cache);
          const membersArray = safeGetArray(members);
          const juizes = membersArray.filter(m => m && m.roles && m.roles.cache.has(juizRole.id));
          for (const juizMember of juizes) {
            await secretThread.members.add(juizMember.id).catch(() => null);
          }
        }

        // Embed fixado e painel de controle sobrio e profissional
        const panelEmbed = new EmbedBuilder()
          .setTitle('AUTOS E DOCUMENTOS SIGILOSOS')
          .setDescription(
            `Sala privativa reservada para juntada e instrução de documentos sigilosos.\n\n` +
            `**Processo de Origem:** \`${processName}\` (ID: \`${processThread.id}\`)\n\n` +
            `**Instruções de Acesso:**\n` +
            `• **Acesso Concedido:** Solicitante (<@${message.author.id}>) e Magistratura.\n` +
            `• **Conceder Acesso:** Mencione o usuário no chat (\`@usuario\`) para liberação automática de acesso.\n\n` +
            `**Painel de Controle (Magistrados):**\n` +
            `• **Publicar no Processo:** Desclassifica o sigilo e transfere todos os documentos para a thread original com código oficial de remessa.\n` +
            `• **Dar Baixa:** Encerra e apaga esta sala privativa sem transferência de arquivos.`
          )
          .setColor(0x4a5568)
          .setFooter({ text: 'Cartório Judicial • Autos Sigilosos' })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`btn_autos_publicar_${processThread.id}`)
            .setLabel('Publicar no Processo')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('btn_autos_baixa')
            .setLabel('Dar Baixa (Apagar)')
            .setStyle(ButtonStyle.Danger)
        );

        const pinnedMsg = await secretThread.send({
          content: `**Sala de Autos Sigilosos Aberta** (<@${message.author.id}>)`,
          embeds: [panelEmbed],
          components: [row]
        }).catch(() => null);

        if (pinnedMsg) {
          await pinnedMsg.pin().catch(() => null);
        }

      } catch (err) {
        console.error('Erro ao criar autos sigilosos:', err);
        await message.channel.send('❌ Ocorreu um erro interno ao tentar abrir a sala de autos sigilosos.').catch(() => null);
      }
      return;
    }

    // COMANDO !SEGREDO
    if (content.toLowerCase() === '!segredo') {
      const guild = message.guild;
      const juizRole = guild.roles.cache.find(r => r.name === 'J. Dir. | Juiz de Direito');
      
      // Verifica se o autor da mensagem é Juiz de Direito
      if (!juizRole || !message.member.roles.cache.has(juizRole.id)) {
        await message.reply('⚠️ **Acesso Negado:** Apenas Juízes de Direito com o cargo adequado podem decretar segredo de justiça.').catch(() => null);
        return;
      }

      const parties = await getProcessParties(message.channel);
      if (!parties) {
        await message.reply('⚠️ **Erro:** Não foi possível identificar as partes do processo a partir da autuação desta thread.').catch(() => null);
        return;
      }

      const { processId, authorUser, defendantUser, authorLawyers, defendantLawyers } = parties;

      const peticionamentoChannel = guild.channels.cache.find(c => c && c.name && matchChannel(c.name, 'peticionamento-eletrônico'));
      const targetParent = peticionamentoChannel || message.channel.parent;

      if (!targetParent || !targetParent.isTextBased()) {
        await message.reply('⚠️ **Erro:** Não foi possível localizar um canal de texto adequado para criar a thread privada de Segredo.').catch(() => null);
        return;
      }

      try {
        const secretThreadName = `🔒 SEGREDO - ${processId}`;
        const newPrivateThread = await targetParent.threads.create({
          name: secretThreadName.substring(0, 100),
          autoArchiveDuration: 1440,
          type: ChannelType.PrivateThread,
          reason: `Segredo de Justiça decretado pelo Juiz ${message.author.tag}`
        });

        // Adiciona as partes e advogados
        if (authorUser) await newPrivateThread.members.add(authorUser.id).catch(() => null);
        if (defendantUser) await newPrivateThread.members.add(defendantUser.id).catch(() => null);
        for (const lawyer of authorLawyers) {
          await newPrivateThread.members.add(lawyer.id).catch(() => null);
        }
        for (const lawyer of defendantLawyers) {
          await newPrivateThread.members.add(lawyer.id).catch(() => null);
        }
        await newPrivateThread.members.add(message.author.id).catch(() => null); // Adiciona o juiz que executou o comando

        // Coleta todas as mensagens da thread pública original (em lotes)
        let allOldMsgs = [];
        let lastId = null;
        while (true) {
          const fetchOptions = { limit: 100 };
          if (lastId) fetchOptions.before = lastId;
          const batch = await message.channel.messages.fetch(fetchOptions).catch(() => null);
          if (!batch || batch.size === 0) break;
          allOldMsgs.push(...Array.from(batch.values()));
          lastId = batch.last().id;
          if (batch.size < 100) break;
        }

        // Ordena da mais antiga para a mais recente
        allOldMsgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        // Notificação de abertura do segredo na nova sala
        await newPrivateThread.send(
          `🔒 **PROCESSO EM SEGREDO DE JUSTIÇA**\n` +
          `Decretado por decisão judicial do Juiz <@${message.author.id}>.\n` +
          `=========================================\n` +
          `📜 **MIGRAÇÃO DE AUTOS E HISTÓRICO ANTERIOR:**`
        ).catch(() => null);

        // Reenvia cada mensagem do histórico para a nova thread privada
        for (const msg of allOldMsgs) {
          if (msg.id === message.id) continue; // Ignora a mensagem de invocação !segredo

          const files = msg.attachments && msg.attachments.size > 0 
            ? Array.from(msg.attachments.values()).map(a => a.url) 
            : [];

          if (msg.embeds && msg.embeds.length > 0) {
            const updatedEmbeds = msg.embeds.map(emb => {
              const newEmb = EmbedBuilder.from(emb);
              const hasSegredoField = emb.fields && emb.fields.some(f => f.name.includes('Segredo'));
              if (hasSegredoField) {
                const fields = emb.fields.filter(f => !f.name.includes('Segredo'));
                newEmb.setFields(fields);
                newEmb.addFields({ name: '🔒 Segredo de Justiça', value: 'Sim', inline: true });
              }
              return newEmb;
            });

            await newPrivateThread.send({
              content: msg.content || null,
              embeds: updatedEmbeds,
              files: files
            }).catch(() => null);
          } else {
            if (!msg.content && files.length === 0) continue;

            let payloadContent = '';
            if (msg.author.id === client.user.id) {
              payloadContent = msg.content;
            } else {
              payloadContent = `💬 **<@${msg.author.id}>**: ${msg.content}`;
            }

            await newPrivateThread.send({
              content: payloadContent || null,
              files: files
            }).catch(() => null);
          }
        }

        await message.channel.send(`🔒 **Segredo de Justiça Decretado:** Este processo foi tornado sigiloso por decisão judicial de <@${message.author.id}>.\nOs autos e todo o histórico de mensagens foram migrados com segurança para a nova thread privada: <#${newPrivateThread.id}>.\n*Esta thread pública antiga será apagada em 10 segundos.*`).catch(() => null);

        // Agenda a exclusão da thread pública antiga
        setTimeout(() => {
          message.channel.delete().catch(() => null);
        }, 10000);

      } catch (err) {
        console.error('Erro ao decretar segredo:', err);
        await message.reply('❌ Ocorreu um erro interno ao tentar decretar segredo de justiça e migrar o processo.').catch(() => null);
      }
      return;
    }

    // COMANDO !ARQUIVAR
    if (content.toLowerCase() === '!arquivar') {
      const guild = message.guild;
      const juizRole = guild.roles.cache.find(r => r.name === 'J. Dir. | Juiz de Direito');
      
      // Verifica se quem chamou é Juiz de Direito
      if (!juizRole || !message.member.roles.cache.has(juizRole.id)) {
        await message.reply('⚠️ **Acesso Negado:** Apenas Juízes de Direito com o cargo adequado podem arquivar processos.').catch(() => null);
        return;
      }

      // Localiza o canal #arquivo-processos (ou similar)
      const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
      const channelsArray = safeGetArray(channels);
      const archiveChannel = channelsArray.find(c => c && c.isTextBased() && (
        matchChannel(c.name, 'arquivo-processos') ||
        matchChannel(c.name, 'processos-arquivados') ||
        matchChannel(c.name, 'arquivo')
      ));

      if (!archiveChannel) {
        await message.reply('⚠️ **Erro:** O canal `#arquivo-processos` não foi encontrado no servidor. Crie o canal para permitir o arquivamento.').catch(() => null);
        return;
      }

      // Assegura que as permissões do canal de arquivo fiquem restritas aos Juízes de Direito
      await ensureArchiveChannelPermissions(guild);

      try {
        const timeStamp = getFormattedDateTime();
        const threadName = message.channel.name;

        // Coleta todas as mensagens da thread (em lotes de 100)
        let allMsgs = [];
        let lastId = null;
        while (true) {
          const fetchOptions = { limit: 100 };
          if (lastId) fetchOptions.before = lastId;
          const batch = await message.channel.messages.fetch(fetchOptions).catch(() => null);
          if (!batch || batch.size === 0) break;
          allMsgs.push(...Array.from(batch.values()));
          lastId = batch.last().id;
          if (batch.size < 100) break;
        }

        // Ordena da mais antiga para a mais recente
        allMsgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        // Header de arquivamento no canal #arquivo-processos (sem pings/menções)
        const archiveHeaderEmbed = new EmbedBuilder()
          .setTitle('📁 PROCESSO JUDICIAL ARQUIVADO')
          .setColor(0x7f8c8d)
          .addFields(
            { name: '📜 Processo / Thread', value: `\`${threadName}\``, inline: true },
            { name: '👨‍⚖️ Arquivado por', value: `\`${message.author.username}\``, inline: true },
            { name: '📅 Data de Arquivamento', value: timeStamp, inline: true }
          )
          .setFooter({ text: 'Arquivo Geral do Poder Judiciário' })
          .setTimestamp();

        await archiveChannel.send({ 
          embeds: [archiveHeaderEmbed],
          allowedMentions: { parse: [] }
        }).catch(() => null);

        // Transcreve e envia cada mensagem do processo para o canal #arquivo-processos (sem notificar/marcar ninguém)
        for (const msg of allMsgs) {
          if (msg.id === message.id) continue; // Ignora o comando !arquivar

          const files = msg.attachments && msg.attachments.size > 0 
            ? Array.from(msg.attachments.values()).map(a => a.url) 
            : [];

          if (msg.embeds && msg.embeds.length > 0) {
            const embedsToSend = msg.embeds.map(e => EmbedBuilder.from(e));
            await archiveChannel.send({
              content: msg.content || null,
              embeds: embedsToSend,
              files: files,
              allowedMentions: { parse: [] }
            }).catch(() => null);
          } else {
            if (!msg.content && files.length === 0) continue;

            let payloadContent = '';
            if (msg.author.id === client.user.id) {
              payloadContent = msg.content;
            } else {
              payloadContent = `💬 **${msg.author.username}**: ${msg.content}`;
            }

            await archiveChannel.send({
              content: payloadContent || null,
              files: files,
              allowedMentions: { parse: [] }
            }).catch(() => null);
          }
        }

        await message.channel.send(`📁 **Processo Arquivado com Sucesso!**\nOs autos foram totalmente transcritos e transferidos para o canal <#${archiveChannel.id}>.\n*Esta thread será permanentemente excluída em 5 segundos.*`).catch(() => null);

        setTimeout(() => {
          message.channel.delete().catch(() => null);
        }, 5000);

      } catch (err) {
        console.error('Erro ao arquivar processo:', err);
        await message.reply('❌ Ocorreu um erro interno ao tentar arquivar o processo.').catch(() => null);
      }
      return;
    }

    // COMANDO !INTIMAR / !INTIMAR-PROCESSO / !INTIMACAO (EXCLUSIVO PARA JUÍZES DE DIREITO)
    const cmdLower = content.toLowerCase();
    if (cmdLower.startsWith('!intimar-processo') || cmdLower.startsWith('!intimar-partes') || cmdLower.startsWith('!intimacao') || cmdLower.startsWith('!intimar')) {
      const member = message.member;
      const isJuiz = member && (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.roles.cache.some(r => r.name === 'J. Dir. | Juiz de Direito' || r.name.toLowerCase().includes('juiz'))
      );

      if (!isJuiz) {
        await message.reply('⚠️ **Acesso Negado:** Apenas Juízes de Direito podem expedir intimações judiciais nos autos do processo.').catch(() => null);
        return;
      }

      const args = content.split(' ');
      const option = (args[1] || 'todos').toLowerCase();

      const parties = await getProcessParties(message.channel);
      if (!parties) {
        await message.reply('⚠️ **Cartório Judicial:** Ficha de autuação do processo não encontrada nesta thread.').catch(() => null);
        return;
      }

      const { processId, type, authorUser, defendantUser, authorLawyers, defendantLawyers } = parties;
      const guild = message.guild;
      const threadName = message.channel.name;

      let sendToAuthor = false;
      let sendToDefendant = false;

      if (['todos', 'partes'].includes(option)) {
        sendToAuthor = true;
        sendToDefendant = true;
      } else if (['autores', 'autor', 'requerentes', 'requerente'].includes(option)) {
        sendToAuthor = true;
      } else if (['requeridos', 'requerido', 'réus', 'reus', 'réu', 'reu', 'executados', 'executado'].includes(option)) {
        sendToDefendant = true;
      } else {
        await message.reply('⚠️ **Cartório Judicial:** Opção de intimação inválida. Use `!intimar todos`, `!intimar autores` ou `!intimar requeridos`.').catch(() => null);
        return;
      }

      const timeStamp = getFormattedDateTime();
      let successCount = 0;
      let targetNames = [];

      const dmContent = (roleName) => {
        return `🏛️ **URGENTE: INTIMAÇÃO JUDICIAL - ATUALIZAÇÃO PROCESSUAL**\n\n` +
               `Prezado(a) (${roleName}), informamos que houve um novo andamento no seu processo.\n\n` +
               `🚨 **IMPORTANTE:** Esta intimação requer **ação ou manifestação urgente do advogado da causa** nos autos do processo.\n\n` +
               `* **Processo nº:** \`${processId}\`\n` +
               `* **Classe Processual:** ${type}\n` +
               `* **Servidor (Discord):** **${guild.name}**\n` +
               `* **Canal/Thread:** <#${message.channel.id}> (#[${threadName}])\n\n` +
               `Por favor, acesse a thread do processo no link acima para visualizar a movimentação e atuar no prazo estabelecido.`;
      };

      // Fila de envio de intimações por DM
      const targets = [];
      if (sendToAuthor) {
        if (authorUser) targets.push({ user: authorUser, roleName: 'Parte Autora' });
        for (const lawyer of authorLawyers) {
          targets.push({ user: lawyer, roleName: 'Advogado da Parte Autora' });
        }
      }
      if (sendToDefendant) {
        if (defendantUser) targets.push({ user: defendantUser, roleName: 'Parte Ré/Executada' });
        for (const lawyer of defendantLawyers) {
          targets.push({ user: lawyer, roleName: 'Advogado da Parte Ré' });
        }
      }

      // Filtra duplicados (caso a parte seja o próprio advogado ou cadastrado múltiplas vezes)
      const uniqueTargets = [];
      const seenIds = new Set();
      for (const t of targets) {
        if (!seenIds.has(t.user.id)) {
          seenIds.add(t.user.id);
          uniqueTargets.push(t);
        }
      }

      for (const target of uniqueTargets) {
        try {
          await target.user.send(dmContent(target.roleName));
          successCount++;
          targetNames.push(`${target.roleName} (<@${target.user.id}>)`);
        } catch (e) {
          console.warn(`Erro ao enviar intimação DM para ${target.user.tag}`);
        }
      }

      if (successCount > 0) {
        const certidao = `=========================================\n` +
                         `📜 **CERTIDÃO DE INTIMAÇÃO - CARTÓRIO JUDICIAL**\n` +
                         `📅 *Movimentação em: ${timeStamp}*\n\n` +
                         `> Certifico que intimei com sucesso via DM privada as seguintes partes e procuradores:\n` +
                         `> * ${targetNames.join('\n> * ')}\n` +
                         `> \n` +
                         `> 🚨 **Atenção:** As partes e advogados intimados devem atuar ou manifestar-se nos autos conforme determinado.\n` +
                         `=========================================`;
        await message.reply(certidao).catch(() => null);
      } else {
        await message.reply('⚠️ **Cartório Judicial:** Nenhuma parte ou advogado pôde ser intimado via DM (Discords não cadastrados ou DMs fechadas).').catch(() => null);
      }
      return;
    }

    // COMANDO !ADV (Adição interativa de advogados por Juízes de Direito)
    if (content.toLowerCase() === '!adv') {
      const member = message.member;
      const isJuiz = member && (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.roles.cache.some(r => r.name === 'J. Dir. | Juiz de Direito' || r.name.toLowerCase().includes('juiz'))
      );

      if (!isJuiz) {
        await message.reply('⚠️ **Acesso Negado:** Apenas Juízes de Direito podem cadastrar ou vincular advogados/procuradores nos autos.').catch(() => null);
        return;
      }

      const messagesToDelete = [message];
      
      try {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('adv_autor').setLabel('Parte Autora (Requerente)').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('adv_reu').setLabel('Parte Ré (Requerida)').setStyle(ButtonStyle.Success)
        );

        const promptMsg = await message.channel.send({
          content: `⚖️ **Cartório Judicial:** Para qual polo deseja adicionar advogados?`,
          components: [row]
        });
        messagesToDelete.push(promptMsg);

        const buttonInteraction = await message.channel.awaitMessageComponent({
          filter: i => i.user.id === message.author.id,
          time: 60000
        }).catch(() => null);

        if (!buttonInteraction) {
          const temp = await message.channel.send('⏳ Tempo limite de resposta excedido para o polo.').catch(() => null);
          if (temp) setTimeout(() => temp.delete().catch(() => null), 5000);
          for (const msg of messagesToDelete) {
            await msg.delete().catch(() => null);
          }
          return;
        }

        await buttonInteraction.deferUpdate().catch(() => null);
        const isAutor = buttonInteraction.customId === 'adv_autor';
        const poloName = isAutor ? 'Parte Autora (Requerente)' : 'Parte Ré (Requerida)';

        const askMsg = await message.channel.send({
          content: `⚖️ **Cartório Judicial:** Mencione todos os advogados a serem adicionados à **${poloName}** (ex: @pessoa1):`
        });
        messagesToDelete.push(askMsg);

        const textCollected = await message.channel.awaitMessages({
          filter: m => m.author.id === message.author.id,
          max: 1,
          time: 120000,
          errors: ['time']
        }).catch(() => null);

        if (!textCollected || textCollected.size === 0) {
          const temp = await message.channel.send('⏳ Tempo limite excedido para menção de advogados.').catch(() => null);
          if (temp) setTimeout(() => temp.delete().catch(() => null), 5000);
          for (const msg of messagesToDelete) {
            await msg.delete().catch(() => null);
          }
          return;
        }

        const responseMsg = textCollected.first();
        messagesToDelete.push(responseMsg);

        const mentions = responseMsg.mentions.users;
        if (mentions.size === 0) {
          const temp = await message.channel.send('⚠️ **Erro:** Você precisa mencionar pelo menos um usuário do Discord.').catch(() => null);
          if (temp) setTimeout(() => temp.delete().catch(() => null), 5000);
          for (const msg of messagesToDelete) {
            await msg.delete().catch(() => null);
          }
          return;
        }

        // Atualização do Embed Inicial (independente do volume de mensagens na thread)
        const botEmbedMsg = await getProcessStarterMessage(message.channel);

        if (botEmbedMsg) {
          const originalEmbed = botEmbedMsg.embeds[0];
          const newEmbed = EmbedBuilder.from(originalEmbed);
          const mentionsList = mentions.map(u => `<@${u.id}>`).join(', ');

          const fieldName = isAutor ? '⚖️ Advogado(s) do Autor' : '⚖️ Advogado(s) do Réu';
          const fields = originalEmbed.fields.filter(f => f.name !== fieldName);
          newEmbed.setFields(fields);
          newEmbed.addFields({ name: fieldName, value: mentionsList, inline: true });

          await botEmbedMsg.edit({ embeds: [newEmbed] });

          // Deleta mensagens temporárias do comando
          for (const msg of messagesToDelete) {
            await msg.delete().catch(() => null);
          }

          // Cria a movimentação de adição de advogados
          const timeStamp = getFormattedDateTime();
          const movMsg = `=========================================\n` +
                         `⚖️ **ATO ORDINATÓRIO - REGISTRO DE PROCURADORES**\n` +
                         `📅 *Movimentação em: ${timeStamp}*\n\n` +
                         `> Registrado(s) o(s) novo(s) advogado(s) para a **${isAutor ? 'Parte Autora' : 'Parte Ré'}**:\n` +
                         `> * ${mentionsList}\n` +
                         `=========================================`;
          await message.channel.send(movMsg).catch(() => null);
        } else {
          const temp = await message.channel.send('⚠️ **Erro:** Não foi possível localizar o embed inicial para atualizar.').catch(() => null);
          if (temp) setTimeout(() => temp.delete().catch(() => null), 5000);
          for (const msg of messagesToDelete) {
            await msg.delete().catch(() => null);
          }
        }

      } catch (err) {
        console.error('Erro no comando !adv:', err);
        const temp = await message.channel.send('❌ Ocorreu um erro interno ao executar o comando !adv.').catch(() => null);
        if (temp) setTimeout(() => temp.delete().catch(() => null), 5000);
        for (const msg of messagesToDelete) {
          await msg.delete().catch(() => null);
        }
      }
      return;
    }


    // COMANDO !PARTES / !PARTE (Adição/Atualização interativa de Partes por Juízes de Direito)
    if (content.toLowerCase() === '!partes' || content.toLowerCase() === '!parte') {
      const member = message.member;
      const isJuiz = member && (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.roles.cache.some(r => r.name === 'J. Dir. | Juiz de Direito' || r.name.toLowerCase().includes('juiz'))
      );

      if (!isJuiz) {
        await message.reply('⚠️ **Acesso Negado:** Apenas Juízes de Direito podem cadastrar ou alterar as partes nos autos do processo.').catch(() => null);
        return;
      }

      const messagesToDelete = [message];
      
      try {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('partes_autor').setLabel('Parte Autora (Requerente)').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('partes_reu').setLabel('Parte Ré (Requerida)').setStyle(ButtonStyle.Success)
        );

        const promptMsg = await message.channel.send({
          content: `⚖️ **Cartório Judicial:** Para qual polo deseja alterar/adicionar a Parte?`,
          components: [row]
        });
        messagesToDelete.push(promptMsg);

        const buttonInteraction = await message.channel.awaitMessageComponent({
          filter: i => i.user.id === message.author.id,
          time: 60000
        }).catch(() => null);

        if (!buttonInteraction) {
          const temp = await message.channel.send('⏳ Tempo limite de resposta excedido para o polo.').catch(() => null);
          if (temp) setTimeout(() => temp.delete().catch(() => null), 5000);
          for (const msg of messagesToDelete) {
            await msg.delete().catch(() => null);
          }
          return;
        }

        await buttonInteraction.deferUpdate().catch(() => null);
        const isAutor = buttonInteraction.customId === 'partes_autor';
        const poloName = isAutor ? 'Parte Autora (Requerente)' : 'Parte Ré (Requerida)';

        const askMsg = await message.channel.send({
          content: `⚖️ **Cartório Judicial:** Mencione a nova parte para o polo de **${poloName}** (ex: @pessoa1):`
        });
        messagesToDelete.push(askMsg);

        const textCollected = await message.channel.awaitMessages({
          filter: m => m.author.id === message.author.id,
          max: 1,
          time: 120000,
          errors: ['time']
        }).catch(() => null);

        if (!textCollected || textCollected.size === 0) {
          const temp = await message.channel.send('⏳ Tempo limite excedido para menção da parte.').catch(() => null);
          if (temp) setTimeout(() => temp.delete().catch(() => null), 5000);
          for (const msg of messagesToDelete) {
            await msg.delete().catch(() => null);
          }
          return;
        }

        const responseMsg = textCollected.first();
        messagesToDelete.push(responseMsg);

        const mentionedUser = responseMsg.mentions.users.first();
        if (!mentionedUser) {
          const temp = await message.channel.send('⚠️ **Erro:** Você precisa mencionar um usuário do Discord (ex: @pessoa1).').catch(() => null);
          if (temp) setTimeout(() => temp.delete().catch(() => null), 5000);
          for (const msg of messagesToDelete) {
            await msg.delete().catch(() => null);
          }
          return;
        }

        // Adiciona a parte à thread
        await message.channel.members.add(mentionedUser.id).catch(() => null);

        // Atualização do Embed Inicial (independente do volume de mensagens na thread)
        const botEmbedMsg = await getProcessStarterMessage(message.channel);

        if (botEmbedMsg) {
          const originalEmbed = botEmbedMsg.embeds[0];
          const newEmbed = EmbedBuilder.from(originalEmbed);
          const mentionText = `<@${mentionedUser.id}>`;

          const fieldName = isAutor ? 'Discord do Autor' : 'Discord do Réu';
          const fields = originalEmbed.fields.map(f => {
            if (f.name.includes(fieldName)) {
              return { name: f.name, value: mentionText, inline: f.inline };
            }
            return f;
          });
          
          newEmbed.setFields(fields);
          await botEmbedMsg.edit({ embeds: [newEmbed] });

          // Deleta mensagens temporárias do comando
          for (const msg of messagesToDelete) {
            await msg.delete().catch(() => null);
          }

          // Cria a movimentação de alteração de partes
          const timeStamp = getFormattedDateTime();
          const movMsg = `=========================================\n` +
                         `⚖️ **ATO ORDINATÓRIO - VINCULAÇÃO DE PARTE**\n` +
                         `📅 *Movimentação em: ${timeStamp}*\n\n` +
                         `> Vinculado(a) o(a) novo(a) participante para a **${isAutor ? 'Parte Autora' : 'Parte Ré'}**:\n` +
                         `> * ${mentionText}\n` +
                         `=========================================`;
          await message.channel.send(movMsg).catch(() => null);
        } else {
          const temp = await message.channel.send('⚠️ **Erro:** Não foi possível localizar o embed inicial para atualizar.').catch(() => null);
          if (temp) setTimeout(() => temp.delete().catch(() => null), 5000);
          for (const msg of messagesToDelete) {
            await msg.delete().catch(() => null);
          }
        }

      } catch (err) {
        console.error('Erro no comando !partes:', err);
        const temp = await message.channel.send('❌ Ocorreu um erro interno ao executar o comando !partes.').catch(() => null);
        if (temp) setTimeout(() => temp.delete().catch(() => null), 5000);
        for (const msg of messagesToDelete) {
          await msg.delete().catch(() => null);
        }
      }
      return;
    }
  }

  // LÓGICA DE INICIALIZAÇÃO DO PETICIONAMENTO (Canal Principal)
  const isTargetChannel = message.channel && message.channel.name && matchChannel(message.channel.name, 'peticionamento-eletrônico');

  if (isTargetChannel) {
    await message.delete().catch(() => null);
  }
});

// Wizard Interativo
async function runPetitionWizard(thread, authorId, modalData) {
  const isCriminal = modalData ? !!modalData.isCriminal : false;

  const data = {
    type: modalData ? modalData.type : '',
    isSecret: false,
    authorName: isCriminal ? 'Ministério Público do Paraná' : (modalData ? modalData.authorName : ''),
    defendantName: modalData ? modalData.defendantName : '',
    discordAuthor: isCriminal ? { id: authorId } : null,
    discordDefendant: null,
    discordAuthorRaw: isCriminal ? `<@${authorId}>` : 'Não informado',
    discordDefendantRaw: 'Não informado',
    petitionText: modalData ? modalData.petitionText : '',
    petitionAttachments: [],
    isCriminal: isCriminal
  };

  const timeout = async () => {
    await thread.send('⏳ Tempo limite de resposta esgotado. O peticionamento foi cancelado.').catch(() => null);
    await thread.delete().catch(() => null); // Deleta a thread de rascunho
  };

  const askQuestion = async (text) => {
    await thread.send(text);
    const filter = m => m.author.id === authorId;
    
    // Aguarda até 3 minutos por resposta
    const collected = await thread.awaitMessages({ filter, max: 1, time: 180000, errors: ['time'] })
      .catch(() => null);
      
    if (!collected || collected.size === 0) return null;
    return collected.first();
  };

  const parseOptionalDiscordUser = (msg) => {
    if (!msg) return { user: null, raw: 'Não informado' };
    const content = msg.content.trim().toLowerCase();
    if (content === 'nenhum' || content === 'não' || content === 'nao' || content === 'n' || content === 'pular') {
      return { user: null, raw: 'Não informado' };
    }
    
    const user = msg.mentions.users.first();
    if (user) {
      return { user, raw: `<@${user.id}>` };
    }
    return { user: null, raw: msg.content.trim() };
  };

  try {
    // 1. Tipo de Processo (Buttons) - Somente se não veio via Modal
    if (!data.type) {
      const typeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('type_comum').setLabel('Procedimento Comum').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('type_execucao').setLabel('Execução').setStyle(ButtonStyle.Success)
      );

      await thread.send({ content: 'Selecione o **Tipo de Processo**:', components: [typeRow] });
      const typeInteraction = await thread.awaitMessageComponent({
        filter: i => i.user.id === authorId,
        time: 60000
      }).catch(() => null);

      if (!typeInteraction) return timeout();
      data.type = typeInteraction.customId === 'type_comum' ? 'Ação de Procedimento Comum' : 'Ação de Execução';
      await typeInteraction.reply({ content: `Tipo selecionado: **${data.type}**` });
    }

    data.isSecret = false;

    // 3. Nome do Autor - Somente se não veio via Modal
    if (!data.authorName) {
      const authMsg = await askQuestion('Digite o **Nome da Parte Autora (Quem processa)**:');
      if (!authMsg) return timeout();
      data.authorName = authMsg.content.trim();
    }

    // 4. Nome do Réu - Somente se não veio via Modal
    if (!data.defendantName) {
      const defMsg = await askQuestion('Digite o **Nome da Parte Ré (Quem é processado)**:');
      if (!defMsg) return timeout();
      data.defendantName = defMsg.content.trim();
    }

    // 5. Discord do Autor (Opcional - se não for criminal)
    if (!data.isCriminal) {
      const discAuthMsg = await askQuestion('Mencione o Discord da **Parte Autora (Quem processa)** (ex: @pessoa1) (ou digite **"nenhum"** para pular):');
      if (!discAuthMsg) return timeout();
      const parsedAuth = parseOptionalDiscordUser(discAuthMsg);
      data.discordAuthor = parsedAuth.user;
      data.discordAuthorRaw = parsedAuth.raw;
    }

    // 6. Discord do Réu (Opcional)
    const discDefMsg = await askQuestion('Mencione o Discord da **Parte Ré (Quem é processado)** (ex: @pessoa1) (ou digite **"nenhum"** para pular):');
    if (!discDefMsg) return timeout();
    const parsedDef = parseOptionalDiscordUser(discDefMsg);
    data.discordDefendant = parsedDef.user;
    data.discordDefendantRaw = parsedDef.raw;

    // 7. Petição Inicial
    if (!modalData) {
      let petitionMsg = null;
      while (!petitionMsg) {
        const tempMsg = await askQuestion('Digite o texto da sua **Petição Inicial**:');
        if (!tempMsg) return timeout();
        
        const hasText = tempMsg.content.trim().length > 0;
        
        if (hasText) {
          petitionMsg = tempMsg;
          data.petitionText = tempMsg.content.trim();
        } else {
          await thread.send('⚠️ Você precisa digitar o texto da sua petição inicial!');
        }
      }
    }
    // Observação: Os anexos e documentos serão juntados diretamente na thread/post do processo após a abertura.
    data.petitionAttachments = [];

    // Geração do Processo
    const processId = `PROC-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const descText = data.isCriminal
      ? `Nova Ação Penal / Processo Criminal instaurado pelo Promotor de Justiça <@${authorId}>.`
      : `Novo processo judicial peticionado eletronicamente pelo advogado <@${authorId}>.`;

    const embedColor = data.isSecret ? 0xd9534f : (data.isCriminal ? 0xc0392b : 0x2f3136);

    // Criar Embed oficial
    const embed = new EmbedBuilder()
      .setTitle(`${data.isSecret ? '🔒 SEGREDO DE JUSTIÇA - ' : '⚖️ '}PROCESSO AUTUADO`)
      .setDescription(descText)
      .setColor(embedColor)
      .addFields(
        { name: '📂 Número do Processo', value: `\`${processId}\``, inline: true },
        { name: '📋 Classe Processual', value: data.type || 'Não informado', inline: true },
        { name: '🔒 Segredo de Justiça', value: data.isSecret ? 'Sim' : 'Não', inline: true },
        { name: '\u200B', value: '\u200B', inline: false },
        { name: '👤 Parte Autora (Quem processa)', value: data.authorName || 'Não informado', inline: true },
        { name: '💬 Discord do Autor', value: data.discordAuthorRaw || 'Não informado', inline: true }
      );

    if (data.isCriminal) {
      embed.addFields(
        { name: '⚖️ Advogado(s) do Autor', value: `<@${authorId}>`, inline: true }
      );
    }

    embed.addFields(
      { name: '\u200B', value: '\u200B', inline: false },
      { name: '👤 Parte Ré (Quem é processado)', value: data.defendantName || 'Não informado', inline: true },
      { name: '💬 Discord do Réu', value: data.discordDefendantRaw || 'Não informado', inline: true },
      { name: '\u200B', value: '\u200B', inline: false },
      { name: '📝 Resumo da Petição Inicial', value: (data.petitionText || 'Não informado').substring(0, 1024) }
    )
    .setTimestamp()
    .setFooter({ text: 'Sistema de Peticionamento Eletrônico Oficial' });

    // Tratar links de arquivos de petição
    if (data.petitionAttachments.length > 0) {
      embed.addFields({ name: '📎 Anexo(s) da Petição', value: data.petitionAttachments.map((url, i) => `[Documento ${i+1}](${url})`).join(', ') });
    }

    // --- PUBLICAÇÃO ---
    const parentChannel = thread.parent;
    const guild = thread.guild;
    let targetThread = null;

    // Garante limites de tamanho no nome da thread (máximo 100 caracteres no Discord)
    let finalThreadName = `${processId} - ${data.authorName} x ${data.defendantName}`;
    if (finalThreadName.length > 100) {
      finalThreadName = finalThreadName.substring(0, 97) + '...';
    }

    let secretThreadName = `🔒 SEGREDO - ${processId}`;
    if (secretThreadName.length > 100) {
      secretThreadName = secretThreadName.substring(0, 100);
    }

    if (data.isSecret) {
      if (parentChannel) {
        targetThread = await parentChannel.threads.create({
          name: secretThreadName,
          autoArchiveDuration: 1440,
          type: ChannelType.PrivateThread,
          reason: `Processo em Segredo de Justiça ${processId}`
        });

        await targetThread.members.add(authorId).catch(() => null);
        if (data.discordAuthor) await targetThread.members.add(data.discordAuthor.id).catch(() => null);
        if (data.discordDefendant) await targetThread.members.add(data.discordDefendant.id).catch(() => null);

        await targetThread.send({ 
          content: '📜 **PROCESSO EM SEGREDO DE JUSTIÇA**\nEsta thread é confidencial e visível apenas para as partes envolvidas e a equipe do Tribunal.',
          embeds: [embed] 
        }).catch(() => null);

        await parentChannel.send(`🔒 **Processo em Segredo de Justiça** autuado como \`${processId}\`! As partes foram adicionadas à thread privada.`).catch(() => null);
      }
    } else {
      // Busca ativa de canais com fetch para evitar falha por falta de cache
      const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
      const peticoesChannel = channels.find(c => c && c.name && matchChannel(c.name, 'petições'));

      if (peticoesChannel) {
        if (peticoesChannel.type === ChannelType.GuildForum) {
          const appliedTags = (peticoesChannel.availableTags && peticoesChannel.availableTags.length > 0)
            ? [peticoesChannel.availableTags[0].id]
            : undefined;

          targetThread = await peticoesChannel.threads.create({
            name: finalThreadName,
            autoArchiveDuration: 60,
            appliedTags: appliedTags,
            message: { embeds: [embed] },
            reason: `Autuação automática ${processId}`
          });
        } else {
          // Se for um canal de texto normal, criamos uma thread pública nele
          targetThread = await peticoesChannel.threads.create({
            name: finalThreadName,
            autoArchiveDuration: 60,
            type: ChannelType.PublicThread,
            reason: `Autuação em canal de texto ${processId}`
          });
          await targetThread.send({ embeds: [embed] }).catch(() => null);
        }
      } else {
        // Fallback final: cria a thread no canal de origem (peticionamento)
        if (parentChannel) {
          targetThread = await parentChannel.threads.create({
            name: finalThreadName,
            autoArchiveDuration: 60,
            type: ChannelType.PublicThread,
            reason: `Autuação de emergência ${processId}`
          });
          await targetThread.send({ 
            content: '⚠️ **Aviso:** Canal `#📜・petições` não encontrado. Processo autuado temporariamente aqui.',
            embeds: [embed] 
          }).catch(() => null);
        }
      }
    }

    // --- MOVIMENTAÇÕES AUTOMÁTICAS E CITAÇÕES ---
    if (targetThread) {
      const timeStamp = getFormattedDateTime();
      
      // Busca ativa de cargos de Magistratura (Juízes de Direito / Magistrados)
      const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
      const rolesArray = safeGetArray(roles);
      
      const juizRoles = rolesArray.filter(r => r && r.name && (
        r.name === 'J. Dir. | Juiz de Direito' ||
        r.name.toLowerCase().includes('juiz') ||
        r.name.toLowerCase().includes('magistrad') ||
        r.name.toLowerCase().includes('desembargad')
      ));

      const promotorRole = rolesArray.find(r => r && r.name && (
        r.name === 'Prom. J | Promotor de Justiça' ||
        r.name.toLowerCase().includes('promotor')
      ));
      const promotorMention = promotorRole ? `<@&${promotorRole.id}>` : '@Prom. J | Promotor de Justiça';

      // Sorteio de Magistrado percorrendo TODOS os Juízes/Magistrados presentes no servidor
      let selectedJuizMention = 'Não designado';
      try {
        const members = await guild.members.fetch({ force: true }).catch(() => null);
        const membersArray = safeGetArray(members);
        
        const juizRoleIds = new Set(juizRoles.map(r => r.id));
        const juizes = membersArray.filter(m => m && !m.user.bot && m.roles && m.roles.cache && m.roles.cache.some(r => juizRoleIds.has(r.id)));
        
        console.log(`[Juízes Sorteio] Magistrados/Juízes encontrados no servidor (${juizes.length}): ${juizes.map(m => m.user.tag).join(', ')}`);
        
        if (juizes && juizes.length > 0) {
          const randomJuiz = juizes[Math.floor(Math.random() * juizes.length)];
          selectedJuizMention = `<@${randomJuiz.id}>`;

          if (randomJuiz.id in juizWorkloadsCache) {
            juizWorkloadsCache[randomJuiz.id]++;
          } else {
            juizWorkloadsCache[randomJuiz.id] = 1;
          }
        } else if (juizRoles.length > 0) {
          selectedJuizMention = `<@&${juizRoles[0].id}>`;
        }
      } catch (fetchErr) {
        console.error('Erro ao buscar membros para sorteio do Juiz:', fetchErr);
        if (juizRoles.length > 0) selectedJuizMention = `<@&${juizRoles[0].id}>`;
      }

      // Movimentação Inicial Unificada
      const unifiedMov = `-----------------------------------------\n` +
                         `**DISTRIBUIÇÃO E CITAÇÃO - CARTÓRIO JUDICIAL**\n` +
                         `*Movimentação em: ${timeStamp}*\n\n` +
                         `> **Sorteio de Magistrado:** Processo distribuído por sorteio ao Excelentíssimo Senhor Juiz de Direito: ${selectedJuizMention}.\n` +
                         `> \n` +
                         `> **Recebimento e Distribuição:** Processo autuado e distribuído. Aguardando manifestação do magistrado designado e do Ministério Público (${promotorMention}).\n` +
                         `> \n` +
                         `> **Instruções:**\n` +
                         `> 1. *Parte Autora:* Anexe nesta thread quaisquer documentos, petições ou provas que julgar necessárias para o prosseguimento.\n` +
                         `> 2. *Contraditório:* A Parte Ré poderá manifestar sua defesa nos autos após o despacho do magistrado.\n\n` +
                         `**Certidão de Citação:** Citação expedida via mensagem privada (DM) para os Discords das partes informadas.\n` +
                         `-----------------------------------------`;

      await targetThread.send(unifiedMov).catch(() => null);

      // Chamada de Comandos Básicos do Processo
      const comandosBasicosMov = `-----------------------------------------\n` +
                                 `**COMANDOS BÁSICOS DO PROCESSO**\n` +
                                 `*Guia de utilização nos autos*\n\n` +
                                 `• **\`!partes\`** - Vincular ou alterar as partes envolvidas (Autor / Réu).\n` +
                                 `• **\`!ia <pergunta>\`** - Consultar a IA Assistente (análise jurídica e resumos).\n` +
                                 `• **\`!autos-sigilosos\`** - Abrir sala privativa reservada para documentos sigilosos.\n\n` +
                                 `**Comandos da Magistratura (Juízes de Direito):**\n` +
                                 `• **\`!oficio\`** - Expedir Ofício Judicial / Ato Ordinatório.\n` +
                                 `• **\`!intimar\`** - Expedir intimação judicial via DM.\n` +
                                 `• **\`!segredo\`** - Decretar Segredo de Justiça no processo.\n` +
                                 `• **\`!arquivar\`** - Encerrar o processo e transferir os autos ao Arquivo Geral.\n` +
                                 `-----------------------------------------`;

      await targetThread.send(comandosBasicosMov).catch(() => null);

      // Envio de Citação e Instruções por DM para os envolvidos
      
      // Citação do Autor
      if (data.discordAuthor) {
        try {
          await data.discordAuthor.send(
            `🏛️ **CITAÇÃO JUDICIAL - PARTE AUTORA**\n\n` +
            `Olá! Você está sendo notificado(a) sobre a autuação do seu processo no Tribunal.\n\n` +
            `* **Número do Processo:** \`${processId}\`\n` +
            `* **Servidor (Discord):** **${guild.name}**\n` +
            `* **Canal/Thread:** <#${targetThread.id}> (#[${targetThread.name}])\n` +
            `* **Classe Processual:** ${data.type}\n` +
            `* **Autor/Exequente:** ${data.authorName}\n` +
            `* **Réu/Executado:** ${data.defendantName}\n\n` +
            `**O que fazer:**\n` +
            `1. Acesse o processo no link acima.\n` +
            `2. Anexe a petição inicial completa, documentos e provas diretamente na thread do processo.`
          );
        } catch (dmErr) {
          console.warn(`Não foi possível enviar DM de citação para o Autor: ${data.discordAuthor.tag}`);
        }
      }

      // Citação do Réu
      if (data.discordDefendant) {
        try {
          await data.discordDefendant.send(
            `🏛️ **CITAÇÃO JUDICIAL - PARTE RÉ (CITADO)**\n\n` +
            `Olá! Você está sendo formalmente citado(a) no processo **${processId}** (${data.type}) autuado no Tribunal.\n\n` +
            `* **Servidor (Discord):** **${guild.name}**\n` +
            `* **Canal/Thread:** <#${targetThread.id}> (#[${targetThread.name}])\n` +
            `* **Classe Processual:** ${data.type}\n` +
            `* **Autor/Exequente:** ${data.authorName}\n` +
            `* **Réu/Executado:** ${data.defendantName}\n\n` +
            `**O que fazer:**\n` +
            `1. Acesse o processo no link acima (se for Segredo de Justiça, você foi adicionado à thread privada).\n` +
            `2. Aguarde a manifestação e o despacho do Juiz de Direito designado para o caso antes de enviar qualquer defesa formal na thread.`
          );
        } catch (dmErr) {
          console.warn(`Não foi possível enviar DM de citação para o Réu: ${data.discordDefendant.tag}`);
        }
      }

      // Atualiza o relatório de carga de trabalho no canal Juízes de forma assíncrona (sem travar o wizard)
      updateJuizesWorkload(guild).catch(err => console.error('Erro ao atualizar workload dos juízes no encerramento:', err));
    }

    // Deleta a thread temporária do wizard
    await thread.delete().catch(() => null);

  } catch (err) {
    console.error('Erro durante o wizard de petição:', err);
    try {
      await thread.send('❌ Ocorreu um erro interno durante o peticionamento. Processo cancelado.').catch(() => null);
      await thread.delete().catch(() => null);
    } catch (e) {}
  }
}

// LISTENER PARA O BOTÃO DE PETICIONAMENTO E EVENTOS DE INTERAÇÃO
client.on('interactionCreate', async (interaction) => {
  // --- MÓDULO DE GESTÃO DE PERMISSÕES (#moderator-only) ---

  // Botão Cancelar Universal da Gestão de Permissões
  if (interaction.isButton() && interaction.customId === 'btn_cancelar_gestao') {
    pendingRoleSelections.delete(interaction.user.id);
    pendingManualRoleInput.delete(interaction.user.id);

    if (interaction.message && interaction.message.deletable && !interaction.message.embeds[0]?.title?.includes('PAINEL INSTITUCIONAL DE GESTÃO')) {
      await interaction.message.delete().catch(() => {});
    }

    await interaction.reply({ content: '❌ **Operação cancelada.**', ephemeral: true }).catch(() => null);
    return;
  }

  // 1. Seleção de Canal/Categoria
  if (interaction.isChannelSelectMenu() && interaction.customId === 'select_canal_gestao') {
    const member = interaction.member;
    const isAuthorized = member && (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      member.roles.cache.some(r => {
        const name = r.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return name.includes('moderad') || name.includes('administrad') || name.includes('juiz') || name.includes('corregedoria') || name.includes('staff');
      })
    );

    if (!isAuthorized) {
      return interaction.reply({
        content: '⚠️ **Acesso Negado:** Apenas Administradores e Moderadores autorizados podem gerenciar permissões de canais.',
        ephemeral: true
      }).catch(() => null);
    }

    const channelId = interaction.values[0];
    const targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);

    if (!targetChannel) {
      return interaction.reply({ content: '❌ Erro: Canal ou categoria não encontrada no servidor.', ephemeral: true }).catch(() => null);
    }

    let overwritesText = '';
    const overwrites = targetChannel.permissionOverwrites.cache;

    if (overwrites.size === 0) {
      overwritesText = '*Nenhuma permissão customizada configurada neste canal (herdando padrões globais do servidor).*';
    } else {
      for (const [id, overwrite] of overwrites) {
        let targetName = id;
        if (id === interaction.guild.roles.everyone.id) {
          targetName = '🌐 @everyone';
        } else {
          const role = interaction.guild.roles.cache.get(id);
          if (role) targetName = `👥 @${role.name}`;
          else {
            const m = await interaction.guild.members.fetch(id).catch(() => null);
            if (m) targetName = `👤 ${m.user.username}`;
          }
        }

        const view = overwrite.allow.has(PermissionFlagsBits.ViewChannel) ? '🟢 Permitido' : (overwrite.deny.has(PermissionFlagsBits.ViewChannel) ? '🔴 Negado' : '⚪ Padrão');
        const send = overwrite.allow.has(PermissionFlagsBits.SendMessages) ? '🟢 Permitido' : (overwrite.deny.has(PermissionFlagsBits.SendMessages) ? '🔴 Negado' : '⚪ Padrão');
        const files = overwrite.allow.has(PermissionFlagsBits.AttachFiles) ? '🟢 Permitido' : (overwrite.deny.has(PermissionFlagsBits.AttachFiles) ? '🔴 Negado' : '⚪ Padrão');
        const manage = (overwrite.allow.has(PermissionFlagsBits.ManageChannels) || overwrite.allow.has(PermissionFlagsBits.ManageMessages)) ? '🟢 Permitido' : ((overwrite.deny.has(PermissionFlagsBits.ManageChannels) || overwrite.deny.has(PermissionFlagsBits.ManageMessages)) ? '🔴 Negado' : '⚪ Padrão');

        overwritesText += `**${targetName}**:\n` +
                          `• 👁️ Ver Canal: ${view}\n` +
                          `• 💬 Enviar Mensagens: ${send}\n` +
                          `• 📎 Anexar Arquivos: ${files}\n` +
                          `• 🛠️ Gerenciar: ${manage}\n\n`;
      }
    }

    const isCategory = targetChannel.type === ChannelType.GuildCategory;
    const typeLabel = isCategory ? '📁 Bloco de Canais (Categoria)' : '📜 Canal de Texto/Mídia';

    const detailEmbed = new EmbedBuilder()
      .setTitle(`🛡️ INSPEÇÃO DE ACESSO: ${targetChannel.name}`)
      .setColor(0x2c3e50)
      .addFields(
        { name: '📂 Tipo do Recurso', value: typeLabel, inline: true },
        { name: '🆔 ID', value: `\`${targetChannel.id}\``, inline: true },
        { name: '📋 Permissões Mapeadas por Cargo', value: overwritesText.substring(0, 1024) }
      )
      .setFooter({ text: 'Selecione um cargo abaixo para rápida edição ou clique em Adicionar Permissões.' })
      .setTimestamp();

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`select_role_gestao_${targetChannel.id}`)
      .setPlaceholder('👥 Edição rápida: Selecione um cargo individual...');

    const rowRole = new ActionRowBuilder().addComponents(roleSelect);

    const btnAddPerm = new ButtonBuilder()
      .setCustomId(`btn_add_perm_${targetChannel.id}`)
      .setLabel('➕ Adicionar Permissões')
      .setStyle(ButtonStyle.Primary);

    const btnCancel = new ButtonBuilder()
      .setCustomId('btn_cancelar_gestao')
      .setLabel('❌ Cancelar')
      .setStyle(ButtonStyle.Secondary);

    const rowButtons = new ActionRowBuilder().addComponents(btnAddPerm, btnCancel);

    await interaction.reply({
      embeds: [detailEmbed],
      components: [rowRole, rowButtons],
      allowedMentions: { parse: [] },
      ephemeral: true
    }).catch(() => null);
    return;
  }

  // 2. Botão ➕ Adicionar Permissões -> Escolhe o Direito / Quesito
  if (interaction.isButton() && interaction.customId.startsWith('btn_add_perm_')) {
    const channelId = interaction.customId.replace('btn_add_perm_', '');
    const targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);

    if (!targetChannel) {
      return interaction.reply({ content: '❌ Canal não encontrado.', ephemeral: true }).catch(() => null);
    }

    const embedRight = new EmbedBuilder()
      .setTitle(`➕ ADICIONAR PERMISSÕES: ${targetChannel.name}`)
      .setDescription(
        `Selecione no menu abaixo **qual o direito / quesito de permissão** você deseja definir neste recurso:\n\n` +
        `• 👁️ **Visualizar Canal** (*ViewChannel & ReadHistory*)\n` +
        `• 💬 **Enviar Mensagens** (*SendMessages & InThreads*)\n` +
        `• 📎 **Anexar Arquivos / Mídia** (*AttachFiles & EmbedLinks*)\n` +
        `• 🛠️ **Gerenciar Canal** (*ManageChannels & Messages*)`
      )
      .setColor(0x2980b9)
      .setTimestamp();

    const selectDireito = new StringSelectMenuBuilder()
      .setCustomId(`select_direito_gestao_${channelId}`)
      .setPlaceholder('🔍 Selecione o direito/quesito de permissão...')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('👁️ Visualizar Canal').setValue('view').setDescription('Permissão para ver o canal e ler histórico de mensagens'),
        new StringSelectMenuOptionBuilder().setLabel('💬 Enviar Mensagens').setValue('send').setDescription('Permissão para digitar e enviar mensagens/respostas'),
        new StringSelectMenuOptionBuilder().setLabel('📎 Anexar Arquivos / Mídia').setValue('files').setDescription('Permissão para enviar anexos, imagens e links'),
        new StringSelectMenuOptionBuilder().setLabel('🛠️ Gerenciar Canal').setValue('manage').setDescription('Permissão para gerenciar e editar o recurso')
      );

    const rowDireito = new ActionRowBuilder().addComponents(selectDireito);
    const btnCancel = new ButtonBuilder().setCustomId('btn_cancelar_gestao').setLabel('❌ Cancelar').setStyle(ButtonStyle.Secondary);
    const rowCancel = new ActionRowBuilder().addComponents(btnCancel);

    await interaction.reply({
      embeds: [embedRight],
      components: [rowDireito, rowCancel],
      allowedMentions: { parse: [] },
      ephemeral: true
    }).catch(() => null);
    return;
  }

  // 3. Seleção do Direito -> Instrução para Digitar/Mencionar Cargos no Chat
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_direito_gestao_')) {
    const channelId = interaction.customId.replace('select_direito_gestao_', '');
    const direito = interaction.values[0];
    const targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);

    if (!targetChannel) {
      return interaction.reply({ content: '❌ Canal não encontrado.', ephemeral: true }).catch(() => null);
    }

    // Registra a sessão para aguardar os cargos digitados no chat
    pendingManualRoleInput.set(interaction.user.id, { channelId, direito });

    const quesitoLabel = direito === 'view' ? 'Visualizar Canal' : (direito === 'send' ? 'Enviar Mensagens' : (direito === 'files' ? 'Anexar Arquivos/Mídia' : 'Gerenciar Canal'));

    const embedPrompt = new EmbedBuilder()
      .setTitle(`📝 MARCAR CARGOS NO CHAT: ${quesitoLabel.toUpperCase()}`)
      .setDescription(
        `Você selecionou o direito **${quesitoLabel}** para o recurso **${targetChannel.name}**.\n\n` +
        `👉 **MENCIONE OU DIGITE OS CARGOS AGORA NO CHAT:**\n` +
        `Envie uma mensagem aqui no chat mencionando os cargos \`(ex: @Juiz de Direito @Delegado)\` ou digitando o nome deles.\n\n` +
        `*(Sua mensagem enviada no chat será apagada automaticamente pelo bot para manter o canal limpo e sem notificações).*`
      )
      .setColor(0xf1c40f)
      .setTimestamp();

    const btnCancel = new ButtonBuilder().setCustomId('btn_cancelar_gestao').setLabel('❌ Cancelar').setStyle(ButtonStyle.Secondary);
    const rowCancel = new ActionRowBuilder().addComponents(btnCancel);

    await interaction.reply({
      embeds: [embedPrompt],
      components: [rowCancel],
      allowedMentions: { parse: [] },
      ephemeral: true
    }).catch(() => null);
    return;
  }

  // 4. Seleção Múltipla de Cargos Concluída -> Mostra Botões Conceder / Restringir / Cancelar
  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('select_roles_multi_')) {
    const parts = interaction.customId.split('_'); // ['select', 'roles', 'multi', channelId, direito]
    const channelId = parts[3];
    const direito = parts[4];
    const roleIds = interaction.values;

    const targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!targetChannel) {
      return interaction.reply({ content: '❌ Canal não encontrado.', ephemeral: true }).catch(() => null);
    }

    // Salva a sessão pendente do usuário
    pendingRoleSelections.set(interaction.user.id, { channelId, direito, roleIds });

    const quesitoLabel = direito === 'view' ? 'Visualizar Canal' : (direito === 'send' ? 'Enviar Mensagens' : (direito === 'files' ? 'Anexar Arquivos/Mídia' : 'Gerenciar Canal'));
    const roleNamesText = roleIds.map(id => {
      const r = interaction.guild.roles.cache.get(id);
      return r ? `\`@${r.name}\`` : `\`${id}\``;
    }).join(', ');

    const embedApply = new EmbedBuilder()
      .setTitle(`⚖️ DEFINIR PERMISSÃO: ${quesitoLabel.toUpperCase()}`)
      .setDescription(
        `Você selecionou **${roleIds.length} cargo(s)** para o recurso **${targetChannel.name}**:\n` +
        `• **Cargos selecionados:** ${roleNamesText}\n` +
        `• **Quesito:** \`${quesitoLabel}\`\n\n` +
        `Escolha a ação a ser aplicada aos cargos selecionados:`
      )
      .setColor(0xe67e22)
      .setTimestamp();

    const btnAllow = new ButtonBuilder().setCustomId('btn_apply_multi_allow').setLabel('🟢 Conceder (Permitir)').setStyle(ButtonStyle.Success);
    const btnDeny = new ButtonBuilder().setCustomId('btn_apply_multi_deny').setLabel('🔴 Restringir (Negar)').setStyle(ButtonStyle.Danger);
    const btnCancel = new ButtonBuilder().setCustomId('btn_cancelar_gestao').setLabel('❌ Cancelar').setStyle(ButtonStyle.Secondary);

    const rowAction = new ActionRowBuilder().addComponents(btnAllow, btnDeny, btnCancel);

    await interaction.reply({
      embeds: [embedApply],
      components: [rowAction],
      allowedMentions: { parse: [] },
      ephemeral: true
    }).catch(() => null);
    return;
  }

  // 5. Botão Aplicar Conceder / Restringir Múltiplos Cargos
  if (interaction.isButton() && (interaction.customId === 'btn_apply_multi_allow' || interaction.customId === 'btn_apply_multi_deny')) {
    const pending = pendingRoleSelections.get(interaction.user.id);
    if (!pending) {
      return interaction.reply({ content: '⚠️ Sessão de alteração expirada. Por favor, refaça a seleção.', ephemeral: true }).catch(() => null);
    }

    const { channelId, direito, roleIds } = pending;
    pendingRoleSelections.delete(interaction.user.id);

    const targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!targetChannel) {
      return interaction.reply({ content: '❌ Canal não encontrado.', ephemeral: true }).catch(() => null);
    }

    const isAllow = interaction.customId === 'btn_apply_multi_allow';
    const patch = {};

    if (direito === 'view') {
      patch.ViewChannel = isAllow;
      patch.ReadMessageHistory = isAllow;
    } else if (direito === 'send') {
      patch.SendMessages = isAllow;
      patch.SendMessagesInThreads = isAllow;
    } else if (direito === 'files') {
      patch.AttachFiles = isAllow;
      patch.EmbedLinks = isAllow;
    } else if (direito === 'manage') {
      patch.ManageChannels = isAllow;
      patch.ManageMessages = isAllow;
    }

    for (const rId of roleIds) {
      await targetChannel.permissionOverwrites.edit(rId, patch).catch(() => null);
    }

    const actionLabel = isAllow ? '🟢 CONCEDIDO (PERMITIDO)' : '🔴 RESTRINGIDO (NEGADO)';
    const quesitoLabel = direito === 'view' ? 'Visualizar Canal' : (direito === 'send' ? 'Enviar Mensagens' : (direito === 'files' ? 'Anexar Arquivos/Mídia' : 'Gerenciar Canal'));
    const roleNamesText = roleIds.map(id => {
      const r = interaction.guild.roles.cache.get(id);
      return r ? `\`@${r.name}\`` : `\`${id}\``;
    }).join(', ');

    if (interaction.message && interaction.message.deletable && !interaction.message.embeds[0]?.title?.includes('PAINEL INSTITUCIONAL DE GESTÃO')) {
      await interaction.message.delete().catch(() => {});
    }

    await interaction.reply({
      content: `✅ **Permissões aplicadas com sucesso!**\n\n` +
               `• **Recurso:** \`${targetChannel.name}\`\n` +
               `• **Quesito/Direito:** \`${quesitoLabel}\` ➡️ **${actionLabel}**\n` +
               `• **Cargos Afetados (${roleIds.length}):** ${roleNamesText}`,
      allowedMentions: { parse: [] },
      ephemeral: true
    }).catch(() => null);
    return;
  }

  // 6. Seleção Individual de Cargo para Edição Rápida
  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('select_role_gestao_')) {
    const channelId = interaction.customId.replace('select_role_gestao_', '');
    const roleId = interaction.values[0];

    const targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const role = interaction.guild.roles.cache.get(roleId);

    if (!targetChannel || !role) {
      return interaction.reply({ content: '❌ Erro: Canal ou Cargo não encontrado.', ephemeral: true }).catch(() => null);
    }

    const overwrite = targetChannel.permissionOverwrites.cache.get(roleId);

    const viewStatus = overwrite && overwrite.allow.has(PermissionFlagsBits.ViewChannel) ? '🟢 Permitido' : (overwrite && overwrite.deny.has(PermissionFlagsBits.ViewChannel) ? '🔴 Negado' : '⚪ Padrão');
    const sendStatus = overwrite && overwrite.allow.has(PermissionFlagsBits.SendMessages) ? '🟢 Permitido' : (overwrite && overwrite.deny.has(PermissionFlagsBits.SendMessages) ? '🔴 Negado' : '⚪ Padrão');
    const filesStatus = overwrite && overwrite.allow.has(PermissionFlagsBits.AttachFiles) ? '🟢 Permitido' : (overwrite && overwrite.deny.has(PermissionFlagsBits.AttachFiles) ? '🔴 Negado' : '⚪ Padrão');

    const roleEmbed = new EmbedBuilder()
      .setTitle(`⚙️ GERENCIAR PERMISSÕES POR QUESITO: @${role.name}`)
      .setDescription(
        `Defina as permissões específicas para o cargo **@${role.name}** no recurso **${targetChannel.name}**:\n\n` +
        `• 👁️ **Visualizar Canal:** ${viewStatus}\n` +
        `• 💬 **Enviar Mensagens:** ${sendStatus}\n` +
        `• 📎 **Anexar Arquivos / Mídia:** ${filesStatus}`
      )
      .setColor(0xf39c12)
      .setTimestamp();

    const rowView = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`btn_perm_allow_view_${channelId}_${roleId}`).setLabel('👁️ Ver: Permitir').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`btn_perm_deny_view_${channelId}_${roleId}`).setLabel('👁️ Ver: Negar').setStyle(ButtonStyle.Danger)
    );

    const rowSend = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`btn_perm_allow_send_${channelId}_${roleId}`).setLabel('💬 Mensagem: Permitir').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`btn_perm_deny_send_${channelId}_${roleId}`).setLabel('💬 Mensagem: Negar').setStyle(ButtonStyle.Danger)
    );

    const rowFiles = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`btn_perm_allow_files_${channelId}_${roleId}`).setLabel('📎 Anexo: Permitir').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`btn_perm_deny_files_${channelId}_${roleId}`).setLabel('📎 Anexo: Negar').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`btn_perm_reset_${channelId}_${roleId}`).setLabel('🔄 Resetar Padrão').setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      embeds: [roleEmbed],
      components: [rowView, rowSend, rowFiles],
      allowedMentions: { parse: [] },
      ephemeral: true
    }).catch(() => null);
    return;
  }

  // 7. Botões de Alteração de Permissões por Quesito Individual
  if (interaction.isButton() && interaction.customId.startsWith('btn_perm_')) {
    const parts = interaction.customId.split('_');
    const action = parts[2];
    const quesito = parts[3];
    const channelId = parts[4];
    const roleId = parts[5];

    const targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const role = interaction.guild.roles.cache.get(roleId);

    if (!targetChannel || !role) {
      return interaction.reply({ content: '❌ Erro ao localizar o canal ou cargo.', ephemeral: true }).catch(() => null);
    }

    try {
      if (action === 'reset') {
        await targetChannel.permissionOverwrites.delete(roleId).catch(() => null);
      } else {
        const isAllow = action === 'allow';
        const patch = {};

        if (quesito === 'view') {
          patch.ViewChannel = isAllow;
          patch.ReadMessageHistory = isAllow;
        } else if (quesito === 'send') {
          patch.SendMessages = isAllow;
          patch.SendMessagesInThreads = isAllow;
        } else if (quesito === 'files') {
          patch.AttachFiles = isAllow;
          patch.EmbedLinks = isAllow;
        }

        await targetChannel.permissionOverwrites.edit(roleId, patch);
      }

      const quesitoLabel = quesito === 'view' ? 'Visualizar Canal' : (quesito === 'send' ? 'Enviar Mensagens' : 'Anexar Arquivos/Mídia');
      const actionLabel = action === 'allow' ? '🟢 PERMITIDO' : (action === 'deny' ? '🔴 NEGADO' : '⚪ PADRÃO (RESET)');

      await interaction.reply({
        content: `✅ **Permissão atualizada com sucesso!**\n\n` +
                 `• **Canal / Bloco:** \`${targetChannel.name}\`\n` +
                 `• **Cargo:** **@${role.name}**\n` +
                 `• **Quesito:** \`${quesitoLabel}\` ➡️ **${actionLabel}**`,
        allowedMentions: { parse: [] },
        ephemeral: true
      }).catch(() => null);
    } catch (err) {
      console.error('Erro ao aplicar alteração de permissão:', err);
      await interaction.reply({ content: '❌ Ocorreu um erro ao modificar as permissões no Discord.', ephemeral: true }).catch(() => null);
    }
    return;
  }
  // Seleção de Canais para o Anúncio (Channel Select Menu)
  if (interaction.isChannelSelectMenu() && interaction.customId === 'select_canais_anuncio') {
    userSelectedChannels.set(interaction.user.id, interaction.values);
    const channelMentions = interaction.values.map(id => `<#${id}>`).join(', ');
    await interaction.reply({
      content: `✅ **Canal(is) selecionado(s):** ${channelMentions}\nAgora clique no botão **📢 Preencher Anúncio Secreto** para digitar a mensagem!`,
      ephemeral: true
    });
    return;
  }

  // Botão Anúncio de Repercussão Geral
  if (interaction.isButton() && interaction.customId === 'btn_anunciar_repercussao') {
    const member = interaction.member;
    const isCorregedoriaOrJuiz = member && member.roles.cache.some(r => {
      const name = r.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return name.includes('corregedoria') || name.includes('juiz');
    });

    if (!isCorregedoriaOrJuiz) {
      return interaction.reply({
        content: '⚠️ **Acesso Negado:** Apenas membros da Corregedoria-Geral e Magistrados podem expedir anúncios de Repercussão Geral.',
        ephemeral: true
      }).catch(() => null);
    }

    const modal = new ModalBuilder()
      .setCustomId('modal_anuncio_repercussao')
      .setTitle('Anúncio de Repercussão Geral');

    const inputConteudo = new TextInputBuilder()
      .setCustomId('input_conteudo_repercussao')
      .setLabel('Conteúdo do Aviso')
      .setPlaceholder('Digite o texto do aviso para todas as corporações...')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(inputConteudo));
    await interaction.showModal(modal);
    return;
  }

  // Submissão Anúncio de Repercussão Geral
  if (interaction.isModalSubmit() && interaction.customId === 'modal_anuncio_repercussao') {
    const conteudo = interaction.fields.getTextInputValue('input_conteudo_repercussao');
    pendingRepercussaoAnnouncements.set(interaction.user.id, {
      conteudo,
      channelId: interaction.channel.id,
      guildId: interaction.guild.id
    });

    const btnSemAnexo = new ButtonBuilder()
      .setCustomId('btn_publicar_repercussao_sem_anexo')
      .setLabel('📢 Publicar sem Anexos')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(btnSemAnexo);
    await interaction.reply({
      content: '📝 **Conteúdo do aviso registrado!**\n\n' +
               '📎 **Deseja anexar imagens ou documentos (arquivos, prints, PDFs)?**\n' +
               '• **Para anexar:** Envie a mensagem com os arquivos/prints aqui no chat agora.\n' +
               '• **Para prosseguir sem anexos:** Digite `nenhum` no chat ou clique no botão **📢 Publicar sem Anexos** abaixo.\n\n' +
               '*(Sua mensagem enviada com os anexos no chat será apagada automaticamente para manter o canal limpo).*',
      components: [row],
      ephemeral: true
    });
    return;
  }

  // Botão Publicar Sem Anexos
  if (interaction.isButton() && interaction.customId === 'btn_publicar_repercussao_sem_anexo') {
    const pending = pendingRepercussaoAnnouncements.get(interaction.user.id);
    if (pending) {
      pendingRepercussaoAnnouncements.delete(interaction.user.id);
      await publishRepercussaoAnnouncement(interaction.guild, interaction.channel, pending.conteudo);
    }
    await interaction.reply({
      content: '✅ **Anúncio de Repercussão Geral publicado com sucesso sem anexos!**',
      ephemeral: true
    });
    if (interaction.message && interaction.message.deletable) {
      await interaction.message.delete().catch(() => {});
    }
    return;
  }

  // Botão Anúncio Oficial (Corregedoria)
  if (interaction.isButton() && interaction.customId === 'btn_abrir_modal_anuncio') {
    const member = interaction.member;
    const isCorregedoriaOrJuiz = member && member.roles.cache.some(r => {
      const name = r.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return name.includes('corregedoria') || name.includes('juiz');
    });

    if (!isCorregedoriaOrJuiz) {
      return interaction.reply({
        content: '⚠️ **Acesso Negado:** Apenas membros da Corregedoria-Geral e Magistrados podem expedir anúncios oficiais.',
        ephemeral: true
      }).catch(() => null);
    }

    const modal = new ModalBuilder()
      .setCustomId('modal_anuncio')
      .setTitle('Publicar Anúncio Oficial');

    const inputConteudo = new TextInputBuilder()
      .setCustomId('input_conteudo_anuncio')
      .setLabel('Conteúdo do Anúncio')
      .setPlaceholder('Digite o texto completo do anúncio...')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const inputMarcar = new TextInputBuilder()
      .setCustomId('input_marcar_corp')
      .setLabel('Mencionar @「CORP」Membro De Corporação?')
      .setPlaceholder('Digite SIM para marcar ou NAO para não marcar')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(10);

    modal.addComponents(
      new ActionRowBuilder().addComponents(inputConteudo),
      new ActionRowBuilder().addComponents(inputMarcar)
    );

    await interaction.showModal(modal);
    return;
  }

  // Submissão Anúncio Secreto
  if (interaction.isModalSubmit() && interaction.customId === 'modal_anuncio') {
    const conteudoAnuncio = interaction.fields.getTextInputValue('input_conteudo_anuncio');
    const respostaMarcar = interaction.fields.getTextInputValue('input_marcar_corp').trim().toLowerCase();
    const deveMarcar = respostaMarcar.startsWith('s') || respostaMarcar === 'sim';

    await interaction.deferReply({ ephemeral: true });

    if (interaction.message && interaction.message.deletable) {
      await interaction.message.delete().catch(() => {});
    }

    const selectedIds = userSelectedChannels.get(interaction.user.id) || [];
    let targetChannels = [];

    if (selectedIds.length > 0) {
      for (const id of selectedIds) {
        const ch = interaction.guild.channels.cache.get(id) || await interaction.guild.channels.fetch(id).catch(() => null);
        if (ch && ch.isTextBased()) targetChannels.push(ch);
      }
    }

    if (targetChannels.length === 0) {
      const defaultCh = interaction.guild.channels.cache.find(
        c => c.name.toLowerCase() === '「📢」・avisos' || c.name.toLowerCase().includes('avisos')
      );
      if (defaultCh) targetChannels.push(defaultCh);
    }

    if (targetChannels.length === 0) {
      return interaction.editReply({
        content: '❌ **Erro:** Nenhum canal de destino válido foi localizado no servidor.',
        ephemeral: true
      });
    }

    let mentionText = '';
    if (deveMarcar) {
      const roleCorp = interaction.guild.roles.cache.find(
        r => r.name.trim().toLowerCase() === ROLE_CORP_NOME.trim().toLowerCase() ||
             r.name.includes('Membro De Corporação') ||
             r.name.includes('CORP')
      );
      if (roleCorp) {
        mentionText = `<@&${roleCorp.id}>`;
      }
    }

    const avisoEmbed = new EmbedBuilder()
      .setTitle('📢 ANÚNCIO OFICIAL - CORREGEDORIA GERAL')
      .setDescription(conteudoAnuncio)
      .setColor('#e74c3c')
      .setFooter({ text: 'Corregedoria-Geral • Comunicado Oficial' })
      .setTimestamp();

    const publishedChannelNames = [];
    for (const ch of targetChannels) {
      try {
        await ch.send({
          content: mentionText ? mentionText : null,
          embeds: [avisoEmbed]
        });
        publishedChannelNames.push(`<#${ch.id}>`);
      } catch (e) {
        console.error(`Erro ao publicar anúncio em ${ch.name}:`, e);
      }
    }

    userSelectedChannels.delete(interaction.user.id);
    await interaction.editReply({
      content: `✅ **Anúncio publicado com sucesso sem qualquer rastro no(s) canal(is):** ${publishedChannelNames.join(', ')}`
    });
    return;
  }

  // Botão Denúncia
  if (interaction.isButton() && interaction.customId === 'btn_iniciar_denuncia') {
    const modal = new ModalBuilder()
      .setCustomId('modal_denuncia')
      .setTitle('Formulário de Denúncia');

    const inputAcusado = new TextInputBuilder()
      .setCustomId('input_acusado')
      .setLabel('Nome / Nick do Denunciado')
      .setPlaceholder('Ex: Fulano#1234 ou Nick do membro')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const inputMotivo = new TextInputBuilder()
      .setCustomId('input_motivo')
      .setLabel('Motivo / Descrição da Denúncia')
      .setPlaceholder('Descreva os fatos detalhadamente...')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(inputAcusado),
      new ActionRowBuilder().addComponents(inputMotivo)
    );

    await interaction.showModal(modal);
    return;
  }

  // Submissão Denúncia
  if (interaction.isModalSubmit() && interaction.customId === 'modal_denuncia') {
    const acusado = interaction.fields.getTextInputValue('input_acusado');
    const motivo = interaction.fields.getTextInputValue('input_motivo');

    await interaction.deferReply({ ephemeral: true });

    const originChannel = interaction.channel;

    const denunciaThread = await originChannel.threads.create({
      name: `denuncia-${acusado}`.substring(0, 50),
      type: ChannelType.PrivateThread,
      reason: `Denúncia aberta por ${interaction.user.tag}`
    });

    await denunciaThread.members.add(interaction.user.id).catch(() => {});

    const membersCorregedoria = await originChannel.guild.members.fetch().catch(() => originChannel.guild.members.cache);
    const authorizedCorregedores = safeGetArray(membersCorregedoria).filter(m => isAuthorizedForMandado(m));
    for (const m of authorizedCorregedores) {
      await denunciaThread.members.add(m.id).catch(() => {});
    }

    const rolePromotor = originChannel.guild.roles.cache.find(r => r.name.trim().toLowerCase() === ROLE_PROMOTOR_NOME.trim().toLowerCase());
    if (rolePromotor) {
      const promotores = safeGetArray(membersCorregedoria).filter(m => m && m.roles && m.roles.cache && m.roles.cache.has(rolePromotor.id));
      for (const m of promotores) {
        await denunciaThread.members.add(m.id).catch(() => {});
      }
    }

    const panelEmbed = new EmbedBuilder()
      .setTitle('⚖️ PROCESSO DE DENÚNCIA / PAD')
      .setDescription(
        `**Denunciante:** <@${interaction.user.id}>\n` +
        `**Denunciado:** ${acusado}\n\n` +
        `**Descrição dos Fatos:**\n${motivo}`
      )
      .setColor('#e74c3c')
      .setFooter({ text: 'Corregedoria Geral • Atendimento Confidencial' })
      .setTimestamp();

    const mentionText = rolePromotor ? `<@&${rolePromotor.id}>` : '';
    await denunciaThread.send({ content: mentionText ? mentionText : null, embeds: [panelEmbed] });

    await interaction.editReply({
      content: `✅ **Sua denúncia foi registrada com sucesso!**\nAcesse a sala privativa criada: <#${denunciaThread.id}>`
    });
    return;
  }

  // Botão Mandado de Prisão (PF / Corregedoria)
  if (interaction.isButton() && interaction.customId === 'btn_solicitar_mandado') {
    const member = interaction.member;
    const hasPermission = member && member.roles.cache.some(r => {
      const name = r.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return name.includes('juiz') || name.includes('delegad') || name.includes('polici') || name.includes('autoridade') || name.includes('escrivao') || name.includes('diretor') || name.includes('corregedoria') || name.includes('membro de corporacao');
    });

    if (!hasPermission) {
      return interaction.reply({
        content: '⚠️ **Acesso Negado:** Apenas Autoridades Policiais, Delegados, Escrivães e Membros de Corporação podem solicitar mandados.',
        ephemeral: true
      }).catch(() => null);
    }

    const modal = new ModalBuilder()
      .setCustomId('modal_solicitar_mandado')
      .setTitle('Solicitação de Mandado de Prisão');

    const inputAcusado = new TextInputBuilder()
      .setCustomId('input_acusado_mandado')
      .setLabel('Nome / Nick do Acusado')
      .setPlaceholder('Ex: Fulano de Tal')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const inputMotivo = new TextInputBuilder()
      .setCustomId('input_motivo_mandado')
      .setLabel('Motivo do Pedido de Prisão')
      .setPlaceholder('Descreva os crimes / motivos legalmente fundamentados...')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(inputAcusado),
      new ActionRowBuilder().addComponents(inputMotivo)
    );

    await interaction.showModal(modal);
    return;
  }

  // Submissão Mandado de Prisão (Triangulação 3-Way)
  if (interaction.isModalSubmit() && interaction.customId === 'modal_solicitar_mandado') {
    const acusado = interaction.fields.getTextInputValue('input_acusado_mandado');
    const motivo = interaction.fields.getTextInputValue('input_motivo_mandado');

    await interaction.deferReply({ ephemeral: true });

    const originChannel = interaction.channel;

    const createThreadSafe = async (targetChan, threadName, embedPayload, reasonText) => {
      if (!targetChan) return null;
      try {
        if (targetChan.type === ChannelType.GuildForum) {
          const appliedTags = (targetChan.availableTags && targetChan.availableTags.length > 0) ? [targetChan.availableTags[0].id] : undefined;
          const forumPost = await targetChan.threads.create({
            name: threadName,
            appliedTags: appliedTags,
            message: { embeds: [embedPayload] },
            reason: reasonText
          });
          return forumPost;
        }
        try {
          const tPriv = await targetChan.threads.create({
            name: threadName,
            type: ChannelType.PrivateThread,
            reason: reasonText
          });
          if (embedPayload) await tPriv.send({ embeds: [embedPayload] }).catch(() => {});
          return tPriv;
        } catch (errPriv) {
          const tPub = await targetChan.threads.create({
            name: threadName,
            reason: reasonText
          });
          if (embedPayload) await tPub.send({ embeds: [embedPayload] }).catch(() => {});
          return tPub;
        }
      } catch (errFinal) {
        console.error(`❌ Erro ao criar thread em ${targetChan.name}:`, errFinal);
        return null;
      }
    };

    let channelGov = null;
    let targetGuildGov = null;
    let channelCorregedoria = null;
    let channelPF = null;

    for (const [guildId, g] of client.guilds.cache) {
      try {
        const channels = await g.channels.fetch().catch(() => g.channels.cache);
        const gName = g.name.toLowerCase();

        for (const c of safeGetArray(channels)) {
          if (!c || !c.name || c.id === originChannel.id) continue;
          const cName = c.name.toLowerCase();

          if (cName.includes('bnmp')) {
            channelGov = c;
            targetGuildGov = g;
            continue;
          }

          if (cName.includes('solicitar-mandado') || cName.includes('mandados') || (cName.includes('mandado') && (gName.includes('pf') || gName.includes('policia') || gName.includes('polícia')))) {
            if (g.id !== originChannel.guild.id || cName.includes('solicitar')) {
              channelPF = c;
            }
          }

          if (cName === 'pedido-de-mandado' || cName.endsWith('pedido-de-mandado') || (cName.includes('mandado') && (gName.includes('corregedoria') || gName.includes('crrgd')))) {
            if (g.id !== originChannel.guild.id || cName === 'pedido-de-mandado') {
              channelCorregedoria = c;
            }
          }
        }
      } catch (err) {}
    }

    const createdThreads = [];

    const originThread = await createThreadSafe(originChannel, `mandado-${acusado}`.substring(0, 50), null, `Solicitação de mandado de prisão para ${acusado}`);
    if (originThread) {
      await originThread.members.add(interaction.user.id).catch(() => {});
      try {
        const membersOrigin = await originChannel.guild.members.fetch().catch(() => originChannel.guild.members.cache);
        const authorizedOrigin = safeGetArray(membersOrigin).filter(m => isAuthorizedForMandado(m));
        for (const m of authorizedOrigin) {
          await originThread.members.add(m.id).catch(() => {});
        }
      } catch (e) {}
      createdThreads.push(originThread);
    }

    const panelEmbed = new EmbedBuilder()
      .setTitle('⚖️ SOLICITAÇÃO DE MANDADO DE PRISÃO')
      .setDescription(
        `**Solicitante:** <@${interaction.user.id}>\n` +
        `**Acusado/Alvo:** ${acusado}\n\n` +
        `**Fundamentação / Motivo:**\n${motivo}\n\n` +
        `🌐 **Integração Ativa:** Esta requisição está sincronizada entre Corregedoria, Polícia Federal e Governo Federal (Magistratura).`
      )
      .setColor('#9b59b6')
      .setFooter({ text: 'Sistema Integrado de Segurança e Justiça • Mandados' })
      .setTimestamp();

    if (originThread) {
      const panelMsg = await originThread.send({ embeds: [panelEmbed] });
      await panelMsg.pin().catch(() => {});
    }

    if (channelPF) {
      const pfThread = await createThreadSafe(channelPF, `mandado-${acusado}`.substring(0, 50), panelEmbed, `Espelhamento para a Polícia Federal`);
      if (pfThread) {
        try {
          const membersPF = await channelPF.guild.members.fetch().catch(() => channelPF.guild.members.cache);
          const authorizedPF = safeGetArray(membersPF).filter(m => isAuthorizedForMandado(m));
          for (const m of authorizedPF) {
            await pfThread.members.add(m.id).catch(() => {});
          }
        } catch (e) {}
        createdThreads.push(pfThread);
      }
    }

    if (channelCorregedoria) {
      const crgdThread = await createThreadSafe(channelCorregedoria, `mandado-${acusado}`.substring(0, 50), panelEmbed, `Espelhamento para a Corregedoria`);
      if (crgdThread) {
        try {
          const membersCorregedoria = await channelCorregedoria.guild.members.fetch().catch(() => channelCorregedoria.guild.members.cache);
          const authorizedCorregedores = safeGetArray(membersCorregedoria).filter(m => isAuthorizedForMandado(m));
          for (const m of authorizedCorregedores) {
            await crgdThread.members.add(m.id).catch(() => {});
          }
        } catch (e) {}
        createdThreads.push(crgdThread);
      }
    }

    if (channelGov) {
      try {
        const govThread = await createThreadSafe(channelGov, `mandado-${acusado}`.substring(0, 50), panelEmbed, `Espelhamento para o Governo Federal`);
        if (govThread) {
          try {
            const membersGov = await channelGov.guild.members.fetch().catch(() => channelGov.guild.members.cache);
            const rolesGov = await channelGov.guild.roles.fetch().catch(() => channelGov.guild.roles.cache);
            const juizRole = safeGetArray(rolesGov).find(r => r.name === 'J. Dir. | Juiz de Direito' || r.name.toLowerCase().includes('juiz') || r.name.toLowerCase().includes('magistratura'));
            
            if (juizRole) {
              const juizes = safeGetArray(membersGov).filter(m => m && m.roles && m.roles.cache && m.roles.cache.has(juizRole.id));
              for (const j of juizes) {
                await govThread.members.add(j.id).catch(() => {});
              }
              await govThread.send({ content: `<@&${juizRole.id}> ⚖️ **Aviso Oficial:** Nova solicitação de mandado de prisão autuada para análise da Magistratura.` }).catch(() => {});
            }
          } catch (e) {
            console.error('Erro ao adicionar juízes no Governo:', e);
          }
          createdThreads.push(govThread);
        }
      } catch (e) {}
    }

    const threadIds = createdThreads.map(t => t.id);
    for (const tId of threadIds) {
      threadBridges.set(tId, threadIds);
    }

    await interaction.editReply({
      content: `✅ **Solicitação de mandado registrada com sucesso!**\nAcesse a sala privativa: <#${originThread ? originThread.id : originChannel.id}>`
    });
    return;
  }

  // Botão Mandado Interno (Comunicação Interna)
  if (interaction.isButton() && interaction.customId === 'btn_solicitar_mandado_interno') {
    const member = interaction.member;
    const hasPermission = member && member.roles.cache.some(r => {
      const name = r.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return name.includes('juiz') || name.includes('delegad') || name.includes('polici') || name.includes('autoridade') || name.includes('escrivao') || name.includes('diretor');
    });

    if (!hasPermission) {
      return interaction.reply({
        content: '⚠️ **Acesso Negado:** Apenas Autoridades Policiais, Delegados, Escrivães e Juízes de Direito podem utilizar este painel de comunicação.',
        ephemeral: true
      }).catch(() => null);
    }

    const modal = new ModalBuilder()
      .setCustomId('modal_solicitar_mandado_interno')
      .setTitle('Mandado via Comunicação Interna');

    const inputAcusado = new TextInputBuilder()
      .setCustomId('input_acusado_mandado_interno')
      .setLabel('Nome / Nick do Acusado')
      .setPlaceholder('Ex: Fulano de Tal')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const inputMotivo = new TextInputBuilder()
      .setCustomId('input_motivo_mandado_interno')
      .setLabel('Motivo do Pedido de Prisão')
      .setPlaceholder('Descreva os fatos e fundamentação legal...')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(inputAcusado),
      new ActionRowBuilder().addComponents(inputMotivo)
    );

    await interaction.showModal(modal);
    return;
  }

  // Submissão Mandado Interno (Comunicação Interna - Triangulado)
  if (interaction.isModalSubmit() && interaction.customId === 'modal_solicitar_mandado_interno') {
    const acusado = interaction.fields.getTextInputValue('input_acusado_mandado_interno');
    const motivo = interaction.fields.getTextInputValue('input_motivo_mandado_interno');

    await interaction.deferReply({ ephemeral: true });

    const originChannel = interaction.channel;

    const createThreadSafe = async (targetChan, threadName, embedPayload, reasonText) => {
      if (!targetChan) return null;
      try {
        if (targetChan.type === ChannelType.GuildForum) {
          const appliedTags = (targetChan.availableTags && targetChan.availableTags.length > 0) ? [targetChan.availableTags[0].id] : undefined;
          const forumPost = await targetChan.threads.create({
            name: threadName,
            appliedTags: appliedTags,
            message: { embeds: [embedPayload] },
            reason: reasonText
          });
          return forumPost;
        }
        try {
          const tPriv = await targetChan.threads.create({
            name: threadName,
            type: ChannelType.PrivateThread,
            reason: reasonText
          });
          if (embedPayload) await tPriv.send({ embeds: [embedPayload] }).catch(() => {});
          return tPriv;
        } catch (errPriv) {
          const tPub = await targetChan.threads.create({
            name: threadName,
            reason: reasonText
          });
          if (embedPayload) await tPub.send({ embeds: [embedPayload] }).catch(() => {});
          return tPub;
        }
      } catch (errFinal) {
        console.error(`❌ Erro ao criar thread em ${targetChan.name}:`, errFinal);
        return null;
      }
    };

    let channelGov = originChannel;
    let channelCorregedoria = null;
    let channelPF = null;

    for (const [guildId, g] of client.guilds.cache) {
      try {
        const channels = await g.channels.fetch().catch(() => g.channels.cache);
        const gName = g.name.toLowerCase();

        for (const c of safeGetArray(channels)) {
          if (!c || !c.name || c.id === originChannel.id) continue;
          const cName = c.name.toLowerCase();

          if (cName.includes('solicitar-mandado') || cName.includes('mandados') || (cName.includes('mandado') && (gName.includes('pf') || gName.includes('policia') || gName.includes('polícia')))) {
            if (g.id !== originChannel.guild.id || cName.includes('solicitar')) {
              channelPF = c;
            }
          }

          if (cName === 'pedido-de-mandado' || cName.endsWith('pedido-de-mandado') || (cName.includes('mandado') && (gName.includes('corregedoria') || gName.includes('crrgd')))) {
            if (g.id !== originChannel.guild.id || cName === 'pedido-de-mandado') {
              channelCorregedoria = c;
            }
          }
        }
      } catch (err) {}
    }

    const createdThreads = [];

    // Thread no Governo (Comunicação Interna) - Adiciona e Marca APENAS o usuário solicitante (SEM marcar todos os juízes!)
    const govThread = await createThreadSafe(channelGov, `mandado-${acusado}`.substring(0, 50), null, `Solicitação de mandado via comunicação interna por ${interaction.user.tag}`);
    if (govThread) {
      await govThread.members.add(interaction.user.id).catch(() => {});
      createdThreads.push(govThread);
    }

    const panelEmbed = new EmbedBuilder()
      .setTitle('⚖️ SOLICITAÇÃO DE MANDADO DE PRISÃO (COMUNICAÇÃO INTERNA)')
      .setDescription(
        `**Solicitante:** <@${interaction.user.id}>\n` +
        `**Acusado/Alvo:** ${acusado}\n\n` +
        `**Fundamentação / Motivo:**\n${motivo}\n\n` +
        `🌐 **Integração Ativa:** Esta requisição está sincronizada entre a Comunicação Interna do Governo, Polícia Federal e Corregedoria.`
      )
      .setColor('#3498db')
      .setFooter({ text: 'Sistema Integrado de Segurança e Justiça • Mandados Internos' })
      .setTimestamp();

    if (govThread) {
      const panelMsg = await govThread.send({
        content: `👤 <@${interaction.user.id}> - Sua solicitação de mandado via comunicação interna foi aberta.`,
        embeds: [panelEmbed]
      });
      await panelMsg.pin().catch(() => {});
    }

    // Thread na Polícia Federal (Local de sempre)
    if (channelPF) {
      const pfThread = await createThreadSafe(channelPF, `mandado-${acusado}`.substring(0, 50), panelEmbed, `Espelhamento para a Polícia Federal`);
      if (pfThread) {
        try {
          const membersPF = await channelPF.guild.members.fetch().catch(() => channelPF.guild.members.cache);
          const authorizedPF = safeGetArray(membersPF).filter(m => isAuthorizedForMandado(m));
          for (const m of authorizedPF) {
            await pfThread.members.add(m.id).catch(() => {});
          }
        } catch (e) {}
        createdThreads.push(pfThread);
      }
    }

    // Thread na Corregedoria (Local de sempre)
    if (channelCorregedoria) {
      const crgdThread = await createThreadSafe(channelCorregedoria, `mandado-${acusado}`.substring(0, 50), panelEmbed, `Espelhamento para a Corregedoria`);
      if (crgdThread) {
        try {
          const membersCorregedoria = await channelCorregedoria.guild.members.fetch().catch(() => channelCorregedoria.guild.members.cache);
          const authorizedCorregedores = safeGetArray(membersCorregedoria).filter(m => isAuthorizedForMandado(m));
          for (const m of authorizedCorregedores) {
            await crgdThread.members.add(m.id).catch(() => {});
          }
        } catch (e) {}
        createdThreads.push(crgdThread);
      }
    }

    const threadIds = createdThreads.map(t => t.id);
    for (const tId of threadIds) {
      threadBridges.set(tId, threadIds);
    }

    await interaction.editReply({
      content: `✅ **Solicitação de mandado interno registrada com sucesso!**\nAcesse a sala privativa criada aqui: <#${govThread ? govThread.id : originChannel.id}>`
    });
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'modal_oficio') {
      try {
        await interaction.deferReply().catch(() => null);
        const content = interaction.fields.getTextInputValue('oficio_content').trim();
        const timeStamp = getFormattedDateTime();

        const formattedContent = content.split('\n').map(line => `> ${line}`).join('\n');
        
        const fullHeader = `-----------------------------------------\n` +
                           `**OFÍCIO / ATO ORDINATÓRIO**\n` +
                           `*Movimentação em: ${timeStamp}*\n\n` +
                           `> **Determinação Judicial (Juiz <@${interaction.user.id}>):**\n`;
        const fullFooter = `\n-----------------------------------------`;

        const fullMsg = `${fullHeader}${formattedContent}${fullFooter}`;

        if (fullMsg.length <= 1900) {
          await interaction.editReply({ content: fullMsg }).catch(() => null);
        } else {
          // Divisão preservando palavras completas e parágrafos sem cortar palavras no meio
          const chunks = splitTextPreservingWords(formattedContent, 1600);
          for (let i = 0; i < chunks.length; i++) {
            const chunkHeader = i === 0 
              ? `${fullHeader}` 
              : `*OFÍCIO (Parte ${i + 1}/${chunks.length}):*\n`;
            
            const chunkFooter = i === chunks.length - 1 ? `${fullFooter}` : '';
            const chunkContent = `${chunkHeader}${chunks[i]}${chunkFooter}`;

            if (i === 0) {
              await interaction.editReply({ content: chunkContent }).catch(() => null);
            } else {
              await interaction.channel.send({ content: chunkContent }).catch(() => null);
            }
          }
        }

        // Pergunta sobre a DM de forma efêmera no chat da thread
        await interaction.followUp({
          content: '⚖️ **Ofício Judicial:** Deseja notificar alguém por DM privada? Mencione os usuários (ex: @pessoa1, @pessoa2) ou digite **"nenhum"** para concluir:',
          ephemeral: true
        }).catch(() => null);

        const filter = m => m.author.id === interaction.user.id;
        const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] }).catch(() => null);

        if (collected && collected.size > 0) {
          const userMsg = collected.first();
          const contentMsg = userMsg.content.trim().toLowerCase();

          if (contentMsg !== 'nenhum' && contentMsg !== 'nao' && contentMsg !== 'não' && contentMsg !== 'pular') {
            const userIds = [...userMsg.content.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
            if (userIds.length > 0) {
              const baseDmHeader = `🏛️ **NOTIFICAÇÃO DE OFÍCIO JUDICIAL**\n\n` +
                                   `Prezado(a), você está sendo notificado(a) sobre a expedição de um Ofício/Ato Judicial.\n\n` +
                                   `* **Origem:** Processo na thread <#${interaction.channel.id}>\n` +
                                   `* **Expedido por:** Juiz <@${interaction.user.id}>\n\n` +
                                   `**Teor do Ofício:**\n`;

              for (const userId of userIds) {
                try {
                  const targetUser = await client.users.fetch(userId).catch(() => null);
                  if (targetUser) {
                    if ((baseDmHeader + formattedContent).length <= 1900) {
                      await targetUser.send(`${baseDmHeader}${formattedContent}`).catch(() => null);
                    } else {
                      const dmChunks = splitTextPreservingWords(formattedContent, 1600);
                      for (let i = 0; i < dmChunks.length; i++) {
                        if (i === 0) {
                          await targetUser.send(`${baseDmHeader}${dmChunks[i]}`).catch(() => null);
                        } else {
                          await targetUser.send(`*(Ofício Parte ${i + 1}/${dmChunks.length}):*\n${dmChunks[i]}`).catch(() => null);
                        }
                      }
                    }
                  }
                } catch (dmErr) {
                  console.warn(`[Ofício DM] Falha ao notificar usuário ${userId}:`, dmErr);
                }
              }
            }
          }
          await userMsg.delete().catch(() => null);
        }
      } catch (err) {
        console.error('Erro ao processar modal de ofício:', err);
        await interaction.reply({ content: '❌ Ocorreu um erro interno ao processar o ofício.', ephemeral: true }).catch(() => null);
      }
      return;
    }

    if (interaction.customId === 'modal_globo') {
      try {
        await interaction.deferReply({ ephemeral: true }).catch(() => null);
        const textContent = interaction.fields.getTextInputValue('globo_content').trim();

        const channels = await interaction.guild.channels.fetch().catch(() => interaction.guild.channels.cache);
        const channelsArray = safeGetArray(channels);
        const chatChannel = channelsArray.find(c => c && c.isTextBased() && (
          c.name === '💬・chat' ||
          c.name === 'chat' ||
          matchChannel(c.name, 'chat')
        ));

        if (!chatChannel) {
          await interaction.editReply({ content: '❌ **Erro:** Canal `💬・chat` não foi encontrado no servidor.' }).catch(() => null);
          return;
        }

        await chatChannel.send(`globo:${textContent}`).catch(err => {
          console.error('Erro ao enviar mensagem globo:', err);
        });

        await interaction.editReply({ content: `✅ **Sucesso:** Mensagem enviada para o canal <#${chatChannel.id}>!` }).catch(() => null);
      } catch (err) {
        console.error('Erro ao processar modal_globo:', err);
        await interaction.reply({ content: '❌ Ocorreu um erro interno ao enviar a mensagem.', ephemeral: true }).catch(() => null);
      }
      return;
    }

    if (interaction.customId === 'modal_peticionamento') {
      try {
        const pet_tipo = interaction.fields.getTextInputValue('pet_tipo').trim();
        const isCriminal = pet_tipo.toLowerCase().includes('crim');

        // Se for Processo Criminal, verifica se quem está peticionando é Promotor de Justiça
        if (isCriminal) {
          const roles = await interaction.guild.roles.fetch().catch(() => interaction.guild.roles.cache);
          const rolesArray = safeGetArray(roles);
          const promotorRole = rolesArray.find(r => r && r.name && (r.name === 'Prom. J | Promotor de Justiça' || matchChannel(r.name, 'promotor')));
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

          if (!promotorRole || !member || !member.roles.cache.has(promotorRole.id)) {
            await interaction.reply({
              content: '⚠️ **Acesso Negado:** Apenas Promotores de Justiça com o cargo adequado podem instaurar e peticionar Ações Penais / Processos Criminais.',
              ephemeral: true
            }).catch(() => null);
            return;
          }
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => null);

        const channel = interaction.channel;
        const thread = await channel.threads.create({
          name: `Petição - ${interaction.user.username}`,
          autoArchiveDuration: 60,
          type: ChannelType.PrivateThread,
          reason: `Peticionamento eletrônico iniciado por ${interaction.user.tag}`,
        });

        await thread.members.add(interaction.user.id);
        await thread.send(`Olá <@${interaction.user.id}>! Iniciando o peticionamento eletrônico com base nas informações enviadas.`);

        let pet_autor = (interaction.fields.getTextInputValue('pet_autor') || '').trim();
        const pet_reu = (interaction.fields.getTextInputValue('pet_reu') || '').trim();
        const pet_texto = 'Aguardando juntada de petição inicial e provas pelas partes nos autos.';

        // Para processos criminais, o autor é obrigatoriamente o Ministério Público do Paraná
        if (isCriminal) {
          pet_autor = 'Ministério Público do Paraná';
        } else if (!pet_autor) {
          pet_autor = 'Não informado';
        }

        const modalData = {
          type: isCriminal ? 'Ação Penal / Processo Criminal' : pet_tipo,
          authorName: pet_autor,
          defendantName: pet_reu,
          petitionText: pet_texto,
          isCriminal: isCriminal
        };

        // Chama o wizard reduzido passando os dados coletados do modal
        runPetitionWizard(thread, interaction.user.id, modalData);

        await interaction.editReply({ content: `✅ Thread privada criada com sucesso: <#${thread.id}>! Acesse o canal para concluir o peticionamento.` }).catch(() => null);
      } catch (err) {
        console.error('Erro ao processar modal de peticionamento:', err);
        await interaction.reply({ content: '❌ Ocorreu um erro interno ao criar a petição.', ephemeral: true }).catch(() => null);
      }
      return;
    }

    if (interaction.customId === 'modal_emitir_precatorio') {
      try {
        await interaction.deferReply({ ephemeral: true }).catch(() => null);
        
        const robloxUser = interaction.fields.getTextInputValue('prec_roblox');
        const valor = interaction.fields.getTextInputValue('prec_valor');
        const justificativa = interaction.fields.getTextInputValue('prec_justificativa');
        const autoridade = interaction.user.tag;
        const autoridadeMention = `<@${interaction.user.id}>`;
        
        // Pergunta o Discord do beneficiário no chat
        await interaction.editReply({
          content: `⚖️ **Precatórios:** Para finalizar, mencione o Discord de quem receberá o precatório (ex: @pessoa1) ou digite **"nenhum"** para pular.`
        }).catch(() => null);

        const filter = m => m.author.id === interaction.user.id;
        const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] }).catch(() => null);
        
        let discordUser = 'Não informado';
        if (collected && collected.size > 0) {
          const userMsg = collected.first();
          const contentMsg = userMsg.content.trim().toLowerCase();
          
          if (contentMsg !== 'nenhum' && contentMsg !== 'nao' && contentMsg !== 'não' && contentMsg !== 'pular') {
            const mentioned = userMsg.mentions.users.first();
            discordUser = mentioned ? `<@${mentioned.id}>` : userMsg.content.trim();
          }
          
          // Apaga a mensagem digitada pelo usuário para deixar o canal limpo
          await userMsg.delete().catch(() => null);
        }

        const precId = `PREC-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
        const timeStampStr = getFormattedDateTime();
        
        const embed = new EmbedBuilder()
          .setTitle('📜 CERTIDÃO DE PRECATÓRIO JUDICIAL')
          .setDescription(
            `**TRIBUNAL DE JUSTIÇA DO GOVERNO FEDERAL**\n` +
            `*Certificamos a constituição e homologação do seguinte precatório judicial:*`
          )
          .setColor(0xd4af37) // Dourado
          .addFields(
            { name: '📂 Protocolo de Registro', value: `\`${precId}\``, inline: true },
            { name: '⚖️ Autoridade Emissora', value: autoridadeMention, inline: true },
            { name: '💰 Valor Homologado', value: `**${valor}**`, inline: true },
            { name: '👤 Beneficiário (Roblox)', value: `\`${robloxUser}\``, inline: true },
            { name: '💬 Beneficiário (Discord)', value: discordUser, inline: true },
            { name: '📝 Justificativa Legal / Motivo', value: justificativa },
            { name: '🚥 Status do Título', value: '🟡 **PENDENTE DE PAGAMENTO**', inline: false },
            { name: '📅 Data de Autuação', value: timeStampStr, inline: false }
          )
          .setTimestamp()
          .setFooter({ text: 'Sistema Nacional de Controle de Precatórios • Brasília-DF' });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`btn_baixar_precatorio_${precId}`)
            .setLabel('Dar Baixa por Pagamento')
            .setStyle(ButtonStyle.Success)
            .setEmoji('💸')
        );
        
        await interaction.channel.send({
          embeds: [embed],
          components: [row]
        });
        
        await interaction.editReply({ content: `✅ **Sucesso:** Precatório emitido com sucesso! Protocolo: \`${precId}\`.` }).catch(() => null);
      } catch (err) {
        console.error('Erro no modal de precatório:', err);
        await interaction.editReply({ content: '❌ Ocorreu um erro interno ao gerar o precatório.' }).catch(() => null);
      }
      return;
    }
  }

  // --- MÓDULO DE AGENDA E MARCAÇÃO DE AUDIÊNCIAS JUDICIAIS (#juízes) ---

  // 1. Botão Agendar Audiência
  if (interaction.isButton() && interaction.customId === 'btn_marcar_audiencia') {
    const member = interaction.member;
    const isJuiz = member && (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.roles.cache.some(r => r.name === 'J. Dir. | Juiz de Direito' || r.name.toLowerCase().includes('juiz'))
    );

    if (!isJuiz) {
      return interaction.reply({
        content: '⚠️ **Acesso Negado:** Apenas Juízes de Direito podem agendar audiências judiciais.',
        ephemeral: true
      }).catch(() => null);
    }

    const modal = new ModalBuilder()
      .setCustomId('modal_marcar_audiencia')
      .setTitle('Agendamento de Audiência Judicial');

    const inputProcesso = new TextInputBuilder()
      .setCustomId('input_processo_audiencia')
      .setLabel('Número do Processo')
      .setPlaceholder('Ex: PROC-2026-X8A9')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const inputTipo = new TextInputBuilder()
      .setCustomId('input_tipo_audiencia')
      .setLabel('Tipo (Conciliação / Instrução e Julgamento)')
      .setPlaceholder('Digite: Conciliação ou Instrução e Julgamento')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const inputData = new TextInputBuilder()
      .setCustomId('input_data_audiencia')
      .setLabel('Data e Horário da Audiência')
      .setPlaceholder('Ex: 28/07/2026 às 15:00')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(inputProcesso),
      new ActionRowBuilder().addComponents(inputTipo),
      new ActionRowBuilder().addComponents(inputData)
    );

    await interaction.showModal(modal).catch(() => null);
    return;
  }

  // 2. Submissão do Modal de Agendamento
  if (interaction.isModalSubmit() && interaction.customId === 'modal_marcar_audiencia') {
    const numProcesso = interaction.fields.getTextInputValue('input_processo_audiencia').trim();
    const tipoRaw = interaction.fields.getTextInputValue('input_tipo_audiencia').trim();
    const dataAudiencia = interaction.fields.getTextInputValue('input_data_audiencia').trim();

    const guild = interaction.guild;
    const category = await getOrCreateTribunalCategory(guild);

    const cleanTipo = tipoRaw.toLowerCase().includes('concili') ? 'Conciliação' : 'Instrução e Julgamento';
    const voiceName = `🔊 [${cleanTipo}] ${numProcesso}`.substring(0, 99);

    // Cria o canal de voz na seção TRIBUNAL DE JUSTIÇA
    const voiceChannel = await guild.channels.create({
      name: voiceName,
      type: ChannelType.GuildVoice,
      parent: category ? category.id : null
    }).catch(() => null);

    const cardEmbed = new EmbedBuilder()
      .setTitle(`⚖️ AUDIÊNCIA JUDICIAL DESIGNADA`)
      .setColor(0x3498db)
      .addFields(
        { name: '📂 Processo Vinculado', value: `\`${numProcesso}\``, inline: true },
        { name: '📜 Tipo de Audiência', value: `**${cleanTipo}**`, inline: true },
        { name: '📅 Data e Horário', value: `\`${dataAudiencia}\``, inline: false },
        { name: '🔊 Sala de Áudio Criada', value: voiceChannel ? `<#${voiceChannel.id}>` : '*Falha ao criar sala de áudio*', inline: false },
        { name: '👨‍⚖️ Juiz Designado', value: `<@${interaction.user.id}>`, inline: true }
      )
      .setFooter({ text: 'Tribunal de Justiça • Pauta Oficial de Audiências' })
      .setTimestamp();

    const btnDelete = new ButtonBuilder()
      .setCustomId(`btn_excluir_audiencia_${voiceChannel ? voiceChannel.id : 'none'}`)
      .setLabel('🗑️ Excluir Audiência')
      .setStyle(ButtonStyle.Danger);

    const rowDelete = new ActionRowBuilder().addComponents(btnDelete);

    await interaction.reply({
      content: `✅ **Audiência agendada com sucesso!**`,
      embeds: [cardEmbed],
      components: [rowDelete]
    }).catch(() => null);
    return;
  }

  // 3. Botão Excluir Audiência (Apaga canal de voz e card)
  if (interaction.isButton() && interaction.customId.startsWith('btn_excluir_audiencia_')) {
    const member = interaction.member;
    const isJuiz = member && (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.roles.cache.some(r => r.name === 'J. Dir. | Juiz de Direito' || r.name.toLowerCase().includes('juiz'))
    );

    if (!isJuiz) {
      return interaction.reply({
        content: '⚠️ **Acesso Negado:** Apenas Juízes de Direito podem excluir ou encerrar audiências.',
        ephemeral: true
      }).catch(() => null);
    }

    const voiceChannelId = interaction.customId.replace('btn_excluir_audiencia_', '');

    if (voiceChannelId && voiceChannelId !== 'none') {
      const vChan = await interaction.guild.channels.fetch(voiceChannelId).catch(() => null);
      if (vChan) {
        await vChan.delete('Audiência encerrada por Juiz de Direito').catch(() => null);
      }
    }

    if (interaction.message && interaction.message.deletable) {
      await interaction.message.delete().catch(() => {});
    }

    await interaction.reply({
      content: '✅ **Audiência e canal de áudio excluídos com sucesso!**',
      ephemeral: true
    }).catch(() => null);
    return;
  }

  if (interaction.isButton()) {
    // BOTÃO DE SOLICITAÇÃO DE ADVOGADO (TICKET ADVOCACIA)
    if (interaction.customId === 'btn_abrir_ticket_advogado') {
      try {
        await interaction.deferReply({ ephemeral: true }).catch(() => null);

        const channel = interaction.channel;
        const threadName = `ticket-adv-${interaction.user.username}`.substring(0, 90);

        let thread;
        try {
          thread = await channel.threads.create({
            name: threadName,
            type: ChannelType.PrivateThread,
            reason: `Solicitação de advogado aberta por ${interaction.user.tag}`
          });
        } catch (errPriv) {
          thread = await channel.threads.create({
            name: threadName,
            reason: `Solicitação de advogado aberta por ${interaction.user.tag}`
          });
        }

        await thread.members.add(interaction.user.id).catch(() => null);

        // Busca a role de Advogado (ex: "Adv. | Advogado" - ID: 1526311674439798964)
        const roles = await interaction.guild.roles.fetch().catch(() => interaction.guild.roles.cache);
        const rolesArray = safeGetArray(roles);
        const lawyerRole = rolesArray.find(r => r && (r.id === '1526311674439798964' || r.name.toLowerCase().includes('adv. | advogado') || r.name.toLowerCase().includes('advogado')));

        const roleMention = lawyerRole ? `<@&${lawyerRole.id}>` : '@Advogado';

        const ticketWelcomeEmbed = new EmbedBuilder()
          .setTitle('⚖️ ATENDIMENTO JURÍDICO - TICKET ABERTO')
          .setDescription(
            `Olá <@${interaction.user.id}>! Seu atendimento com a **Advocacia** foi iniciado.\n\n` +
            `Descreva detalhadamente o seu caso, mandado ou motivo da assistência jurídica.\n` +
            `Os advogados disponíveis com o cargo ${roleMention} foram notificados.`
          )
          .setColor(0x2b2d31)
          .setFooter({ text: 'Ordem dos Advogados do Brasil • OAB' })
          .setTimestamp();

        await thread.send({
          content: `${roleMention} 🔔 **Novo Atendimento:** O usuário <@${interaction.user.id}> solicitou assistência jurídica.`,
          embeds: [ticketWelcomeEmbed]
        });

        await interaction.editReply({
          content: `✅ **Ticket de Solicitação de Advogado criado com sucesso!**\nAcesse o canal reservado: <#${thread.id}>`
        }).catch(() => null);
      } catch (errTicket) {
        console.error('Erro ao abrir ticket de advogado:', errTicket);
        await interaction.editReply({ content: '❌ Ocorreu um erro interno ao abrir o ticket de atendimento.' }).catch(() => null);
      }
      return;
    }

    // BOTÃO DE SOLICITAÇÃO DE DENÚNCIA (MINISTÉRIO PÚBLICO)
    if (interaction.customId === 'btn_abrir_ticket_denuncia') {
      try {
        await interaction.deferReply({ ephemeral: true }).catch(() => null);

        const guild = interaction.guild;
        const user = interaction.user;

        // 1. Busca Categoria "➲ MINISTÉRIO PÚBLICO" ou variante
        const allChannels = await guild.channels.fetch().catch(() => guild.channels.cache);
        const channelsArray = safeGetArray(allChannels);
        const mpCategory = channelsArray.find(c => 
          c && c.type === ChannelType.GuildCategory && (
            matchChannel(c.name, 'ministerio publico') ||
            matchChannel(c.name, 'ministério público') ||
            matchChannel(c.name, 'ministerio-publico') ||
            matchChannel(c.name, 'promotoria') ||
            c.name.toLowerCase().includes('ministério público') ||
            c.name.toLowerCase().includes('ministerio publico') ||
            c.name.toLowerCase().includes('promotor')
          )
        );

        // 2. Busca o cargo de Promotor de Justiça
        const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
        const rolesArray = safeGetArray(roles);
        const promotorRole = rolesArray.find(r => r && r.name && (
          r.name === 'Prom. J | Promotor de Justiça' ||
          r.name === 'Promotor de Justiça - MPPR' ||
          r.name.trim().toLowerCase() === ROLE_PROMOTOR_NOME.trim().toLowerCase() ||
          r.name.toLowerCase().includes('promotor')
        ));

        const cleanUsername = user.username.toLowerCase().replace(/[^a-z0-9_-]/g, '').substring(0, 70);
        const ticketChannelName = `denuncia-${cleanUsername || user.id}`;

        // 3. Verifica se o usuário já possui um ticket de denúncia aberto
        const existingChannel = channelsArray.find(c => 
          c && c.type === ChannelType.GuildText && 
          c.name === ticketChannelName && 
          (!mpCategory || c.parentId === mpCategory.id)
        );

        if (existingChannel) {
          await interaction.editReply({
            content: `⚠️ **Você já possui uma denúncia em andamento!**\nAcesse o seu canal reservado do Ministério Público: <#${existingChannel.id}>`
          }).catch(() => null);
          return;
        }

        // 4. Configuração de Permissões (Privado: apenas Denunciante, Promotores e Bot)
        const permissionOverwrites = [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks
            ]
          },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.EmbedLinks
            ]
          }
        ];

        if (promotorRole) {
          permissionOverwrites.push({
            id: promotorRole.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.EmbedLinks
            ]
          });
        }

        // 5. Criação do Canal Privado no Ministério Público
        const channelOptions = {
          name: ticketChannelName,
          type: ChannelType.GuildText,
          permissionOverwrites: permissionOverwrites,
          reason: `Denúncia registrada por ${user.tag}`
        };

        if (mpCategory) {
          channelOptions.parent = mpCategory.id;
        }

        const ticketChannel = await guild.channels.create(channelOptions);

        const promotorMention = promotorRole ? `<@&${promotorRole.id}>` : '@Promotores';

        const welcomeEmbed = new EmbedBuilder()
          .setTitle('🚨 MINISTÉRIO PÚBLICO - NOVA DENÚNCIA REGISTRADA')
          .setDescription(
            `Olá <@${user.id}>! Sua denúncia foi iniciada e enviada ao **Ministério Público**.\n\n` +
            `📝 **Orientações ao Denunciante:**\n` +
            `1. Descreva detalhadamente os fatos, apontando nomes, locais e datas.\n` +
            `2. Anexe todas as provas disponíveis (prints, fotos, vídeos, depoimentos ou links de processos).\n\n` +
            `⚖️ **Atenção:** Os Doutos Promotores de Justiça (${promotorMention}) foram notificados e analisarão o seu caso em breve.\n\n` +
            `*Este canal é estritamente confidencial e visível apenas a você e aos Promotores de Justiça.*`
          )
          .setColor(0xc0392b)
          .setFooter({ text: 'Ministério Público • Governo Federal / Poder Judiciário' })
          .setTimestamp();

        const closeRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('btn_fechar_ticket_denuncia')
            .setLabel('🔒 Fechar Denúncia')
            .setStyle(ButtonStyle.Secondary)
        );

        await ticketChannel.send({
          content: `${promotorMention} 🔔 **Nova Denúncia Recebida:** O usuário <@${user.id}> registrou uma nova denúncia.`,
          embeds: [welcomeEmbed],
          components: [closeRow]
        });

        await interaction.editReply({
          content: `✅ **Denúncia registrada com sucesso!**\nAcesse o seu canal reservado do Ministério Público: <#${ticketChannel.id}>`
        }).catch(() => null);

      } catch (errDenuncia) {
        console.error('Erro ao abrir ticket de denúncia:', errDenuncia);
        await interaction.editReply({ content: '❌ Ocorreu um erro interno ao abrir o canal de denúncia. Verifique as permissões do bot.' }).catch(() => null);
      }
      return;
    }

    // BOTÃO DE FECHAR TICKET DE DENÚNCIA
    if (interaction.customId === 'btn_fechar_ticket_denuncia') {
      try {
        await interaction.deferReply().catch(() => null);
        await interaction.editReply({
          content: `🔒 **Encerrando Denúncia:** Este canal será excluído em **5 segundos** por solicitação de <@${interaction.user.id}>...`
        });

        setTimeout(async () => {
          await interaction.channel.delete('Ticket de denúncia finalizado').catch(err => {
            console.error('Erro ao excluir canal de denúncia:', err);
          });
        }, 5000);
      } catch (errClose) {
        console.error('Erro no botão fechar denúncia:', errClose);
      }
      return;
    }

    // BOTAO DE RESPOSTA PRIVADA DA IA (!ia privada)
    if (interaction.customId.startsWith('btn_ia_private_')) {
      const data = privateIaResponses.get(interaction.customId);
      if (!data) {
        return interaction.reply({ content: '⏳ Esta resposta privada expirou ou não está mais no cache.', ephemeral: true }).catch(() => null);
      }
      if (interaction.user.id !== data.userId) {
        return interaction.reply({ content: '⚠️ **Acesso Negado:** Apenas o Dr. Renato pode visualizar esta resposta privada.', ephemeral: true }).catch(() => null);
      }

      if (data.text.length <= 1900) {
        await interaction.reply({ content: `🤖 **IA Assistente (Resposta Privada):**\n${data.text}`, ephemeral: true }).catch(() => null);
      } else {
        const chunks = data.text.match(/[\s\S]{1,1900}/g) || [data.text];
        await interaction.reply({ content: `🤖 **IA Assistente (Parte 1/${chunks.length} - Privada):**\n${chunks[0]}`, ephemeral: true }).catch(() => null);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: `🤖 **(Parte ${i + 1}/${chunks.length} - Privada):**\n${chunks[i]}`, ephemeral: true }).catch(() => null);
        }
      }
      return;
    }

    if (interaction.customId === 'btn_abrir_globo') {
      try {
        const modal = new ModalBuilder()
          .setCustomId('modal_globo')
          .setTitle('Enviar Mensagem (Globo)');

        const textInput = new TextInputBuilder()
          .setCustomId('globo_content')
          .setLabel('Conteúdo da Mensagem')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Digite aqui o texto para o Tupper globo:text...')
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(textInput));
        await interaction.showModal(modal).catch(() => null);
      } catch (err) {
        console.error('Erro ao abrir modal globo:', err);
        await interaction.reply({ content: '❌ Ocorreu um erro interno ao abrir o formulário.', ephemeral: true }).catch(() => null);
      }
      return;
    }

    // REUNIÃO PARA DESPACHO ENTRE JUIZ E ADVOGADO
    if (interaction.customId.startsWith('btn_despacho_')) {
      const juizId = interaction.customId.replace('btn_despacho_', '');
      const guild = interaction.guild;

      try {
        await interaction.deferReply({ ephemeral: true }).catch(() => null);

        // Busca o membro do juiz
        const juizMember = await guild.members.fetch(juizId).catch(() => null);
        const juizName = juizMember ? juizMember.user.username : 'Juiz';

        // Cria a thread privativa diretamente no canal de juízes (interaction.channel)
        const threadName = `Despacho - ${interaction.user.username} & ${juizName}`;
        const thread = await interaction.channel.threads.create({
          name: threadName.substring(0, 100),
          autoArchiveDuration: 1440,
          type: ChannelType.PrivateThread,
          reason: `Reunião para despacho solicitada por ${interaction.user.tag}`
        });

        // Adiciona o solicitante e o juiz à thread
        await thread.members.add(interaction.user.id).catch(() => null);
        await thread.members.add(juizId).catch(() => null);

        // Envia a mensagem de boas-vindas marcando e contextualizando
        const welcomeMsg = `🏛️ **AUDIÊNCIA DE DESPACHO INICIADA**\n\n` +
                           `Esta thread privativa foi aberta para despachos e alinhamentos processuais entre o Magistrado e a Parte/Advogado solicitante.\n\n` +
                           `* **Solicitante:** <@${interaction.user.id}>\n` +
                           `* **Magistrado Designado:** <@${juizId}>\n\n` +
                           `Juiz <@${juizId}>, você foi convocado pelo solicitante <@${interaction.user.id}> para realizar o despacho.`;
        await thread.send(welcomeMsg).catch(() => null);

        await interaction.editReply({ content: `✅ **Sucesso:** Reunião de despacho agendada! Acesse a sala privativa aqui: <#${thread.id}>.` }).catch(() => null);

      } catch (err) {
        console.error('Erro ao criar reunião de despacho:', err);
        await interaction.editReply({ content: '❌ Ocorreu um erro interno ao tentar agendar o despacho com o juiz.' }).catch(() => null);
      }
      return;
    }
    // TRATAMENTO DE BOTAO PAINEL AUTOS SIGILOSOS - DAR BAIXA
    if (interaction.customId === 'btn_autos_baixa') {
      const guild = interaction.guild;
      const member = interaction.member;
      const juizRole = guild.roles.cache.find(r => r.name === 'J. Dir. | Juiz de Direito');

      if (!juizRole || !member.roles.cache.has(juizRole.id)) {
        await interaction.reply({ content: '⚠️ **Acesso Negado:** Apenas Juízes de Direito podem dar baixa ou encerrar a sala de autos sigilosos.', ephemeral: true }).catch(() => null);
        return;
      }

      await interaction.reply('🗑️ **Encerrando Autos Sigilosos:** A thread será permanentemente excluída em 3 segundos...').catch(() => null);

      setTimeout(() => {
        interaction.channel.delete().catch(() => null);
      }, 3000);
      return;
    }

    // TRATAMENTO DE BOTAO PAINEL AUTOS SIGILOSOS - PUBLICAR NO PROCESSO
    if (interaction.customId.startsWith('btn_autos_publicar_')) {
      const targetProcessId = interaction.customId.replace('btn_autos_publicar_', '');
      const guild = interaction.guild;
      const member = interaction.member;
      const juizRole = guild.roles.cache.find(r => r.name === 'J. Dir. | Juiz de Direito');

      if (!juizRole || !member.roles.cache.has(juizRole.id)) {
        await interaction.reply({ content: '⚠️ **Acesso Negado:** Apenas Juízes de Direito podem publicar os autos sigilosos no processo original.', ephemeral: true }).catch(() => null);
        return;
      }

      await interaction.deferReply({ ephemeral: true }).catch(() => null);

      const targetProcessThread = await guild.channels.fetch(targetProcessId).catch(() => null);

      if (!targetProcessThread || !targetProcessThread.isTextBased()) {
        await interaction.editReply({ content: '⚠️ **Erro:** A thread original do processo não foi encontrada para publicação dos autos.' }).catch(() => null);
        return;
      }

      try {
        // Coleta todas as mensagens da thread de autos sigilosos
        let allMsgs = [];
        let lastId = null;
        while (true) {
          const fetchOptions = { limit: 100 };
          if (lastId) fetchOptions.before = lastId;
          const batch = await interaction.channel.messages.fetch(fetchOptions).catch(() => null);
          if (!batch || batch.size === 0) break;
          allMsgs.push(...Array.from(batch.values()));
          lastId = batch.last().id;
          if (batch.size < 100) break;
        }

        // Ordena cronologicamente
        allMsgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        // Header no processo original
        const headerEmbed = new EmbedBuilder()
          .setTitle('📢 AUTOS SIGILOSOS DESCLASSIFICADOS E PUBLICADOS')
          .setDescription(`Documentos e autos sigilosos previamente juntados em sala privativa foram tornados públicos e incorporados ao processo por determinação do Juiz <@${interaction.user.id}>.`)
          .setColor(0x2ecc71)
          .setTimestamp();

        await targetProcessThread.send({ embeds: [headerEmbed] }).catch(() => null);

        // Reenvia todo o conteúdo publicado para a thread do processo original
        for (const msg of allMsgs) {
          // Ignora a mensagem de painel e mensagens do sistema bot sem anexos/conteúdo relevante
          if (msg.author.id === client.user.id && msg.components && msg.components.length > 0) continue;
          if (msg.content && msg.content.includes('Sala de Autos Sigilosos Aberta!')) continue;

          const files = msg.attachments && msg.attachments.size > 0 
            ? Array.from(msg.attachments.values()).map(a => a.url) 
            : [];

          if (msg.embeds && msg.embeds.length > 0) {
            const embedsToSend = msg.embeds.map(e => EmbedBuilder.from(e));
            await targetProcessThread.send({
              content: msg.content || null,
              embeds: embedsToSend,
              files: files
            }).catch(() => null);
          } else {
            if (!msg.content && files.length === 0) continue;

            let payloadContent = '';
            if (msg.author.id === client.user.id) {
              payloadContent = msg.content;
            } else {
              payloadContent = `💬 **${msg.author.username}**: ${msg.content}`;
            }

            await targetProcessThread.send({
              content: payloadContent || null,
              files: files
            }).catch(() => null);
          }
        }

        await interaction.editReply({ content: '✅ **Sucesso:** Todos os autos sigilosos foram publicados na thread do processo original! Excluindo sala privativa em 3 segundos...' }).catch(() => null);

        setTimeout(() => {
          interaction.channel.delete().catch(() => null);
        }, 3000);

      } catch (err) {
        console.error('Erro ao publicar autos sigilosos:', err);
        await interaction.editReply({ content: '❌ Ocorreu um erro interno ao transferir e publicar os autos sigilosos.' }).catch(() => null);
      }
      return;
    }

    if (interaction.customId === 'btn_peticionar') {
      try {
        const modal = new ModalBuilder()
          .setCustomId('modal_peticionamento')
          .setTitle('Peticionamento Eletrônico');

        const inputTipo = new TextInputBuilder()
          .setCustomId('pet_tipo')
          .setLabel('Tipo (Comum, Execução ou Criminal)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: Procedimento Comum, Execução ou Criminal')
          .setRequired(true);

        const inputAutor = new TextInputBuilder()
          .setCustomId('pet_autor')
          .setLabel('Parte Autora (Quem processa) (Opcional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: Maria Silva (Opcional | Para Criminal: MPPR automático)')
          .setRequired(false);

        const inputReu = new TextInputBuilder()
          .setCustomId('pet_reu')
          .setLabel('Parte Ré (Quem é processado)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: João Souza (Nome do acusado/réu)')
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(inputTipo),
          new ActionRowBuilder().addComponents(inputAutor),
          new ActionRowBuilder().addComponents(inputReu)
        );

        await interaction.showModal(modal).catch(() => null);
      } catch (err) {
        console.error('Erro ao abrir modal de peticionamento:', err);
        await interaction.reply({ content: '❌ Ocorreu um erro interno ao abrir o formulário de petição.', ephemeral: true }).catch(() => null);
      }
      return;
    }

    // BOTÃO REGISTRAR MANDADO (BNMP)
    if (interaction.customId === 'btn_registrar_mandado') {
      const guild = interaction.guild;
      const member = interaction.member;

      try {
        const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
        const juizRole = roles.find(r => r.name === 'J. Dir. | Juiz de Direito');

        if (!juizRole || !member.roles.cache.has(juizRole.id)) {
          return interaction.reply({
            content: '⚠️ **Acesso Negado:** Apenas Juízes de Direito (@J. Dir. | Juiz de Direito) podem registrar novos mandados de prisão.',
            ephemeral: true
          }).catch(() => null);
        }

        // Buscar canais para encontrar a seção de Petições/Processos
        const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
        const channelsArray = safeGetArray(channels);
        const peticoesChannel = channelsArray.find(c => c && c.name && (
          matchChannel(c.name, 'petições') || 
          matchChannel(c.name, 'petição') || 
          matchChannel(c.name, 'peticao') || 
          matchChannel(c.name, 'peticionamento') || 
          matchChannel(c.name, 'processos') || 
          matchChannel(c.name, 'processo')
        ));

        let threadsArray = [];
        if (peticoesChannel) {
          const active = await peticoesChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
          const archived = await peticoesChannel.threads.fetchArchived().catch(() => ({ threads: new Map() }));
          const allThreads = [...safeGetArray(active.threads), ...safeGetArray(archived.threads)];
          threadsArray = allThreads.filter(t => t && t.name);
        }

        // Se houver processos ativos ou arquivados, mostramos o Select Menu primeiro
        if (threadsArray.length > 0) {
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('select_processo_mandado')
            .setPlaceholder('Escolha o processo relacionado...');

          const options = [
            new StringSelectMenuOptionBuilder()
              .setLabel('Nenhum Processo')
              .setDescription('Não associar este mandado a nenhum processo.')
              .setValue('none')
          ];

          // Limita a 24 processos
          const limitThreads = threadsArray.slice(0, 24);
          for (const thread of limitThreads) {
            options.push(
              new StringSelectMenuOptionBuilder()
                .setLabel(thread.name.substring(0, 100))
                .setValue(thread.id)
            );
          }

          selectMenu.addOptions(options);
          const row = new ActionRowBuilder().addComponents(selectMenu);

          await interaction.reply({
            content: '⚖️ **BNMP:** Selecione a qual processo este mandado de prisão está associado:',
            components: [row],
            ephemeral: true
          }).catch(() => null);
        } else {
          // Se não houver nenhum processo na lista, abre o modal direto com campo de link manual
          const modal = new ModalBuilder()
            .setCustomId('modal_registrar_mandado_none')
            .setTitle('Registrar Mandado de Prisão');

          const inputNome = new TextInputBuilder()
            .setCustomId('input_nome')
            .setLabel('Nome in-game do Acusado')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('Ex: Joaozinho_BR');

          const inputMotivo = new TextInputBuilder()
            .setCustomId('input_motivo')
            .setLabel('Motivo / Artigo / Crime')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('Descreva os motivos e artigos que fundamentam a prisão...');

          const inputProcesso = new TextInputBuilder()
            .setCustomId('input_processo')
            .setLabel('Link ou Nº do Processo (Opcional)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('Copie e cole o link do processo ou número aqui...');

          const inputAnalise = new TextInputBuilder()
            .setCustomId('input_analise_promotores')
            .setLabel('Notificar Promotores para Criar Processo?')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('Digite Sim para expedir Ofício aos Promotores de Justiça (se sem processo)');

          modal.addComponents(
            new ActionRowBuilder().addComponents(inputNome),
            new ActionRowBuilder().addComponents(inputMotivo),
            new ActionRowBuilder().addComponents(inputProcesso),
            new ActionRowBuilder().addComponents(inputAnalise)
          );

          await interaction.showModal(modal).catch(err => {
            console.error('[BNMP] Erro ao abrir modal de mandado:', err);
          });
        }
      } catch (err) {
        console.error('[BNMP] Erro na interação do botão de mandado:', err);
        await interaction.reply({
          content: '❌ Ocorreu um erro interno ao tentar abrir o formulário.',
          ephemeral: true
        }).catch(() => null);
      }
      return;
    }

    if (interaction.customId === 'btn_abrir_oficio') {
      const guild = interaction.guild;
      const juizRole = guild.roles.cache.find(r => r.name === 'J. Dir. | Juiz de Direito');
      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      
      if (!juizRole || !member || !member.roles.cache.has(juizRole.id)) {
        await interaction.reply({ content: '⚠️ **Acesso Negado:** Apenas Juízes de Direito podem redigir ofícios.', ephemeral: true }).catch(() => null);
        return;
      }

      // Deleta a mensagem do prompt que contém o botão 'Redigir Ofício' para não deixar vestígios no chat
      if (interaction.message) {
        await interaction.message.delete().catch(() => null);
      }

      const modal = new ModalBuilder()
        .setCustomId('modal_oficio')
        .setTitle('Redigir Ofício / Ato');

      const textInput = new TextInputBuilder()
        .setCustomId('oficio_content')
        .setLabel('Conteúdo do Ofício / Determinação')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Digite aqui a determinação judicial...')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(textInput)
      );

      await interaction.showModal(modal).catch(() => null);
      return;
    }

    if (interaction.customId === 'btn_iniciar_precatorio') {
      const guild = interaction.guild;
      const member = interaction.member;

      try {
        const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
        const juizRole = roles.find(r => r.name === 'J. Dir. | Juiz de Direito');

        if (!juizRole || !member.roles.cache.has(juizRole.id)) {
          await interaction.reply({ content: '⚠️ **Acesso Negado:** Apenas Juízes de Direito com o cargo adequado podem emitir precatórios.', ephemeral: true }).catch(() => null);
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId('modal_emitir_precatorio')
          .setTitle('Emitir Precatório Judicial');

        const inputRoblox = new TextInputBuilder()
          .setCustomId('prec_roblox')
          .setLabel('Quem receberá: Nome no Roblox (Obrigatório)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: Joaozinho_BR')
          .setRequired(true);

        const inputValor = new TextInputBuilder()
          .setCustomId('prec_valor')
          .setLabel('Valor do Precatório (R$)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: R$ 500.000,00')
          .setRequired(true);

        const inputJustificativa = new TextInputBuilder()
          .setCustomId('prec_justificativa')
          .setLabel('Justificativa Legal / Motivo')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Insira os fundamentos legais da emissão do precatório...')
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(inputRoblox),
          new ActionRowBuilder().addComponents(inputValor),
          new ActionRowBuilder().addComponents(inputJustificativa)
        );

        await interaction.showModal(modal).catch(() => null);
      } catch (err) {
        console.error('Erro ao abrir modal de precatório:', err);
        await interaction.reply({ content: '❌ Ocorreu um erro interno ao abrir o formulário.', ephemeral: true }).catch(() => null);
      }
      return;
    }

    if (interaction.customId.startsWith('btn_baixar_precatorio_')) {
      const precId = interaction.customId.replace('btn_baixar_precatorio_', '');
      const guild = interaction.guild;
      const member = interaction.member;

      try {
        const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
        const juizRole = roles.find(r => r.name === 'J. Dir. | Juiz de Direito');

        // Proteção: apenas Juiz de Direito pode dar baixa
        if (!juizRole || !member.roles.cache.has(juizRole.id)) {
          return interaction.reply({
            content: '⚠️ **Acesso Negado:** Apenas Juízes de Direito com o cargo adequado podem dar baixa em precatórios.',
            ephemeral: true
          }).catch(() => null);
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => null);

        // Recupera o embed da mensagem original
        const message = interaction.message;
        if (!message || message.embeds.length === 0) {
          await interaction.editReply({ content: '❌ Erro: Não foi possível recuperar a certidão original.' }).catch(() => null);
          return;
        }

        const originalEmbed = message.embeds[0];
        
        // Deleta a mensagem antiga
        await message.delete().catch(() => null);

        // Cria o embed atualizado marcado como PAGO / DADO BAIXA
        const timeStampStr = getFormattedDateTime();
        const updatedFields = originalEmbed.fields.map(f => {
          if (f.name.includes('Status do Título')) {
            return { name: f.name, value: '🟢 **PAGO / DADO BAIXA**', inline: f.inline };
          }
          return f;
        });

        // Adiciona um campo de auditoria informando quem deu baixa e a data
        updatedFields.push({
          name: '👮 Auditoria de Pagamento',
          value: `Baixa efetuada por <@${interaction.user.id}> em ${timeStampStr}.`,
          inline: false
        });

        const updatedEmbed = EmbedBuilder.from(originalEmbed)
          .setTitle('📜 CERTIDÃO DE PRECATÓRIO - PAGO / DADO BAIXA')
          .setColor(0xe74c3c) // Vermelho
          .setFields(updatedFields);

        // Publica no mesmo canal a certidão atualizada sem botões
        await interaction.channel.send({
          embeds: [updatedEmbed]
        });

        await interaction.editReply({ content: `✅ **Sucesso:** Baixa registrada com sucesso para o precatório \`${precId}\`!` }).catch(() => null);
      } catch (err) {
        console.error('Erro ao dar baixa em precatório:', err);
        await interaction.followUp({ content: '❌ Ocorreu um erro interno ao registrar o pagamento do precatório.', ephemeral: true }).catch(() => null);
      }
      return;
    }

    if (interaction.customId === 'btn_solicitar_prisao') {
      try {
        await interaction.deferReply({ ephemeral: true }).catch(() => null);

        const guild = interaction.guild;
        const channel = interaction.channel;

        // Cria a thread privada de solicitação
        const thread = await channel.threads.create({
          name: `Solicitação-Prisão-${interaction.user.username}`,
          autoArchiveDuration: 1440,
          type: ChannelType.PrivateThread,
          reason: `Solicitação de prisão iniciada por ${interaction.user.tag}`
        });

        // Adiciona o solicitante
        await thread.members.add(interaction.user.id);

        // Busca e adiciona os juízes
        const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
        const juizRole = roles.find(r => r.name === 'J. Dir. | Juiz de Direito');
        if (juizRole) {
          const members = await guild.members.fetch().catch(() => guild.members.cache);
          const juizes = members.filter(m => m.roles.cache.has(juizRole.id));
          for (const [id, member] of juizes) {
            await thread.members.add(id).catch(() => null);
          }
        }

        // Mensagem de boas-vindas na thread
        const welcomeMsg = `👮 **SOLICITAÇÃO DE MANDADO DE PRISÃO**\n\n` +
                           `Esta thread privativa foi aberta para discussão sobre a solicitação de prisão feita pela Autoridade Policial <@${interaction.user.id}>.\n\n` +
                           `* **Solicitante:** <@${interaction.user.id}>\n` +
                           `* **Magistrados Designados:** ${juizRole ? `<@&${juizRole.id}>` : 'Não configurado'}\n\n` +
                           `<@${interaction.user.id}>, envie aqui as informações sobre o acusado, os motivos/crimes, link do processo correspondente e provas para análise judicial.`;

        await thread.send(welcomeMsg).catch(() => null);

        await interaction.editReply({ content: `✅ **Sucesso:** Sala de discussão privada criada: <#${thread.id}>!` }).catch(() => null);
      } catch (err) {
        console.error('Erro ao processar solicitação de prisão:', err);
        await interaction.followUp({ content: '❌ Ocorreu um erro interno ao criar a sala privada de solicitação.', ephemeral: true }).catch(() => null);
      }
      return;
    }

    if (interaction.customId.startsWith('btn_baixar_mandado_')) {
      const mandadoId = interaction.customId.replace('btn_baixar_mandado_', '');
      const guild = interaction.guild;
      const member = interaction.member;

      try {
        const roles = await guild.roles.fetch().catch(() => guild.roles.cache);

        // Permite Juízes de Direito, Delegados e Autoridades Policiais
        const hasAuthorizedRole = member.roles.cache.some(role => {
          const name = role.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          return (
            name.includes('juiz') ||
            name.includes('delegad') ||
            name.includes('polici') ||
            name.includes('autoridade')
          );
        });

        if (!hasAuthorizedRole) {
          return interaction.reply({
            content: '⚠️ **Acesso Negado:** Apenas Juízes de Direito e Autoridades Policiais / Delegados podem revogar ou dar baixa em mandados de prisão.',
            ephemeral: true
          }).catch(() => null);
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => null);

        const message = interaction.message;
        if (!message || message.embeds.length === 0) {
          await interaction.editReply({ content: '❌ Erro: Não foi possível recuperar o mandado original.' }).catch(() => null);
          return;
        }

        const originalEmbed = message.embeds[0];
        
        // Deleta o mandado antigo
        await message.delete().catch(() => null);

        // Atualiza a barra lateral para vermelho e marca como revogado
        const timeStampStr = getFormattedDateTime();
        
        const updatedEmbed = EmbedBuilder.from(originalEmbed)
          .setTitle('👮 MANDADO DE PRISÃO - REVOGADO / DADO BAIXA')
          .setColor(0xe74c3c) // Vermelho
          .addFields({
            name: '🔓 Revogação / Baixa',
            value: `Mandado revogado / dado baixa por <@${interaction.user.id}> em ${timeStampStr}.`,
            inline: false
          });

        // Se a mensagem original possuía botões (como "Ir para o Processo"), nós mantemos o link do processo mas removemos o botão de dar baixa!
        let components = [];
        if (message.components && message.components.length > 0) {
          const actionRow = message.components[0];
          // Procura se tem algum botão link de processo
          const linkButton = actionRow.components.find(c => c.style === 5); // 5 = ButtonStyle.Link em d.js v14
          if (linkButton) {
            const newRow = new ActionRowBuilder().addComponents(
              ButtonBuilder.from(linkButton)
            );
            components = [newRow];
          }
        }

        // Publica no mesmo canal do Governo Federal o relatório/sombra do mandado revogado
        await interaction.channel.send({
          embeds: [updatedEmbed],
          components: components
        });

        // --- EXCLUSÃO AUTOMÁTICA NOS CANAIS EXTERNOS (PF E CORREGEDORIA) ---
        for (const [gId, g] of client.guilds.cache) {
          if (gId === interaction.guild.id) continue;
          try {
            const channels = await g.channels.fetch().catch(() => g.channels.cache);
            const channelsList = safeGetArray(channels).filter(c => c && c.name && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement));

            let targetCh = channelsList.find(c => {
              const nameLow = c.name.toLowerCase();
              return nameLow.includes('solicitar-mandado') || nameLow.includes('pedido-de-mandado');
            });

            if (!targetCh) {
              targetCh = channelsList.find(c => {
                const nameLow = c.name.toLowerCase();
                return nameLow.includes('mandados') || nameLow.includes('mandado');
              });
            }

            if (targetCh) {
              const fetchedMsgs = await targetCh.messages.fetch({ limit: 50 }).catch(() => null);
              if (fetchedMsgs) {
                const msgsToDelete = safeGetArray(fetchedMsgs).filter(m => 
                  m && m.author.id === client.user.id && 
                  m.embeds && m.embeds.length > 0 &&
                  m.embeds.some(e => 
                    (e.description && e.description.includes(mandadoId)) || 
                    (e.fields && e.fields.some(f => f.value && f.value.includes(mandadoId)))
                  )
                );

                for (const delMsg of msgsToDelete) {
                  await delMsg.delete().catch(() => {});
                }
              }
            }
          } catch (e) {
            console.error(`Erro ao apagar mandado transmitido em ${g.name}:`, e);
          }
        }

        await interaction.editReply({ content: `✅ **Sucesso:** Mandado de prisão \`${mandadoId}\` revogado/baixado no BNMP e removido dos canais da PF e Corregedoria!` }).catch(() => null);
      } catch (err) {
        console.error('Erro ao dar baixa em mandado:', err);
        await interaction.followUp({ content: '❌ Ocorreu um erro interno ao registrar a baixa do mandado.', ephemeral: true }).catch(() => null);
      }
      return;
    }
  }

  // TRATAMENTO DE SELEÇÃO DE PROCESSO (SELECT MENU)
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'select_processo_mandado') {
      try {
        const threadId = interaction.values[0];

        const modal = new ModalBuilder()
          .setCustomId(`modal_registrar_mandado_${threadId}`)
          .setTitle('Registrar Mandado de Prisão');

        const inputNome = new TextInputBuilder()
          .setCustomId('input_nome')
          .setLabel('Nome in-game do Acusado')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('Ex: Joaozinho_BR');

        const inputMotivo = new TextInputBuilder()
          .setCustomId('input_motivo')
          .setLabel('Motivo / Artigo / Crime')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('Descreva os motivos e artigos que fundamentam a prisão...');

        const inputProcesso = new TextInputBuilder()
          .setCustomId('input_processo')
          .setLabel('Link ou Nº do Processo (Opcional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('Insira o link ou número caso queira customizar...');

        const inputAnalise = new TextInputBuilder()
          .setCustomId('input_analise_promotores')
          .setLabel('Notificar Promotores para Criar Processo?')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('Digite Sim para expedir Ofício aos Promotores de Justiça (se sem processo)');

        modal.addComponents(
          new ActionRowBuilder().addComponents(inputNome),
          new ActionRowBuilder().addComponents(inputMotivo),
          new ActionRowBuilder().addComponents(inputProcesso),
          new ActionRowBuilder().addComponents(inputAnalise)
        );

        await interaction.showModal(modal).catch(err => {
          console.error('[BNMP] Erro ao abrir modal após select:', err);
        });
      } catch (err) {
        console.error('[BNMP] Erro na seleção do processo:', err);
        await interaction.reply({
          content: '❌ Ocorreu um erro interno ao carregar o formulário.',
          ephemeral: true
        }).catch(() => null);
      }
      return;
    }
  }

  // TRATAMENTO DE ENVIO DE FORMULÁRIO (MODAL SUBMIT)
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('modal_registrar_mandado')) {
      try {
        await interaction.deferReply({ ephemeral: true }).catch(() => null);

        const threadId = interaction.customId.includes('_') ? interaction.customId.split('_').pop() : 'none';
        const nome = interaction.fields.getTextInputValue('input_nome');
        const motivo = interaction.fields.getTextInputValue('input_motivo');
        const inputProcessoVal = interaction.fields.getTextInputValue('input_processo') || '';
        let inputAnaliseVal = '';
        try {
          inputAnaliseVal = interaction.fields.getTextInputValue('input_analise_promotores') || '';
        } catch (e) {}

        const mandadoId = `MP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
        const timeStamp = getFormattedDateTime();

        let threadUrl = "";
        let processDisplay = "";

        // Se uma thread foi selecionada pelo dropdown
        if (threadId && threadId !== 'none') {
          const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
          if (thread) {
            threadUrl = thread.url;
            processDisplay = `[${thread.name}](${thread.url})`;
          }
        }

        // Se o usuário preencheu o campo de processo manualmente no modal, dá prioridade
        if (inputProcessoVal.trim() !== '') {
          const val = inputProcessoVal.trim();
          if (val.startsWith('http://') || val.startsWith('https://')) {
            threadUrl = val;
            processDisplay = `[Processo](${val})`;
          } else {
            processDisplay = val;
          }
        }

        const embed = new EmbedBuilder()
          .setTitle('🚨 MANDADO DE PRISÃO EXPEDIDO')
          .setColor(0xd9534f)
          .addFields(
            { name: '📂 Mandado Nº', value: `\`${mandadoId}\``, inline: true },
            { name: '👤 Acusado (Roblox)', value: `\`${nome}\``, inline: true },
            { name: '⚖️ Autoridade Emissora', value: `<@${interaction.user.id}>`, inline: true },
            { name: '📝 Motivo / Crime', value: motivo, inline: false },
            { name: '📅 Data de Expedição', value: timeStamp, inline: true }
          )
          .setTimestamp()
          .setFooter({ text: 'Banco Nacional de Mandados de Prisão' });

        if (processDisplay !== "") {
          embed.addFields({ name: '📜 Processo Associado', value: processDisplay, inline: false });
        }

        latestWarrant = {
          id: mandadoId,
          nome: nome,
          motivo: motivo,
          emissor: interaction.user.username,
          timeStamp: timeStamp,
          processUrl: threadUrl
        };

        openWarrants.push(latestWarrant);
        if (openWarrants.length > 20) {
          openWarrants.shift();
        }

        const hasValidUrl = threadUrl.startsWith('http://') || threadUrl.startsWith('https://');

        const row = new ActionRowBuilder();
        if (hasValidUrl) {
          row.addComponents(
            new ButtonBuilder()
              .setLabel('Ir para o Processo')
              .setStyle(ButtonStyle.Link)
              .setURL(threadUrl)
          );
        }
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`btn_baixar_mandado_${mandadoId}`)
            .setLabel('Dar Baixa em Mandado')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔓')
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });

        // --- TRANSMISSÃO AUTOMÁTICA DO MANDADO PARA PF E CORREGEDORIA ---
        try {
          const bnmpUrl = interaction.channel.url || `https://discord.com/channels/${interaction.guild.id}/${interaction.channel.id}`;

          const externalEmbed = EmbedBuilder.from(embed)
            .addFields({
              name: '⚠️ INSTRUÇÃO PARA BAIXA OFICIAL DE MANDADO',
              value: `Para efetuar a baixa ou revogação deste mandado de prisão, acesse o **BNMP no Governo Federal**:\n👉 [**Clique Aqui para Acessar o BNMP no Governo Federal**](${bnmpUrl}) e utilize a opção de Dar Baixa.`,
              inline: false
            });

          const externalRow = new ActionRowBuilder();
          if (hasValidUrl) {
            externalRow.addComponents(
              new ButtonBuilder()
                .setLabel('Ir para o Processo')
                .setStyle(ButtonStyle.Link)
                .setURL(threadUrl)
            );
          }
          externalRow.addComponents(
            new ButtonBuilder()
              .setLabel('🏛️ Acessar BNMP no Governo Federal')
              .setStyle(ButtonStyle.Link)
              .setURL(bnmpUrl)
          );

          for (const [gId, g] of client.guilds.cache) {
            if (gId === interaction.guild.id) continue;
            try {
              const channels = await g.channels.fetch().catch(() => g.channels.cache);
              const channelsList = safeGetArray(channels).filter(c => c && c.name && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement));

              let targetCh = channelsList.find(c => {
                const nameLow = c.name.toLowerCase();
                return nameLow.includes('solicitar-mandado') || nameLow.includes('pedido-de-mandado');
              });

              if (!targetCh) {
                targetCh = channelsList.find(c => {
                  const nameLow = c.name.toLowerCase();
                  return nameLow.includes('mandados') || nameLow.includes('mandado');
                });
              }

              if (targetCh) {
                await targetCh.send({
                  embeds: [externalEmbed],
                  components: [externalRow]
                }).catch(err => console.error(`Erro ao enviar mandado transmitido para ${g.name}:`, err));
              }
            } catch (e) {
              console.error(`Erro ao buscar canais de mandado em ${g.name}:`, e);
            }
          }
        } catch (bcastErr) {
          console.error('Erro na transmissão do mandado para PF e Corregedoria:', bcastErr);
        }

        // Se NÃO houver processo vinculado E o Juiz marcou a necessidade de processo
        let notifiedPromotores = false;
        const solicitarAnalise = inputAnaliseVal.trim().toLowerCase().startsWith('s');

        if (processDisplay === "" && solicitarAnalise) {
          try {
            const roles = await interaction.guild.roles.fetch().catch(() => interaction.guild.roles.cache);
            const rolesArray = safeGetArray(roles);
            const promotorRole = rolesArray.find(r => r && r.name && (r.name === 'Prom. J | Promotor de Justiça' || matchChannel(r.name, 'promotor')));

            const peticionamentoChannel = interaction.guild.channels.cache.find(c => c && c.name && matchChannel(c.name, 'peticionamento-eletrônico'));
            const peticionamentoMention = peticionamentoChannel ? `<#${peticionamentoChannel.id}>` : '`#peticionamento-eletrônico`';

            const oficioPromotores = `=========================================\n` +
                                     `⚖️ **OFÍCIO / ATO ORDINATÓRIO - ANÁLISE DE NECESSIDADE PROCESSUAL**\n` +
                                     `📅 *Expedido em: ${timeStamp}*\n\n` +
                                     `> **Determinação Judicial (Juiz <@${interaction.user.id}>):**\n` +
                                     `> Determino à Douta Promotoria de Justiça a análise quanto à necessidade de autuação e instauração de Ação Penal / Processo Judicial decorrente do Mandado de Prisão expedido sem processo vinculado.\n\n` +
                                     `📋 **DADOS DO MANDADO DE PRISÃO (BNMP):**\n` +
                                     `* **📂 Mandado Nº:** \`${mandadoId}\`\n` +
                                     `* **👤 Acusado (Roblox):** \`${nome}\`\n` +
                                     `* **📝 Motivo / Crime:** ${motivo}\n` +
                                     `* **🚨 Status:** Mandado Expedido no BNMP sem Processo Associado\n\n` +
                                     `📌 **Determinação:** Havendo necessidade de autuação da causa, proceda ao devido peticionamento no canal ${peticionamentoMention}.\n` +
                                     `=========================================`;

            if (promotorRole) {
              const members = await interaction.guild.members.fetch().catch(() => interaction.guild.members.cache);
              const membersArray = safeGetArray(members);
              const promotores = membersArray.filter(m => m && m.roles && m.roles.cache.has(promotorRole.id));

              for (const promotorMember of promotores) {
                try {
                  await promotorMember.user.send(oficioPromotores).catch(() => null);
                } catch (e) {}
              }
              if (promotores.length > 0) notifiedPromotores = true;
            }
          } catch (errProm) {
            console.error('[BNMP] Erro ao expedir ofício aos promotores:', errProm);
          }
        }

        const replyContent = notifiedPromotores
          ? '✅ **Mandado de Prisão expedido com sucesso!** ⚖️ **Ofício expedido privativamente aos Promotores de Justiça notificando a necessidade de análise processual.**'
          : '✅ **Mandado de Prisão expedido e publicado com sucesso no canal!**';

        await interaction.editReply({
          content: replyContent
        }).catch(() => null);

      } catch (err) {
        console.error('[BNMP] Erro ao registrar mandado de prisão via modal:', err);
        await interaction.editReply({
          content: '❌ Ocorreu um erro interno ao processar o mandado.'
        }).catch(() => null);
      }
    }
  }
});

// ATUALIZAÇÃO DO RELATÓRIO DE JUÍZES EM TEMPO REAL
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const roles = await newMember.guild.roles.fetch().catch(() => newMember.guild.roles.cache);
    const juizRole = roles.find(r => r.name === 'J. Dir. | Juiz de Direito');
    if (juizRole) {
      const hadRole = oldMember.roles.cache.has(juizRole.id);
      const hasRole = newMember.roles.cache.has(juizRole.id);
      if (hadRole !== hasRole) {
        console.log(`[Juízes Relatório] Alteração de cargo detectada para ${newMember.user.tag}. Atualizando painel...`);
        updateJuizesWorkload(newMember.guild).catch(err => console.error('Erro ao atualizar workload dos juízes no memberUpdate:', err));
      }
    }
  } catch (err) {
    console.error('Erro no evento guildMemberUpdate:', err);
  }
});

client.on('guildMemberRemove', async (member) => {
  try {
    console.log(`[Juízes Relatório] Membro ${member.user.tag} saiu do servidor. Atualizando painel...`);
    updateJuizesWorkload(member.guild).catch(err => console.error('Erro ao atualizar workload dos juízes no memberRemove:', err));
  } catch (err) {
    console.error('Erro no evento guildMemberRemove:', err);
  }
});

// --- Servidor Web Express para Integração com o Roblox ---
const app = express();
app.use(express.json());

// Middleware de Log para diagnóstico no Render
app.use((req, res, next) => {
  console.log(`[HTTP Request] ${req.method} ${req.url} - IP: ${req.ip} - User-Agent: ${req.headers['user-agent']}`);
  next();
});

// Rota GET / para monitoramento de atividade (uptime check)
app.get('/', (req, res) => {
  res.status(200).send('Bot de integração do Governo Federal está online e operacional!');
});

// Endpoint para receber Auditoria de Votação do Roblox
// Endpoint para receber Auditoria de Votação do Roblox (Resumo dos Resultados)
app.post('/submit-auditoria', async (req, res) => {
  const { titulo, sim, nao, abstencao, resultado, votosNominais } = req.body;
  
  if (!titulo) {
    return res.status(400).json({ success: false, error: 'Título da votação é obrigatório.' });
  }

  try {
    let sent = false;
    for (const [guildId, guild] of client.guilds.cache) {
      // Busca ativa de canais com fetch para garantir cache atualizado
      const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
      const channel = channels.find(c => c && c.name && matchChannel(c.name, 'painel-de-votação') && c.isTextBased());
      
      if (channel) {
        // Formata a lista de votos nominais
        let nominalsText = 'Nenhum voto registrado.';
        if (votosNominais && votosNominais.length > 0) {
          nominalsText = votosNominais.map(v => `• **${v.nome}**: ${v.voto}`).join('\n');
          // Limita para não estourar os limites do campo de embed do Discord (1024 caracteres)
          if (nominalsText.length > 1000) {
            nominalsText = nominalsText.substring(0, 997) + '...';
          }
        }

        const embed = new EmbedBuilder()
          .setTitle('🏛️ AUDITORIA DE VOTAÇÃO - CONGRESSO NACIONAL')
          .setDescription(`A sessão de votação **"${titulo}"** foi encerrada no Plenário do Roblox.`)
          .setColor(resultado.includes('APROVADO') ? 0x2ecc71 : (resultado.includes('REJEITADO') ? 0xe74c3c : 0xf1c40f))
          .addFields(
            { name: '📋 Título da Sessão', value: `\`${titulo}\``, inline: false },
            { name: '🟢 Votos SIM', value: `**${sim}**`, inline: true },
            { name: '🔴 Votos NÃO', value: `**${nao}**`, inline: true },
            { name: '🟡 Abstenções', value: `**${abstencao}**`, inline: true },
            { name: '👥 Votos Nominais', value: nominalsText, inline: false },
            { name: '⚖️ Resultado Final', value: `**${resultado}**`, inline: false }
          )
          .setTimestamp()
          .setFooter({ text: 'Sistema de Auditoria Eletrônica do Congresso' });

        await channel.send({ embeds: [embed] });
        sent = true;
      }
    }

    if (sent) {
      return res.json({ success: true });
    } else {
      console.warn('[Web Server] Canal "painel-de-votação" não encontrado em nenhum servidor.');
      return res.status(404).json({ success: false, error: 'Canal "painel-de-votação" não encontrado.' });
    }
  } catch (error) {
    console.error('[Web Server] Erro ao enviar auditoria para o Discord:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para receber Notificação de Início de Votação do Roblox
app.post('/start-votacao', async (req, res) => {
  const { titulo } = req.body;
  
  if (!titulo) {
    return res.status(400).json({ success: false, error: 'Título da votação é obrigatório.' });
  }

  try {
    let sent = false;
    for (const [guildId, guild] of client.guilds.cache) {
      // Busca ativa de canais com fetch para garantir cache atualizado
      const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
      const channel = channels.find(c => c && c.name && matchChannel(c.name, 'mesa-diretora-cn') && c.isTextBased());
      
      if (channel) {
        const embed = new EmbedBuilder()
          .setTitle('🏛️ SESSÃO DE VOTAÇÃO INICIADA')
          .setDescription(`Uma nova sessão de votação foi iniciada no Plenário do Roblox pela Presidência.`)
          .setColor(0x3498db)
          .addFields(
            { name: '📋 Projeto / Matéria', value: `\`${titulo}\``, inline: false },
            { name: '🚥 Status', value: '🟢 **Votação em Andamento**', inline: true }
          )
          .setTimestamp()
          .setFooter({ text: 'Mesa Diretora do Congresso Nacional' });

        await channel.send({ embeds: [embed] });
        sent = true;
      }
    }

    if (sent) {
      return res.json({ success: true });
    } else {
      console.warn('[Web Server] Canal "mesa-diretora-cn" não encontrado em nenhum servidor.');
      return res.status(404).json({ success: false, error: 'Canal "mesa-diretora-cn" não encontrado.' });
    }
  } catch (error) {
    console.error('[Web Server] Erro ao enviar início de votação para o Discord:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para fornecer o último mandado de prisão para o Roblox
app.get('/latest-warrant', (req, res) => {
  res.json(latestWarrant);
});

// Endpoint para fornecer todos os mandados de prisão em aberto para o Roblox
app.get('/open-warrants', (req, res) => {
  res.json(openWarrants);
});

// Endpoint de B.O. (Boletim de Ocorrência) para integração do Roblox
app.post('/submit-bo', async (req, res) => {
  const { robloxName, discordName, denuncia } = req.body;
  try {
    let sent = false;
    for (const [guildId, guild] of client.guilds.cache) {
      const channel = guild.channels.cache.find(c => 
        c && c.name && (matchChannel(c.name, 'boletim-de-ocorrência') || matchChannel(c.name, 'bo'))
      );
      if (channel && channel.isTextBased()) {
        const embed = new EmbedBuilder()
          .setTitle('👮 NOVO BOLETIM DE OCORRÊNCIA')
          .setColor(0x34495e)
          .addFields(
            { name: '👤 Nome Roblox', value: robloxName || 'Não informado', inline: true },
            { name: '💬 Discord', value: discordName || 'Não informado', inline: true },
            { name: '📝 Denúncia/Ocorrência', value: denuncia || 'Sem descrição' }
          )
          .setTimestamp();
        await channel.send({ embeds: [embed] });
        sent = true;
      }
    }
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Web Server] Servidor de integração HTTP rodando na porta ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
