function buildAgentPrompt({ message, context, intent, memory }) {
  const contextText = context.length
    ? context.map(c => c.payload.text).join('\n')
    : 'NO MATCH';

  const historyText = memory.history
    .slice(-5)
    .map(h => `${h.role}: ${h.message}`)
    .join('\n');

  return `
You are a STRICT AI SALES AGENT.

RULES:
- ONLY recommend products from CONTEXT
- If CONTEXT = NO MATCH → say product NOT AVAILABLE
- DO NOT suggest unrelated items
- DO NOT guess
- DO NOT hallucinate

INTENT:
${intent}

CHAT HISTORY:
${historyText}

CONTEXT:
${contextText}

USER:
${message}

ANSWER:
`;
}

module.exports = { buildAgentPrompt };
