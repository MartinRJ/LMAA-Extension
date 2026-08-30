/* LMAA Browser Port – External Script (CSP-compliant for Chrome Extensions) */
/* All persistent data uses chrome.storage.local to survive extension reloads/updates */

/* Utils */
const $ = id => document.getElementById(id);
const escapeHtml = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const CORE = globalThis.LmaaCore;
if (!CORE) throw new Error("LMAA_CORE_MISSING");

/* ───── Storage Layer (chrome.storage.local) ───── */
const STORAGE_SETTINGS = "lmaa_settings";
const STORAGE_BRIEFINGS = "lmaa_briefings";

const DEFAULT_STYLE_PROMPT = `Erstelle ein sachliches, informationsdichtes YouTube-Briefing auf Deutsch.
Nutze ausschließlich die bereitgestellten Inhalte und ergänze keine externen Fakten.
Trenne Aussagen des Videos klar von gesicherten technischen Metadaten. Erfinde keine
Aussagen, Quellen oder Zeitmarken. Markiere fehlende Belege, unverständliche Passagen,
Widersprüche und Unsicherheiten ausdrücklich. Verwende konkrete Zeitmarken nur, wenn
sie in den bereitgestellten Daten vorkommen.

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
  rapidapiHeaders: "X-RapidAPI-Host: youtube-transcripts.p.rapidapi.com\nX-RapidAPI-Key: {{rapidapi_key}}\nAccept: application/json",
  rapidapiUsage: { month: "", attempts: 0, successes: 0 }
};

let SET = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let BRIEFINGS = []; /* in-memory cache, synced to chrome.storage.local */

/* Read from chrome.storage.local */
async function loadStorage() {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_SETTINGS, STORAGE_BRIEFINGS], result => {
      if (result[STORAGE_SETTINGS]) {
        Object.assign(SET, result[STORAGE_SETTINGS]);
        SET = CORE.migrateSettings(SET);
        if (!SET.styles || !SET.styles.length) SET.styles = [...DEFAULT_SETTINGS.styles];
      }
      BRIEFINGS = result[STORAGE_BRIEFINGS] || [];
      resolve();
    });
  });
}

async function persistSettings() {
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_SETTINGS]: SET }, resolve);
  });
}

async function persistBriefings() {
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_BRIEFINGS]: BRIEFINGS }, resolve);
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
  BRIEFINGS.push(b);
  await persistBriefings();
}

function getBriefingsSorted() {
  return BRIEFINGS.slice().sort((a, b) => b.ts - a.ts);
}

async function deleteBriefing(id) {
  BRIEFINGS = BRIEFINGS.filter(b => b.id !== id);
  await persistBriefings();
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
    SET.styles[styleIdx].prompt = $("cfgStylePrompt").value.trim();
  }
  SET.activeStyleId = currentStyleId;

  SET.rapidapiMode = $("cfgRapidapiMode").value;
  const replacementRapidApiKey = $("cfgRapidapiKey").value.trim();
  if (replacementRapidApiKey) SET.rapidapiKey = replacementRapidApiKey;
  SET.rapidapiEndpoint = $("cfgRapidapiEndpoint").value.trim();
  SET.rapidapiMethod = $("cfgRapidapiMethod").value;
  SET.rapidapiHeaders = $("cfgRapidapiHeaders").value.trim();

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
  $("cfgStylePrompt").value = style.prompt;

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

function renderMarkdown(src) {
  return CORE.renderMarkdown(src);
}

/* ───── UI Logic ───── */

function renderHistory() {
  const list = getBriefingsSorted();
  const el = $("historyList");
  if (!list.length) { el.innerHTML = "Keine Briefings vorhanden."; return; }
  el.innerHTML = list.map(b => '\
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

function openBriefing(id) {
  const b = BRIEFINGS.find(x => x.id === id);
  if (!b) return;
  currentBriefing = b;
  $("view-home").style.display = "none";
  $("view-detail").style.display = "block";
  $("detailTitle").textContent = b.title;
  $("detailMeta").innerHTML = '<a href="https://www.youtube.com/watch?v=' + b.videoId + '" target="_blank" rel="noopener noreferrer">YouTube-Link</a> · Kanal: ' + escapeHtml(b.channel) + ' · Erstellt: ' + new Date(b.ts).toLocaleString() + ' · Stil: ' + escapeHtml(b.styleName || "Unbekannt");
  $("detailContent").innerHTML = renderMarkdown(b.markdown);
}

$("backBtn").addEventListener("click", () => {
  $("view-detail").style.display = "none";
  $("view-home").style.display = "block";
  currentBriefing = null;
  renderHistory();
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

  renderStyleSelect();
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

  const res = await fetch(request.url, request.options);
  if (!res.ok) throw new Error("RapidAPI HTTP Fehler: " + res.status);
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json") && !contentType.startsWith("text/")) {
    throw new Error("RapidAPI Content-Type nicht erlaubt: " + (contentType || "fehlend"));
  }
  const content = await readUtf8Response(res, 2_000_000, "RAPIDAPI");
  if (!content.trim()) throw new Error("RapidAPI lieferte eine leere Antwort");
  SET.rapidapiUsage.successes += 1;
  await persistSettings();
  log("RapidAPI-Nutzung " + month + ": " + SET.rapidapiUsage.attempts + " Versuche / " + SET.rapidapiUsage.successes + " Erfolge (Basic-Hinweis: /100)");
  return { content, label: "RAPIDAPI_RAW_RESPONSE" };
}

$("analyzeBtn").addEventListener("click", async () => {
  const url = $("ytUrl").value.trim();
  const vid = extractVideoId(url);
  if (!vid) return alert("Ungültige YouTube URL");

  const existing = CORE.findNewestBriefing(BRIEFINGS, vid);
  if (existing) {
    const decision = await chooseExistingOrNew(existing);
    if (decision === "open") {
      openBriefing(existing.id);
      return;
    }
    if (decision !== "new") return;
  }

  if (!SET.openaiKey) return alert("OpenAI API-Key fehlt. Bitte klicke auf 'Verwaltung'.");

  $("statusLog").textContent = "";
  $("analyzeBtn").disabled = true;

  try {
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

    const activeStyle = getActiveStyle();

    // 3. OpenAI Briefing
    log("Generiere Briefing via OpenAI (" + CORE.EXACT_MODEL + ", Stil: " + activeStyle.name + ")...");
    const input = CORE.buildBriefingInput(
      vid,
      title,
      channel,
      transcript.label,
      transcript.content
    );
    const aiRequest = CORE.buildOpenAiRequest(SET.openaiKey, activeStyle.prompt, input);
    const aiRes = await fetch(aiRequest.url, aiRequest.options);

    if (!aiRes.ok) {
      throw new Error("OpenAI HTTP Fehler: " + aiRes.status);
    }
    const aiData = await aiRes.json();
    const markdown = CORE.extractOpenAiOutputText(aiData);
    if (!markdown) throw new Error("OpenAI lieferte ein leeres Briefing");
    const loweredMarkdown = markdown.toLowerCase();
    if (loweredMarkdown.includes("<script") || loweredMarkdown.includes("javascript:")) {
      throw new Error("OpenAI lieferte unsicheres aktives Markup");
    }

    // 4. Speichern
    log("Speichere Ergebnis...");
    const b = { id: Date.now().toString(), videoId: vid, title, channel, markdown, ts: Date.now(), styleName: activeStyle.name, model: CORE.EXACT_MODEL };
    await saveBriefing(b);

    $("ytUrl").value = "";
    log("Fertig!");
    renderHistory();
    setTimeout(() => openBriefing(b.id), 500);

  } catch (err) {
    log("Fehler: " + err.message);
  } finally {
    $("analyzeBtn").disabled = false;
  }
});

/* ───── Init ───── */
(async () => {
  await loadStorage();
  await migrateOldData();
  renderHistory();
})();
