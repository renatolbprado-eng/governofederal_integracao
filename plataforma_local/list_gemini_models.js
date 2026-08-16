import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

async function listModels() {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      console.log("=== MODELOS DISPONÍVEIS NA SUA CHAVE ===");
      if (data.models) {
        data.models.forEach(m => {
          if (m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')) {
            console.log(`- ${m.name.replace('models/', '')} (${m.displayName})`);
          }
        });
      } else {
        console.log("Nenhum modelo retornado no objeto:", data);
      }
    } else {
      console.log("Erro ao listar modelos Status:", res.status, await res.text());
    }
  } catch (e) {
    console.error("Erro:", e.message);
  }
}

listModels();
