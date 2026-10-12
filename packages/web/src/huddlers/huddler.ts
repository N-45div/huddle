/**
 * The Huddlers: a little bot for each of your assistants, and Hud, Huddle's own. Same family, each its own
 * colour, with a nod to what it is (OpenClaw's claws, Hermes's wings, Ollama's llama ears...), and a mood.
 * Drawn as an SVG string from fixed parts only (no text from anyone goes in), so the canvas and the desktop
 * app's opening screen share one drawing.
 */

export type Mood = "idle" | "happy" | "thinking" | "waiting" | "sleepy" | "oops";

/** Friendly colours a Huddler can be; each assistant keeps the same one. */
export const PALETTE = ["#5b63e6", "#1fa69a", "#f26d5b", "#f2a93b", "#e45d9c", "#3aa0e8", "#6fb43a", "#9a62e0"] as const;
/** Hud's colour: Huddle's own indigo. */
export const HUD = "#5b63e6";

/** The same colour for the same assistant, every time. */
export function colorFor(id: string): string {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

/** A colour made darker (for feet and outlines) or lighter, by mixing with black or white. */
function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const mix = (channel: number) => Math.round(amount < 0 ? channel * (1 + amount) : channel + (255 - channel) * amount);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(mix);
  return `#${((1 << 24) | (r! << 16) | (g! << 8) | b!).toString(16).slice(1)}`;
}

const SCREEN = "#1b1d2e";
const GLOW = "#e9ecff";

