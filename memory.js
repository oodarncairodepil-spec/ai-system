const memoryStore = new Map();

/**
 * structure:
 * userId -> {
 *   history: [],
 *   lastIntent: "",
 *   context: {}
 * }
 */

function getSession(userId) {
  if (!memoryStore.has(userId)) {
    memoryStore.set(userId, {
      history: [],
      lastIntent: null,
      context: {},
    });
  }

  return memoryStore.get(userId);
}

function addMessage(userId, role, message) {
  const session = getSession(userId);

  session.history.push({
    role,
    message,
    time: Date.now(),
  });

  // keep memory light
  if (session.history.length > 20) {
    session.history.shift();
  }
}

module.exports = {
  getSession,
  addMessage,
};
