import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

const candidateModels = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-flash-latest',
  'gemini-pro-latest',
  'gemini-2.5-flash-lite'
];

async function testModels() {
  for (const modelName of candidateModels) {
    try {
      console.log(`Testing REST model: ${modelName}...`);
      const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Olá! Responda OK em uma palavra." }] }]
        })
      });

      if (response.ok) {
        const data = await response.json();
        const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        console.log(`✅ SUCESSO com (${modelName}):`, txt ? txt.trim() : "Sem texto");
      } else {
        const errText = await response.text();
        console.log(`❌ FALHA com (${modelName}) Status ${response.status}:`, errText.substring(0, 150));
      }
    } catch (e) {
      console.log(`❌ ERRO (${modelName}):`, e.message);
    }
  }
}

testModels();
