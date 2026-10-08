// Usage: node test-judge.js "quest" passFolder failFolder
// Runs the real judge (judge.js, same as the app) on two folders of photos and prints accuracy and speed.
const fs = require('fs'), path = require('path');
const { judgeObject, MODEL } = require('./judge');
const [, , quest, passDir, failDir] = process.argv;
if (!quest || !passDir || !failDir) { console.log('Usage: node test-judge.js "quest" passFolder failFolder'); process.exit(1); }
(async () => {
  let right = 0, total = 0, time = 0;
  for (const [dir, expected] of [[passDir, true], [failDir, false]])
    for (const f of fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f))) {
      const t0 = Date.now();
      const v = await judgeObject(quest, fs.readFileSync(path.join(dir, f)).toString('base64'));
      const secs = (Date.now() - t0) / 1000, pass = v.match && v.confidence >= 60 && v.outdoors !== false;
      total++; time += secs; if (pass === expected) right++;
      console.log(`${pass === expected ? 'OK ' : 'BAD'} ${f} -> ${pass ? 'pass' : 'fail'} (${v.confidence}%) ${v.caption} [outdoors: ${v.outdoors}, ${secs.toFixed(1)}s]`);
    }
  console.log(`\n${right}/${total} correct, average ${(time / total).toFixed(1)}s per photo (model: ${MODEL})`);
})().catch(e => console.log('Failed:', e.message));
