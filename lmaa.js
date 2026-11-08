/* LMAA Browser Port – External Script (CSP-compliant for Chrome Extensions) */
/* All persistent data uses chrome.storage.local to survive extension reloads/updates */

/* Utils */
const $ = id => document.getElementById(id);
const escapeHtml = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const CORE = globalThis.LmaaCore;
const DATA = globalThis.LmaaData;
if (!CORE) throw new Error("LMAA_CORE_MISSING");

/* ───── Storage Layer (chrome.storage.local) ───── */
const STORAGE_SETTINGS = "lmaa_settings";
const STORAGE_BRIEFINGS = "lmaa_briefings";

const DEFAULT_STYLE_PROMPT = `Erstelle ein sachliches, informationsdichtes YouTube-Briefing auf Deutsch.
Nutze ausschließlich die bereitgestellten Inhalte und ergänze keine externen Fakten.
Trenne Aussagen des Videos klar von gesicherten technischen Metadaten. Erfinde keine
Aussagen, Quellen oder Zeitmarken. Markiere fehlende Belege, unverständliche Passagen,
Widersprüche und Unsicherheiten ausdrücklich. Verwende konkrete Zeitmarken nur, wenn
sie in den bereitgestellten Daten vorkommen, und verlinke sie mit der kanonischen Video-URL.

Gib das Ergebnis als kompaktes Markdown ohne HTML und ohne vorgeschaltete Einleitung
aus. Verwende exakt diese Überschriften in dieser Reihenfolge:
# Kernaussage
## Kurzfassung
## Wichtigste Punkte
## Argumentation und Belege
## Genannte Personen, Organisationen und Quellen
## Offene Fragen / Unsicherheiten
## Kapitel mit Zeitmarken`;

const DEFAULT_SETTINGS = {
  openaiKey: "",
  model: "gpt-5.6-sol",
  activeStyleId: "std",
  styles: [
    { id: "std", name: "Standard", prompt: DEFAULT_STYLE_PROMPT, isBuiltIn: true }
  ],
  rapidapiMode: "off",
  rapidapiKey: "",
  rapidapiEndpoint: CORE.DEFAULT_RAPIDAPI_ENDPOINT,
  rapidapiMethod: "GET",
  rapidapiBody: "", rapidapiTimeoutMs: 30000, rapidapiMaxBytes: 2000000, rapidapiSuccessCodes: [200],
  rapidapiHeaders: "X-RapidAPI-Host: youtube-transcripts.p.rapidapi.com\nX-RapidAPI-Key: {{rapidapi_key}}\nAccept: application/json",
  rapidapiUsage: { month: "", attempts: 0, successes: 0 }
};

let SET = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let BRIEFINGS = []; /* in-memory cache, synced to chrome.storage.local */

/* Read from chrome.storage.local */
async function loadStorage() {
  const result = await chrome.storage.local.get([STORAGE_SETTINGS, STORAGE_BRIEFINGS]);
  if (result[STORAGE_SETTINGS]) Object.assign(SET, result[STORAGE_SETTINGS]);
  SET = CORE.migrateSettings(SET);
  if (!SET.styles?.length) SET.styles = structuredClone(DEFAULT_SETTINGS.styles);
  const standard = SET.styles.find(s => s.id === "std");
  if (standard) { standard.prompt = DEFAULT_STYLE_PROMPT; standard.isBuiltIn = true; }
  BRIEFINGS = result[STORAGE_BRIEFINGS] || [];
}

async function persistSettings() {
  await chrome.storage.local.set({ [STORAGE_SETTINGS]: SET });
  updateActiveStyle();
}
async function persistBriefings() {
  await chrome.storage.local.set({ [STORAGE_BRIEFINGS]: BRIEFINGS });
}
async function mutateBriefings(update) {
  return navigator.locks.request("lmaa-history", async () => {
    const stored = await chrome.storage.local.get(STORAGE_BRIEFINGS);
    const next = structuredClone(stored[STORAGE_BRIEFINGS] || []);
    await update(next);
    await chrome.storage.local.set({ [STORAGE_BRIEFINGS]: next });
    BRIEFINGS = next;
    if (currentBriefing) currentBriefing = next.find(b => b.id === currentBriefing.id) || null;
  });
}

/* Migrate old localStorage / IndexedDB data (one-time) */
async function migrateOldData() {
  let migrated = false;

  /* 1. Migrate settings from localStorage */
  try {
    const oldSettings = JSON.parse(localStorage.getItem("lmaa_settings_v1"));
    if (oldSettings && !SET.openaiKey) {
      Object.assign(SET, oldSettings);
      if (!SET.styles || !SET.styles.length) SET.styles = [...DEFAULT_SETTINGS.styles];
      await persistSettings();
      localStorage.removeItem("lmaa_settings_v1");
      migrated = true;
    }
  } catch(e) {}

  /* 2. Migrate briefings from IndexedDB */
  if (BRIEFINGS.length === 0) {
    try {
      const oldBriefings = await readOldIndexedDB();
      if (oldBriefings.length > 0) {
        BRIEFINGS = oldBriefings;
        await persistBriefings();
        migrated = true;
        /* Clean up old DB */
        indexedDB.deleteDatabase("lmaa_db_v1");
      }
    } catch(e) {}
  }

  return migrated;
}

function readOldIndexedDB() {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open("lmaa_db_v1", 1);
      req.onupgradeneeded = () => { req.result.close(); resolve([]); };
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("briefings")) { db.close(); resolve([]); return; }
        const tx = db.transaction("briefings", "readonly");
        const all = tx.objectStore("briefings").getAll();
        all.onsuccess = () => { db.close(); resolve(all.result || []); };
        all.onerror = () => { db.close(); resolve([]); };
      };
      req.onerror = () => resolve([]);
    } catch(e) { resolve([]); }
  });
}

