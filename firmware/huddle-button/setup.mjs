#!/usr/bin/env node
// Sets a Huddle button up to talk to your Huddle: makes its device token, finds this computer's address on your
// network, asks for your Wi-Fi (the password typed hidden, never printed), and writes config.h next to the
// sketch. Then it says how to let the button in and how to flash it.
//
//   HUDDLE_TOKEN=... node firmware/huddle-button/setup.mjs [--huddle http://127.0.0.1:7700] [--name "Desk button"]
//                                                            [--ssid "My Wi-Fi"] [--host 192.168.1.20] [--force]
//
// WIFI_PASSWORD in the environment skips the password question (for scripts).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const huddle = (flag("huddle") ?? process.env.HUDDLE_URL ?? "http://127.0.0.1:7700").replace(/\/$/, "");
const token = process.env.HUDDLE_TOKEN?.trim();
const name = flag("name") ?? "Huddle button";
const out = flag("out") ?? join(here, "config.h");
const FQBN = "esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,DebugLevel=none";

const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};
// One reader for every question, its lines queued: piped answers arrive all at once, before the next question.
// Typing shows as * while muted. A closed input answers undefined.
let reader;
let muted = false;
const lines = [];
const waiting = [];
const question = (text) => {
  if (!reader) {
    reader = createInterface({ input: process.stdin, output: process.stdout });
    reader._writeToOutput = (out) => {
      if (!muted) return reader.output.write(out);
      const prompt = reader.getPrompt();
      reader.output.write(out.startsWith(prompt) ? prompt + "*".repeat(out.length - prompt.length) : out.replace(/[^\r\n]/g, "*"));
    };
    reader.on("line", (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
    reader.on("close", () => waiting.splice(0).forEach((resolve) => resolve(undefined)));
    reader.on("SIGINT", () => {
      process.stdout.write("\n");
      process.exit(130);
    });
  }
  if (lines.length) {
    process.stdout.write(`${text}\n`);
    return Promise.resolve(lines.shift());
  }
  reader.setPrompt(text);
  reader.prompt();
  return new Promise((resolve) => waiting.push(resolve));
};
const ask = async (text, fallback = "") => ((await question(fallback ? `${text} [${fallback}]: ` : `${text}: `)) ?? "").trim() || fallback;
const askHidden = async (text) => {
  muted = true;
  try {
    return await question(`${text}: `);
  } finally {
    muted = false;
  }
};
const run = (command, commandArgs) => {
  try {
    return execFileSync(command, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};
/** A C string literal's insides: backslashes and quotes escaped. */
const cString = (value) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

// A config.h that's still the example (no token pasted in) holds nothing to lose.
const filled = existsSync(out) && !readFileSync(out, "utf8").includes("hdl_d_paste-yours-here");
if (filled && !args.includes("--force")) fail(`${out} already exists. Add --force to replace it (it holds your Wi-Fi password and the token).`);

// 1. Huddle answers, and the token works.
const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
const info = await fetch(`${huddle}/api/info`, { headers }).then(
  (response) => (response.ok ? response.json() : null),
  () => null,
);
if (!info) fail(`Huddle isn't answering at ${huddle}. Start it first (npm start), or pass --huddle with its address.`);
const check = await fetch(`${huddle}/api/devices`, { headers });
if (check.status === 401) fail("Huddle wants its token: set HUDDLE_TOKEN to the token Huddle was started with.");
console.log(`Huddle ${info.version ?? ""} answers at ${huddle}.`);

// 2. This computer's address on the Wi-Fi: what the button connects to.
const addresses = Object.entries(networkInterfaces()).flatMap(([iface, list]) =>
  (list ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => ({ iface, address: entry.address })),
);
const local = addresses.filter(({ address }) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address));
const wifiFirst = [...local].sort((a, b) => Number(/wi-?fi|wlan|wireless/i.test(b.iface)) - Number(/wi-?fi|wlan|wireless/i.test(a.iface)));
const url = new URL(huddle);
const reachable = url.hostname === "127.0.0.1" || url.hostname === "localhost" ? undefined : url.hostname;
const host = flag("host") ?? reachable ?? wifiFirst[0]?.address;
if (!host) fail("Couldn't find this computer's address on a local network. Pass --host with it (ipconfig shows it).");
if (wifiFirst.length > 1 && !flag("host") && !reachable) console.log(`This computer has more than one address (${wifiFirst.map((entry) => `${entry.address} on ${entry.iface}`).join(", ")}); using ${host}. Pass --host to pick another.`);
const tls = url.protocol === "https:";
const port = Number(url.port || (tls ? 443 : 80));

// 3. The Wi-Fi the button joins. It has to be 2.4 GHz (channels 1 to 14): the ESP32-S3 has no 5 GHz radio, and a
// laptop is often on its router's 5 GHz name. On Windows, netsh says which band this computer and the networks
// around it are on; elsewhere there's no telling, so the question only says it.
const valueOf = (text, label) => {
  const line = text.split("\n").map((each) => each.trim()).find((each) => each.startsWith(label) && /^\s*:/.test(each.slice(label.length)));
  return line ? line.slice(line.indexOf(":") + 1).trim() : "";
};
let currentSsid = "";
let currentChannel = 0;
const bands = new Map(); // network name -> the bands it was seen on, "2.4" and/or "5"
if (platform() === "win32") {
  const now = run("netsh", ["wlan", "show", "interfaces"]);
  currentSsid = valueOf(now, "SSID");
  currentChannel = Number(valueOf(now, "Channel")) || 0;
  let seen;
  for (const line of run("netsh", ["wlan", "show", "networks", "mode=bssid"]).split("\n").map((each) => each.trim())) {
    if (/^SSID \d+ :/.test(line)) {
      seen = line.slice(line.indexOf(":") + 1).trim();
      bands.set(seen, new Set());
    } else if (seen !== undefined && line.startsWith("Channel")) bands.get(seen).add(Number(valueOf(line, "Channel")) <= 14 ? "2.4" : "5");
  }
} else if (platform() === "linux") currentSsid = run("iwgetid", ["-r"]).trim();
const near24 = [...bands].filter(([, seenOn]) => seenOn.has("2.4")).map(([network]) => network).filter(Boolean);
const on5 = currentChannel > 14;
if (on5) {
  console.log(`\nThis computer is on "${currentSsid}" at 5 GHz (channel ${currentChannel}). The button can't join 5 GHz: give it your router's 2.4 GHz network.`);
  console.log(near24.length ? `2.4 GHz networks in range: ${near24.map((network) => `"${network}"`).join(", ")}.` : "No 2.4 GHz network shows up here. Turn the router's 2.4 GHz band on (its settings page or app), or put this computer and the button on a phone hotspot set to 2.4 GHz and run this again.");
  console.log("The button and this computer can be on different bands of the same router: they're still one network.\n");
}
const suggestion = on5 ? (near24.find((network) => network.toLowerCase() === currentSsid.toLowerCase().replace(/[-_ ]?5(\.0)?g(hz)?$/i, "")) ?? "") : currentSsid;
const ssid = flag("ssid") ?? (await ask("Wi-Fi name for the button (2.4 GHz)", suggestion));
if (!ssid) fail("The button needs a Wi-Fi name.");
if (bands.get(ssid)?.size && !bands.get(ssid).has("2.4")) console.log(`"${ssid}" only shows up at 5 GHz here, so the button probably won't join it.`);
const password = process.env.WIFI_PASSWORD ?? (await askHidden(`Password for "${ssid}" (empty for an open network)`));
reader?.close();
if (password === undefined) fail("Stopped before the Wi-Fi password was typed.");

// 4. A device token, shown once: it goes straight into config.h.
const made = await fetch(`${huddle}/api/devices`, { method: "POST", headers, body: JSON.stringify({ name }) });
const device = await made.json().catch(() => ({}));
if (!made.ok || !device.token) fail(`Huddle didn't make a device token: ${device.error ?? `HTTP ${made.status}`}`);

writeFileSync(
  out,
  `// Written by setup.mjs for "${cString(name)}". Holds your Wi-Fi password and the device token: keep it out of git.
#define WIFI_SSID "${cString(ssid)}"
#define WIFI_PASSWORD "${cString(password)}"
#define HUDDLE_HOST "${cString(host)}"
#define HUDDLE_PORT ${port}
#define HUDDLE_TLS ${tls ? 1 : 0}
#define DEVICE_TOKEN "${cString(device.token)}"
#define VOLUME 70
// The button finds its mic channel at start-up; this is what it uses until one has heard its chime.
#define MIC_RIGHT_CHANNEL 0
`,
);
console.log(`\nWrote ${out} for "${name}" (Huddle at ${tls ? "https" : "http"}://${host}:${port}).`);

// 5. What's left: let the button in, then flash it.
const ports = run("arduino-cli", ["board", "list"]).match(/^COM\d+|^\/dev\/tty(ACM|USB)\d+/gm) ?? [];
const sketch = here;
const env = { HUDDLE_HOST: "0.0.0.0", ...(port === 7700 || tls ? {} : { HUDDLE_PORT: String(port) }), HUDDLE_TOKEN: "<your token>" };
const start =
  platform() === "win32"
    ? `${Object.entries(env).map(([key, value]) => `$env:${key}="${value}"`).join("; ")}; npm start    (in PowerShell)`
    : `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join(" ")} npm start`;
console.log(`
Next:
  1. Start Huddle so the button can reach it (the token is required off this machine):
       ${start}
${platform() === "win32" && !tls ? `  2. Let it through Windows Firewall, on private networks (an Administrator PowerShell, once):
       New-NetFirewallRule -DisplayName "Huddle ${port}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private
     and make sure your Wi-Fi is set to a Private network in Windows settings.
` : "  2. Make sure nothing blocks port " + port + " from your Wi-Fi.\n"}  3. Plug the board in by USB and flash it:
       arduino-cli compile --fqbn "${FQBN}" "${sketch}"
       arduino-cli upload --fqbn "${FQBN}" -p ${ports[0] ?? "<port: arduino-cli board list>"} "${sketch}"
     If the upload can't find the board: hold BOOT, tap RESET, let go of BOOT, and upload again.
  4. Watch it start (screen wiring, chime, mic, Wi-Fi, Huddle):
       arduino-cli monitor -p ${ports[0] ?? "<port>"} -c baudrate=115200
`);
