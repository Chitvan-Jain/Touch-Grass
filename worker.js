// Home judge for a hosted Grassroots (MODE=hub). Run on the laptop that has Ollama.
//   set HUB_URL=https://your-app.example.com
//   set WORKER_KEY=the-same-secret-as-the-server
//   node worker.js
// It only makes outgoing requests, so no router or firewall changes are needed.
const { MODEL, judgeObject, judgeSquad, makeBank } = require('./judge');
const HUB = (process.env.HUB_URL || '').replace(/\/$/, ''), KEY = process.env.WORKER_KEY;
if (!HUB || !KEY) { console.log('Set HUB_URL and WORKER_KEY first. See flow.md.'); process.exit(1); }
const hub = async (p, opt = {}) => {
  const r = await fetch(HUB + p, { ...opt, headers: { 'x-worker-key': KEY, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r;
};
const tries = new Map();
async function tick() {
  const { proofs, bank } = await (await hub('/api/worker/pending')).json();
  for (const pr of proofs) {
    try {
      const image = Buffer.from(await (await hub('/api/worker/photo/' + pr.id)).arrayBuffer()).toString('base64');
      const v = await (pr.kind === 'squad' ? judgeSquad : judgeObject)(pr.text, image);
      await hub('/api/worker/verdict/' + pr.id, { method: 'POST', body: JSON.stringify(v) });
      console.log(`Judged ${pr.kind}: ${v.match ? 'match' : 'no match'} (${v.confidence}%)`);
    } catch (e) {
      const n = (tries.get(pr.id) || 0) + 1; tries.set(pr.id, n);
      console.log('Problem with a proof:', e.message);
      if (e.parse && n >= 3) await hub('/api/worker/verdict/' + pr.id, { method: 'POST', body: JSON.stringify({ match: false, caption: 'The judge could not read this photo.' }) }).catch(() => {});
    }
  }
  if (!proofs.length && Object.values(bank || {}).some(n => n > 0)) {
    const lists = await makeBank(bank);
    await hub('/api/worker/bank', { method: 'POST', body: JSON.stringify(lists) });
    console.log('Quest bank refilled.');
  }
}
console.log(`Home judge running for ${HUB} (model ${MODEL}). Leave this window open.`);
(async function loop() {
  try { await tick(); } catch (e) { console.log('Waiting for the hub:', e.message); }
  setTimeout(loop, 5000);
})();
