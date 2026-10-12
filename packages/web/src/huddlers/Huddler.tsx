import { useMemo } from "react";
import { colorFor, huddlerSvg, type Mood } from "./huddler.ts";

/**
 * A Huddler: the little bot for an assistant (its colour from its id, what it wears from its connector), or
 * Hud, Huddle's own, when there's neither. `live` lets it bob, blink and wave (not for people who'd rather
 * nothing moved).
 */
export function Huddler({
  id,
  connector,
  mood = "idle",
  size = 40,
  title,
  live = false,
  className,
}: {
  readonly id?: string;
  readonly connector?: string;
  readonly mood?: Mood;
  readonly size?: number;
  readonly title?: string;
  readonly live?: boolean;
  readonly className?: string;
}) {
  // Drawn from fixed parts only: the id picks a colour, the connector an accessory; no text goes in.
  const svg = useMemo(() => huddlerSvg({ connector, mood, size, title, ...(id ? { color: colorFor(id) } : {}) }), [id, connector, mood, size, title]);
  return <span className={["huddler-wrap", live ? "live" : "", className ?? ""].filter(Boolean).join(" ")} dangerouslySetInnerHTML={{ __html: svg }} />;
}
