# Grassroots

*Go out. Seal it. Bring it home.*

**An offline-first outdoor game for friends. You do real things outside, photos stay sealed on your phone, and a local open-weight AI (Gemma) opens the envelopes when you get home.**

Built for the DEV Hacktoberfest Open-Source AI Challenge, Week 1: Touch Grass.

> Screenshots: add yours to `docs/screenshots/` and link them here.
> Live demo: `<your-render-url>` (judging only happens while the home judge is running, see [Limitations](#limitations)).

## What it does

Create a squad, share the code, and compete on daily outdoor goals:

| Activity | What you do | Points |
|---|---|---|
| **Squad quest** | The whole group does an activity together (ball game, walk-and-talk, frisbee, stretching). Each player sends a photo. | 10 + streak bonus (up to 5) |
| **Together bonus** | Two squadmates' passed photos were taken within 90 minutes of each other. | +10 each |
| **Walk challenge** | Five photo checkpoints of simple things (something blue, a tree, a gate). Stops are revealed one at a time. | 4 per stop, +10 for finishing all five |
| **Detox quest** | Log 3 or more hours of screen time and an outdoor photo task unlocks. | 15 |

There is a leaderboard, daily streaks, levels (every 50 points) and a feed of judged photos.

## How it works

1. **Out of range:** every photo is shrunk and saved on the phone. The app and today's quests are cached, so it opens with no signal.
2. **Back online:** sealed photos upload in order.
3. **At home:** Gemma looks at each photo, decides whether it matches the quest, whether people are visible (squad quests) and whether it was taken outdoors, then awards points.
4. **Photos are deleted** from the server as soon as they are judged. Only the verdict, a short caption and the points are stored.

```
LOCAL MODE (everything on one laptop)
  Phone  --HTTP-->  server.js  -->  judge.js  -->  Ollama (Gemma)

HOSTED MODE (public link, no AI on the server)
  Phone  --HTTPS-->  server.js (MODE=hub)  <--outgoing calls--  worker.js  -->  Ollama (Gemma)
                      hosted, e.g. Render                         your laptop
```

The hosted server is only a mailbox and scoreboard. Your laptop makes outgoing requests to it, so no router or firewall setup is needed.

## Why open-weight

- Runs on a laptop with a 4 GB graphics card, no cloud AI service involved.
- Friends' photos are judged on a machine you control.
- You can change how it behaves. Turning off Gemma's "thinking" step cut judging from up to a minute to a few seconds. Models, prompts and the confidence threshold are all swappable.
- No per-photo cost.

## Results so far

- Tested the object judge on 9 photos (5 leaves, 4 lookalikes plus indoor shots): **9/9 correct, about 3.5 seconds per photo** on an RTX 2050 (4 GB) laptop with `gemma4:e4b-it-q4_K_M`. That is a small test with clean images, so treat it as promising, not proven.
- Tried running Gemma 4 inside the phone's browser with WebGPU. It worked on a laptop but the phone stopped with a "does not support fp16" error, so the laptop stays the judge.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer
- [Ollama](https://ollama.com) with a Gemma 4 vision model, for example `ollama pull gemma4:e4b-it-q4_K_M`
- Phones on the same Wi-Fi as the laptop (local mode), or a hosted deployment (hosted mode)

## Quick start (local mode)

```bash
git clone <your-repo-url>
cd <your-repo>
npm install
ollama pull gemma4:e4b-it-q4_K_M
npm start
```

The terminal prints an address like `http://192.168.0.9:3000`. Open it on your phone, create a group, and invite friends with the group code.

Browsers only run service workers on secure origins, so offline page caching needs HTTPS. In local mode the sealed-photo queue still works as long as the page stays open.

## Hosted mode (public link)

1. Deploy this repo as a Node web service. On Render, a paid instance with a persistent disk is needed to keep data across restarts.
   - Build command: `npm install`
   - Start command: `npm start`
   - Disk mounted at `/var/data`
   - Environment variables: `MODE=hub`, `DATA_DIR=/var/data`, `WORKER_KEY=<a long random secret>`
2. On the laptop that has Ollama, start the home judge:

```bat
set HUB_URL=https://<your-service>.onrender.com
set WORKER_KEY=<the same secret>
node worker.js
```

Keep that window open. The app shows "waiting for the home judge" whenever it is not running.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `local` | `local` judges in-process, `hub` is the hosted mailbox |
| `PORT` | `3000` | Server port |
| `DATA_DIR` | project folder | Where `data.json` and temporary photos live |
| `WORKER_KEY` | none | Shared secret for the home judge (required in hub mode) |
| `MODEL` | `gemma4:e4b-it-q4_K_M` | Ollama model used to judge |
| `OLLAMA_URL` | `http://localhost:11434` | Where Ollama is running |
| `SCREEN_LIMIT` | `3` | Hours of screen time that unlock the detox quest |
| `REQUIRE_OUTDOORS` | on | Set to `0` to stop rejecting photos that look indoors |
| `HUB_URL` | none | Hosted app address, used by `worker.js` |

## Project structure

```
server.js            App, API, sealed-proof storage and scoring
judge.js             All Gemma prompts and the quest generator
worker.js            Home judge for hosted mode
public/index.html    The whole front end (HTML, CSS, JS)
public/sw.js         Offline page cache
public/fonts/        Bundled fonts (no CDN)
check-gemma.js       Ask Gemma to describe one photo
test-judge.js        Measure judge accuracy and speed on two photo folders
public/webgpu-check.html   Phone check for WebGPU and storage limits
decision.md          Every design decision and why
flow.md              Architecture, endpoints and data flow
```

## Testing the judge

```bash
node test-judge.js "Photograph leaves" path/to/should-pass path/to/should-fail
```

It prints each verdict, the seconds per photo and the total score.

## Limitations

- In hosted mode, photos are only judged while the laptop worker and Ollama are running.
- Offline page caching needs HTTPS.
- A small model cannot count and can be fooled by a photo of a screen.
- The together bonus relies on each phone's clock.
- Walk distance is not measured. Checkpoints are photos, not verified kilometres.
- Data is stored in one JSON file, which is fine for a squad-sized game, not for thousands of users.

## Documentation

- [`decision.md`](decision.md): the decisions behind the design, including what was tried and dropped
- [`flow.md`](flow.md): architecture, endpoints, data model and rules

## Credits

- [Gemma](https://ai.google.dev/gemma) (open weights by Google) running through [Ollama](https://ollama.com)
- [Express](https://expressjs.com)
- Fonts bundled under the SIL Open Font License: Barlow Condensed, Space Mono and Inter
- Visual style inspired by the Hacktoberfest 2026 site's colors and type, with original layout and artwork
- Built with AI assistance (Claude). Design choices and test results are logged in `decision.md`.

## License

Add your chosen license here (for example MIT) and include a `LICENSE` file.
