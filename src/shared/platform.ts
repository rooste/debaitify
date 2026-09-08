/**
 * Thin wrapper over the extension APIs.
 *
 * Every call site goes through here so a Firefox build is a change to this file
 * plus the manifest, rather than a port. Firefox exposes `browser` with promise
 * semantics; Chrome MV3 exposes `chrome` with promise semantics too, so the
 * shim is a namespace pick rather than a promisifying layer.
 */
type ExtNamespace = typeof chrome;

/** Resolved lazily: importing this module outside an extension context (tests,
 *  tooling) must not throw at load time. */
function ext(): ExtNamespace {
  const g = globalThis as unknown as { browser?: ExtNamespace; chrome?: ExtNamespace };
  const api = g.browser ?? g.chrome;
  if (!api) throw new Error("extension APIs unavailable in this context");
  return api;
}

export const storage = {
  async get<T>(key: string): Promise<T | undefined> {
    const out = await ext().storage.local.get(key);
    return out[key] as T | undefined;
  },

  /** `null` reads the entire store — used only by the eviction sweep. */
  async getMany(keys: string[] | null): Promise<Record<string, unknown>> {
    return (await ext().storage.local.get(keys)) as Record<string, unknown>;
  },

  async set(items: Record<string, unknown>): Promise<void> {
    await ext().storage.local.set(items);
  },

  async remove(keys: string | string[]): Promise<void> {
    await ext().storage.local.remove(keys);
  },
};

export const runtime = {
  sendMessage: <Res>(msg: unknown): Promise<Res> =>
    ext().runtime.sendMessage(msg) as Promise<Res>,

  onMessage: (
    handler: (
      msg: unknown,
      sender: chrome.runtime.MessageSender,
    ) => Promise<unknown>,
  ): void => {
    ext().runtime.onMessage.addListener((msg, sender, sendResponse) => {
      // Returning `true` keeps the channel open for the async reply. Errors are
      // funnelled into the response rather than thrown, so a content script
      // never hangs waiting on a listener that already died.
      handler(msg, sender).then(sendResponse, (err: unknown) =>
        sendResponse({ ok: false, reason: "api-error", detail: String(err) }),
      );
      return true;
    });
  },
};

/** Absolute URL of a packaged file, e.g. runtime.getURL("bridge.js"). */
export const getURL = (path: string): string => ext().runtime.getURL(path);

export const onInstalled = (
  handler: (details: chrome.runtime.InstalledDetails) => void,
): void => {
  ext().runtime.onInstalled.addListener(handler);
};

export const openOptionsPage = (): void => {
  void ext().runtime.openOptionsPage();
};
