# decision.md: what we decided and why

Newest decisions go at the bottom. Add a row whenever something changes.

| # | Decision | Why | Trade-off / revisit when |
|---|----------|-----|--------------------------|
| D1 | The app runs fully offline: everything lives on one laptop, phones connect over local Wi-Fi or a phone hotspot. | The challenge is about open models, and "works with no internet and no data leaving your machine" is the strongest story. | Players must be on the same network. |
| D2 | Model: `gemma4:e4b-it-q4_K_M` through Ollama. | Open-weight, multimodal (reads photos), and small enough for a 4 GB GPU with RAM spill. Also qualifies for Best Use of Gemma. | Slower than E2B. If judging takes too long, switch with `set MODEL=gemma4:e2b`. |
| D3 | Mobile-friendly web page instead of a native app. | Two-day deadline. Browsers can open the phone camera through a file input, which works over plain HTTP. | Cannot read real phone screen time. |
| D4 | Backend is Node.js + Express. | Smallest amount of code, one language end to end, easy to fix by pasting errors. | None for now. |
| D5 | Data is stored in one JSON file (`data.json`) held in memory. | SQLite needs native builds that often fail on Windows, and we only need a few hundred records. | Move to SQLite if the group grows or concurrent writes become a problem. |
| D6 | Photos are shrunk to 640 px in the browser and sent as base64 JSON. They are not saved. | Small images are judged much faster on 4 GB VRAM, and not storing photos supports the privacy story. | The feed shows captions, not pictures. |
| D7 | Gemma is both Quest Master and referee. Judge replies in JSON `{match, confidence, caption}`. A pass needs `match = true` and confidence of at least 60. | One model, two jobs, keeps the AI central to the product. A threshold reduces false passes from a small model. | Tune `MIN_CONFIDENCE` after testing about 15 photos. |
| D8 | If quest generation fails or returns junk, use a built-in list of 6 quests. | The game must never be blocked by the AI. | Fallback quests repeat sooner. |
| D9 | One scored completion per player per day. Identical photos (SHA-1 of the image) are rejected. | Cheap anti-cheat that needs no extra tooling. | A re-encoded copy of the same photo would pass. |
| D10 | Scoring: 10 points, +5 for being first in the group that day, plus streak bonus (streak days, capped at 5). | Rewards speed and consistency, which are the two things the game is about. | Adjust after playtesting. |
| D11 | No GPS verification. Multi-stop walks will use numbered checkpoints. | Browsers block location on plain HTTP, and verifying distance is out of scope for two days. | Needs HTTPS or a native app. |
| D12 | Screen-time nudges (planned) use a number the player types in. | Web pages cannot read phone usage. A real version would use Android's usage-stats API. | Say this clearly in the write-up. |
| D13 | Mastra agent wrapper is deferred to layer 2. | Core loop (join, quest, photo, judge, leaderboard) must work first. | Only claim the Mastra category if we actually ship it. |
| D14 | No web fonts or CDN scripts. | Offline requirement. | Uses system fonts only. |
