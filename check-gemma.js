// Usage: node check-gemma.js path\to\photo.jpg
// Sends one photo to your local Gemma model and prints what it sees.
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.log('Usage: node check-gemma.js path\\to\\photo.jpg'); process.exit(1); }
const MODEL = process.env.MODEL || 'gemma4:e4b-it-q4_K_M';
(async () => {
  const t = Date.now();
  const r = await fetch('http://localhost:11434/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, messages: [{
      role: 'user', content: 'Describe this photo in two sentences.',
      images: [fs.readFileSync(file).toString('base64')] }] })
  });
  const j = await r.json();
  console.log(j.message ? j.message.content : j);
  console.log(`(${((Date.now() - t) / 1000).toFixed(1)}s)`);
})().catch(e => console.log('Failed:', e.message, '\nIs Ollama running? Is the model name right? (ollama list)'));
