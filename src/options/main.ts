import {
  loadSettings,
  saveSettings,
  apiKeyFor,
  type Settings,
  type Strategy,
} from "../shared/settings";
import { storage, runtime } from "../shared/platform";
import { resolveConfig } from "../sites/resolve";
import { SitesFileSchema } from "../sites/schema";
import { providerMetas, getProvider } from "../providers/registry";
import type { Stats } from "../shared/messages";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const els = {
  provider: $<HTMLSelectElement>("provider"),
  providerHint: $<HTMLParagraphElement>("providerHint"),
  apiKey: $<HTMLInputElement>("apiKey"),
  testKey: $<HTMLButtonElement>("testKey"),
  keyStatus: $<HTMLParagraphElement>("keyStatus"),
  model: $<HTMLSelectElement>("model"),
  modelHint: $<HTMLParagraphElement>("modelHint"),
  strategy: $<HTMLDivElement>("strategy"),
  sites: $<HTMLDivElement>("sites"),
  reveal: $<HTMLInputElement>("revealTimeoutMs"),
  revealOut: $<HTMLOutputElement>("revealTimeoutOut"),
  debug: $<HTMLInputElement>("debug"),
  cacheCount: $<HTMLSpanElement>("cacheCount"),
  purge: $<HTMLButtonElement>("purge"),
  overrides: $<HTMLTextAreaElement>("overrides"),
  saveOverrides: $<HTMLButtonElement>("saveOverrides"),
  resetOverrides: $<HTMLButtonElement>("resetOverrides"),
  overrideStatus: $<HTMLParagraphElement>("overrideStatus"),
};

/**
 * Cost estimates are per fresh front page of ~60 teasers, before caching. They
 * are order-of-magnitude, and the whole point of showing them is that the three
 * strategies differ by roughly 500x.
 */
const STRATEGIES: Array<{
  id: Strategy;
  label: string;
  detail: string;
  needsKey: boolean;
}> = [
  {
    id: "lead",
    label: "Publisher's own lead sentence — free",
    detail:
      "Replaces each clickbait title with the summary the publisher already wrote. No model, no API key, instant. Reads oddly where the lead is a supporting sentence rather than a headline.",
    needsKey: false,
  },
  {
    id: "model-lead",
    label: "Model, from title + lead — about $0.001 per front page",
    detail:
      "One batched request covering every new teaser. Good headlines where the lead carries real facts; teasers whose lead is boilerplate are left alone. Recommended.",
    needsKey: true,
  },
  {
    id: "model-article",
    label: "Model, from the full article — about $0.60 per front page",
    detail:
      "Fetches each article and rewrites from its full text. The most accurate, and the only option that handles teasers with a useless lead — but it downloads every article and makes one request per teaser. Fetching is limited to teasers you actually scroll to.",
    needsKey: true,
  },
];

let settings: Settings;

void init();

async function init(): Promise<void> {
  settings = await loadSettings();
  const { file, overrideError } = await resolveConfig();

  renderProviders();
  renderStrategies();
  renderSites(file.sites.map((s) => ({ id: s.id, label: s.label, host: s.hosts[0]! })));

  els.reveal.value = String(settings.revealTimeoutMs);
  els.revealOut.value = `${settings.revealTimeoutMs} ms`;
  els.debug.checked = settings.debug;

  const raw = await storage.get<unknown>("siteOverrides");
  els.overrides.value = raw ? JSON.stringify(raw, null, 2) : "";
  if (overrideError) {
    setStatus(els.overrideStatus, `Override rejected — ${overrideError}`, false);
  }

  await refreshStats();

  els.debug.addEventListener("change", () => void patch({ debug: els.debug.checked }));
  els.reveal.addEventListener("input", () => {
    els.revealOut.value = `${els.reveal.value} ms`;
    void patch({ revealTimeoutMs: Number(els.reveal.value) });
  });
  els.purge.addEventListener("click", async () => {
    await runtime.sendMessage({ type: "purgeCache" });
    await refreshStats();
  });
  els.testKey.addEventListener("click", () => void testKey());
  els.saveOverrides.addEventListener("click", () => void persistOverrides());
  els.resetOverrides.addEventListener("click", async () => {
    await storage.remove("siteOverrides");
    els.overrides.value = "";
    setStatus(els.overrideStatus, "Reset to bundled configuration.", true);
  });
}

async function patch(p: Partial<Settings>): Promise<void> {
  settings = await saveSettings(p);
}

