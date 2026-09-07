import { runtime, openOptionsPage } from "../shared/platform";
import type { Stats } from "../shared/messages";
import type { PageStatus } from "../content/status";

const state = document.getElementById("state") as HTMLElement;
const original = document.getElementById("original") as HTMLElement;
const revertBtn = document.getElementById("revert") as HTMLButtonElement;
const statusList = document.getElementById("status") as HTMLElement;

document.getElementById("options")?.addEventListener("click", openOptionsPage);

void init();

async function init(): Promise<void> {
  const stats = await runtime.sendMessage<Stats>({ type: "stats" });
  addRow("Model", stats.model);
  addRow("Cached", `${stats.entries} articles`);

  if (!stats.hasApiKey) {
    state.textContent = "No API key set — open Settings.";
    return;
  }

  const page = await askActiveTab();
  if (!page) {
    state.textContent = "Not an article Debaitify handles.";
    return;
  }

  state.textContent = describe(page);
  if (page.original) {
    original.textContent = page.original;
    original.hidden = false;
  }
  if (page.swapped) {
    revertBtn.hidden = false;
    revertBtn.addEventListener("click", async () => {
      await sendToActiveTab({ type: "revert" });
      window.close();
    });
  }
}

function describe(p: PageStatus): string {
  if (p.swapped) return p.source === "cache" ? "Rewritten (from cache)" : "Rewritten";
  if (p.reason) return `Showing original — ${p.reason}`;
  return "Working…";
}

function addRow(term: string, detail: string): void {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = detail;
  statusList.append(dt, dd);
}

async function askActiveTab(): Promise<PageStatus | null> {
  try {
    return await sendToActiveTab<PageStatus>({ type: "status" });
  } catch {
    // No content script in this tab — an unmatched site, or a page loaded
    // before the extension was installed.
    return null;
  }
}

async function sendToActiveTab<T>(msg: unknown): Promise<T> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return (await chrome.tabs.sendMessage(tab.id, msg)) as T;
}