/* ───── Briefing CRUD (in-memory + chrome.storage.local) ───── */

async function saveBriefing(b) {
  await mutateBriefings(list => list.push(b));
}

function getBriefingsSorted() {
  return BRIEFINGS.slice().sort((a, b) => b.ts - a.ts);
}

async function deleteBriefing(id) {
  await mutateBriefings(list => { const i = list.findIndex(b => b.id === id); if (i >= 0) list.splice(i, 1); });
}

/* ───── Settings ───── */

function getActiveStyle() {
  return SET.styles.find(s => s.id === SET.activeStyleId) || SET.styles[0];
}

async function saveSettings() {
  const replacementOpenAiKey = $("cfgOpenai").value.trim();
  if (replacementOpenAiKey) SET.openaiKey = replacementOpenAiKey;
  SET.model = CORE.EXACT_MODEL;

  const currentStyleId = $("cfgStyleSelect").value;
  const styleIdx = SET.styles.findIndex(s => s.id === currentStyleId);
  if (styleIdx >= 0) {
    if (!SET.styles[styleIdx].isBuiltIn) {
      SET.styles[styleIdx].name = $("cfgStyleName").value.trim() || "Unbenannt";
    }
    if (!SET.styles[styleIdx].isBuiltIn) {
      const prompt = $("cfgStylePrompt").value.trim();
      if (!prompt || prompt.length > 8000) return alert("Bitte eine Stil-Anweisung mit 1–8000 Zeichen eingeben.");
      SET.styles[styleIdx].prompt = prompt;
      SET.styles[styleIdx].outputLanguage = $("cfgStyleLanguage").value.trim() || "Deutsch";
    }
  }
  SET.activeStyleId = currentStyleId;

  SET.rapidapiMode = $("cfgRapidapiMode").value;
  const replacementRapidApiKey = $("cfgRapidapiKey").value.trim();
  if (replacementRapidApiKey) SET.rapidapiKey = replacementRapidApiKey;
  SET.rapidapiEndpoint = $("cfgRapidapiEndpoint").value.trim();
  SET.rapidapiMethod = $("cfgRapidapiMethod").value;
  SET.rapidapiHeaders = $("cfgRapidapiHeaders").value.trim();

  SET.rapidapiBody = $("cfgRapidapiBody").value;
  SET.rapidapiTimeoutMs = Number($("cfgRapidapiTimeout").value);
  SET.rapidapiMaxBytes = Number($("cfgRapidapiLimit").value);
  SET.rapidapiSuccessCodes = $("cfgRapidapiCodes").value.split(",").map(x => Number(x.trim()));
  try { CORE.buildRapidApiRequest({ ...SET, rapidapiKey: SET.rapidapiKey || "validation-only" }, "abcdefghijk", "de"); }
  catch (_) { return alert("Ungültiges RapidAPI-Profil. Bitte Endpoint, Header, Body und Grenzen prüfen."); }
  await persistSettings();
  $("manageOverlay").classList.remove("on");
}

/* ───── Styles UI ───── */

function renderStyleSelect() {
  const sel = $("cfgStyleSelect");
  sel.innerHTML = SET.styles.map(s => '<option value="' + s.id + '"' + (s.id === SET.activeStyleId ? " selected" : "") + '>' + escapeHtml(s.name) + '</option>').join("");
  loadSelectedStyle();
}

function loadSelectedStyle() {
  const id = $("cfgStyleSelect").value;
  const style = SET.styles.find(s => s.id === id);
  if (!style) return;

  $("cfgStyleName").value = style.name;
  $("cfgStyleName").maxLength = 80;
  $("cfgStylePrompt").value = style.prompt;
  $("cfgStylePrompt").disabled = !!style.isBuiltIn;
  $("cfgStyleLanguage").value = style.outputLanguage || "Deutsch";
  $("cfgStyleLanguage").disabled = !!style.isBuiltIn;

  if (style.isBuiltIn) {
    $("cfgStyleName").disabled = true;
    $("btnDeleteStyle").style.display = "none";
  } else {
    $("cfgStyleName").disabled = false;
    $("btnDeleteStyle").style.display = "inline-block";
  }
}

$("cfgStyleSelect").addEventListener("change", loadSelectedStyle);

$("btnNewStyle").addEventListener("click", () => {
  const newId = "style_" + Date.now();
  SET.styles.push({ id: newId, name: "Neuer Stil", prompt: "", isBuiltIn: false });
  SET.activeStyleId = newId;
  renderStyleSelect();
});

$("btnDeleteStyle").addEventListener("click", () => {
  const id = $("cfgStyleSelect").value;
  const style = SET.styles.find(s => s.id === id);
  if (!style || style.isBuiltIn) return;
  if (!confirm("Stil '" + style.name + "' wirklich löschen?")) return;

  SET.styles = SET.styles.filter(s => s.id !== id);
  SET.activeStyleId = "std";
  renderStyleSelect();
});

/* ───── Markdown Renderer ───── */

function renderMarkdown(src, videoId) {
  return CORE.renderMarkdown(src, videoId);
}

function renderMath(container) {
  container.querySelectorAll("[data-tex]").forEach(element => {
    katex.render(element.dataset.tex, element, {
      displayMode: element.classList.contains("math-display"),
      throwOnError: false,
      strict: "warn",
      trust: false
    });
  });
}

/* ───── UI Logic ───── */

