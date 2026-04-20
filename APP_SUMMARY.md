# AI System App Summary

## What this app is

This project is a lightweight **AI Sales Agent** web app. It lets a user chat in a browser, then tries to answer with product recommendations based on a Retrieval-Augmented Generation (RAG) flow:

1. Convert user query to embeddings using a local Ollama embedding model.
2. Search similar product vectors in a local Qdrant collection.
3. Filter low-confidence matches.
4. Build a prompt with matched product context.
5. Ask an LLM to generate a natural-language answer (Bahasa Indonesia style).

The server is in Node.js/Express, and the UI is a single static HTML page.

## Main components

- `server.js`
  - Starts Express server on port `3000`.
  - Serves static files from `public/`.
  - Exposes:
    - `POST /add`: add product text into Qdrant as vectorized point.
    - `POST /chat`: run retrieval + LLM response generation.
  - Uses:
    - Ollama embeddings endpoint (`/api/embeddings`) with `nomic-embed-text`.
    - Qdrant at `http://localhost:6333`, collection `products`.
    - OpenAI Chat Completions (`gpt-4o-mini`) for final response.

- `public/index.html`
  - Minimal chat UI.
  - Sends user message to `/chat`.
  - Shows AI response and a debug block.

- `embed.js`
  - Shared helper for getting embeddings from Ollama.

- `qdrant.js`
  - Wrapper helpers for vector search and upsert.
  - Applies score threshold (`0.75`) for relevance filtering.

- `intent.js`, `llm.js`, `prompt.js`, `memory.js`
  - Additional modular pieces for a more structured agent pipeline:
    - intent classification,
    - prompt construction with memory/history,
    - local LLM generation,
    - in-memory session state.
  - These modules are currently **not wired into** `server.js`.

- `tools.js`
  - Example integrations for product and shipping APIs.
  - Not currently connected to running chat endpoint.

## Runtime dependencies and services

The app relies on several external/local services:

- Local Ollama server (`http://localhost:11434`) with model:
  - `nomic-embed-text` (embeddings)
- Local Qdrant server (`http://localhost:6333`)
- OpenAI API key in `.env`:
  - `OPENAI_API_KEY`

Without these, `/chat` and `/add` will fail.

## End-to-end request flow (`POST /chat`)

1. Receive user message.
2. Embed query text via Ollama.
3. Search top 3 vectors in Qdrant.
4. Keep only matches with score >= `0.75`.
5. Build prompt containing user message + matched product text.
6. Call OpenAI `gpt-4o-mini`.
7. Return:
   - `response` (LLM answer),
   - `context` (retrieved text),
   - `raw` (filtered retrieval objects).

## Code review notes (important)

- `public/index.html` expects `data.context` to be an array and uses `.join(', ')`, but `server.js` returns `context` as a string. This mismatch can break UI rendering in some cases.
- `server.js` prints URL `/chat-ui`, but the static page is at `/` (unless a separate route exists elsewhere).
- `tools.js` contains hard-coded partner credentials; this is a security risk and should be moved to environment variables.
- Repo includes `node_modules/` in source control, which is unusual and increases repo size/noise.
- Several modules (`intent.js`, `llm.js`, `memory.js`, `prompt.js`, `qdrant.js`, `tools.js`) look like planned architecture but are currently unused by the main server route.

## Practical interpretation

This is an **early-stage prototype** of a sales chatbot that combines:

- vector retrieval for product relevance,
- prompt-guarded answer generation,
- and a simple web chat interface.

Core RAG behavior is present and functional in concept, but the app needs integration cleanup and production hardening (security, module consistency, and data flow fixes).
