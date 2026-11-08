const { chromium } = require(process.env.LMAA_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const work = process.env.LMAA_TEST_WORK || path.join(root, 'work');
(async () => {
  await fs.mkdir(work, { recursive: true });
  const profile = await fs.mkdtemp(path.join(work, 'browser-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath:process.env.LMAA_CHROMIUM,headless:true,
    args:['--no-sandbox','--disable-gpu','--enable-unsafe-extension-debugging','--disable-features=DisableLoadExtensionCommandLineSwitch','--disable-extensions-except=' + root,'--load-extension=' + root],
    ignoreDefaultArgs:['--disable-extensions'], viewport:{width:1280,height:960}, acceptDownloads:true
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const origin = 'chrome-extension://' + new URL(worker.url()).host;
    const page = await context.newPage();
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    page.on('dialog', d=>d.accept());
    await page.goto(origin+'/lmaa.html');
    await page.waitForFunction(()=>document.getElementById('activeStyleLabel').textContent.length>0);
    await page.evaluate(async ()=> {
      const s=structuredClone(SET);s.openaiKey='synthetic-openai';s.rapidapiKey='synthetic-rapid';s.rapidapiMode='primary';
      s.styles.push({id:'custom',name:'Kurztest',prompt:'Antworte exakt mit einem Satz.',outputLanguage:'Deutsch',isBuiltIn:false});s.activeStyleId='custom';
      await chrome.storage.local.set({lmaa_settings:s,lmaa_briefings:[]});
    });
    await page.reload();
    await page.getByText('Aktiver Stil: Kurztest').waitFor();
    let captionGate=null, modelGate=null, requests=[], failChat=false, longSource=false;
    await context.route('https://www.youtube.com/oembed**', route=>route.fulfill({json:{title:'Synthetisches Video',author_name:'Testkanal'}}));
    await context.route('https://youtube-transcripts.p.rapidapi.com/**', async route=> {
      if(captionGate) await captionGate;
      await route.fulfill({json:{transcript:longSource ? 'Synthetischer Satz. '.repeat(5000) : '[00:00:01] Nur synthetische Quelle.'}});
    });
    await context.route('https://api.openai.com/v1/responses', async route=> {
      const payload=route.request().postDataJSON();requests.push(payload);
      if(modelGate) await modelGate;
      if (Array.isArray(payload.input) && failChat) { failChat=false; return route.fulfill({status:429,json:{error:{code:'rate_limit_exceeded'}}}); }
      const chat = Array.isArray(payload.input);
      assert.deepEqual(payload.tools, chat ? [{type:'web_search'}] : []);
      if (chat) assert.equal(payload.tool_choice, 'auto');
      const annotations = chat ? [{type:'url_citation',end_index:26,url:'https://example.org/quelle'}] : [];
      await route.fulfill({json:{output:[{type:'message',content:[{type:'output_text',annotations,text:chat?'Eine synthetische Antwort.':'# Synthetisches Briefing\n[12:34] Ein Satz.'}]}]}});
    });
    // Focus before any generation: no provider call until submit.
    await page.locator('#ytUrl').fill('https://youtu.be/abcdefghijk');
    await page.locator('#focusedBtn').click();
    await page.locator('#focusInput').fill('Nur XYZ behandeln.');
    assert.equal(requests.length,0);
    await page.locator('#focusSubmit').click();
    await page.locator('#view-detail').waitFor({state:'visible'});
    assert.match(requests[0].instructions,/Nur XYZ behandeln/);
    assert.match(requests[0].instructions,/Antworte exakt mit einem Satz/);
    assert.equal(await page.locator('#detailContent a').getAttribute('href'),'https://www.youtube.com/watch?v=abcdefghijk&t=754s');
    await page.locator('#chatInput').fill('Was bedeutet das?');
    await page.locator('#chatSend').click();
    await page.locator('#chatMessages').getByText('Eine synthetische Antwort.').waitFor();
    assert.equal(await page.locator('#chatMessages a').getAttribute('href'),'https://example.org/quelle');
    assert.equal(requests[1].input.at(-1).content,'Was bedeutet das?');
    assert.equal(await page.locator('#chatRetry').isVisible(), false);
    assert.match(requests[1].input[0].content,/Nur synthetische Quelle/);
    const firstId=await page.evaluate(()=>currentBriefing.id);
    await page.reload();
    const search=page.getByLabel('Titel oder Kanal suchen');
    const entries=page.locator('#historyList .history-item');
    const fullCount=await entries.count();
    assert.ok(fullCount>0);
    for (const term of ['SYNTHETISCHES','TESTKANAL']) {
      await search.fill(term); assert.equal(await entries.count(),fullCount);
    }
    await search.fill('kein-passendes-briefing'); assert.equal(await entries.count(),0);
    await search.fill(''); assert.equal(await entries.count(),fullCount);
    await page.locator('[data-action="open"]').first().click();
    await page.locator('#chatMessages').getByText('Eine synthetische Antwort.').waitFor();
    // Pause during transcript fetch; the regular model request must never start.
    await page.evaluate(()=>showHome());
    await page.locator('#ytUrl').fill('https://youtu.be/12345678901');
    let releaseCaption; captionGate=new Promise(r=>releaseCaption=r);
    await page.locator('#analyzeBtn').click();
    await page.waitForFunction(()=>activeJob?.phase==='fetching');
    await page.locator('#focusedBtn').click();
    releaseCaption(); captionGate=null;
    await page.waitForFunction(()=>activeJob?.resume!==undefined);
    assert.equal(requests.length,2);
    await page.locator('#focusInput').fill('Nur zweites Thema.');
    await page.locator('#focusSubmit').click();
    await page.locator('#view-detail').waitFor({state:'visible'});
    assert.equal(requests.length,3);
    // Late focus preserves regular result and creates a distinct focused briefing.
    await page.evaluate(()=>showHome());
    await page.locator('#ytUrl').fill('https://youtu.be/98765432109');
    let releaseModel; modelGate=new Promise(r=>releaseModel=r);
    await page.locator('#analyzeBtn').click();
    await page.waitForFunction(()=>activeJob?.phase==='generating');
    await page.locator('#focusedBtn').click();
    await page.locator('#focusInput').fill('Nur spätes Thema.');
    await page.locator('#focusSubmit').click();
    releaseModel(); modelGate=null;
    await page.waitForFunction(()=>BRIEFINGS.filter(b=>b.videoId==='98765432109').length===2);
    assert.equal(await page.evaluate(()=>BRIEFINGS.length),4);
    // Per-briefing isolation and persisted transfer.
    await page.evaluate(()=>openBriefing(BRIEFINGS.find(b=>b.videoId==='12345678901').id));
    assert.equal(await page.locator('#chatMessages section').count(),0);
    await page.locator('#manageBtn').click();
    const downloadPromise=page.waitForEvent('download');
    await page.locator('#exportHistory').click();
    const download=await downloadPromise;
    await download.saveAs(path.join(work, 'browser-archive.json'));
    const archive=JSON.parse(await fs.readFile(path.join(work, 'browser-archive.json'),'utf8'));
    assert.equal(archive.briefings.length,4);
    const exportedMessages = archive.briefings.find(b=>b.id===firstId).messages;
    assert.equal(exportedMessages.length,2);
    assert.match(exportedMessages[1].content,/\[Quelle: example\.org\]\(https:\/\/example\.org\/quelle\)/);
    assert.ok(!JSON.stringify(archive).includes('synthetic-openai'));
    await page.locator('#importHistory').setInputFiles(path.join(work, 'browser-archive.json'));
    await page.getByText('Import abgeschlossen. Neue Briefings: 0 · Neue Chatnachrichten: 0').waitFor();
    assert.equal(await page.evaluate(()=>BRIEFINGS.length),4);
    await page.locator('#manageClose').click();
    await page.evaluate(id=>openBriefing(id),firstId);
    assert.equal(await page.locator('#chatMessages a').getAttribute('href'),'https://example.org/quelle');
    await page.screenshot({path:path.join(work, 'extension-chat.png'),fullPage:true});
    // Failed chat requests remain retryable after reload, without duplicating the question.
    failChat=true;
    await page.locator('#chatInput').fill('Zweite Frage nach einem Fehler?');
    await page.locator('#chatSend').click();
    await page.locator('#chatStatus').getByText('Antwort fehlgeschlagen: OpenAI HTTP 429').waitFor();
    await page.reload();
    await page.getByText('Aktiver Stil: Kurztest').waitFor();
    await page.evaluate(id=>openBriefing(id),firstId);
    await page.locator('#chatRetry').click();
    await page.waitForFunction(id=>BRIEFINGS.find(b=>b.id===id).messages.length===4,firstId);
    assert.equal(await page.locator('#chatRetry').isVisible(),false);
    // Persisted interrupted jobs resume with their original style snapshot and stable result ID.
    await page.evaluate(async()=> {
      await chrome.storage.local.set({lmaa_job_recovery: {id:'recovery', url:'https://youtu.be/zyxwvutsrqp', question:'Wiederaufnahme',
        style:{name:'Snapshot',prompt:'Alte gespeicherte Anweisung.',outputLanguage:'Deutsch'},ts:1}});
      showHome(); await renderRecovery();
    });
    await page.getByText('Unterbrochene Analyse fortsetzen (Snapshot)',{exact:true}).click();
    await page.waitForFunction(()=>BRIEFINGS.some(b=>b.id==='recovery'));
    assert.match(requests.at(-1).instructions,/Alte gespeicherte Anweisung/);
    // Long briefing generation uses style-aware chunks; chat never uses this reduction.
    longSource=true;
    const countBefore=requests.length;
    await page.evaluate(()=>showHome());
    await page.locator('#ytUrl').fill('https://youtu.be/longtest001');
    await page.locator('#analyzeBtn').click();
    await page.waitForFunction(()=>BRIEFINGS.some(b=>b.videoId==='longtest001'));
    assert.equal(requests.length-countBefore,3);
    assert.ok(requests.slice(countBefore).every(r=>r.instructions.includes('Antworte exakt mit einem Satz')));
    assert.equal(await page.evaluate(()=>BRIEFINGS.find(b=>b.videoId==='longtest001').transcript.content.length)>80000,true);
    await page.setViewportSize({width:390,height:844});
    await page.emulateMedia({colorScheme:'dark'});
    await page.screenshot({path:path.join(work,'extension-mobile-dark.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
    console.log('PASS: focus before/during/after generation, custom style, timestamps, chat/source/persistence/isolation, export/import deduplication, failed-chat retry, interrupted-job recovery, long-source chunking, mobile dark layout; no page errors.');
  } finally { await context.close(); await fs.rm(profile, { recursive: true, force: true }); }
})().catch(e=>{console.error(e);process.exit(1)});