function renderHistory() {
  const list = getBriefingsSorted();
  const term = $("historySearch").value.trim().toLowerCase();
  const el = $("historyList");
  if (!list.length) { el.innerHTML = "Keine Briefings vorhanden."; return; }
  const visible = list.filter(b => [b.title, b.channel].some(value => (value || "").toLowerCase().includes(term)));
  el.innerHTML = visible.map(b => '\
    <div class="history-item">\
      <div class="history-info">\
        <div class="history-title">' + escapeHtml(b.title) + '</div>\
        <div class="history-meta">' + new Date(b.ts).toLocaleString() + ' · ' + escapeHtml(b.channel) + '</div>\
      </div>\
      <div class="history-actions">\
        <button class="btn ghost" data-action="open" data-id="' + b.id + '">Öffnen</button>\
        <button class="btn danger" data-action="delete" data-id="' + b.id + '" title="Löschen">✕</button>\
      </div>\
    </div>\
  ').join("");
}

$("historySearch").addEventListener("input", renderHistory);

/* Event delegation for history buttons */
$("historyList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (action === "open") {
    openBriefing(id);
  } else if (action === "delete") {
    const title = BRIEFINGS.find(b => b.id === id)?.title || "Unbekannt";
    if (confirm('Briefing "' + title + '" wirklich löschen?')) {
      await deleteBriefing(id);
      renderHistory();
    }
  }
});

let currentBriefing = null;
let duplicateResolver = null;

function closeDuplicateDialog(decision) {
  $("duplicateOverlay").classList.remove("on");
  const resolver = duplicateResolver;
  duplicateResolver = null;
  if (resolver) resolver(decision);
}

function chooseExistingOrNew(existing) {
  $("duplicateOpenLink").textContent =
    existing.title + " · " + new Date(existing.ts).toLocaleString();
  $("duplicateOverlay").classList.add("on");
  return new Promise(resolve => { duplicateResolver = resolve; });
}

$("duplicateOpenLink").addEventListener("click", event => {
  event.preventDefault();
  closeDuplicateDialog("open");
});
$("duplicateNewBtn").addEventListener("click", () => closeDuplicateDialog("new"));
$("duplicateCancelBtn").addEventListener("click", () => closeDuplicateDialog("cancel"));

function openBriefing(id, options = {}) {
  const b = BRIEFINGS.find(x => x.id === id);
  if (!b) return;
  currentBriefing = b;
  $("view-home").style.display = "none";
  $("view-detail").style.display = "block";
  $("detailTitle").textContent = b.title;
  $("detailMeta").innerHTML = '<a href="https://www.youtube.com/watch?v=' + b.videoId + '" target="_blank" rel="noopener noreferrer">YouTube-Link</a> · Kanal: ' + escapeHtml(b.channel) + ' · Erstellt: ' + new Date(b.ts).toLocaleString() + ' · Stil: ' + escapeHtml(b.styleName || "Unbekannt");
  $("detailContent").innerHTML = renderMarkdown(b.markdown, b.videoId);
  renderMath($("detailContent"));
  $("chatInput").value = "";
  renderChat();
  if (options.pushHistory !== false) history.pushState({ view: "detail", id }, "");
}

$("backBtn").addEventListener("click", () => {
  history.back();
});

function showHome() {
  $("view-detail").style.display = "none";
  $("view-home").style.display = "block";
  currentBriefing = null;
  renderHistory();
}

addEventListener("popstate", event => {
  if (event.state?.view === "detail" && event.state.id) {
    openBriefing(event.state.id, { pushHistory: false });
  } else {
    showHome();
  }
});

const buildShareText = b => "Titel: " + b.title + "\nKanal: " + b.channel + "\nURL: " + CORE.canonicalUrl(b.videoId) + "\n\n" + b.markdown;

$("copyBtn").addEventListener("click", () => {
  if (!currentBriefing) return;
  navigator.clipboard.writeText(buildShareText(currentBriefing)).then(() => alert("In die Zwischenablage kopiert!"));
});

$("deleteBtn").addEventListener("click", async () => {
  if (!currentBriefing) return;
  if (confirm("Löschen?")) {
    await deleteBriefing(currentBriefing.id);
    $("backBtn").click();
  }
});

/* ───── Settings UI ───── */

$("manageBtn").addEventListener("click", () => {
  $("cfgOpenai").value = "";
  $("cfgOpenai").placeholder = SET.openaiKey ? "**** (leer lassen zum Beibehalten)" : "sk-...";
  $("cfgModel").value = CORE.EXACT_MODEL;

  $("cfgRapidapiMode").value = SET.rapidapiMode;
  $("cfgRapidapiKey").value = "";
  $("cfgRapidapiKey").placeholder = SET.rapidapiKey ? "**** (leer lassen zum Beibehalten)" : "Dein RapidAPI-Key";
  $("cfgRapidapiEndpoint").value = SET.rapidapiEndpoint;
  $("cfgRapidapiMethod").value = SET.rapidapiMethod;
  $("cfgRapidapiHeaders").value = SET.rapidapiHeaders;
  $("cfgRapidapiBody").value = SET.rapidapiBody || "";
  $("cfgRapidapiTimeout").value = SET.rapidapiTimeoutMs || 30000;
  $("cfgRapidapiLimit").value = SET.rapidapiMaxBytes || 2000000;
  $("cfgRapidapiCodes").value = (SET.rapidapiSuccessCodes || [200]).join(",");

  renderStyleSelect();
  $("rapidapiUsage").textContent = "RapidAPI: " + (SET.rapidapiUsage?.attempts || 0) + " Versuche / " + (SET.rapidapiUsage?.successes || 0) + " Erfolge (Basic-Hinweis: /100; Dashboard maßgeblich)";
  $("manageOverlay").classList.add("on");
});
$("manageClose").addEventListener("click", () => $("manageOverlay").classList.remove("on"));
$("cfgSave").addEventListener("click", saveSettings);
$("wipeBtn").addEventListener("click", () => {
  if (confirm("ALLE lokalen Daten (Keys + Historie) löschen? Das kann NICHT rückgängig gemacht werden.")) {
    chrome.storage.local.clear(() => location.reload());
  }
});

