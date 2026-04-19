const axios = require('axios');

async function detectIntent(message) {
  const res = await axios.post('http://localhost:11434/api/chat', {
    model: 'llama3.1:8b',
    messages: [
      {
        role: 'system',
        content: `
Classify user intent into ONE of:
- BUY
- SEARCH
- COMPARE
- TRACK_ORDER
- SHIPPING_INFO
- OTHER

Return ONLY the intent word.
        `,
      },
      {
        role: 'user',
        content: message,
      },
    ],
    stream: false,
  });

  return res.data.message.content.trim();
}

module.exports = { detectIntent };
