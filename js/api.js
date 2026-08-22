// Reserved for the server-side AI gateway.
// No AI provider secret belongs in this file or any GitHub Pages code.

async function sendAiRequest(payload) {
  throw new Error('AI Gateway is not connected yet.');
}

window.kotohaApi = { sendAiRequest };