/* ───── Analysis Logic ───── */

function log(msg) {
  const el = $("statusLog");
  el.style.display = "block";
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
}

/* YouTube URL parser – faithful port of android/.../YoutubeUrlParser.kt */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const LONG_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const TRAILING_PUNCT = /[.,;:!?)\]}']+$/;

function extractVideoId(input) {
  if (!input || !input.trim()) return null;
  const urlMatches = input.match(URL_RE);
  if (!urlMatches) return null;
  const ids = new Set();
  for (const raw of urlMatches) {
    const cleaned = raw.replace(TRAILING_PUNCT, "");
    const id = parseYoutubeCandidate(cleaned);
    if (id) ids.add(id);
  }
  if (ids.size === 1) return ids.values().next().value;
  return null;
}

function parseYoutubeCandidate(candidate) {
  let url;
  try { url = new URL(candidate); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || (url.port && url.port !== "")) return null;
  const host = url.hostname.toLowerCase();
  let videoId = null;
  if (host === "youtu.be") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 1) videoId = segments[0];
  } else if (LONG_HOSTS.has(host)) {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 1 && segments[0] === "watch") {
      videoId = url.searchParams.get("v");
    } else if (segments.length === 2 && (segments[0] === "shorts" || segments[0] === "live")) {
      videoId = segments[1];
    } else if (segments.length === 2 && segments[0] === "embed") {
      videoId = segments[1];
    }
  }
  if (videoId && VIDEO_ID_RE.test(videoId)) return videoId;
  return null;
}

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isNativeFallbackAllowed(error) {
  return new Set([
    "YOUTUBE_REQUEST_FAILED",
    "YOUTUBE_DATA_UNPARSABLE",
    "YOUTUBE_EMPTY_TRANSCRIPT"
  ]).has(error && error.code);
}

async function readUtf8Response(response, maxBytes, providerName) {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw providerError(providerName + "_RESPONSE_TOO_LARGE", providerName + "-Antwort ist zu groß");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (_) {
    throw providerError(providerName + "_INVALID_UTF8", providerName + "-Antwort ist kein gültiges UTF-8");
  }
}

// 1. Native Local Chrome Ext Fetch (Primär)
async function fetchTranscriptNative(videoId) {
  log("Versuche nativen direkten Abruf via YouTube (Extension erforderlich)...");
  let htmlRes;
  try {
    htmlRes = await fetch(CORE.canonicalUrl(videoId), {
      headers: { "Accept-Language": "de,en;q=0.9" }
    });
  } catch (_) {
    throw providerError("YOUTUBE_REQUEST_FAILED", "YouTube-Watch-Seite konnte nicht geladen werden");
  }
  if (!htmlRes.ok) {
    throw providerError("YOUTUBE_REQUEST_FAILED", "YouTube HTTP Fehler: " + htmlRes.status);
  }
  const html = await htmlRes.text();

  let innertubeRequest;
  try {
    innertubeRequest = CORE.buildInnertubeRequest(CORE.extractInnertubeApiKey(html), videoId);
  } catch (_) {
    throw providerError("YOUTUBE_DATA_UNPARSABLE", "Innertube-Konfiguration nicht gefunden");
  }

  let playerRes;
  try {
    playerRes = await fetch(innertubeRequest.url, innertubeRequest.options);
  } catch (_) {
    throw providerError("YOUTUBE_REQUEST_FAILED", "YouTube-Playerdaten konnten nicht geladen werden");
  }
  if (!playerRes.ok) {
    throw providerError("YOUTUBE_REQUEST_FAILED", "YouTube Player HTTP Fehler: " + playerRes.status);
  }

  let playerResponse;
  try {
    playerResponse = await playerRes.json();
  } catch (_) {
    throw providerError("YOUTUBE_DATA_UNPARSABLE", "Ungültige YouTube-Playerantwort");
  }
  const playability = playerResponse?.playabilityStatus?.status;
  if (playability && playability !== "OK") {
    const reason = playerResponse?.playabilityStatus?.reason || playability;
    throw providerError("YOUTUBE_VIDEO_UNPLAYABLE", "Video nicht abspielbar: " + reason);
  }

  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  let track;
  try {
    track = CORE.selectCaptionTrack(tracks);
  } catch (_) {
    throw providerError("TRANSCRIPTS_DISABLED", "Keine Untertitel verfügbar (TRANSCRIPTS_DISABLED)");
  }

  log("Lade nativen Track: " + track.languageCode + " (" + (track.kind === "asr" ? "automatisch" : "manuell") + ")");
  let transcriptRes;
  try {
    transcriptRes = await fetch(CORE.captionTrackUrl(track));
  } catch (error) {
    if (error && error.message === "YOUTUBE_CAPTION_URL_NOT_ALLOWED") throw error;
    throw providerError("YOUTUBE_REQUEST_FAILED", "YouTube-Untertitel konnten nicht geladen werden");
  }
  if (!transcriptRes.ok) {
    throw providerError("YOUTUBE_REQUEST_FAILED", "YouTube Caption HTTP Fehler: " + transcriptRes.status);
  }
  const transcriptXml = await readUtf8Response(transcriptRes, 5_000_000, "YOUTUBE");
  if (!transcriptXml.trim()) {
    throw providerError("YOUTUBE_EMPTY_TRANSCRIPT", "YouTube lieferte einen leeren Caption-Body");
  }

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(transcriptXml, "text/xml");
  if (xmlDoc.getElementsByTagName("parsererror").length) {
    throw providerError("YOUTUBE_DATA_UNPARSABLE", "Ungültiges YouTube-Caption-XML");
  }
  const textNodes = xmlDoc.getElementsByTagName("text");
  const segments = [];
  for (let i = 0; i < textNodes.length; i++) {
    segments.push({
      start: textNodes[i].getAttribute("start"),
      text: textNodes[i].textContent
    });
  }
  const content = CORE.formatTranscriptSegments(segments);
  if (!content) {
    throw providerError("YOUTUBE_EMPTY_TRANSCRIPT", "YouTube lieferte keine Caption-Segmente");
  }
  return { content, label: "TRANSKRIPT" };
}

