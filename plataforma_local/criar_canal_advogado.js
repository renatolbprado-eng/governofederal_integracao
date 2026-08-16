// Script de Execução Única: Criar canal "solicite-advogado" abaixo de "chat" e publicar o Embed de Ticket

console.log("=== INICIANDO CRIAÇÃO DO CANAL SOLICITE-ADVOGADO ===");

// 1. Buscar canais e localizar o "chat" com resiliência a emojis
const channels = await guild.channels.fetch();

let chatChannel = null;
channels.forEach(ch => {
  if (!ch) return;
  const cleanName = ch.name.toLowerCase().replace(/[^\w\s-]/g, '').trim();
  if (cleanName === 'chat' || ch.name.toLowerCase().includes('chat')) {
    // Dá preferência ao canal de chat da categoria INTERAÇÕES se houver múltiplos
    if (!chatChannel || (ch.parentId === '1526311750759219365')) {
      chatChannel = ch;
    }
  }
});

if (!chatChannel) {
  throw new Error("Não foi possível encontrar o canal 'chat' no servidor!");
}

console.log(`📌 Canal de referência encontrado: "${chatChannel.name}" (ID: ${chatChannel.id})`);
console.log(`📌 Categoria do chat: ${chatChannel.parentId} | Posição atual: ${chatChannel.position}`);

// 2. Extrair o prefixo de emoji do canal "chat" (ex: "💬・")
let emojiPrefix = '💬・';
const match = chatChannel.name.match(/^([^\w\s]+・?)/);
if (match) {
  emojiPrefix = match[1];
}
console.log(`📌 Prefixo de emoji detectado: "${emojiPrefix}"`);

const newChannelName = `${emojiPrefix}solicite-advogado`;
console.log(`📌 Nome do novo canal a ser criado: "${newChannelName}"`);

// 3. Verificar se o canal já existe para evitar duplicidades
let targetChannel = channels.find(c => c && (c.name === newChannelName || c.name.includes('solicite-advogado')));

if (!targetChannel) {
  console.log("Creating new channel...");
  targetChannel = await guild.channels.create({
    name: newChannelName,
    type: ChannelType.GuildText,
    parent: chatChannel.parentId || undefined,
    position: chatChannel.position + 1,
    topic: "Canal oficial para solicitação de atendimento advocatício e representação jurídica."
  });
  console.log(`✅ Novo canal criado com sucesso! ID: ${targetChannel.id}`);
} else {
  console.log(`ℹ️ O canal "${targetChannel.name}" já existe (ID: ${targetChannel.id}). Atualizando mensagem...`);
  // Ajusta a posição caso necessário
  if (chatChannel.position) {
    await targetChannel.setPosition(chatChannel.position + 1).catch(() => {});
  }
}

// 4. Localizar a Role exata de Advogado
const roles = await guild.roles.fetch();
// Procura a role principal de Advogado: "Adv. | Advogado" (ID: 1526311674439798964) ou similar
let lawyerRole = roles.get('1526311674439798964') || roles.find(r => r.name.toLowerCase().includes('adv. | advogado') || r.name.toLowerCase().includes('advogado'));

const roleMention = lawyerRole ? `<@&${lawyerRole.id}>` : '@Advogado';
console.log(`📌 Cargo de Advogado selecionado: ${lawyerRole ? lawyerRole.name : 'Não encontrado por ID, usando fallback'} (Mention: ${roleMention})`);

// 5. Construir o Embed e o Botão de Ticket
const ticketEmbed = new EmbedBuilder()
  .setTitle("⚖️ SOLICITAÇÃO DE ASSISTÊNCIA JURÍDICA — OAB")
  .setDescription(
    "Necessita de representação legal, auxílio em custódia ou acompanhamento judicial?\n\n" +
    "Clique no botão abaixo para **abrir um atendimento reservado com a Advocacia**.\n" +
    `Ao solicitar, um canal privado será criado e os membros com o cargo ${roleMention} serão notificados imediatamente.`
  )
  .setColor(0x2b2d31)
  .addFields(
    { name: "📋 Atendimento Disponível", value: "• Acompanhamento de Depoimentos\n• Pedidos de Liberdade / Mandados\n• Defesa de Direitos e Recursos", inline: false },
    { name: "⚡ Plantão Judiciário", value: "Plantão ativo 24/7 para atendimento imediato.", inline: false }
  )
  .setFooter({ text: "Ordem dos Advogados do Brasil • Ordem & Justiça" })
  .setTimestamp();

const row = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId("btn_abrir_ticket_advogado")
    .setLabel("Solicitar Advogado")
    .setStyle(ButtonStyle.Primary)
    .setEmoji("⚖️")
);

// Limpa mensagens antigas do bot no canal antes de enviar a nova oficial (opcional, para ficar limpo)
try {
  const existingMsgs = await targetChannel.messages.fetch({ limit: 10 });
  if (existingMsgs.size > 0) {
    await targetChannel.bulkDelete(existingMsgs).catch(() => {});
  }
} catch (e) {}

// Envia a mensagem oficial no canal
const sentMsg = await targetChannel.send({
  content: `${roleMention}`, // Marca a role de advogado para notificação/referência no topo
  embeds: [ticketEmbed],
  components: [row]
});

console.log(`🎉 Embed e botão de solicitação publicados com sucesso no canal #${targetChannel.name}! (Msg ID: ${sentMsg.id})`);

return {
  sucesso: true,
  canalId: targetChannel.id,
  canalNome: targetChannel.name,
  mensagemId: sentMsg.id,
  roleMarcada: lawyerRole ? lawyerRole.name : null
};
