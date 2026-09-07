/** Namespaced logging, silent unless the debug setting is on. */
let enabled = false;

export function setDebug(on: boolean): void {
  enabled = on;
}

const emit =
  (level: "debug" | "warn") =>
  (...args: unknown[]): void => {
    if (!enabled && level === "debug") return;
    console[level]("[debaitify]", ...args);
  };

export const log = {
  debug: emit("debug"),
  /** Warnings always print: they mean a site config or selector is broken. */
  warn: emit("warn"),
};
