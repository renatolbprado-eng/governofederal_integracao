// Procura o canal "chat" (resistente a emojis) e os cargos de Advogado
console.log("=== BUSCANDO CANAIS ===");
const channels = await guild.channels.fetch();
let targetChatChannel = null;

channels.forEach(ch => {
  if (!ch) return;
  // Limpa emojis e caracteres especiais para comparar
  const cleanName = ch.name.toLowerCase().replace(/[^\w\s-]/g, '').trim();
  console.log(`Canal: "${ch.name}" | Nome Limpo: "${cleanName}" | ID: ${ch.id} | Tipo: ${ch.type} | Pos: ${ch.rawPosition}`);
  
  if (cleanName.includes('chat') || ch.name.toLowerCase().includes('chat')) {
    targetChatChannel = ch;
    console.log("👉 ENCONTRADO CANAL ALVO CHAT:", ch.name, "ID:", ch.id, "Categoria:", ch.parentId);
  }
});

console.log("\n=== BUSCANDO CARGOS (ADVOGADO) ===");
const roles = await guild.roles.fetch();
roles.forEach(r => {
  const cleanRole = r.name.toLowerCase();
  if (cleanRole.includes('adv') || cleanRole.includes('oab') || cleanRole.includes('jur') || cleanRole.includes('defens')) {
    console.log(`👉 CARGO DE ADVOGADO ENCONTRADO: "${r.name}" | ID: ${r.id}`);
  }
});

return {
  chatFound: targetChatChannel ? { name: targetChatChannel.name, id: targetChatChannel.id, parentId: targetChatChannel.parentId, pos: targetChatChannel.rawPosition } : null
};
