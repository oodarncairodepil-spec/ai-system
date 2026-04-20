const axios = require("axios");
const crypto = require("crypto");
const OpenAI = require("openai");
require("dotenv").config();

const {
  QDRANT_URL,
  QDRANT_COLLECTION,
  OPENAI_API_KEY,
  PLUGO_PARTNER_ID,
  PLUGO_PASS,
  PLUGO_API_KEY,
  PLUGO_BASE_URL,
} = process.env;

const VENDOR_ID = "3476";

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// =============================
// 🕒 UTC timestamp (Postman format)
// YYYY-MM-DD HH:mm:ss
// =============================
function getTimestamp() {
  const now = new Date();

  const pad = (n) => String(n).padStart(2, "0");

  return (
    `${now.getUTCFullYear()}-` +
    `${pad(now.getUTCMonth() + 1)}-` +
    `${pad(now.getUTCDate())} ` +
    `${pad(now.getUTCHours())}:` +
    `${pad(now.getUTCMinutes())}:` +
    `${pad(now.getUTCSeconds())}`
  );
}

// =============================
// 🔐 SIGNATURE (EXACT MATCH POSTMAN)
// SHA256(timeStamp + vendorID + partnerPASS + apiKey)
// =============================
function generateSignature(timeStamp) {
  const message = timeStamp + VENDOR_ID + PLUGO_PASS + PLUGO_API_KEY;

  return crypto.createHash("sha256").update(message).digest("hex");
}

// =============================
// 📦 FETCH PRODUCTS FROM PLUGO
// =============================
async function fetchProducts() {
  const timeStamp = getTimestamp();
  const signedKey = generateSignature(timeStamp);

  console.log("📄 Fetching products...");

  const res = await axios.get(
    `${PLUGO_BASE_URL}/v1/products`,
    {
      headers: {
        partnerID: PLUGO_PARTNER_ID,
        partnerPASS: PLUGO_PASS,
        vendorID: VENDOR_ID,
        timeStamp,
        signedKey,
      }
    }
  );

  const items = res.data?.data || [];

  // 🛑 safety: ensure uniqueness
  const uniqueMap = new Map();

  for (const item of items) {
    uniqueMap.set(item.id, item);
  }

  return Array.from(uniqueMap.values());
}

// =============================
// 🧠 EMBEDDING
// =============================
async function embed(text) {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  return res.data[0].embedding;
}

// =============================
// 📦 FORMAT FOR QDRANT
// =============================
function formatProduct(product, vector) {
  const active =
    product.productVariations?.find(v => v.isActive) ||
    product.productVariations?.[0];

  return {
    id: product.id,
    vector,
    payload: {
      name: product.name,
      description: product.description || "",
      price: active?.price || 0,
      sku: active?.sku || "",
      image: product.images?.[0]?.url || "",
      productCode: product.productCode || "",
    },
  };
}

// =============================
// ⬆️ UPSERT TO QDRANT
// =============================
async function upsertBatch(points) {
  await axios.put(
    `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points`,
    { points }
  );
}

// =============================
// 🚀 MAIN SYNC
// =============================
async function main() {
  console.log("🚀 Sync started...");

  const products = await fetchProducts();

  console.log("📦 Total products:", products.length);

  if (!products.length) {
    console.log("❌ No products found");
    return;
  }

  const BATCH_SIZE = 20;
  let batch = [];

  for (let i = 0; i < products.length; i++) {
    const p = products[i];

    const text = `
      ${p.name}
      ${p.description || ""}
      kategori: ${p.category || ""}
      produk dijual online
    `;

    const vector = await embed(text);

    batch.push(formatProduct(p, vector));

    console.log("✅ Embedded:", p.name);

    if (batch.length >= BATCH_SIZE) {
      await upsertBatch(batch);
      console.log("⬆️ Uploaded batch");
      batch = [];
    }
  }

  if (batch.length > 0) {
    await upsertBatch(batch);
  }

  console.log("🔥 Sync completed successfully!");
}

main().catch((err) => {
  console.error("💥 Sync failed:", err.response?.data || err.message);
});