function face(mood: Mood): string {
  const line = `stroke="${GLOW}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  switch (mood) {
    case "happy":
      return `<path class="h-eyes" d="M22.5 35.5q3-4.5 6 0M35.5 35.5q3-4.5 6 0" ${line}/><path d="M27.5 39.5q4.5 4.5 9 0" ${line}/>`;
    case "thinking":
      return `<g class="h-eyes" fill="${GLOW}"><rect x="25" y="29.5" width="4.6" height="6" rx="2.3"/><rect x="37.5" y="29.5" width="4.6" height="6" rx="2.3"/></g><path d="M29.5 40.5h5" ${line}/>`;
    case "waiting":
      return `<g class="h-eyes" fill="${GLOW}"><circle cx="25.5" cy="34" r="3"/><circle cx="38.5" cy="34" r="3"/></g><circle cx="32" cy="41" r="1.7" fill="none" stroke="${GLOW}" stroke-width="1.6"/>`;
    case "sleepy":
      return `<path d="M22.5 34.5h6M35.5 34.5h6" ${line}/><path d="M30 40.5q2 1.2 4 0" ${line}/>`;
    case "oops":
      return `<path d="M23 31.5l5 5M28 31.5l-5 5M36 31.5l5 5M41 31.5l-5 5" ${line}/><path d="M27.5 41.5q2.25-2 4.5 0q2.25 2 4.5 0" ${line}/>`;
    default:
      return `<g class="h-eyes" fill="${GLOW}"><rect x="22.8" y="30.5" width="5.2" height="7.4" rx="2.6"/><rect x="36" y="30.5" width="5.2" height="7.4" rx="2.6"/></g><path d="M28.5 40.2q3.5 2.8 7 0" ${line}/>`;
  }
}

/** Above the head (and sometimes about it): what kind of assistant this is. */
function accessory(connector: string, color: string, dark: string): { back: string; front: string; arms?: boolean } {
  const antenna = (bulb: string) => `<line x1="32" y1="17.5" x2="32" y2="9" stroke="${dark}" stroke-width="2.4" stroke-linecap="round"/><circle class="h-bulb" cx="32" cy="7.2" r="3.6" fill="${bulb}"/>`;
  switch (connector) {
    case "openclaw": {
      // Lobster claws for hands, open and ready.
      const claw = (x: number, flip: number) =>
        `<g class="${flip > 0 ? "h-arm-l" : "h-arm-r"}" transform="translate(${x} 39) scale(${flip} 1)"><path d="M0 0c-3.5 0-6.5-2.5-7-6.2c-.4-3 1-5.6 3.4-6.8l1.6 4.6l2.8-5.4c2.6.9 4.4 3.4 4.3 6.4C5 -3.2 3 0 0 0z" fill="#ef4f3f" stroke="${dark}" stroke-width="1.1" stroke-linejoin="round"/></g>`;
      return { back: "", front: `${antenna("#ef4f3f")}${claw(9.5, 1)}${claw(54.5, -1)}`, arms: false };
    }
    case "hermes": {
      // Wings at the temples: the messenger.
      const wing = (x: number, flip: number) =>
        `<g transform="translate(${x} 0) scale(${flip} 1)"><path d="M0 26c-4.5-.5-8.5-3.8-9.5-9.5c2.2 1.3 4.6 1.7 6.8 1.2c-1.7 1.3-1.9 3.1-1.2 4.3c1.3-.6 2.7-.6 3.9 0C-.4 23.3-.4 24.7 0 26z" fill="#ffffff" stroke="${dark}" stroke-width="1.2" stroke-linejoin="round"/></g>`;
      return { back: `${wing(11, 1)}${wing(53, -1)}`, front: antenna("#ffd166") };
    }
    case "ollama": {
      // Llama ears.
      const ear = (x: number, angle: number) =>
        `<g transform="rotate(${angle} ${x} 18)"><path d="M${x - 4} 19c-1-6 1-11 4-13.5c3 2.5 5 7.5 4 13.5z" fill="${color}"/><path d="M${x - 1.8} 17.5c-.4-3.8.6-7 1.8-8.6c1.2 1.6 2.2 4.8 1.8 8.6z" fill="#ffd9c7"/></g>`;
      const wool = `<path d="M26 18.5c-1.5-2.8.8-5.6 3.4-4.6c.8-2.6 4.6-3 5.8-.6c2.6-.8 4.8 1.8 3.6 4.2c1.2 1.6.4 3.6-1.4 3.8H27.6c-1.6-.2-2.4-1.6-1.6-2.8z" fill="#fff6ee" stroke="${dark}" stroke-width="1" stroke-linejoin="round"/>`;
      return { back: `${ear(19, -22)}${ear(45, 22)}`, front: wool };
    }
    case "email":
      // An envelope on the way.
      return { back: "", front: `<g class="h-float"><rect x="22.5" y="1.5" width="19" height="13" rx="2.2" fill="#ffffff" stroke="${dark}" stroke-width="1.4"/><path d="M23.5 2.8l8.5 6.5l8.5-6.5" fill="none" stroke="${dark}" stroke-width="1.4" stroke-linejoin="round"/></g>` };
    case "pact":
      // Dressed for business: a bow tie.
      return { back: "", front: `${antenna("#ffd166")}<path d="M25.5 47.5l6.5 3.2l-6.5 3.2zM38.5 47.5l-6.5 3.2l6.5 3.2z" fill="#ffd166" stroke="${dark}" stroke-width="1" stroke-linejoin="round"/><circle cx="32" cy="50.7" r="1.8" fill="${dark}"/>` };
    case "openshell":
      // Inside a glass dome: sandboxed.
      return { back: antenna("#7cf0c9"), front: `<path d="M6.5 31a25.5 25.5 0 0 1 51 0" fill="#bfe3ff" fill-opacity=".22" stroke="#8fd0ff" stroke-width="1.8"/><path d="M14 18a18 18 0 0 1 9-7" stroke="#ffffff" stroke-opacity=".75" stroke-width="2" fill="none" stroke-linecap="round"/>` };
    case "homeassistant":
      // A roof for a hat.
      return { back: "", front: `<path d="M15.5 19.5L32 5.5l16.5 14" fill="none" stroke="#41bdf5" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><rect x="40" y="6" width="3.6" height="7" rx="1" fill="#41bdf5"/>` };
    case "sochen":
      // A thought on its way up.
      return { back: "", front: `<circle cx="35" cy="14" r="1.6" fill="#ffffff" stroke="${dark}" stroke-width="1"/><circle cx="38.5" cy="10" r="2.3" fill="#ffffff" stroke="${dark}" stroke-width="1"/><path d="M38 6.5c0-3 3-4.5 5-3c1-2 4.5-2 5.5.5c2.5 0 3.5 3 1.5 4.5c.5 2.5-2.5 3.5-4 2c-1.5 1.5-4.5 1-5-1c-2 .5-3.5-1.5-3-3z" fill="#ffffff" stroke="${dark}" stroke-width="1"/>` };
    case "instinct":
      // A spark.
      return { back: "", front: `<path class="h-bulb" d="M34.5 1.5l-7 10h5.2l-3.2 7.5l8.8-11h-5.4l3.6-6.5z" fill="#ffd23f" stroke="${dark}" stroke-width="1.1" stroke-linejoin="round"/>` };
    case "agentzero":
      // A halo, for agent zero.
      return { back: "", front: `<ellipse class="h-float" cx="32" cy="9" rx="11.5" ry="3.4" fill="none" stroke="#ffd23f" stroke-width="2.6"/>` };
    case "cli":
      // A little terminal with its prompt: an agent CLI on this computer.
      return {
        back: "",
        front: `<line x1="32" y1="17.5" x2="32" y2="15" stroke="${dark}" stroke-width="2.4" stroke-linecap="round"/><rect x="22" y="2.5" width="20" height="13" rx="2.6" fill="#1e2030" stroke="${dark}" stroke-width="1.2"/><circle cx="25" cy="5" r=".8" fill="#ff6b6b"/><circle cx="27.5" cy="5" r=".8" fill="#ffd23f"/><path d="M25.5 8.2l2.8 2.2l-2.8 2.2" fill="none" stroke="#7cf0c9" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><line x1="30.5" y1="12.6" x2="36" y2="12.6" stroke="#7cf0c9" stroke-width="1.7" stroke-linecap="round"/>`,
      };
    case "vllm":
      // A GPU chip with a V: your own model, served by vLLM.
      return {
        back: "",
        front: `<line x1="32" y1="17.5" x2="32" y2="15" stroke="${dark}" stroke-width="2.4" stroke-linecap="round"/><g stroke="${dark}" stroke-width="1.4" stroke-linecap="round"><path d="M26 4v-2M30.7 4v-2M35.3 4v-2M40 4v-2M26 16v1M38 16v1"/></g><rect x="23" y="3.5" width="18" height="12" rx="2.4" fill="#2d3142" stroke="${dark}" stroke-width="1.2"/><path d="M27.8 6.8l4.2 6l4.2-6" fill="none" stroke="#ffd23f" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
      };
    case "mock":
      return { back: "", front: antenna("#c9cbd6") };
    case "openai":
    case "a2a":
    case "http":
      // Talking over the wire.
      return { back: "", front: `${antenna("#7cf0c9")}<path class="h-waves" d="M38.5 3.5a6 6 0 0 1 0 7.5M42 1a10.5 10.5 0 0 1 0 12.5" stroke="${dark}" stroke-width="1.6" fill="none" stroke-linecap="round"/>` };
    default:
      return { back: "", front: antenna("#ffd166") };
  }
}

