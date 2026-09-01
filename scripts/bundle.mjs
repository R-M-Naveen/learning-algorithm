// `npm run bundle` is the contract with unbiased-app, in the same sense
// unbiased-app-engine's `make bundle` is: it produces dist/sidecar/, a
// self-contained directory the app copies into its package — and nothing else
// crosses the repo boundary.
//
// The app must not learn how this repo is built. It resolves a DIRECTORY and
// reads sidecar.json to find out how to run what is inside it. That manifest
// is the hook: shipping a compiled binary instead of a JS bundle later, or
// changing the entry filename, or needing an extra flag, is a change to the
// manifest and to this script — never to the app.
//
// tsx is a dev-only loader (it transpiles on every start), so what ships is a
// bundle: one file, zero runtime dependencies, `node:*` builtins only.
import { build } from "esbuild";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist", "sidecar");
const entryName = "learning-sidecar.mjs";
const pkg = createRequire(import.meta.url)("../package.json");

// Regenerate rather than patch: a stale file in a shipped directory is the
// kind of thing nobody notices until it is in someone's app bundle.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(root, "src", "adapters", "stdio.ts")],
  outfile: join(outDir, entryName),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // node:sqlite and friends are builtins, and bundling them would be wrong;
  // everything else is our own source, so the output has no dependencies.
  packages: "bundle",
  external: ["node:*"],
  sourcemap: true,
  minify: false, // a stack trace from a user's machine has to be readable
  legalComments: "none",
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);

// PROTOCOL_VERSION is the number the app must send in learning/initialize.
// Publishing it here means the app reads the version it is talking to instead
// of hard-coding a constant that can drift.
const protocolVersion = 1;

writeFileSync(
  join(outDir, "sidecar.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      protocolVersion,
      // How to run it. "node" means: spawn the host's own Node — for Electron
      // that is process.execPath with ELECTRON_RUN_AS_NODE=1 — with `entry`
      // as the script, plus `args`. A future compiled build would say
      // {"runtime":"executable","entry":"learning-sidecar"} and the app's
      // launcher would need no change beyond honouring that.
      runtime: "node",
      entry: entryName,
      args: [],
      // Minimum Node the bundle was built for; the app can refuse early with
      // a clear message instead of failing on a syntax error at startup.
      minNodeVersion: "22.5.0",
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);

console.log(`  • bundled ${entryName} (${(bytes / 1024).toFixed(1)} KB) + sidecar.json → dist/sidecar/`);
