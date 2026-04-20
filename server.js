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
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'products';

const qdrant = new QdrantClient({
  url: QDRANT_URL,
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
    const info = await qdrant.getCollection(QDRANT_COLLECTION);
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
      await qdrant.createCollection(QDRANT_COLLECTION, {
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
      return { embedding: await getEmbeddingFromOpenAI(text), provider: 'openai' };
    } catch (err) {
      try {
        return { embedding: await getEmbeddingFromOllama(text), provider: 'ollama' };
      } catch (err2) {
        throw err;
      }
    }
  }

  return { embedding: await getEmbeddingFromOllama(text), provider: 'ollama' };
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

function makeRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isGreeting(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  return /^(hi|hello|hey|hai|halo|hallo|pagi|siang|sore|malam|ass?alam(u|o)alaikum)[!.\s]*$/.test(t);
}

function isProductIntent(text) {
  const t = String(text || '').toLowerCase();
  return /(produk|product|barang|item|harga|price|berapa|beli|buy|pesan|order|rekomendasi|recommend|cari|search|stok|stock|warna|size|ukuran|variant|varian|promo|diskon)/.test(t);
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

    const { embedding, provider } = await getEmbedding(text);
    console.log(`[ADD] provider=${provider} collection=${QDRANT_COLLECTION} id=${id}`);
    await ensureProductsCollection(embedding.length);

    await qdrant.upsert(QDRANT_COLLECTION, {
      points: [
        {
          id: id,
          vector: embedding,
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
  const requestId = makeRequestId();
  try {
    const userMessage = req.body.message;
    console.log(`[CHAT ${requestId}] userMessage=${JSON.stringify(userMessage)}`);
    console.log(`[CHAT ${requestId}] qdrantUrl=${QDRANT_URL} collection=${QDRANT_COLLECTION} openai=${Boolean(OPENAI_API_KEY)}`);

    if (isGreeting(userMessage) && !isProductIntent(userMessage)) {
      console.log(`[CHAT ${requestId}] path=greeting_bypass`);
      res.json({
        response: 'Halo! Ada yang bisa saya bantu? Kamu lagi cari produk apa (nama/kategori/budget)?',
        context: [],
        raw: [],
      });
      return;
    }

    // 1. EMBEDDING
    let embedding;
    let embeddingProvider;
    try {
      const result = await getEmbedding(userMessage);
      embedding = result.embedding;
      embeddingProvider = result.provider;
      console.log(`[CHAT ${requestId}] embeddingProvider=${embeddingProvider} vectorSize=${embedding?.length}`);
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
      await ensureProductsCollection(embedding.length);
      const collectionInfo = await qdrant.getCollection(QDRANT_COLLECTION);
      const pointsCount = collectionInfo?.result?.points_count;
      const vectorsCount = collectionInfo?.result?.vectors_count;
      const vectorSize = getQdrantVectorSize(collectionInfo);
      console.log(`[CHAT ${requestId}] collectionInfo points_count=${pointsCount} vectors_count=${vectorsCount} vector_size=${vectorSize}`);

      search = await qdrant.search(QDRANT_COLLECTION, {
        vector: embedding,
        limit: 5,
        with_payload: true,
      });
      console.log(`[CHAT ${requestId}] qdrantResults total=${Array.isArray(search) ? search.length : 'n/a'}`);
      if (Array.isArray(search) && search.length) {
        const top = search.slice(0, 5).map((r) => ({
          id: r.id,
          score: r.score,
          payloadKeys: r.payload ? Object.keys(r.payload).slice(0, 20) : [],
        }));
        console.log(`[CHAT ${requestId}] qdrantTop=${JSON.stringify(top)}`);
      }
    } catch (err) {
      throw makeStageError(
        'QDRANT_SEARCH_FAILED',
        err,
        `Ensure Qdrant is running on ${QDRANT_URL} and collection "${QDRANT_COLLECTION}" exists.`
      );
    }

    // 3. FILTER (IMPORTANT)
    const threshold = 0.75;
    const filtered = search.filter(item => item.score >= threshold);
    console.log(`[CHAT ${requestId}] threshold=${threshold} kept=${filtered.length} dropped=${search.length - filtered.length}`);

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
    console.log(`[CHAT ${requestId}] contextItems=${contextList.length}`);

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
    console.error(`🔥 CHAT ERROR [${stage}] [${requestId}]:`, detail);

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
