import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

const candidateModels = [
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-2.5-pro',
  'gemini-flash-latest',
  'gemini-pro-latest'
];

async function testSingleModel(modelName) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
    const response = await fetch(targetUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Olá! Responda OK." }] }]
      })
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      console.log(`✅ SUCESSO (${modelName}):`, txt ? txt.trim() : "Sem texto");
    } else {
      const errText = await response.text();
      console.log(`❌ STATUS ${response.status} (${modelName}):`, errText.substring(0, 120));
    }
  } catch (e) {
    console.log(`❌ ERRO (${modelName}):`, e.message);
  }
}

async function run() {
  for (const m of candidateModels) {
    await testSingleModel(m);
  }
}

run();