// 2. RapidAPI Fetch
async function fetchTranscriptRapidAPI(videoId) {
  log("Versuche Abruf via konfiguriertem RapidAPI Provider...");
  const request = CORE.buildRapidApiRequest(SET, videoId, "en");
  const month = new Date().toISOString().slice(0, 7);
  if (!SET.rapidapiUsage || SET.rapidapiUsage.month !== month) {
    SET.rapidapiUsage = { month, attempts: 0, successes: 0 };
  }
  SET.rapidapiUsage.attempts += 1;
  await persistSettings();

  const res = await fetch(request.url, { ...request.options, signal: AbortSignal.timeout(request.timeoutMs) });
  if (!request.successCodes.includes(res.status)) throw new Error("RapidAPI HTTP Fehler: " + res.status);
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json") && !contentType.startsWith("text/")) {
    throw new Error("RapidAPI Content-Type nicht erlaubt: " + (contentType || "fehlend"));
  }
  const content = await readUtf8Response(res, request.maxBytes, "RAPIDAPI");
  if (!content.trim()) throw new Error("RapidAPI lieferte eine leere Antwort");
  SET.rapidapiUsage.successes += 1;
  await persistSettings();
  log("RapidAPI-Nutzung " + month + ": " + SET.rapidapiUsage.attempts + " Versuche / " + SET.rapidapiUsage.successes + " Erfolge (Basic-Hinweis: /100)");
  return { content, label: "RAPIDAPI_RAW_RESPONSE" };
}

