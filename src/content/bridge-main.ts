/**
 * MAIN-world bridge.
 *
 * Content scripts run in an isolated world and cannot see page globals. The
 * clickbait title is in the DOM, but the publisher's own lead sentence — the
 * only factual material we have without fetching the article — lives in the
 * page's hydration state. This script runs in the page's own world, reads that
 * state, and posts a plain id→lead map across.
 *
 * It reads only. It never touches page state, and it posts nothing but strings
 * the page itself already rendered.
 */
import type { BridgeMessage } from "../shared/messages";

const IL_UUID = /\/a\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
const IS_ART = /\/art-(\d+)\.html/;

collectAndPost();
// The front page hydrates and lazy-loads more teasers, so re-read on request.
window.addEventListener("message", (e) => {
  if (e.source === window && (e.data as { __debaitifyAsk?: boolean })?.__debaitifyAsk) {
    collectAndPost();
  }
});

function collectAndPost(): void {
  let leads: Record<string, string> = {};
  let source = "none";
  try {
    const il = readIltalehti();
    if (Object.keys(il).length > 0) {
      leads = il;
      source = "iltalehti";
    } else {
      const nx = readNextData();
      if (Object.keys(nx).length > 0) {
        leads = nx;
        source = "next-data";
      }
    }
  } catch {
    /* a page-shape change must not throw inside the page's own world */
  }
  const msg: BridgeMessage = { __debaitify: "teasers", leads, source };
  window.postMessage(msg, window.location.origin);
}

/** Iltalehti: window.App.state.fronts.<front>.items[].items[].content */
function readIltalehti(): Record<string, string> {
  const state = (window as unknown as { App?: { state?: unknown } }).App?.state;
  const out: Record<string, string> = {};
  walk(state, (node) => {
    const n = node as { type?: string; content?: { url?: string; article_id?: string; lead?: string } };
    if (n.type !== "article" || !n.content) return;
    const { url, article_id, lead } = n.content;
    const id = article_id ?? (url ? IL_UUID.exec(url)?.[1] : undefined);
    if (id && lead) out[id] = lead;
  });
  return out;
}

/** Ilta-Sanomat: the __NEXT_DATA__ script tag. Initial props only — it covers
 *  the server-rendered teasers, not ones added after hydration. */
function readNextData(): Record<string, string> {
  const el = document.getElementById("__NEXT_DATA__");
  if (!el?.textContent) return {};
  const out: Record<string, string> = {};
  walk(JSON.parse(el.textContent), (node) => {
    const n = node as Record<string, unknown>;
    const href = typeof n["href"] === "string" ? n["href"] : undefined;
    const lead = n["ingress"] ?? n["lead"] ?? n["description"];
    const id = href ? IS_ART.exec(href)?.[1] : undefined;
    if (id && typeof lead === "string" && lead.trim()) out[id] = lead;
  });
  return out;
}

function walk(node: unknown, visit: (n: object) => void, depth = 0): void {
  if (depth > 12 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const v of node) walk(v, visit, depth + 1);
    return;
  }
  visit(node);
  for (const v of Object.values(node)) walk(v, visit, depth + 1);
}
