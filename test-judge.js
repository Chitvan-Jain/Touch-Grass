// Usage: node test-judge.js "quest" passFolder failFolder
// Runs the same judge prompt as server.js on two folders of photos and prints accuracy and speed.
const fs = require('fs'), path = require('path');
const [, , quest, passDir, failDir] = process.argv;
if (!quest || !passDir || !failDir) { console.log('Usage: node test-judge.js "quest" passFolder failFolder'); process.exit(1); }
const MODEL = process.env.MODEL || 'gemma4:e4b-it-q4_K_M';
const post = b => fetch('http://localhost:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
async function judge(file) {
  const t0 = Date.now();
  const body = { model: MODEL, stream: false, format: 'json', options: { temperature: 0.2, num_ctx: 2048 }, messages: [{ role: 'user',
    images: [fs.readFileSync(file).toString('base64')],
    content: `Quest: "${quest}"\nFirst list the main objects you can clearly see. Do not guess what kind of place it is or what people are doing; name only what is visible.\nThen decide whether the photo clearly satisfies the quest.\nAlso say whether it was taken outdoors. Answer true if there is any sign of being outside (sky, ground, grass, plants, an outdoor wall or street, daylight); close-ups of things outside count as outdoors. Answer false only if it is clearly inside a room.\nReply with JSON only: {"seen": ["..."], "match": true or false, "confidence": 0-100, "outdoors": true or false, "caption": "one friendly sentence naming only what you can see"}` }] };
  let r = await post({ ...body, think: false });
  if (r.status === 400) r = await post(body);
  const v = JSON.parse((await r.json()).message.content);
  return { pass: v.match === true && Number(v.confidence) >= 60 && v.outdoors !== false, v, secs: (Date.now() - t0) / 1000 };
}
(async () => {
  let right = 0, total = 0, time = 0;
  for (const [dir, expected] of [[passDir, true], [failDir, false]])
    for (const f of fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f))) {
      const { pass, v, secs } = await judge(path.join(dir, f));
      total++; time += secs; if (pass === expected) right++;
      console.log(`${pass === expected ? 'OK ' : 'BAD'} ${f} -> ${pass ? 'pass' : 'fail'} (${v.confidence}%) ${v.caption} [outdoors: ${v.outdoors}, ${secs.toFixed(1)}s]`);
    }
  console.log(`\n${right}/${total} correct, average ${(time / total).toFixed(1)}s per photo (model: ${MODEL})`);
})().catch(e => console.log('Failed:', e.message));