async function analyze(url = $("ytUrl").value.trim(), question = "", checkDuplicate = true, recovered = null) {
  const id = recovered?.id || crypto.randomUUID();
  return navigator.locks.request("lmaa-analysis-" + id, async () => {
    const latest = (await chrome.storage.local.get(STORAGE_BRIEFINGS))[STORAGE_BRIEFINGS] || [];
    if (latest.some(b => b.id === id)) { await chrome.storage.local.remove("lmaa_job_" + id); return; }
    return runAnalysis(url, question, checkDuplicate, { ...recovered, id });
  });
}
async function runAnalysis(url, question, checkDuplicate, recovered) {
  const vid = extractVideoId(url);
  if (!vid) return alert("Ungültige YouTube URL");

  const existing = CORE.findNewestBriefing(BRIEFINGS, vid);
  if (checkDuplicate && existing) {
    const decision = await chooseExistingOrNew(existing);
    if (decision === "open") {
      openBriefing(existing.id);
      return;
    }
    if (decision !== "new") return;
  }

  if (!SET.openaiKey) return alert("OpenAI API-Key fehlt. Bitte klicke auf 'Verwaltung'.");

  const job = { id: recovered.id, url, question, style: structuredClone(recovered.style || getActiveStyle()), phase: "fetching", paused: !$("focusPanel").hidden && !question, background: false, cancelled: false };
  activeJob = job;
  $("statusLog").textContent = "";
  $("analyzeBtn").disabled = true;
  $("cancelAnalysisBtn").hidden = false;

  let completed = false;
  try {
    await chrome.storage.local.set({ ["lmaa_job_" + job.id]: { id: job.id, url, question, style: job.style, ts: Date.now() } });
    // 1. YouTube oEmbed
    log("Lade Video-Metadaten...");
    let title = "Unbekannt", channel = "Unbekannt";
    try {
      const oembed = await fetch("https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=" + vid + "&format=json").then(r => r.json());
      title = oembed.title; channel = oembed.author_name;
    } catch (e) { log("Warnung: oEmbed fehlgeschlagen, nutze Fallback-Titel."); }

    // 2. Transcript
    let transcript = null;
    const mode = SET.rapidapiMode;

    if (mode === "primary") {
      try {
        transcript = await fetchTranscriptRapidAPI(vid);
      } catch (e) {
        log("Primär-RapidAPI gescheitert: " + e.message);
        if (e.message && e.message.startsWith("RAPIDAPI_")) throw e;
        transcript = await fetchTranscriptNative(vid);
      }
    } else {
      try {
        transcript = await fetchTranscriptNative(vid);
      } catch (e) {
        log("Nativer lokaler Abruf gescheitert: " + e.message);
        if (mode === "fallback" && isNativeFallbackAllowed(e)) {
          transcript = await fetchTranscriptRapidAPI(vid);
        } else {
          throw e;
        }
      }
    }

    if (!transcript || !transcript.content || transcript.content.trim().length === 0) {
      throw new Error("Erhaltenes Transkript ist leer.");
    }

    if (job.paused) await new Promise(resolve => { job.resume = resolve; });
    if (job.cancelled) return;
    const activeStyle = job.style;
    const instructions = activeStyle.prompt + "\nAusgabesprache: " + (activeStyle.outputLanguage || "Deutsch") + (question ? "\n\nGezielte Frage (hat redaktionell Vorrang):\n" + question : "");
    job.phase = "generating";

    // 3. OpenAI Briefing
    log("Generiere Briefing via OpenAI (" + CORE.EXACT_MODEL + ", Stil: " + activeStyle.name + ")...");
    const chunks = CORE.chunkSource(transcript.content);
    const summaries = [];
    const ask = async (prompt, input) => {
      const request = CORE.buildOpenAiRequest(SET.openaiKey, prompt, input);
      const response = await fetch(request.url, { ...request.options, redirect: "error", signal: AbortSignal.timeout(240000) });
      if (!response.ok) throw new Error("OpenAI HTTP Fehler: " + response.status);
      const text = CORE.extractOpenAiOutputText(await response.json());
      if (!text) throw new Error("OpenAI lieferte eine leere Antwort");
      return text;
    };
    if (chunks.length > 1) {
      for (let i = 0; i < chunks.length; i++) {
        if (job.cancelled) return;
        log("Verarbeite Transkriptteil " + (i + 1) + " / " + chunks.length);
        summaries.push(await ask("Bereite diesen chronologischen Teil für die spätere Gesamtausgabe vor. Die folgende Stilvorgabe bestimmt die Auswahl und Darstellung:\n" + instructions,
          CORE.buildBriefingInput(vid, title, channel, transcript.label, chunks[i])));
      }
    }
    if (job.cancelled) return;
    const input = CORE.buildBriefingInput(vid, title, channel,
      chunks.length > 1 ? "CHRONOLOGISCHE_TEILZUSAMMENFASSUNGEN" : transcript.label,
      chunks.length > 1 ? summaries.join("\n\n") : transcript.content);
    const markdown = await ask(instructions, input);
    if (!markdown) throw new Error("OpenAI lieferte ein leeres Briefing");
    const loweredMarkdown = markdown.toLowerCase();
    if (loweredMarkdown.includes("<script") || loweredMarkdown.includes("javascript:")) {
      throw new Error("OpenAI lieferte unsicheres aktives Markup");
    }

    // 4. Speichern
    log("Speichere Ergebnis...");
    if (job.cancelled) return;
    const b = { id: job.id, videoId: vid, title, channel, markdown, ts: Date.now(),
      styleName: activeStyle.name, styleInstructions: instructions, styleOutputLanguage: activeStyle.outputLanguage || "Deutsch",
      model: CORE.EXACT_MODEL, transcript: { ...transcript, language: transcript.language || "", provider: transcript.provider || (transcript.label === "RAPIDAPI_RAW_RESPONSE" ? "rapidapi" : "primary") }, messages: [] };
    await saveBriefing(b);
    completed = true;

    if (!job.background && !job.paused) $("ytUrl").value = "";
    log("Fertig!");
    renderHistory();
    if (!job.background && !job.paused && $("focusPanel").hidden) openBriefing(b.id);

  } catch (err) {
    log("Fehler: " + err.message);
  } finally {
    if (completed || job.cancelled) await chrome.storage.local.remove("lmaa_job_" + job.id);
    if (activeJob === job) {
      activeJob = null;
      $("analyzeBtn").disabled = false;
      $("cancelAnalysisBtn").hidden = true;
    }
    setTimeout(renderRecovery, 0);
  }
}

/* ───── Init ───── */
(async () => {
  await loadStorage();
  await migrateOldData();
  renderHistory();
  updateActiveStyle();
  await renderRecovery();
  history.replaceState({ view: "home" }, "");

  const requestedUrl = new URL(location.href).searchParams.get("youtubeUrl");
  if (extractVideoId(requestedUrl || "")) {
    $("ytUrl").value = requestedUrl;
    return;
  }

  try {
    const clipboardText = await navigator.clipboard.readText();
    const clipboardVideoId = extractVideoId(clipboardText);
    if (clipboardVideoId && confirm("Soll ich die YouTube-URL aus der Zwischenablage benutzen?")) {
      $("ytUrl").value = CORE.canonicalUrl(clipboardVideoId);
      $("analyzeBtn").click();
    }
  } catch (_) {
    // An unavailable or denied clipboard must not prevent the extension from opening.
  }
})();

