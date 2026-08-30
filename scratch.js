/*
 * Opt-in live smoke for the browser-extension contracts.
 * No secret or transcript content is printed. Usage:
 *   node scratch.js native --video-id NmHhXoTckcM
 *   node scratch.js providers --video-id NmHhXoTckcM
 *   node scratch.js origin-probe --video-id NmHhXoTckcM
 */
const fs = require("node:fs");
const path = require("node:path");
const Core = require("./lmaa-core.js");

const repositoryRoot = __dirname;
const args = process.argv.slice(2);
const mode = args[0];
const videoIdIndex = args.indexOf("--video-id");
const videoId = videoIdIndex >= 0 ? args[videoIdIndex + 1] : "NmHhXoTckcM";
const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

function readSecret(filename) {
  let value = fs.readFileSync(path.join(repositoryRoot, filename), "utf8")
    .replace(/^\uFEFF/, "").trim();
  if (value.includes("=") && !/[\r\n]/.test(value)) value = value.split("=").slice(1).join("=").trim();
  if (!value || /[\r\n]/.test(value)) throw new Error(filename + " enthält keinen einzelnen Wert");
  return value;
}

async function checkedText(response, provider, maxBytes) {
  if (!response.ok) throw new Error(provider + " HTTP " + response.status);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new Error(provider + " response too large");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.trim()) throw new Error(provider + " empty response");
  return { text, byteLength: bytes.byteLength };
}

async function smokeNative() {
  const watch = await fetch(Core.canonicalUrl(videoId), {
    headers: { "Accept-Language": "de,en;q=0.9", "User-Agent": chromeUserAgent }
  });
  const html = (await checkedText(watch, "youtube-watch", 3_000_000)).text;
  const playerRequest = Core.buildInnertubeRequest(Core.extractInnertubeApiKey(html), videoId);
  const playerResponse = await fetch(playerRequest.url, playerRequest.options);
  const playerText = (await checkedText(playerResponse, "youtube-player", 3_000_000)).text;
  const player = JSON.parse(playerText);
  if (player?.playabilityStatus?.status !== "OK") {
    throw new Error("youtube playability " + (player?.playabilityStatus?.status || "missing"));
  }
  const track = Core.selectCaptionTrack(
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  );
  const captionResponse = await fetch(Core.captionTrackUrl(track));
  const caption = await checkedText(captionResponse, "youtube-caption", 5_000_000);
  const segmentCount = (caption.text.match(/<text(?:\s|>)/g) || []).length;
  if (!segmentCount) throw new Error("youtube-caption contains no segments");
  return {
    provider: "youtube-innertube",
    videoId,
    language: track.languageCode,
    generated: track.kind === "asr",
    segmentCount,
    responseBytes: caption.byteLength
  };
}

async function smokeProviders() {
  const rapidapiKey = readSecret("youtube-transcripts Key.txt");
  const rapidRequest = Core.buildRapidApiRequest({
    rapidapiKey,
    rapidapiEndpoint: Core.DEFAULT_RAPIDAPI_ENDPOINT,
    rapidapiMethod: "GET",
    rapidapiHeaders:
      "X-RapidAPI-Host: youtube-transcripts.p.rapidapi.com\n" +
      "X-RapidAPI-Key: {{rapidapi_key}}\nAccept: application/json"
  }, videoId, "en");
  const rapidResponse = await fetch(rapidRequest.url, rapidRequest.options);
  const rapid = await checkedText(rapidResponse, "rapidapi", 2_000_000);
  const contentType = (rapidResponse.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json") && !contentType.startsWith("text/")) {
    throw new Error("rapidapi content type not allowed");
  }

  const metadataResponse = await fetch(
    "https://www.youtube.com/oembed?url=" + encodeURIComponent(Core.canonicalUrl(videoId)) +
    "&format=json"
  );
  const metadata = JSON.parse((await checkedText(metadataResponse, "oembed", 200_000)).text);
  const input = Core.buildBriefingInput(
    videoId,
    metadata.title,
    metadata.author_name,
    "RAPIDAPI_RAW_RESPONSE",
    rapid.text
  );
  const openaiRequest = Core.buildOpenAiRequest(
    readSecret("OpenAI API KEY.txt"),
    "Antworte auf Deutsch mit genau der Überschrift # Kernaussage und einer knappen Zusammenfassung.",
    input
  );
  const openaiResponse = await fetch(openaiRequest.url, openaiRequest.options);
  const openaiText = (await checkedText(openaiResponse, "openai", 2_000_000)).text;
  const openaiData = JSON.parse(openaiText);
  const output = Core.extractOpenAiOutputText(openaiData);
  if (!output) throw new Error("openai empty output");
  return {
    rapidapi: {
      status: rapidResponse.status,
      responseBytes: rapid.byteLength,
      contentType
    },
    openai: {
      status: openaiResponse.status,
      model: openaiData.model,
      outputCharacters: output.length,
      requestedHeadingPresent: output.includes("# Kernaussage")
    }
  };
}

async function probeExtensionOrigin() {
  const watch = await fetch(Core.canonicalUrl(videoId), {
    headers: { "Accept-Language": "de,en;q=0.9", "User-Agent": chromeUserAgent }
  });
  const html = (await checkedText(watch, "youtube-watch", 3_000_000)).text;
  const apiKey = Core.extractInnertubeApiKey(html);
  const body = JSON.stringify({
    context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
    videoId
  });
  const url = "https://www.youtube.com/youtubei/v1/player?key=" + encodeURIComponent(apiKey);
  const variants = [
    { name: "baseline", headers: { "Content-Type": "application/json" } },
    {
      name: "extension-origin-json",
      headers: {
        "Content-Type": "application/json",
        "Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    },
    {
      name: "extension-origin-client-headers",
      headers: {
        "Content-Type": "application/json",
        "Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "X-YouTube-Client-Name": "3",
        "X-YouTube-Client-Version": "20.10.38"
      }
    },
    {
      name: "extension-origin-text",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  ];
  const results = [];
  for (const variant of variants) {
    const response = await fetch(url, { method: "POST", headers: variant.headers, body });
    results.push({ name: variant.name, status: response.status });
    await response.arrayBuffer();
  }
  return { videoId, results };
}

(async () => {
  if (mode === "native") console.log(JSON.stringify(await smokeNative()));
  else if (mode === "providers") console.log(JSON.stringify(await smokeProviders()));
  else if (mode === "origin-probe") console.log(JSON.stringify(await probeExtensionOrigin()));
  else throw new Error("Modus muss 'native', 'providers' oder 'origin-probe' sein");
})().catch(error => {
  console.error(JSON.stringify({ status: "failed", error: error.message }));
  process.exitCode = 1;
});
