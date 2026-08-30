const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Core = require("./lmaa-core.js");

const rapidSettings = {
  rapidapiKey: "synthetic-secret",
  rapidapiEndpoint: Core.DEFAULT_RAPIDAPI_ENDPOINT,
  rapidapiMethod: "GET",
  rapidapiHeaders:
    "X-RapidAPI-Host: youtube-transcripts.p.rapidapi.com\n" +
    "X-RapidAPI-Key: {{rapidapi_key}}\nAccept: application/json"
};

test("RapidAPI default renders the verified provider contract", () => {
  const request = Core.buildRapidApiRequest(rapidSettings, "NmHhXoTckcM", "en");
  const url = new URL(request.url);
  assert.equal(url.origin, "https://youtube-transcripts.p.rapidapi.com");
  assert.equal(url.searchParams.get("url"), "https://www.youtube.com/watch?v=NmHhXoTckcM");
  assert.equal(url.searchParams.get("videoId"), "NmHhXoTckcM");
  assert.equal(url.searchParams.get("chunkSize"), "100");
  assert.equal(url.searchParams.get("text"), "false");
  assert.equal(url.searchParams.get("lang"), "en");
  assert.equal(request.options.headers["X-RapidAPI-Key"], "synthetic-secret");
  assert.equal(request.url.includes("synthetic-secret"), false);
});

test("broken persisted RapidAPI default is migrated", () => {
  const migrated = Core.migrateSettings({
    model: "other-model",
    rapidapiEndpoint: Core.BROKEN_RAPIDAPI_ENDPOINT
  });
  assert.equal(migrated.rapidapiEndpoint, Core.DEFAULT_RAPIDAPI_ENDPOINT);
  assert.equal(migrated.model, "gpt-5.6-sol");
});

test("RapidAPI rejects unsafe hosts and key placement", () => {
  assert.throws(
    () => Core.buildRapidApiRequest({
      ...rapidSettings,
      rapidapiEndpoint: "https://example.com/transcript?videoId={{video_id}}"
    }, "NmHhXoTckcM", "en"),
    /RAPIDAPI_ENDPOINT_NOT_ALLOWED/
  );
  assert.throws(
    () => Core.buildRapidApiRequest({
      ...rapidSettings,
      rapidapiEndpoint: Core.DEFAULT_RAPIDAPI_ENDPOINT + "&key={{rapidapi_key}}"
    }, "NmHhXoTckcM", "en"),
    /RAPIDAPI_KEY_PLACEHOLDER_LOCATION_INVALID/
  );
});

test("Innertube request mirrors youtube-transcript-api 1.2.4", () => {
  const apiKey = Core.extractInnertubeApiKey(
    '<script>ytcfg.set({"INNERTUBE_API_KEY":"synthetic_key-1"});</script>'
  );
  const request = Core.buildInnertubeRequest(apiKey, "NmHhXoTckcM");
  const body = JSON.parse(request.options.body);
  assert.equal(new URL(request.url).searchParams.get("lmaa_extension_request"), "1");
  assert.equal(body.context.client.clientName, "ANDROID");
  assert.equal(body.context.client.clientVersion, "20.10.38");
  assert.equal(body.videoId, "NmHhXoTckcM");
});

test("caption selection and transcript formatting are deterministic", () => {
  const track = Core.selectCaptionTrack([
    { languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=x" },
    { languageCode: "de", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=x" }
  ]);
  assert.equal(track.languageCode, "de");
  assert.equal(track.kind, "asr");
  assert.equal(
    Core.formatTranscriptSegments([{ start: 65.9, text: "  Hallo\nWelt  " }]),
    "[00:01:05] Hallo Welt"
  );
});

test("OpenAI uses Responses, exact model, no tools and store false", () => {
  const input = Core.buildBriefingInput(
    "NmHhXoTckcM",
    "Synthetic title",
    "Synthetic channel",
    "RAPIDAPI_RAW_RESPONSE",
    '{"content":[{"text":"synthetic"}]}'
  );
  const request = Core.buildOpenAiRequest("synthetic-openai", "Freier Stil", input);
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, []);
  assert.match(body.input, /BEGIN UNTRUSTED_RAPIDAPI_RAW_RESPONSE/);
  assert.equal(
    Core.extractOpenAiOutputText({
      output: [{ type: "message", content: [{ type: "output_text", text: "# Ergebnis" }] }]
    }),
    "# Ergebnis"
  );
});

test("Markdown renders tables, blockquotes and safe timestamp links", () => {
  const markdown = [
    "| Zeit | Thema |",
    "| --- | --- |",
    "| [00:01:05](https://www.youtube.com/watch?v=NmHhXoTckcM&t=65s) | **Start** |",
    "",
    "> Quellenkritischer Hinweis",
    "",
    "<script>alert(1)</script>",
    "[unsicher](javascript:alert(1))"
  ].join("\n");
  const html = Core.renderMarkdown(markdown);
  assert.match(html, /<table>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /href="https:\/\/www\.youtube\.com\/watch\?v=NmHhXoTckcM&amp;t=65s"/);
  assert.match(html, /<strong>Start<\/strong>/);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes('href="javascript:'), false);
});

test("duplicate lookup returns the newest briefing for the video", () => {
  const newest = Core.findNewestBriefing([
    { id: "old", videoId: "NmHhXoTckcM", ts: 10 },
    { id: "other", videoId: "dQw4w9WgXcQ", ts: 30 },
    { id: "new", videoId: "NmHhXoTckcM", ts: 20 }
  ], "NmHhXoTckcM");
  assert.equal(newest.id, "new");
});

test("extension manifest is least-privilege and loads core before UI", () => {
  const manifest = JSON.parse(fs.readFileSync(__dirname + "/manifest.json", "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("declarativeNetRequestWithHostAccess"));
  const rules = JSON.parse(fs.readFileSync(__dirname + "/network-rules.json", "utf8"));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].action.requestHeaders[0].header, "Origin");
  assert.equal(rules[0].action.requestHeaders[0].operation, "remove");
  assert.match(rules[0].condition.urlFilter, /lmaa_extension_request=1/);
  const html = fs.readFileSync(__dirname + "/lmaa.html", "utf8");
  assert.ok(html.indexOf('src="lmaa-core.js"') < html.indexOf('src="lmaa.js"'));
  const source = fs.readFileSync(__dirname + "/lmaa.js", "utf8");
  assert.equal(source.includes("/v1/chat/completions"), false);
  assert.equal(source.includes("?video_id={{video_id}}"), false);
});