/* Focus control: stop before the first model request, otherwise preserve regular result. */
let activeJob = null;
let focusUrl = "";
$("analyzeBtn").addEventListener("click", () => { if (!activeJob) analyze(); });
$("focusedBtn").addEventListener("click", () => {
  if (duplicateResolver) closeDuplicateDialog("cancel");
  focusUrl = activeJob?.url || $("ytUrl").value.trim();
  if (!extractVideoId(focusUrl)) return alert("Bitte zuerst einen gültigen YouTube-Link eingeben.");
  if (activeJob) { activeJob.paused = true; activeJob.background = activeJob.phase === "generating"; }
  $("focusPanel").hidden = false;
  $("focusInput").focus();
});
$("focusSubmit").addEventListener("click", () => {
  const question = $("focusInput").value.trim();
  if (!question) return $("focusInput").focus();
  if (activeJob?.phase === "fetching") { activeJob.cancelled = true; activeJob.resume?.(); }
  else if (activeJob) activeJob.background = true;
  $("focusPanel").hidden = true;
  $("focusInput").value = "";
  analyze(focusUrl, question, false);
});
$("focusCancel").addEventListener("click", () => {
  $("focusPanel").hidden = true;
  if (activeJob) { activeJob.paused = false; activeJob.background = false; activeJob.resume?.(); }
});
$("cancelAnalysisBtn").addEventListener("click", () => {
  if (activeJob) { activeJob.cancelled = true; activeJob.paused = false; activeJob.resume?.(); }
  activeJob = null;
  $("analyzeBtn").disabled = false;
  $("cancelAnalysisBtn").hidden = true;
  log("Analyse abgebrochen.");
});
function updateActiveStyle() { $("activeStyleLabel").textContent = "Aktiver Stil: " + getActiveStyle().name; }
$("regenerateBtn").addEventListener("click", () => {
  if (!currentBriefing || activeJob) return;
  const url = CORE.canonicalUrl(currentBriefing.videoId);
  showHome(); $("ytUrl").value = url;
  analyze(url, "", false);
});
function downloadFile(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("shareBtn").addEventListener("click", async () => {
  if (!currentBriefing) return;
  const text = buildShareText(currentBriefing);
  if (navigator.share) { try { await navigator.share({ title: currentBriefing.title, text }); } catch (_) {} }
  else downloadFile(text, "lmaa-briefing.txt", "text/plain");
});
for (const [button, key, field] of [["deleteOpenaiKey", "openaiKey", "cfgOpenai"], ["deleteRapidapiKey", "rapidapiKey", "cfgRapidapiKey"]]) {
  $(button).addEventListener("click", async () => {
    SET[key] = ""; if (key === "rapidapiKey") { SET.rapidapiMode = "off"; $("cfgRapidapiMode").value = "off"; }
    await persistSettings(); $(field).value = ""; $(field).placeholder = "Kein Key gespeichert";
  });
}

/* Durable per-briefing chat. A reload retains user input and offers explicit retry. */
const chatting = new Set();
const submittingChat = new Set();
function renderChat() {
  if (!currentBriefing) return;
  const messages = currentBriefing.messages || [];
  $("chatMessages").innerHTML = messages.map(m => '<section><strong>' + (m.role === "user" ? "Du" : "LMAA") + '</strong>' + renderMarkdown(m.content, currentBriefing.videoId) + '</section>').join("");
  renderMath($("chatMessages"));
  const busy = chatting.has(currentBriefing.id);
  $("chatSend").disabled = busy;
  $("chatInput").disabled = busy;
  $("chatRetry").hidden = busy || messages.at(-1)?.role !== "user";
  $("chatStatus").textContent = busy ? "Antwort wird erstellt …" : (currentBriefing.chatError || "");
}
async function sendChat(briefingId) {
  if (chatting.has(briefingId)) return;
  chatting.add(briefingId); renderChat();
  await navigator.locks.request("lmaa-chat-" + briefingId, async () => {
    try {
      const fresh = (await chrome.storage.local.get(STORAGE_BRIEFINGS))[STORAGE_BRIEFINGS] || [];
      const b = fresh.find(x => x.id === briefingId);
      if (!b || b.messages?.at(-1)?.role !== "user") return;
      const pending = b.messages.at(-1);
      const { input, omitted } = DATA.chatContext(b, b.messages);
      const request = CORE.buildOpenAiRequest(SET.openaiKey, "", input);
      const payload = JSON.parse(request.options.body);
      payload.instructions = DATA.CHAT_INSTRUCTIONS;
      payload.tools = [{ type: "web_search" }];
      payload.tool_choice = "auto";
      request.options.body = JSON.stringify(payload);
      const response = await fetch(request.url, { ...request.options, signal: AbortSignal.timeout(240000) });
      if (!response.ok) throw new Error("OpenAI HTTP " + response.status);
      const content = CORE.extractOpenAiOutputText(await response.json(), true);
      if (!content) throw new Error("Leere Antwort");
      await mutateBriefings(list => {
        const target = list.find(x => x.id === briefingId);
        if (!target || target.messages.some(m => m.id === pending.id + "-reply")) return;
        target.messages.push({ id: pending.id + "-reply", role: "assistant", content, ts: Math.max(Date.now(), pending.ts + 1) });
        target.chatError = omitted ? omitted + " ältere Nachrichten wurden für diese Antwort nicht mitgesendet." : "";
      });
    } catch (e) {
      await mutateBriefings(list => {
        const b = list.find(x => x.id === briefingId);
        if (b) b.chatError = e.message === "CHAT_CONTEXT_TOO_LARGE" ? "Transkript, Briefing und letzte Frage überschreiten das Kontextbudget. Es wurde nichts gekürzt oder gesendet." : "Antwort fehlgeschlagen: " + e.message;
      });
    } finally { chatting.delete(briefingId); renderChat(); }
  });
}
$("chatForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentBriefing || chatting.has(currentBriefing.id) || submittingChat.has(currentBriefing.id)) return;
  const content = $("chatInput").value.trim(); if (!content) return;
  const id = currentBriefing.id;
  submittingChat.add(id);
  $("chatSend").disabled = true;
  try {
    await mutateBriefings(list => {
      const b = list.find(x => x.id === id); if (!b) throw new Error("Briefing gelöscht");
      b.messages ||= [];
      b.messages.push({ id: crypto.randomUUID(), role: "user", content, ts: Math.max(Date.now(), (b.messages.at(-1)?.ts || 0) + 1) });
      b.chatError = "";
    });
    $("chatInput").value = "";
    await sendChat(id);
  } catch (_) { $("chatStatus").textContent = "Nachricht konnte nicht gespeichert werden."; $("chatSend").disabled = false; }
  finally { submittingChat.delete(id); }
});
$("chatRetry").addEventListener("click", () => { if (currentBriefing) sendChat(currentBriefing.id); });