export interface HuddlerOptions {
  /** The assistant's connector: picks what it wears (none for Hud). */
  readonly connector?: string;
  readonly color?: string;
  readonly mood?: Mood;
  /** Read out by screen readers; the drawing is decorative without it. */
  readonly title?: string;
  readonly size?: number;
}

/** One Huddler as an SVG string. */
export function huddlerSvg(options: HuddlerOptions = {}): string {
  const color = options.color ?? HUD;
  const dark = shade(color, -0.42);
  const light = shade(color, 0.35);
  const mood = options.mood ?? "idle";
  const stand = options.connector === "mock";
  const { back, front, arms = true } = accessory(options.connector ?? "", color, dark);
  const size = options.size ?? 64;
  const label = options.title ? `role="img" aria-label="${options.title.replace(/[<>&"]/g, "")}"` : `aria-hidden="true"`;
  return `<svg class="huddler mood-${mood}" viewBox="0 0 64 64" width="${size}" height="${size}" ${label} xmlns="http://www.w3.org/2000/svg">
<ellipse class="h-shadow" cx="32" cy="60.5" rx="15" ry="2.6" fill="#000" opacity=".14"/>
<g class="h-body">
${back}
<rect x="20" y="51.5" width="9.5" height="7.5" rx="3.75" fill="${dark}"/>
<rect x="34.5" y="51.5" width="9.5" height="7.5" rx="3.75" fill="${dark}"/>
${arms ? `<rect class="h-arm-l" x="5.5" y="32" width="9" height="13.5" rx="4.5" fill="${color}"/>\n<rect class="h-arm-r" x="49.5" y="32" width="9" height="13.5" rx="4.5" fill="${color}"/>` : ""}
<rect x="10" y="17" width="44" height="39" rx="19" fill="${color}"${stand ? ` stroke="${dark}" stroke-width="1.6" stroke-dasharray="3 2.4"` : ""}/>
<path d="M17 27.5q2.5-6.5 10-8" stroke="${light}" stroke-width="2.8" fill="none" stroke-linecap="round" opacity=".8"/>
<ellipse cx="32" cy="50" rx="10" ry="3.6" fill="#ffffff" opacity=".16"/>
<rect x="16" y="24.5" width="32" height="20.5" rx="10.25" fill="${SCREEN}"/>
<circle cx="13.8" cy="42" r="2.4" fill="#ff8fa3" opacity=".75"/>
<circle cx="50.2" cy="42" r="2.4" fill="#ff8fa3" opacity=".75"/>
${face(mood)}
${front}
${mood === "thinking" ? `<g class="h-dots" fill="${dark}"><circle cx="53" cy="15" r="1.6"/><circle cx="57.5" cy="11" r="2"/><circle cx="62" cy="6.5" r="2.4"/></g>` : ""}
</g>
</svg>`;
}