function renderProviders(): void {
  els.provider.replaceChildren();
  for (const meta of providerMetas()) {
    const opt = document.createElement("option");
    opt.value = meta.id;
    opt.textContent = meta.available ? meta.label : `${meta.label} — not yet supported`;
    opt.disabled = !meta.available;
    els.provider.append(opt);
  }
  els.provider.value = settings.provider;
  els.provider.addEventListener("change", async () => {
    const meta = getProvider(els.provider.value)?.meta;
    await patch({
      provider: els.provider.value,
      model: meta?.defaultModel ?? settings.model,
    });
    renderProvider();
  });
  renderProvider();
}

/** Key field, key link and model list all follow the selected provider. */
function renderProvider(): void {
  const meta = getProvider(settings.provider)?.meta;
  if (!meta) return;

  els.apiKey.placeholder = meta.apiKeyLabel;
  els.apiKey.value = apiKeyFor(settings);
  els.providerHint.replaceChildren(
    document.createTextNode("Keys are stored per provider, so switching back keeps yours. Get one at "),
  );
  const a = document.createElement("a");
  a.href = meta.apiKeyUrl;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = meta.apiKeyUrl;
  els.providerHint.append(a);

  els.model.replaceChildren();
  for (const m of meta.models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    els.model.append(opt);
  }
  els.model.value = meta.models.some((m) => m.id === settings.model)
    ? settings.model
    : meta.defaultModel;
  els.model.disabled = meta.models.length === 0;
  showModelCost();

  els.apiKey.onchange = () =>
    void patch({
      apiKeys: { ...settings.apiKeys, [settings.provider]: els.apiKey.value.trim() },
    });
  els.model.onchange = async () => {
    await patch({ model: els.model.value });
    showModelCost();
  };
}

function showModelCost(): void {
  const m = getProvider(settings.provider)?.meta.models.find(
    (x) => x.id === els.model.value,
  );
  els.modelHint.textContent = m
    ? `$${m.inputPer1M.toFixed(2)} per million input tokens, $${m.outputPer1M.toFixed(2)} output. Changing the model invalidates cached headlines rather than deleting them, so switching back re-uses the originals.`
    : "";
}

function renderStrategies(): void {
  els.strategy.replaceChildren();
  for (const s of STRATEGIES) {
    const label = document.createElement("label");
    label.className = "choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "strategy";
    radio.value = s.id;
    radio.checked = settings.strategy === s.id;
    radio.addEventListener("change", () => void patch({ strategy: s.id }));

    const title = document.createElement("strong");
    title.textContent = s.label;
    const detail = document.createElement("span");
    detail.className = "hint";
    detail.textContent = s.detail;
    if (s.needsKey) detail.textContent += " Requires an API key.";

    label.append(radio, title, detail);
    els.strategy.append(label);
  }
}

function renderSites(sites: Array<{ id: string; label: string; host: string }>): void {
  els.sites.replaceChildren();
  for (const site of sites) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = settings.siteEnabled[site.id] !== false;
    box.addEventListener("change", () =>
      void patch({ siteEnabled: { ...settings.siteEnabled, [site.id]: box.checked } }),
    );
    label.append(box, ` ${site.label} (${site.host})`);
    els.sites.append(label);
  }
}

async function refreshStats(): Promise<void> {
  const stats = await runtime.sendMessage<Stats>({ type: "stats" });
  els.cacheCount.textContent = String(stats.entries);
}

/** Delegates to the provider: Options knows nothing about any vendor's API. */
async function testKey(): Promise<void> {
  const key = els.apiKey.value.trim();
  if (!key) return setStatus(els.keyStatus, "Enter a key first.", false);

  const entry = getProvider(settings.provider);
  if (!entry) return setStatus(els.keyStatus, "Unknown provider.", false);

  setStatus(els.keyStatus, "Testing…", true);
  await patch({ apiKeys: { ...settings.apiKeys, [settings.provider]: key } });
  const result = await entry.testKey(key);
  setStatus(els.keyStatus, result.detail, result.ok);
}

async function persistOverrides(): Promise<void> {
  const text = els.overrides.value.trim();
  if (!text) {
    await storage.remove("siteOverrides");
    return setStatus(els.overrideStatus, "Cleared; using bundled configuration.", true);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return setStatus(els.overrideStatus, `Not valid JSON: ${String(err)}`, false);
  }
  const check = SitesFileSchema.safeParse(parsed);
  if (!check.success && !Array.isArray((parsed as { sites?: unknown }).sites)) {
    return setStatus(els.overrideStatus, "Expected an object with a `sites` array.", false);
  }
  await storage.set({ siteOverrides: parsed });
  const { overrideError } = await resolveConfig();
  setStatus(
    els.overrideStatus,
    overrideError ? `Saved, but rejected at load — ${overrideError}` : "Saved.",
    !overrideError,
  );
}

function setStatus(el: HTMLElement, msg: string, ok: boolean): void {
  el.textContent = msg;
  el.className = `status ${ok ? "ok" : "err"}`;
}
