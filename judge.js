// Shared Gemma logic. Used by server.js (local mode) and worker.js (home judge for a hosted app).
const MODEL = process.env.MODEL || 'gemma4:e4b-it-q4_K_M';
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const BAD_QUEST = /\d|\b(exactly|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;   // D18

async function gemma(messages, wantJson, temp = 0.4) {
  const body = {
    model: MODEL, messages, stream: false, keep_alive: '30m',
    ...(wantJson ? { format: 'json' } : {}),
    options: { temperature: temp, num_ctx: 2048 }
  };
  const post = b => fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let r = await post({ ...body, think: false });   // D26: skip Gemma 4's slow thinking step
  if (r.status === 400) r = await post(body);      // this Ollama/model does not accept the flag
  if (!r.ok) throw new Error('Ollama returned ' + r.status);
  return (await r.json()).message.content;
}
function parse(text) {
  try { return JSON.parse(text); }
  catch { const e = new Error('Judge returned unreadable JSON'); e.parse = true; throw e; }
}
const norm = v => ({ match: v.match === true, confidence: Number(v.confidence) || 0, outdoors: v.outdoors, people: v.people, caption: String(v.caption || '').slice(0, 200) });

const SEE = 'First list the main objects you can clearly see. Do not guess what kind of place it is or what people are doing; name only what is visible.\n';
const OUT = 'Also say whether it was taken outdoors. Answer true if there is any sign of being outside (sky, ground, grass, plants, an outdoor wall or street, daylight); close-ups of things outside count as outdoors. Answer false only if it is clearly inside a room.\n';

// Walk stops and detox quests: "is this thing in the photo?" (D15, D27)
async function judgeObject(text, image) {
  const out = await gemma([{ role: 'user', images: [image], content:
    `Quest: "${text}"\n` + SEE + 'Then decide whether the photo clearly satisfies the quest.\n' + OUT +
    'Reply with JSON only: {"seen": ["..."], "match": true or false, "confidence": 0-100, "outdoors": true or false, "caption": "one friendly sentence naming only what you can see"}' }], true, 0.2);
  return norm(parse(out));
}
// Squad quest: "are people doing this activity together, outside?" (D34)
async function judgeSquad(text, image) {
  const out = await gemma([{ role: 'user', images: [image], content:
    `Squad quest (friends doing an activity together outside): "${text}"\n` +
    'First list what you can clearly see: people, objects and the place. Do not invent details.\n' +
    'Then decide whether the photo shows people taking part in this activity, or clearly set up for it (the ball, the path they are walking, the group together).\n' +
    'Also say whether any people are visible.\n' + OUT +
    'Reply with JSON only: {"seen": ["..."], "match": true or false, "confidence": 0-100, "people": true or false, "outdoors": true or false, "caption": "one friendly sentence naming only what you can see"}' }], true, 0.2);
  return norm(parse(out));
}

// Quest bank: Gemma writes quests ahead of time so the app never waits on the AI (D33).
const RULES = 'The photo judge is a small AI that cannot count, read text or check exact details, so never use numbers or counting, nothing rare, no brands or writing. ';
const SPECS = {
  squad: { max: 110, ask: n => `Invent ${n} DIFFERENT activities a group of friends can do together outdoors for a while, such as a ball game, a walk-and-talk through green space, frisbee, a picnic or light stretching. Ordinary people, no special equipment beyond maybe a ball. One short sentence each, written as an instruction to the group. ${RULES}` },
  stops: { max: 80, ask: n => `Invent ${n} DIFFERENT, very simple photo targets to find while walking outside. Each is one short sentence about one common, clearly visible thing, like "Photograph something blue." or "Photograph a tree trunk." ${RULES}` },
  detox: { max: 80, ask: n => `Invent ${n} DIFFERENT short outdoor photo tasks that get someone away from their phone, like "Photograph the sky." or "Photograph a tree." One short sentence each. ${RULES}` }
};
async function makeBank(need) {
  const out = {};
  for (const [k, spec] of Object.entries(SPECS)) {
    const n = need[k] || 0; if (n <= 0) continue;
    try {
      const j = parse(await gemma([{ role: 'user', content: spec.ask(n) + '\nReply with JSON only: {"items": ["...", "..."]}' }], true));
      out[k] = [...new Set((Array.isArray(j.items) ? j.items : []).filter(t => typeof t === 'string' && t.trim() && t.length <= spec.max && !BAD_QUEST.test(t)).map(t => t.trim()))];
    } catch (e) { console.log(`Quest bank "${k}" failed:`, e.message); }
  }
  return out;
}
module.exports = { MODEL, BAD_QUEST, gemma, judgeObject, judgeSquad, makeBank };
