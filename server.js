require('dotenv').config({ quiet: true });
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { QdrantClient } = require('@qdrant/js-client-rest');
const OpenAI = require('openai');
const { ServiceManager } = require('./service-manager');
const { DeployHook } = require('./deploy-hook');
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
const RUNTIME_DIR = process.env.RUNTIME_DIR || path.join(__dirname, 'runtime');

const qdrant = new QdrantClient({
  url: QDRANT_URL,
  checkCompatibility: false,
});

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const services = new ServiceManager({ runtimeDir: RUNTIME_DIR });
const deploy = new DeployHook({ runtimeDir: RUNTIME_DIR, repoDir: __dirname });

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function pageShell(title, body) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body{font-family:Arial;background:#0f172a;color:#fff;margin:0;padding:16px}
    a{color:#60a5fa}
    .card{background:#111827;border-radius:12px;padding:16px;margin:12px 0}
    .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    button{padding:8px 12px;border:0;border-radius:8px;background:#22c55e;color:#fff;cursor:pointer}
    button.secondary{background:#334155}
    button.danger{background:#ef4444}
    select,input{padding:8px 10px;border-radius:8px;border:0;outline:none}
    pre{white-space:pre-wrap;background:#0b1220;padding:12px;border-radius:10px;overflow:auto;max-height:60vh}
    table{width:100%;border-collapse:collapse}
    th,td{padding:8px;border-bottom:1px solid #1f2937;text-align:left;font-size:14px;vertical-align:top}
    .muted{color:#9ca3af}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#1f2937}
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

app.get('/admin', (req, res) => {
  res.type('html').send(pageShell('Admin', `
    <div class="card">
      <h2 style="margin:0 0 8px 0;">Admin</h2>
      <div class="row">
        <a href="/admin/services">Services</a>
        <a href="/admin/logs">Logs</a>
        <a href="/hooks/deploy-ai">Deploy hook</a>
      </div>
    </div>
  `));
});

app.get('/admin/services', (req, res) => {
  res.type('html').send(pageShell('Services', `
    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <div>
          <h2 style="margin:0 0 6px 0;">Services</h2>
          <div class="muted">Config file: ${escapeHtml(services.configPath)}</div>
        </div>
        <div class="row">
          <button class="secondary" onclick="refresh()">Refresh</button>
          <a class="muted" href="/admin">Back</a>
        </div>
      </div>
    </div>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>PID</th>
            <th>Last</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <script>
      function fmt(v){return v ? String(v) : ''}
      function pill(text){return '<span class="pill">'+text+'</span>'}
      async function api(path, method){
        const res = await fetch(path, {method, headers:{'Content-Type':'application/json'}});
        const data = await res.json().catch(()=>null);
        if(!res.ok){throw new Error((data && (data.message||data.error)) || ('HTTP '+res.status))}
        return data
      }
      function row(s){
        const status = s.running ? pill('running') : pill('stopped')
        const pid = s.pid ? String(s.pid) : ''
        const last = [
          s.lastStartAt ? ('start: '+s.lastStartAt) : null,
          s.lastExitAt ? ('exit: '+s.lastExitAt+' code='+(s.lastExitCode ?? '')+' sig='+(s.lastExitSignal ?? '')) : null,
          s.lastError ? ('err: '+s.lastError) : null
        ].filter(Boolean).join('\\n')
        const btn = (label, cls, fn) => '<button class="'+cls+'" onclick="'+fn+'(\\''+s.name.replaceAll(\"'\",\"\\\\'\")+\"\\')\">'+label+'</button>'
        const actions = [
          btn('Start','', 'startSvc'),
          btn('Restart','secondary', 'restartSvc'),
          btn('Stop','danger', 'stopSvc')
        ].join(' ')
        return '<tr>'+
          '<td><div><b>'+s.name+'</b></div><div class="muted">'+fmt(s.type)+'</div></td>'+
          '<td>'+status+'</td>'+
          '<td>'+pid+'</td>'+
          '<td><pre style="margin:0;">'+fmt(last)+'</pre></td>'+
          '<td class="row">'+actions+'</td>'+
        '</tr>'
      }
      async function refresh(){
        const list = await api('/api/services','GET')
        document.getElementById('rows').innerHTML = list.map(row).join('')
      }
      async function startSvc(name){ await api('/api/services/'+encodeURIComponent(name)+'/start','POST'); await refresh() }
      async function stopSvc(name){ await api('/api/services/'+encodeURIComponent(name)+'/stop','POST'); await refresh() }
      async function restartSvc(name){ await api('/api/services/'+encodeURIComponent(name)+'/restart','POST'); await refresh() }
      refresh()
    </script>
  `));
});

app.get('/admin/logs', (req, res) => {
  res.type('html').send(pageShell('Logs', `
    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <div>
          <h2 style="margin:0 0 6px 0;">Logs</h2>
          <div class="muted">Filter by service and tail length.</div>
        </div>
        <div class="row">
          <a class="muted" href="/admin">Back</a>
        </div>
      </div>
      <div class="row" style="margin-top:8px;">
        <select id="service"></select>
        <input id="tail" type="number" value="200" min="10" max="5000" />
        <button class="secondary" onclick="load()">Load</button>
        <button class="secondary" onclick="toggleAuto()" id="autoBtn">Auto: off</button>
      </div>
    </div>
    <div class="card">
      <pre id="out" style="margin:0;"></pre>
    </div>
    <script>
      let timer = null
      async function api(path){
        const res = await fetch(path)
        const data = await res.json().catch(()=>null)
        if(!res.ok){throw new Error((data && (data.message||data.error)) || ('HTTP '+res.status))}
        return data
      }
      async function init(){
        const list = await api('/api/services')
        const sel = document.getElementById('service')
        sel.innerHTML = list.map(s => '<option value="'+s.name+'">'+s.name+'</option>').join('')
        if(list.length){ await load() }
      }
      async function load(){
        const name = document.getElementById('service').value
        const tail = document.getElementById('tail').value || 200
        const lines = await api('/api/logs?service='+encodeURIComponent(name)+'&tail='+encodeURIComponent(tail))
        document.getElementById('out').textContent = lines.join('\\n')
      }
      function toggleAuto(){
        if(timer){
          clearInterval(timer)
          timer = null
          document.getElementById('autoBtn').textContent = 'Auto: off'
        } else {
          timer = setInterval(load, 1500)
          document.getElementById('autoBtn').textContent = 'Auto: on'
        }
      }
      init()
    </script>
  `));
});

app.get('/api/services', (req, res) => {
  res.json(services.list());
});

app.post('/api/services/:name/start', async (req, res) => {
  try {
    const data = await services.start(req.params.name);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: 'start failed', message: String(err?.message || err) });
  }
});

app.post('/api/services/:name/stop', async (req, res) => {
  try {
    const data = await services.stop(req.params.name);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: 'stop failed', message: String(err?.message || err) });
  }
});

app.post('/api/services/:name/restart', async (req, res) => {
  try {
    const data = await services.restart(req.params.name);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: 'restart failed', message: String(err?.message || err) });
  }
});

app.get('/api/logs', async (req, res) => {
  const name = String(req.query.service || '');
  if (!name) {
    res.status(400).json({ error: 'missing service' });
    return;
  }
  try {
    res.json(await services.getLogs(name, req.query.tail));
  } catch (err) {
    res.status(500).json({ error: 'logs failed', message: String(err?.message || err) });
  }
});

app.get('/api/deploy/status', (req, res) => {
  res.json(deploy.getStatus());
});

app.post('/api/deploy/pull', async (req, res) => {
  try {
    const status = await deploy.pull();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'pull failed', message: String(err?.message || err) });
  }
});

app.all('/hooks/deploy-ai', async (req, res) => {
  const viewOnly = String(req.query.view || '') === '1';
  const shouldPull = !viewOnly && (req.method === 'POST' || req.method === 'GET');
  if (shouldPull) {
    try {
      await deploy.pull();
    } catch (err) {
    }
  }
  const status = deploy.getStatus();
  const headline = status.lastPullCommit && status.lastPullAtFormatted
    ? `Pull triggered: ${escapeHtml(status.lastPullCommit)} at ${escapeHtml(status.lastPullAtFormatted)}`
    : 'Pull not triggered yet';
  const detail = [
    status.lastPullOk === null ? null : `ok=${status.lastPullOk}`,
    status.lastPullOutput ? `stdout=${status.lastPullOutput}` : null,
    status.lastPullError ? `stderr=${status.lastPullError}` : null,
  ].filter(Boolean).join('\n');

  res.type('html').send(pageShell('Deploy hook', `
    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <div>
          <h2 style="margin:0 0 6px 0;">Deploy hook</h2>
          <div class="muted">${escapeHtml(headline)}</div>
        </div>
        <div class="row">
          <a class="muted" href="/admin">Back</a>
        </div>
      </div>
      <div class="row" style="margin-top:10px;">
        <button onclick="pullNow()">Pull now</button>
        <button class="secondary" onclick="refresh()">Refresh</button>
      </div>
    </div>
    <div class="card">
      <div class="muted" style="margin-bottom:8px;">Details</div>
      <pre style="margin:0;" id="detail">${escapeHtml(detail || '')}</pre>
    </div>
    <script>
      async function pullNow(){
        const res = await fetch('/api/deploy/pull', { method:'POST', headers:{'Content-Type':'application/json'} })
        const data = await res.json().catch(()=>null)
        if(!res.ok){ alert((data && (data.message||data.error)) || ('HTTP '+res.status)); return }
        location.reload()
      }
      async function refresh(){ location.reload() }
    </script>
  `));
});

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
