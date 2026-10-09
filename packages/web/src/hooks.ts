import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "./api.ts";

export interface Resource<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  /** Fetches again; the newest call wins if several overlap. */
  readonly reload: () => Promise<void>;
  readonly setData: Dispatch<SetStateAction<T | null>>;
}

/** Loads something from the API whenever `deps` change, keeping the last good data on error. */
export function useResource<T>(load: () => Promise<T>, deps: readonly unknown[]): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  const sequence = useRef(0);

  useEffect(() => {
    loadRef.current = load;
  });

  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    try {
      const result = await loadRef.current();
      if (mine !== sequence.current) return;
      setData(result);
      setError(null);
    } catch (caught) {
      if (mine !== sequence.current) return;
      setError(describeError(caught));
    } finally {
      if (mine === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload, setData };
}

/** A function that runs `fn` once things go quiet for `wait` ms (for bursts of change events). */
export function useDebounced(fn: () => void, wait = 200): () => void {
  const fnRef = useRef(fn);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => fnRef.current(), wait);
  }, [wait]);
}
