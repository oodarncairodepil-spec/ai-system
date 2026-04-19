require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { QdrantClient } = require('@qdrant/js-client-rest');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// ==============================
// CONFIG
// ==============================
const PORT = 3000;

const qdrant = new QdrantClient({
  url: 'http://localhost:6333',
  checkCompatibility: false,
});

// ==============================
// EMBEDDING (LOCAL - OLLAMA)
// ==============================
async function getEmbedding(text) {
  const res = await axios.post('http://localhost:11434/api/embeddings', {
    model: 'nomic-embed-text',
    prompt: text,
  });

  return res.data.embedding;
}

// ==============================
// ADD DATA TO QDRANT
// ==============================
app.post('/add', async (req, res) => {
  try {
    const { id, text } = req.body;

    const vector = await getEmbedding(text);

    await qdrant.upsert('products', {
      points: [
        {
          id: id,
          vector: vector,
          payload: { text },
        },
      ],
    });

    res.json({ status: 'added', id, text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'add failed' });
  }
});

// ==============================
// CHAT (RAG + CLOUD LLM)
// ==============================
app.post('/chat', async (req, res) => {
  try {
    const userMessage = req.body.message;
    console.log("USER:", userMessage);

    // 1. EMBEDDING
    const vector = await getEmbedding(userMessage);

    // 2. SEARCH QDRANT
    const search = await qdrant.search('products', {
      vector,
      limit: 3,
    });

    // 3. FILTER (IMPORTANT)
    const threshold = 0.75;
    const filtered = search.filter(item => item.score >= threshold);

    let contextText = '';

    if (filtered.length > 0) {
      contextText = filtered
        .map(item => item.payload.text)
        .join('\n');
    }

    // 4. BUILD PROMPT
    const systemPrompt = `
You are an AI sales assistant.

Rules:
- ONLY recommend products if they are relevant to user request
- If no relevant product found → say "Maaf, produk tidak ditemukan"
- DO NOT force unrelated products
- Be helpful, short, and natural (Bahasa Indonesia)
    `;

    const userPrompt = `
User: ${userMessage}

Relevant products:
${contextText || "NONE"}

Answer:
`;

    // 5. CALL OPENAI (🔥 THIS IS THE NEW PART)
    const completion = await axios.post(
  'https://api.openai.com/v1/chat/completions',
  {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.7,
  },
  {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
  }
);

const answer = completion.data.choices[0].message.content;

    // 6. RESPONSE
    res.json({
      response: answer,
      context: contextText,
      raw: filtered,
    });

  } catch (err) {
    console.error("🔥 CHAT ERROR:", err.response?.data || err.message);

    res.status(500).json({
      error: 'chat failed',
      detail: err.response?.data || err.message,
    });
  }
});

// ==============================
// START SERVER
// ==============================
app.listen(PORT, () => {
  console.log(`AI Sales Agent running on ${PORT}`);
  console.log(`Chat UI: http://100.109.16.90:3000/chat-ui`);
});
