const { QdrantClient } = require('@qdrant/js-client-rest');

const qdrant = new QdrantClient({
  url: 'http://localhost:6333',
  checkCompatibility: false
});

const COLLECTION = 'products';

// 🔥 ADD THRESHOLD
const SCORE_THRESHOLD = 0.75;

async function searchVector(vector) {
  const result = await qdrant.search(COLLECTION, {
    vector,
    limit: 5,
    with_payload: true,
  });

  // filter low-quality matches
  return result.filter(r => r.score >= SCORE_THRESHOLD);
}

async function addVector(id, vector, text) {
  return await qdrant.upsert(COLLECTION, {
    points: [
      {
        id,
        vector,
        payload: { text },
      },
    ],
  });
}

module.exports = { searchVector, addVector };
