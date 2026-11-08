const { test } = require('node:test');
const assert = require('node:assert/strict');
const data = require('./lmaa-data.js');
const core = require('./lmaa-core.js');
const fixture = () => ({ id:'briefing-1', videoId:'abcdefghijk', title:'Synthetisch', channel:'Test', markdown:'[12:34] Inhalt', ts:1,
  model:core.EXACT_MODEL, styleName:'Eigener Stil', styleInstructions:'Nur ein Satz.', styleOutputLanguage:'Deutsch',
  transcript:{content:'[00:00:01] Ungekürzte Quelle 😃',label:'TRANSKRIPT',language:'de',provider:'primary'},
  messages:[{id:'message-1',role:'user',content:'Warum?',ts:2}] });
test('archive roundtrip includes source and chat but never settings or keys', () => {
  const b = fixture(); b.openaiKey = 'synthetic-secret';
  const text = data.exportArchive([b], [{isBuiltIn:false,name:'Kurz',prompt:'Ein Satz.',openaiKey:'synthetic-secret'}]);
  assert.ok(!text.includes('synthetic-secret'));
  assert.deepEqual(data.validateArchive(text).briefings, [data.portableBriefing(b)]);
});
test('repeat import is idempotent and merges divergent chat histories', () => {
  const b = fixture(), incoming = structuredClone(b);
  incoming.messages.push({id:'message-2',role:'assistant',content:'Darum.',ts:3});
  const archive = {briefings:[incoming]};
  const merged = data.mergeArchive([b], archive);
  assert.equal(merged.length,1); assert.equal(merged[0].messages.length,2);
  assert.deepEqual(data.mergeArchive(merged,archive),merged);
  assert.equal(b.messages.length,1);
});
test('conflicts reject atomically without overwriting local history', () => {
  const b=fixture(), incoming=structuredClone(b); incoming.markdown='Anderer Inhalt';
  assert.throws(()=>data.mergeArchive([b],{briefings:[incoming]}),/CONFLICT/);
  assert.equal(b.markdown,'[12:34] Inhalt');
});
test('archive rejects unsupported versions, duplicate IDs, invalid videos and roles', () => {
  const root=JSON.parse(data.exportArchive([fixture()],[]));
  for (const mutate of [r=>r.version=2,r=>r.briefings.push(r.briefings[0]),r=>r.briefings[0].videoId='bad',r=>r.briefings[0].messages[0].role='system',r=>r.briefings[0].ts=1.5]) {
    const copy=structuredClone(root); mutate(copy); assert.throws(()=>data.validateArchive(JSON.stringify(copy)));
  }
});
test('chat retains full source and a contiguous newest suffix without modifying stored messages', () => {
  const b=fixture(); const old={id:'old',role:'user',content:'X'.repeat(1000),ts:1};
  const messages=[old,{id:'answer',role:'assistant',content:'Antwort',ts:2},...b.messages];
  const budget=Buffer.byteLength(data.CHAT_INSTRUCTIONS,'utf8')+600;
  const context=data.chatContext(b,messages,budget);
  assert.equal(context.omitted,1); assert.equal(messages.length,3);
  assert.ok(context.input[0].content.includes('Ungekürzte Quelle 😃'));
  assert.equal(context.input.at(-1).content,'Warum?');
});
test('oversized source or latest message fails without compression or partial cutting', () => {
  const b=fixture(); b.transcript.content='X'.repeat(2000);
  assert.throws(()=>data.chatContext(b,b.messages,1000),/CONTEXT_TOO_LARGE/);
});
test('plain timestamps link to the current video but code, math and existing links remain intact', () => {
  const html=core.renderMarkdown('[12:34] und 1:02:03\n\n`12:34`\n\n[Zeit](https://example.test/?t=1)\n\n```\n12:34\n```','abcdefghijk');
  assert.ok(html.includes('watch?v=abcdefghijk&amp;t=754s'));
  assert.ok(html.includes('&amp;t=3723s'));
  assert.ok(html.includes('<code>12:34</code>'));
  assert.equal((html.match(/watch\?v=/g)||[]).length,2);
  assert.ok(html.includes('https://example.test/?t=1'));
});
test('chunking preserves Unicode and every source character', () => {
  const source='abc😃def'.repeat(20), chunks=core.chunkSource(source,4);
  assert.equal(chunks.join(''),source);
  assert.ok(chunks.every(x=>!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(x)));
});
test('RapidAPI cURL parsing extracts key separately and never executes commands', () => {
  const command=`curl --request POST --url 'https://test.p.rapidapi.com/transcript' --header 'X-RapidAPI-Host: test.p.rapidapi.com' --header 'X-RapidAPI-Key: synthetic-test' --header 'Content-Type: application/json' --data '{"id":"{{video_id}}"}'`;
  const parsed=core.parseRapidApiCurl(command);
  assert.equal(parsed.key,'synthetic-test');
  assert.ok(!JSON.stringify(parsed.settings).includes('synthetic-test'));
  const req=core.buildRapidApiRequest({...parsed.settings,rapidapiKey:parsed.key},'abcdefghijk','de');
  assert.equal(req.options.body,'{"id":"abcdefghijk"}'); assert.equal(req.options.redirect,'error');
  for(const suffix of [' | sh','; echo bad',' --location',' > file']) assert.throws(()=>core.parseRapidApiCurl(command+suffix));
});
test('RapidAPI limits and key locations are validated', () => {
  const settings={rapidapiKey:'synthetic-test',rapidapiEndpoint:'https://test.p.rapidapi.com/transcript',rapidapiHeaders:'X-RapidAPI-Host: test.p.rapidapi.com\nX-RapidAPI-Key: {{rapidapi_key}}'};
  assert.throws(()=>core.buildRapidApiRequest({...settings,rapidapiTimeoutMs:0},'abcdefghijk','de'));
  assert.throws(()=>core.buildRapidApiRequest({...settings,rapidapiEndpoint:'https://test.p.rapidapi.com/{{rapidapi_key}}'},'abcdefghijk','de'));
  assert.throws(()=>core.buildRapidApiRequest({...settings,rapidapiMethod:'POST',rapidapiBody:'{{rapidapi_key}}'},'abcdefghijk','de'));
  assert.throws(()=>core.buildRapidApiRequest({...settings,rapidapiSuccessCodes:[500]},'abcdefghijk','de'));
});
