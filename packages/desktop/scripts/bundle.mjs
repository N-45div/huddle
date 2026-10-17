// Gets what the desktop app ships ready in src-tauri: Huddle's server as one file (resources/server), the
// built canvas (resources/web), the OpenShell protos the server loads at run time, and a pinned Node runtime
// as the app's sidecar (binaries/huddle-node-<target>), checked against nodejs.org's published checksum.
//
//   node scripts/bundle.mjs                 for this machine's target
//   HUDDLE_NODE_TARGET=x86_64-unknown-linux-gnu node scripts/bundle.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const NODE_VERSION = "24.11.1";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const tauri = join(here, "..", "src-tauri");
const resources = join(tauri, "resources");

// 1. The server, bundled: its workspace packages and dependencies in one ES module.
rmSync(join(resources, "server"), { recursive: true, force: true });
await build({
  entryPoints: [join(root, "packages/server/src/main.ts")],
  outfile: join(resources, "server/huddle.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  legalComments: "none",
  // Dependencies written as CommonJS still reach for require and __dirname.
  banner: {
    js: [
      'import { createRequire as __huddleRequire } from "node:module";',
      'import { fileURLToPath as __huddlePath } from "node:url";',
      'import { dirname as __huddleDir } from "node:path";',
      "const require = __huddleRequire(import.meta.url);",
      "const __filename = __huddlePath(import.meta.url);",
      "const __dirname = __huddleDir(__filename);",
    ].join("\n"),
  },
  logLevel: "warning",
});
// The OpenShell client loads its protos from ./proto next to itself.
cpSync(join(root, "packages/core/src/openshell/proto"), join(resources, "server/proto"), { recursive: true });
// The example flows, offered as templates in the canvas.
cpSync(join(root, "examples"), join(resources, "server/examples"), { recursive: true });

// 2. The canvas, built.
const web = join(root, "packages/web/dist");
if (!existsSync(join(web, "index.html"))) execFileSync("npm", ["run", "build", "-w", "@huddle/web"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
rmSync(join(resources, "web"), { recursive: true, force: true });
cpSync(web, join(resources, "web"), { recursive: true });

// 3. The opening screen: Hud and friends, drawn in each mood, put into the page.
const { colorFor, huddlerSvg } = await import(new URL("../../web/src/huddlers/huddler.ts", import.meta.url).href);
const crew = { hud: { size: 132 }, f1: { connector: "hermes", size: 92 }, f2: { connector: "openclaw", size: 104 }, f3: { connector: "ollama", size: 104 }, f4: { connector: "email", size: 92 }, back1: { connector: "openshell", size: 74 }, back2: { connector: "homeassistant", size: 74 } };
const draw = (mood) => Object.fromEntries(Object.entries(crew).map(([spot, who]) => [spot, huddlerSvg({ ...(who.connector ? { connector: who.connector, color: colorFor(`${who.connector}-${spot}`) } : {}), size: who.size, mood: spot === "hud" && mood === "idle" ? "happy" : mood })]));
const idle = draw("idle");
let splash = readFileSync(join(here, "..", "launcher", "splash.html"), "utf8");
for (const [spot, svg] of Object.entries(idle)) splash = splash.replace(`{{${spot}}}`, svg);
// "</" can't appear inside a <script>: write it as "<\/", which JavaScript reads back as "</".
splash = splash.replace("{{moods}}", JSON.stringify({ happy: draw("happy"), oops: draw("oops") }).replaceAll("</", "<\\/"));
writeFileSync(join(here, "..", "launcher", "index.html"), splash);

// 4. Node, for the target the app is built for.
const target = process.env.HUDDLE_NODE_TARGET ?? (process.platform === "linux" ? (process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu") : null);
if (target) await fetchNode(target);
else console.log("Bundled the server, the canvas and the opening screen. No Node runtime fetched: the desktop app is built for Linux (set HUDDLE_NODE_TARGET).");

async function fetchNode(target) {
const arch = { "x86_64-unknown-linux-gnu": "linux-x64", "aarch64-unknown-linux-gnu": "linux-arm64" }[target];
if (!arch) throw new Error(`No Node runtime for ${target}.`);
const sidecar = join(tauri, "binaries", `huddle-node-${target}`);
const stamp = `${sidecar}.version`;
if (!existsSync(sidecar) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== NODE_VERSION) {
  const name = `node-v${NODE_VERSION}-${arch}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split("\n").find((line) => line.endsWith(`  ${name}.tar.xz`))?.split(" ")[0];
  if (!expected) throw new Error(`nodejs.org lists no checksum for ${name}.tar.xz.`);
  const archive = Buffer.from(await (await fetch(`${base}/${name}.tar.xz`)).arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`${name}.tar.xz doesn't match nodejs.org's checksum (${actual} vs ${expected}).`);
  const scratch = join(tauri, "binaries", ".node");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "node.tar.xz"), archive);
  execFileSync("tar", ["-xJf", "node.tar.xz", `${name}/bin/node`], { cwd: scratch, stdio: "inherit" });
  cpSync(join(scratch, name, "bin/node"), sidecar);
  chmodSync(sidecar, 0o755);
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(stamp, NODE_VERSION);
}
console.log(`Bundled the server, the canvas, the opening screen, and Node ${NODE_VERSION} for ${target}.`);
}
