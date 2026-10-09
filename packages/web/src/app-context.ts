import { createContext, useContext } from "react";
import type { Info } from "./types.ts";

export interface AppContextValue {
  /** What this Huddle can do; null until /api/info answers. */
  readonly info: Info | null;
  /** How many approvals are waiting (the sidebar badge). */
  readonly waiting: number;
  readonly refreshWaiting: () => void;
  /** Goes up when the token changes, so screens fetch again. */
  readonly authVersion: number;
  /** Goes to a hash route, asking first if leaving would lose unsaved work. */
  readonly navigate: (to: string) => void;
}

export const AppContext = createContext<AppContextValue>({
  info: null,
  waiting: 0,
  refreshWaiting: () => {},
  authVersion: 0,
  navigate: (to) => {
    window.location.hash = to;
  },
});

export function useApp(): AppContextValue {
  return useContext(AppContext);
}
