require('dotenv').config({ quiet: true });
const http = require('http');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { QdrantClient } = require('@qdrant/js-client-rest');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.get('/chat-ui', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ==============================
// CONFIG
// ==============================
const PORT = Number(process.env.PORT) || 3001;

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

function getErrorDetail(err) {
  if (err?.response?.data) {
    if (typeof err.response.data === 'string') {
      return err.response.data;
    }
    return JSON.stringify(err.response.data);
  }

  if (err?.message) {
    return err.message;
  }

  return 'Unknown error';
}

function makeStageError(stage, err, hint) {
  const reason = getErrorDetail(err);
  const detail = `${reason || 'Unknown error'}${hint ? ` | Hint: ${hint}` : ''}`;
  const wrapped = new Error(detail);
  wrapped.stage = stage;
  wrapped.cause = err;
  return wrapped;
}

async function generateAnswer(systemPrompt, userPrompt) {
  if (OPENAI_API_KEY) {
    const completion = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return completion.data.choices?.[0]?.message?.content || '';
  }

  const local = await axios.post('http://localhost:11434/api/chat', {
    model: 'llama3.1:8b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
  });

  return local.data?.message?.content || '';
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
    let vector;
    try {
      vector = await getEmbedding(userMessage);
    } catch (err) {
      throw makeStageError(
        'OLLAMA_EMBEDDING_FAILED',
        err,
        'Make sure Ollama is running on http://localhost:11434 and model nomic-embed-text is available.'
      );
    }

    // 2. SEARCH QDRANT
    let search;
    try {
      search = await qdrant.search('products', {
        vector,
        limit: 3,
      });
    } catch (err) {
      throw makeStageError(
        'QDRANT_SEARCH_FAILED',
        err,
        'Ensure Qdrant is running on http://localhost:6333 and collection "products" exists.'
      );
    }

    // 3. FILTER (IMPORTANT)
    const threshold = 0.75;
    const filtered = search.filter(item => item.score >= threshold);

    const contextList = filtered
      .map(item => item.payload?.text)
      .filter(Boolean);
    const contextText = contextList.length > 0
      ? contextList.join('\n')
      : '';

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
    let answer;
    try {
      answer = await generateAnswer(systemPrompt, userPrompt);
    } catch (err) {
      const hint = OPENAI_API_KEY
        ? 'Check OPENAI_API_KEY validity and outbound internet access for OpenAI API.'
        : 'OPENAI_API_KEY is missing. Local Ollama chat fallback also failed; ensure llama3.1:8b is available in Ollama.';
      throw makeStageError('LLM_GENERATION_FAILED', err, hint);
    }

    // 6. RESPONSE
    res.json({
      response: answer,
      context: contextList,
      raw: filtered,
    });

  } catch (err) {
    const stage = err?.stage || 'CHAT_PIPELINE_FAILED';
    const rawDetail = getErrorDetail(err);
    const detail = rawDetail && rawDetail.trim() ? rawDetail : 'Unknown error';
    console.error(`🔥 CHAT ERROR [${stage}]:`, detail);

    res.status(500).json({
      error: 'chat failed',
      stage,
      detail,
      message: `${stage}: ${detail}`,
    });
  }
});

// ==============================
// START SERVER
// ==============================
const MAX_PORT_ATTEMPTS = 20;

function startServer(port, attemptsLeft = MAX_PORT_ATTEMPTS) {
  const server = http.createServer(app);

  server.on('close', () => {
    console.error('HTTP server closed unexpectedly');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is in use, retrying on ${nextPort}...`);
      startServer(nextPort, attemptsLeft - 1);
      return;
    }

    console.error('Failed to start server:', err.message);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`AI Sales Agent running on ${port}`);
    console.log(`Chat UI: http://localhost:${port}/chat-ui`);
    console.log(`Root UI: http://localhost:${port}/`);
  });
}

startServer(PORT);
