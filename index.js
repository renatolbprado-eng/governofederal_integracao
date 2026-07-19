import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Collection, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

// Cache global em memória para a carga de trabalho dos juízes
const juizWorkloadsCache = {};

// Cache global em memória para o último mandado de prisão expedido
let latestWarrant = {
  id: "",
  nome: "",
  motivo: "",
  emissor: "",
  timeStamp: ""
};

// Lista de todos os mandados de prisão em aberto
let openWarrants = [];

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

// Helper dinâmico para buscar envolvidos (incluindo advogados de ambos os lados) a partir do Embed Inicial
async function getProcessParties(thread) {
  try {
    const msgs = await thread.messages.fetch({ limit: 50 });
    const botEmbedMsg = msgs.filter(m => m.author.id === client.user.id && m.embeds.length > 0)
                             .sort((a, b) => a.createdTimestamp - b.createdTimestamp).first();
    if (!botEmbedMsg) return null;

    const embed = botEmbedMsg.embeds[0];
    const processIdField = embed.fields.find(f => f.name.includes('Número do Processo'));
    const processId = processIdField ? processIdField.value.replace(/`/g, '') : 'Não identificado';
    
    const typeField = embed.fields.find(f => f.name.includes('Classe Processual'));
    const type = typeField ? typeField.value : 'Ação judicial';

    const authorField = embed.fields.find(f => f.name.includes('Discord do Autor'));
    const defendantField = embed.fields.find(f => f.name.includes('Discord do Réu'));

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
    const authorLawyersField = embed.fields.find(f => f.name.includes('Advogado(s) do Autor'));
    const authorLawyers = [];
    if (authorLawyersField) {
      const matches = [...authorLawyersField.value.matchAll(/<@!?(\d+)>/g)];
      for (const match of matches) {
        const user = await client.users.fetch(match[1]).catch(() => null);
        if (user) authorLawyers.push(user);
      }
    }

    // Busca Advogados do Réu
    const defendantLawyersField = embed.fields.find(f => f.name.includes('Advogado(s) do Réu'));
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

// Inicializa a contagem de processos em cache na inicialização do bot
async function initializeJuizesWorkload(guild) {
  try {
    const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
    const rolesArray = safeGetArray(roles);
    const juizRole = rolesArray.find(r => r && r.name === 'J. Dir. | Juiz de Direito');
    if (!juizRole) return;

    // Busca ativa dos juízes com fallbacks
    let members = await guild.members.fetch({ force: true }).catch(() => null);
    if (!members) members = juizRole.members;
    if (!members) members = guild.members.cache;

    const membersArray = safeGetArray(members);
    const juizes = membersArray.filter(m => m && m.roles && m.roles.cache && m.roles.cache.has(juizRole.id));

    // Zera o cache antes da varredura
    for (const member of juizes) {
      juizWorkloadsCache[member.id] = 0;
    }

    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const channelsArray = safeGetArray(channels);
    const peticoesChannel = channelsArray.find(c => c && c.name && matchChannel(c.name, 'petições'));
    const peticionamentoChannel = channelsArray.find(c => c && c.name && matchChannel(c.name, 'peticionamento-eletrônico'));

    const allThreads = [];

    // Coleta do Fórum
    if (peticoesChannel && peticoesChannel.type === ChannelType.GuildForum) {
      const active = await peticoesChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
      const archived = await peticoesChannel.threads.fetchArchived({ limit: 50 }).catch(() => ({ threads: new Map() }));
      allThreads.push(...safeGetArray(active.threads), ...safeGetArray(archived.threads));
    }

    // Coleta de Segredo
    if (peticionamentoChannel) {
      const active = await peticionamentoChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
      const archived = await peticionamentoChannel.threads.fetchArchived({ limit: 50 }).catch(() => ({ threads: new Map() }));
      allThreads.push(...safeGetArray(active.threads), ...safeGetArray(archived.threads));
    }

    const processThreads = allThreads.filter(t => t.name.includes('PROC-') || t.name.includes('🔒 SEGREDO'));

    // Varre cada thread sequencialmente para contar
    for (const thread of processThreads) {
      try {
        const msgs = await thread.messages.fetch({ limit: 5 }).catch(() => null);
        if (!msgs) continue;
        const msgsArray = safeGetArray(msgs);
        const distMsg = msgsArray.find(m => m && m.content && m.content.includes('Sorteio de Magistrado:'));
        if (distMsg) {
          const match = distMsg.content.match(/Sorteio de Magistrado:.*?<@!?(\d+)>/i);
          if (match && match[1]) {
            const juizId = match[1];
            if (juizId in juizWorkloadsCache) {
              juizWorkloadsCache[juizId]++;
            }
          }
        }
      } catch (err) {
        // Ignora erros de canais/mensagens indisponíveis
      }
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

    // Formata o relatório
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

    // Atualiza a mensagem no canal "Juízes"
    const channelMsgs = await juizesChannel.messages.fetch({ limit: 20 }).catch(() => []);
    const channelMsgsArray = safeGetArray(channelMsgs);
    const botMsg = channelMsgsArray.find(m => m && m.author && m.author.id === client.user.id && m.content.includes('RELATÓRIO DE DISTRIBUIÇÃO'));

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

    console.log(`[Juízes Relatório] Relatório atualizado no canal #${juizesChannel.name} de ${guild.name}.`);
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
        .setDescription('Painel de controle para emissão de Mandados de Prisão.\n\nApenas **Juízes de Direito** possuem permissão para registrar mandados.')
        .setColor(0x2f3136)
        .setTimestamp()
        .setFooter({ text: 'Tribunal de Justiça - Governo Federal' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('btn_registrar_mandado')
          .setLabel('Registrar novo Mandado de Prisão')
          .setStyle(ButtonStyle.Danger)
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
      console.log(`[BNMP] Painel de controle já está presente e fixado no canal #${bnmpChannel.name} de ${guild.name}.`);
    }
  } catch (err) {
    console.error('[BNMP] Erro ao inicializar canal do BNMP:', err);
  }
}

client.once('ready', async () => {
  console.log(`Bot de Peticionamento conectado com sucesso como: ${client.user.tag}`);
  
  try {
    const guilds = await client.guilds.fetch();
    for (const [guildId] of guilds) {
      const guild = await client.guilds.fetch(guildId);
      
      // Inicializa o cache de juízes e depois atualiza o relatório
      await initializeJuizesWorkload(guild).catch(() => null);
      await updateJuizesWorkload(guild).catch(() => null);
      await initializeBNMP(guild).catch(() => null);
    }
  } catch (err) {
    console.error('Erro no startup:', err);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // LÓGICA DE REGISTRO DE ADVOGADOS & COMANDO !INTIMAR (Thread do Processo)
  if (message.channel.isThread()) {
    const content = message.content.trim();

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

        // Busca o Embed da thread atual
        const msgs = await message.channel.messages.fetch({ limit: 50 });
        const botEmbedMsg = msgs.filter(m => m.author.id === client.user.id && m.embeds.length > 0)
                                 .sort((a, b) => a.createdTimestamp - b.createdTimestamp).first();

        if (botEmbedMsg) {
          const originalEmbed = botEmbedMsg.embeds[0];
          const newEmbed = EmbedBuilder.from(originalEmbed);
          // Atualiza o campo Segredo de Justiça no embed
          const fields = originalEmbed.fields.filter(f => f.name !== '🔒 Segredo de Justiça');
          newEmbed.setFields(fields);
          newEmbed.addFields({ name: '🔒 Segredo de Justiça', value: 'Sim', inline: true });

          await newPrivateThread.send({
            content: `🔒 **PROCESSO EM SEGREDO DE JUSTIÇA**\nDecretado por decisão judicial de <@${message.author.id}>.`,
            embeds: [newEmbed]
          });
        }

        await message.channel.send(`🔒 **Segredo de Justiça Decretado:** Este processo foi tornado sigiloso por decisão judicial de <@${message.author.id}>.\nOs autos foram migrados com segurança para uma thread privada.\n*Esta thread pública será apagada em 10 segundos.*`).catch(() => null);

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

    // COMANDO !INTIMAR
    if (content.toLowerCase().startsWith('!intimar')) {
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

    // COMANDO !ADV (Adição interativa de advogados)
    if (content.toLowerCase() === '!adv') {
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
          content: `⚖️ **Cartório Judicial:** Mencione todos os advogados a serem adicionados à **${poloName}**:`
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

        // Atualização do Embed
        const msgs = await message.channel.messages.fetch({ limit: 50 });
        const botEmbedMsg = msgs.filter(m => m.author.id === client.user.id && m.embeds.length > 0)
                                 .sort((a, b) => a.createdTimestamp - b.createdTimestamp).first();

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
  }

  // LÓGICA DE INICIALIZAÇÃO DO PETICIONAMENTO (Canal Principal)
  const isTargetChannel = message.channel && message.channel.name && matchChannel(message.channel.name, 'peticionamento-eletrônico');

  if (isTargetChannel) {
    await message.delete().catch(() => null);
  }
});

// Wizard Interativo
async function runPetitionWizard(thread, authorId) {
  const data = {
    type: '',
    isSecret: false,
    authorName: '',
    defendantName: '',
    discordAuthor: null, // Objeto User
    discordDefendant: null, // Objeto User
    discordAuthorRaw: 'Não informado',
    discordDefendantRaw: 'Não informado',
    petitionText: '',
    petitionAttachments: []
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
    // 1. Tipo de Processo (Buttons)
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

    data.isSecret = false;

    // 3. Nome do Autor
    const authMsg = await askQuestion('Digite o **Nome da parte Autora / Exequente**:');
    if (!authMsg) return timeout();
    data.authorName = authMsg.content.trim();

    // 4. Nome do Réu
    const defMsg = await askQuestion('Digite o **Nome da parte Ré / Executada**:');
    if (!defMsg) return timeout();
    data.defendantName = defMsg.content.trim();

    // 5. Discord do Autor (Opcional)
    const discAuthMsg = await askQuestion('Mencione o Discord da **parte Autora/Exequente** (ou digite **"nenhum"** para pular):');
    if (!discAuthMsg) return timeout();
    const parsedAuth = parseOptionalDiscordUser(discAuthMsg);
    data.discordAuthor = parsedAuth.user;
    data.discordAuthorRaw = parsedAuth.raw;

    // 6. Discord do Réu (Opcional)
    const discDefMsg = await askQuestion('Mencione o Discord da **parte Ré/Executada** (ou digite **"nenhum"** para pular):');
    if (!discDefMsg) return timeout();
    const parsedDef = parseOptionalDiscordUser(discDefMsg);
    data.discordDefendant = parsedDef.user;
    data.discordDefendantRaw = parsedDef.raw;

    // 7. Petição Inicial (Obrigatória - Texto e/ou Anexos)
    let petitionMsg = null;
    while (!petitionMsg) {
      const tempMsg = await askQuestion('Envie a sua **Petição Inicial** (você pode digitar o texto e/ou anexe o arquivo PDF/imagem correspondente):');
      if (!tempMsg) return timeout();
      
      const hasText = tempMsg.content.trim().length > 0;
      const hasFiles = tempMsg.attachments.size > 0;
      
      if (hasText || hasFiles) {
        petitionMsg = tempMsg;
        data.petitionText = tempMsg.content.trim() || 'Ver arquivo(s) anexo(s) abaixo.';
        data.petitionAttachments = tempMsg.attachments.map(a => a.url);
      } else {
        await thread.send('⚠️ Você precisa enviar um texto ou um arquivo contendo a petição inicial!');
      }
    }

    // Geração do Processo
    const processId = `PROC-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

    // Criar Embed oficial
    const embed = new EmbedBuilder()
      .setTitle(`${data.isSecret ? '🔒 SEGREDO DE JUSTIÇA - ' : '⚖️ '}PROCESSO AUTUADO`)
      .setDescription(`Novo processo judicial peticionado eletronicamente pelo advogado <@${authorId}>.`)
      .setColor(data.isSecret ? 0xd9534f : 0x2f3136)
      .addFields(
        { name: '📂 Número do Processo', value: `\`${processId}\``, inline: true },
        { name: '📋 Classe Processual', value: data.type || 'Não informado', inline: true },
        { name: '🔒 Segredo de Justiça', value: data.isSecret ? 'Sim' : 'Não', inline: true },
        { name: '\u200B', value: '\u200B', inline: false },
        { name: '👤 Parte Autora (Exequente)', value: data.authorName || 'Não informado', inline: true },
        { name: '💬 Discord do Autor', value: data.discordAuthorRaw || 'Não informado', inline: true },
        { name: '\u200B', value: '\u200B', inline: false },
        { name: '👤 Parte Ré (Executada)', value: data.defendantName || 'Não informado', inline: true },
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
          targetThread = await peticoesChannel.threads.create({
            name: finalThreadName,
            autoArchiveDuration: 60,
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
      
      // Busca ativa de cargos para evitar falhas de cache
      const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
      const juizRole = roles.find(r => r.name === 'J. Dir. | Juiz de Direito');
      const promotorRole = roles.find(r => r.name === 'Prom. J | Promotor de Justiça');
      const promotorMention = promotorRole ? `<@&${promotorRole.id}>` : '@Prom. J | Promotor de Justiça';

      // Sorteio de magistrado do Judiciário com fetching forçado e logs
      let selectedJuizMention = 'Não designado';
      if (juizRole) {
        try {
          const members = await guild.members.fetch({ force: true }).catch(() => null);
          const membersArray = safeGetArray(members);
          const juizes = membersArray.filter(m => m && m.roles && m.roles.cache && m.roles.cache.has(juizRole.id));
          
          console.log(`[Juízes Sorteio] Procurando membros com cargo "${juizRole.name}"...`);
          console.log(`[Juízes Sorteio] Juízes encontrados no servidor: ${juizes.map(m => m.user.tag).join(', ')}`);
          
          if (juizes && juizes.length > 0) {
            const randomJuiz = juizes[Math.floor(Math.random() * juizes.length)];
            selectedJuizMention = `<@${randomJuiz.id}>`;

            // Incrementa o contador do juiz sorteado no cache em memória
            if (randomJuiz.id in juizWorkloadsCache) {
              juizWorkloadsCache[randomJuiz.id]++;
            } else {
              juizWorkloadsCache[randomJuiz.id] = 1;
            }
          } else {
            // Fallback para menção do cargo caso não encontre membros individuais
            selectedJuizMention = `<@&${juizRole.id}>`;
          }
        } catch (fetchErr) {
          console.error('Erro ao buscar membros para sorteio do Juiz:', fetchErr);
          selectedJuizMention = `<@&${juizRole.id}>`;
        }
      } else {
        selectedJuizMention = 'Não designado (Cargo de Juiz de Direito não encontrado)';
      }

      // Movimentação Inicial Unificada
      const unifiedMov = `=========================================\n` +
                         `🏛️ **DISTRIBUIÇÃO E CITAÇÃO - CARTÓRIO JUDICIAL**\n` +
                         `📅 *Movimentação em: ${timeStamp}*\n\n` +
                         `> ⚖️ **Sorteio de Magistrado:** O processo foi distribuído por sorteio automático ao Excelentíssimo Senhor Juiz de Direito: ${selectedJuizMention}.\n` +
                         `> \n` +
                         `> 📂 **Recebimento e Distribuição:** Processo autuado e distribuído. Aguardando designação e manifestação do magistrado designado, bem como do Ministério Público (${promotorMention}).\n` +
                         `> \n` +
                         `> 📌 **Instruções para as partes:**\n` +
                         `> 1. *Parte Autora:* Anexe nesta thread quaisquer documentos ou provas que julgar necessárias para o prosseguimento.\n` +
                         `> 2. *Registro de Procuradores:* O advogado de qualquer um dos polos deve declarar-se enviando o comando \`!adv\` nesta thread.\n` +
                         `>    *(As mensagens do comando serão ocultadas automaticamente e os nomes inseridos na autuação).* \n\n` +
                         `📢 **Certidão de Citação:** Iniciada a citação de todas as partes envolvidas. Os mandados de citação contendo instruções detalhadas de defesa/manifestação já foram expedidos e enviados via mensagem direta (DM) privada para os Discords informados.\n` +
                         `=========================================`;

      await targetThread.send(unifiedMov).catch(() => null);

      // Envio de Citação e Instruções por DM para os envolvidos (com nome do servidor e canal/thread)
      
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
            `2. **Importante:** Utilize o comando \`!adv\` na thread do processo para vincular seus advogados de defesa à autuação.\n` +
            `3. Anexe os documentos e provas que desejar na respectiva thread.`
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
            `* **Autor/Exequente:** ${data.authorName}\n` +
            `* **Réu/Executado:** ${data.defendantName}\n\n` +
            `**O que fazer:**\n` +
            `1. Acesse o processo no link acima (se for Segredo de Justiça, você foi adicionado à thread privada).\n` +
            `2. **Importante:** Utilize o comando \`!adv\` na thread do processo para vincular seus advogados de defesa à autuação.\n` +
            `3. Aguarde a manifestação e o despacho do Juiz de Direito designado para o caso antes de enviar qualquer defesa formal na thread.`
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
  if (interaction.isButton()) {
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

    if (interaction.customId === 'btn_peticionar') {
      try {
        await interaction.deferReply({ ephemeral: true }).catch(() => null);

        const channel = interaction.channel;
        const thread = await channel.threads.create({
          name: `Petição - ${interaction.user.username}`,
          autoArchiveDuration: 60,
          type: ChannelType.PrivateThread,
          reason: `Peticionamento eletrônico iniciado por ${interaction.user.tag}`,
        });

        await thread.members.add(interaction.user.id);
        await thread.send(`Olá <@${interaction.user.id}>! Iniciando seu peticionamento eletrônico confidencial.`);
        
        runPetitionWizard(thread, interaction.user.id);

        await interaction.editReply({ content: `✅ Thread privada criada com sucesso: <#${thread.id}>!` }).catch(() => null);

      } catch (err) {
        console.error('Erro ao iniciar petição via botão:', err);
        await interaction.followUp({ content: 'Ocorreu um erro ao tentar criar a thread privada. Certifique-se de que o bot tem permissão de "Criar Threads Privadas" no canal.', ephemeral: true }).catch(() => null);
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

        // Cria o Modal
        const modal = new ModalBuilder()
          .setCustomId('modal_registrar_mandado')
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

        modal.addComponents(
          new ActionRowBuilder().addComponents(inputNome),
          new ActionRowBuilder().addComponents(inputMotivo)
        );

        await interaction.showModal(modal).catch(err => {
          console.error('[BNMP] Erro ao abrir modal de mandado:', err);
        });
      } catch (err) {
        console.error('[BNMP] Erro na interação do botão de mandado:', err);
        await interaction.reply({
          content: '❌ Ocorreu um erro interno ao tentar abrir o formulário.',
          ephemeral: true
        }).catch(() => null);
      }
      return;
    }
  }

  // TRATAMENTO DE ENVIO DE FORMULÁRIO (MODAL SUBMIT)
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'modal_registrar_mandado') {
      try {
        await interaction.deferReply({ ephemeral: true }).catch(() => null);

        const nome = interaction.fields.getTextInputValue('input_nome');
        const motivo = interaction.fields.getTextInputValue('input_motivo');

        const mandadoId = `MP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
        const timeStamp = getFormattedDateTime();

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

        latestWarrant = {
          id: mandadoId,
          nome: nome,
          motivo: motivo,
          emissor: interaction.user.username,
          timeStamp: timeStamp
        };

        openWarrants.push(latestWarrant);
        if (openWarrants.length > 20) {
          openWarrants.shift();
        }

        await interaction.channel.send({ embeds: [embed] });

        await interaction.editReply({
          content: '✅ **Mandado de Prisão expedido e publicado com sucesso no canal!**'
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
