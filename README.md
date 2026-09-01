# learning-algorithm

Local learning sidecar for the Unbiased desktop app: records agent
trajectories, scores outcomes, distills compact lessons, and serves them
back for injection into future turns. All data stays on the user's machine —
with one exception, opt-in and off by default: the `pareto` judge posts a
redacted digest (which includes the task's absolute cwd) to the gateway.

**Standalone-first.** The desktop app is one client of this protocol, not
the center of the design. Today the ways in are the CLI, synthetic
trajectories, and rollout replay; the stdio server (docs/PROTOCOL.md) is the
app's eventual entry point, and `conformance/` will be its executable spec —
the same pattern `unbiased-app-engine` uses.

## Layout

| Path | What |
|---|---|
| `docs/PROTOCOL.md` | The wire contract (ndjson over stdio, ack'd ingestion, backpressure, judge config) |
| `docs/EVENT-MAPPING.md` | LearningEvent schema + field-by-field mapping from rollouts and app notifications |
| `src/core/` | Pure logic: event schema/validation, redaction |
| `src/store/` | SQLite via `node:sqlite` (zero native deps), FTS5 lesson index |
| `src/synth/` | Seeded archetype generator with ground-truth labels |
| `src/adapters/` | CLI, rollout replay, and the stdio server the app spawns |
| `conformance/` | Executable spec of the protocol — spawns the real process, drives it like the app will |
| `fixtures/` | Hand-written rollout sample mirroring real engine 0.147.0 records |

## Use

```bash
npm install
npm test
npm run typecheck

# synthesize + ingest a labeled trajectory
node --import tsx src/adapters/cli.ts gen --archetype flailing-loop --seed 7

# map a real conversation log (dry-run prints the census)
node --import tsx src/adapters/cli.ts replay ~/.unbiased/app-engine/home/sessions/2026/08/18/rollout-*.jsonl --dry-run

node --import tsx src/adapters/cli.ts stats
```

The database defaults to `data/learning.db` (gitignored); every free-text
field passes through `src/core/redact.ts` before persistence, and the store
refuses events whose text still looks like a secret.

## Roadmap

1. ✅ Protocol + skeleton + redaction + synthetic ingest + rollout replay
2. ✅ Deterministic rewards + archetype ranking tests
3. ✅ Lessons + FTS5 retrieval + planted-lesson tests
4. ✅ Judge interface + mock backend (rubric/parser ported from draco-bench-box)
5. ✅ Pareto judge behind strict budget/idle gates (live smoke passed 2026-08-30, $0.0029)
6. ✅ Stdio server + conformance suite (npm run conformance)
7. ✅ Full rollout replay report (`replay-all` + `report`; findings in data/replay-report.md)
8. App integration (`LearningClient` in unbiased-app) — the sidecar half is
   ready: `npm run bundle` emits `dist/sidecar/` with a `sidecar.json`
   manifest declaring how to launch it, and `npm run conformance:bundle`
   drives the suite against that built artifact.
