import { log } from "../shared/log";

/**
 * In-flight de-duplication and a concurrency cap.
 *
 * The dedupe is the important half: a refresh landing mid-generation must join
 * the existing promise rather than start a second billed call. Under
 * bring-your-own-key that is the user's money.
 */
const MAX_CONCURRENT = 2;

const inFlight = new Map<string, Promise<unknown>>();
const waiting: Array<() => void> = [];
let active = 0;

export function run<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    log.debug("joining in-flight request", key);
    return existing as Promise<T>;
  }

  const promise = (async () => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiting.push(() => {
      active++;
      resolve();
    });
  });
}

function release(): void {
  active--;
  waiting.shift()?.();
}
