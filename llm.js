const axios = require('axios');

async function generateLLM(prompt) {
  try {
    const res = await axios.post('http://localhost:11434/api/chat', {
      model: 'llama3.1:8b',
      messages: [
        {
          role: 'system',
          content: `You are a strict AI sales assistant.
Only answer using provided context.
If context is weak, say you are not sure.
Do not hallucinate.`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: false,
    });

    return res.data.message.content;
  } catch (err) {
    console.error('LLM ERROR:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = { generateLLM };
