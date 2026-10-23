import { api } from "./api.ts";
import { colorFor, HUD, huddlerSvg } from "./huddlers/huddler.ts";
import hermesLogo from "./huddlers/logos/hermes.svg?url";
import openclawLogo from "./huddlers/logos/openclaw.svg?url";
import { type Sprite, toRgb565 } from "./usb-link.ts";

/**
 * The pictures for the Huddle button's screen: Hud, and one for each of your assistants. An assistant with a
 * logo of its own (OpenClaw, Hermes) is its logo on a round plate, which the button rings while it works;
 * any other is a Huddler (its colour from its id, what it wears from its connector), drawn here from the
 * canvas's own art with an empty visor (the button draws the faces, so they can blink, look around and talk),
 * over a soft glow on the button's background.
 */

/** Pixels square, as the button draws them (64 drawing units at 1.375 each). */
export const SPRITE_SIZE = 88;
/** A logo's square: the button tells a logo from a Huddler by this size, and draws no face on it. */
export const LOGO_SIZE = 64;
/** The button's screen background, which the glow fades into at the picture's edges. */
const BACKGROUND = "#13142a";
const GLOW = "#2a2d66";
const PLATE = "#1f2247";

/** Logos by connector (see huddlers/logos/README.md): the file, and how much of the plate it fills. */
const LOGOS: Record<string, { readonly url: string; readonly fill: number }> = {
  openclaw: { url: openclawLogo, fill: 0.8 },
  // Hermes' is a portrait, edge to edge: it fills the plate, cut round like an avatar.
  hermes: { url: hermesLogo, fill: 1 },
};

async function drawLogo(key: string, logo: { readonly url: string; readonly fill: number }): Promise<Sprite> {
  const image = new Image();
  image.src = logo.url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = LOGO_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser can't draw the logos.");
  const middle = LOGO_SIZE / 2;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, LOGO_SIZE, LOGO_SIZE);
  context.beginPath();
  context.arc(middle, middle, middle - 0.5, 0, Math.PI * 2);
  context.fillStyle = PLATE;
  context.fill();
  context.clip();
  // Fitted in the share of the plate it's given, keeping its shape (an SVG without a size draws square).
  const aspect = image.naturalWidth > 0 && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : 1;
  const box = LOGO_SIZE * logo.fill;
  const width = aspect >= 1 ? box : box * aspect;
  const height = aspect >= 1 ? box / aspect : box;
  context.drawImage(image, middle - width / 2, middle - height / 2, width, height);
  return { key, width: LOGO_SIZE, height: LOGO_SIZE, pixels: toRgb565(context.getImageData(0, 0, LOGO_SIZE, LOGO_SIZE).data) };
}

async function draw(key: string, connector: string | undefined, color: string): Promise<Sprite> {
  const svg = huddlerSvg({ ...(connector ? { connector } : {}), color, face: false, size: SPRITE_SIZE });
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SPRITE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser can't draw the Huddlers.");
  const middle = SPRITE_SIZE / 2;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  const glow = context.createRadialGradient(middle, middle, 4, middle, middle, middle);
  glow.addColorStop(0, GLOW);
  glow.addColorStop(1, BACKGROUND);
  context.fillStyle = glow;
  context.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  context.drawImage(image, 0, 0, SPRITE_SIZE, SPRITE_SIZE);
  return { key, width: SPRITE_SIZE, height: SPRITE_SIZE, pixels: toRgb565(context.getImageData(0, 0, SPRITE_SIZE, SPRITE_SIZE).data) };
}

let drawn: Promise<readonly Sprite[]> | null = null;

/** Hud ("hud") and every assistant Huddle knows of, its own and those in your flows, keyed by assistant id. */
export function spritesForButton(): Promise<readonly Sprite[]> {
  drawn ??= (async () => {
    const [assistants, flows] = await Promise.all([api.assistants().catch(() => []), api.flows().catch(() => [])]);
    const seen = new Map<string, string>();
    for (const assistant of assistants) seen.set(assistant.id, assistant.connector);
    for (const view of flows) for (const assistant of view.flow.assistants) if (!seen.has(assistant.id)) seen.set(assistant.id, assistant.connector);
    const sprites = [await draw("hud", undefined, HUD)];
    for (const [id, connector] of [...seen].slice(0, 23)) {
      const logo = LOGOS[connector];
      sprites.push(logo ? await drawLogo(id, logo) : await draw(id, connector, colorFor(id)));
    }
    return sprites;
  })().catch((error: unknown) => {
    drawn = null;
    throw error;
  });
  return drawn;
}