$("exportHistory").addEventListener("click", async () => {
  try {
    const latest = await chrome.storage.local.get([STORAGE_BRIEFINGS, STORAGE_SETTINGS]);
    const text = DATA.exportArchive(latest[STORAGE_BRIEFINGS] || [], latest[STORAGE_SETTINGS]?.styles || SET.styles);
    downloadFile(text, "lmaa-verlauf.json", "application/json");
    $("transferStatus").textContent = "Export erstellt. Auf dem anderen Gerät ‚Verlauf importieren‘ wählen.";
  } catch (_) { $("transferStatus").textContent = "Export fehlgeschlagen. Es wurden keine Daten geändert."; }
});
$("importHistory").addEventListener("change", async event => {
  try {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > DATA.ARCHIVE_LIMIT) throw new Error("ARCHIVE_TOO_LARGE");
    const archive = DATA.validateArchive(await file.text());
    await navigator.locks.request("lmaa-history", async () => {
      const latest = await chrome.storage.local.get([STORAGE_BRIEFINGS, STORAGE_SETTINGS]);
      const merged = DATA.mergeArchive(latest[STORAGE_BRIEFINGS] || [], archive);
      const settings = structuredClone(latest[STORAGE_SETTINGS] || SET);
      for (const style of archive.styles || []) {
        if (settings.styles.some(s => s.prompt === style.instructions && (s.outputLanguage || "Deutsch") === style.outputLanguage)) continue;
        let name = style.name, suffix = 1;
        while (settings.styles.some(s => s.name.toLowerCase() === name.toLowerCase())) name = style.name.slice(0, 60) + " (Import " + suffix++ + ")";
        settings.styles.push({ id: crypto.randomUUID(), name, prompt: style.instructions, outputLanguage: style.outputLanguage, isBuiltIn: false });
      }
      await chrome.storage.local.set({ [STORAGE_BRIEFINGS]: merged.briefings, [STORAGE_SETTINGS]: settings });
      BRIEFINGS = merged.briefings; SET = settings;
      $("transferStatus").textContent = `Import abgeschlossen. Neue Briefings: ${merged.addedBriefings} · Neue Chatnachrichten: ${merged.addedMessages}`;
    });
    renderHistory(); updateActiveStyle(); renderStyleSelect();

  } catch (_) { $("transferStatus").textContent = "Import abgelehnt: ungültige, zu große oder widersprüchliche Datei. Bestehende Daten bleiben erhalten."; }
  finally { event.target.value = ""; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_SETTINGS]?.newValue) { SET = changes[STORAGE_SETTINGS].newValue; updateActiveStyle(); }
  if (changes[STORAGE_BRIEFINGS]) {
    BRIEFINGS = changes[STORAGE_BRIEFINGS].newValue || [];
    if (currentBriefing) { currentBriefing = BRIEFINGS.find(b => b.id === currentBriefing.id) || null; if (currentBriefing) renderChat(); else showHome(); }
    renderHistory();
  }
});

$("importCurl").addEventListener("click", () => {
  try {
    const parsed = CORE.parseRapidApiCurl($("cfgCurl").value);
    $("cfgRapidapiEndpoint").value = parsed.settings.rapidapiEndpoint;
    $("cfgRapidapiMethod").value = parsed.settings.rapidapiMethod;
    $("cfgRapidapiHeaders").value = parsed.settings.rapidapiHeaders;
    $("cfgRapidapiBody").value = parsed.settings.rapidapiBody;
    if (parsed.key) $("cfgRapidapiKey").value = parsed.key;
    $("cfgCurl").value = "";
  } catch (_) { alert("cURL nicht unterstützt. Erlaubt sind nur GET/POST, URL, Header und Body ohne Shell-Kommandos."); }
});
$("rapidapiDefaults").addEventListener("click", () => {
  $("cfgRapidapiEndpoint").value = DEFAULT_SETTINGS.rapidapiEndpoint;
  $("cfgRapidapiHeaders").value = DEFAULT_SETTINGS.rapidapiHeaders;
  $("cfgRapidapiMethod").value = "GET"; $("cfgRapidapiMode").value = "off";
  $("cfgRapidapiBody").value = ""; $("cfgRapidapiTimeout").value = 30000;
  $("cfgRapidapiLimit").value = 2000000; $("cfgRapidapiCodes").value = "200";
});

async function renderRecovery() {
  const all = await chrome.storage.local.get(null);
  const held = (await navigator.locks.query()).held || [];
  const container = $("recoveryActions"); container.replaceChildren();
  for (const [key, job] of Object.entries(all)) {
    if (!key.startsWith("lmaa_job_") || !job?.id || held.some(lock => lock.name === "lmaa-analysis-" + job.id)) continue;
    const row = document.createElement("p");
    const resume = document.createElement("button"); resume.className = "btn ghost";
    resume.textContent = "Unterbrochene Analyse fortsetzen (" + (job.style?.name || "Stil") + ")";
    resume.addEventListener("click", () => { if (activeJob) return; row.remove(); $("ytUrl").value = job.url; analyze(job.url, job.question || "", false, job); });
    const discard = document.createElement("button"); discard.className = "btn ghost"; discard.textContent = "Verwerfen";
    discard.addEventListener("click", async () => { await chrome.storage.local.remove(key); row.remove(); });
    row.append(resume, discard); container.append(row);
  }
}
