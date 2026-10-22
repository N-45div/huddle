import { api } from "./api.ts";
import { colorFor, HUD, huddlerSvg } from "./huddlers/huddler.ts";
import { type Sprite, toRgb565 } from "./usb-link.ts";

/**
 * The Huddlers for the Huddle button's screen: Hud, and one for each of your assistants (its colour from its
 * id, what it wears from its connector), drawn here from the canvas's own art with an empty visor (the button
 * draws the faces, so they can blink, look around and talk), over a soft glow on the button's background.
 */

/** Pixels square, as the button draws them (64 drawing units at 1.375 each). */
export const SPRITE_SIZE = 88;
/** The button's screen background, which the glow fades into at the picture's edges. */
const BACKGROUND = "#13142a";
const GLOW = "#2a2d66";

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
    for (const [id, connector] of [...seen].slice(0, 23)) sprites.push(await draw(id, connector, colorFor(id)));
    return sprites;
  })().catch((error: unknown) => {
    drawn = null;
    throw error;
  });
  return drawn;
}
