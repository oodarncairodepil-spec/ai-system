require('dotenv').config({ quiet: true });
const http = require('http');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { QdrantClient } = require('@qdrant/js-client-rest');
const OpenAI = require('openai');
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

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ==============================
// EMBEDDING (LOCAL - OLLAMA)
// ==============================
function getQdrantVectorSize(collectionInfo) {
  const vectors = collectionInfo?.result?.config?.params?.vectors;
  if (!vectors) return null;
  if (typeof vectors.size === 'number') return vectors.size;
  if (typeof vectors === 'object') {
    for (const v of Object.values(vectors)) {
      if (typeof v?.size === 'number') return v.size;
    }
  }
  return null;
}

async function ensureProductsCollection(vectorSize) {
  try {
    const info = await qdrant.getCollection('products');
    const existingSize = getQdrantVectorSize(info);
    if (typeof existingSize === 'number' && existingSize !== vectorSize) {
      const err = new Error(`Vector size mismatch (collection=${existingSize}, query=${vectorSize})`);
      throw makeStageError(
        'QDRANT_COLLECTION_MISMATCH',
        err,
        openai
          ? 'Recreate/resync Qdrant collection with the same embedding model used by this server.'
          : 'Set OPENAI_API_KEY (to use text-embedding-3-small) or resync Qdrant using the same embedding model (e.g., Ollama nomic-embed-text).'
      );
    }
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    if (status === 404) {
      await qdrant.createCollection('products', {
        vectors: { size: vectorSize, distance: 'Cosine' },
      });
      return;
    }
    throw err;
  }
}

async function getEmbeddingFromOpenAI(text) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return res.data[0].embedding;
}

async function getEmbeddingFromOllama(text) {
  const res = await axios.post('http://localhost:11434/api/embeddings', {
    model: 'nomic-embed-text',
    prompt: text,
  });
  return res.data.embedding;
}

async function getEmbedding(text) {
  if (openai) {
    try {
      return await getEmbeddingFromOpenAI(text);
    } catch (err) {
      try {
        return await getEmbeddingFromOllama(text);
      } catch (err2) {
        throw err;
      }
    }
  }

  return await getEmbeddingFromOllama(text);
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
        'EMBEDDING_FAILED',
        err,
        OPENAI_API_KEY
          ? 'Embedding failed. Check OPENAI_API_KEY / OpenAI connectivity or ensure Ollama is running on http://localhost:11434 with model nomic-embed-text.'
          : 'Make sure Ollama is running on http://localhost:11434 and model nomic-embed-text is available.'
      );
    }

    // 2. SEARCH QDRANT
    let search;
    try {
      await ensureProductsCollection(vector.length);
      search = await qdrant.search('products', {
        vector,
        limit: 3,
        with_payload: true,
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
      .map((item) => {
        const payload = item.payload || {};
        if (typeof payload.text === 'string' && payload.text.trim()) return payload.text.trim();
        const parts = [];
        if (payload.name) parts.push(`Name: ${payload.name}`);
        if (payload.description) parts.push(`Description: ${payload.description}`);
        if (payload.price !== undefined && payload.price !== null) parts.push(`Price: ${payload.price}`);
        if (payload.sku) parts.push(`SKU: ${payload.sku}`);
        if (payload.productCode) parts.push(`Code: ${payload.productCode}`);
        return parts.join('\n');
      })
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
