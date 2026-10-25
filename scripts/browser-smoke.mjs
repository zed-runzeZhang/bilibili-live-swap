import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const live = process.argv.includes('--live');
const extensionPath = resolve('dist');
await mkdir('artifacts', { recursive: true });
const profile = await mkdtemp(resolve('artifacts', live ? 'live-profile-' : 'fixture-profile-'));
const cliExtensionArgs = process.env.BILI_SWAP_BROWSER_CHANNEL === 'chrome' ? [] : [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`];
const context = await chromium.launchPersistentContext(profile, {
  channel: process.env.BILI_SWAP_BROWSER_CHANNEL || 'chromium', headless: true, viewport: { width: 1280, height: 900 },
  proxy: process.env.BILI_SWAP_PROXY ? {server: process.env.BILI_SWAP_PROXY} : undefined,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [...cliExtensionArgs, '--enable-unsafe-extension-debugging', '--mute-audio', '--autoplay-policy=no-user-gesture-required']
});

// Exercise actual audio/video tracks without external files or a running server.
const mediaScript = `
  const canvas=document.createElement('canvas'); canvas.width=1280; canvas.height=720;
  const ctx=canvas.getContext('2d');
  let frame=0;
  const render=()=>{ctx.fillStyle=SOURCE?'#982637':'#173d89';ctx.fillRect(0,0,1280,720);ctx.fillStyle='white';ctx.font='48px sans-serif';ctx.fillText(SOURCE?'A source picture (silent)':'B original picture',80,330);ctx.fillText(String(++frame),80,410);};
  render();setInterval(render,100);
  const audio=new AudioContext();const oscillator=audio.createOscillator();const destination=audio.createMediaStreamDestination();oscillator.connect(destination);oscillator.start();audio.resume();
  const stream=canvas.captureStream(10);stream.addTrack(destination.stream.getAudioTracks()[0]);
  const video=document.querySelector('video');video.srcObject=stream;video.muted=false;video.volume=.6;video.play();
`;
const targetHtml = `<!doctype html><meta charset="utf-8"><style>
body{font:20px sans-serif;background:#eee;margin:40px}#live-player{position:relative;width:960px;height:540px;background:black}
video{position:absolute;inset:0;width:100%;height:100%;z-index:1}.web-player-danmaku{position:absolute;inset:0;z-index:10;pointer-events:none;color:white;text-shadow:1px 1px black;padding:30px;box-sizing:border-box}
button{position:absolute;bottom:12px;left:12px;z-index:20}input{margin:20px}
</style><h1>B live room</h1><div id="live-player"><video autoplay playsinline></video><div class="web-player-danmaku">B DANMAKU — stays above A</div><button id="control">B control</button></div><input id="chat" placeholder="B chat"><script>const SOURCE=false;${mediaScript}document.querySelector('#control').onclick=()=>document.querySelector('#control').textContent='B control clicked';</script>`;
const sourceHtml = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}#player_container{height:100%;background:black}video{width:100%;height:100%}</style><div class="player-left-container"><div id="player_container"><div style="height:100%;position:relative"><video autoplay playsinline></video><div class="web-player-danmaku">A unwanted overlay</div></div></div></div><script>const SOURCE=true;${mediaScript}</script>`;

try {
  let loadedExtensionId;
  if (process.env.BILI_SWAP_BROWSER_CHANNEL === 'chrome') {
    const session = await context.browser().newBrowserCDPSession();
    const loaded = await session.send('Extensions.loadUnpacked', { path: extensionPath });
    loadedExtensionId = loaded.id;
    console.log('Loaded unpacked extension', loaded);
    await session.detach();
  }
  if (!live) {
    await context.route('https://live.bilibili.com/7777', route => route.fulfill({contentType:'text/html',body:targetHtml}));
    await context.route('https://www.bilibili.com/blackboard/live/live-activity-player.html*', route => route.fulfill({contentType:'text/html',body:sourceHtml}));
    await context.route('https://api.live.bilibili.com/room/v1/Room/room_init*', route => route.fulfill({json:{code:0,data:{room_id:7734200,live_status:1,is_hidden:false,is_locked:false}}}));
  }
  const extensionId = loadedExtensionId || new URL((context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')).url()).host;
  const target = await context.newPage();
  await target.goto('https://live.bilibili.com/7777', { waitUntil: 'domcontentloaded', timeout:60_000 });
  await target.waitForSelector('#live-player > video', {timeout:60_000});
  await target.waitForFunction(() => document.querySelector('#live-player > video')?.currentTime > 0, undefined, {timeout:60_000});
  await target.evaluate(() => {
    const video=document.querySelector('#live-player > video');
    video.muted=false;video.volume=.6;
    window.__originalB=video;
    window.__originalBSource=video.currentSrc;
  });
  await target.bringToFront();
  const browserSession = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', {filter:[{type:'tab',exclude:false}]});
  const tabTarget = targetInfos.find(info => info.url === target.url());
  assert.ok(tabTarget, `B tab target found: ${JSON.stringify(targetInfos)}`);
  // This grants activeTab exactly as clicking the real extension action does.
  await browserSession.send('Extensions.triggerAction', {id:extensionId,targetId:tabTarget.targetId});
  // Headless Chrome does not expose the toolbar bubble as a Playwright page.
  const popup=await context.newPage();
  await target.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await browserSession.detach();
  await popup.locator('#source-room').waitFor();
  await popup.waitForFunction(() => !document.querySelector('#source-room').disabled);
  await popup.locator('#source-room').fill('6');
  await popup.locator('#enable-button').click();
  await popup.waitForFunction(() => ['playing','error'].includes(document.querySelector('[data-popup-root]').dataset.phase), undefined, {timeout:60_000});
  assert.equal(await popup.locator('[data-popup-root]').getAttribute('data-phase'),'playing',await popup.locator('#status-message').textContent());
  const frame=target.frames().find(f=>f.url().includes('bili_swap_token'));
  assert.ok(frame, 'A frame exists');
  const sourceBefore=await frame.evaluate(() => {
    const video=document.querySelector('video');
    video.muted=false;video.volume=1;video.defaultMuted=false;
    return {muted:video.muted,volume:video.volume,defaultMuted:video.defaultMuted,time:video.currentTime,width:video.videoWidth,paused:video.paused};
  });
  assert.equal(sourceBefore.muted,true); assert.equal(sourceBefore.volume,0); assert.equal(sourceBefore.defaultMuted,true);
  assert.ok(sourceBefore.width>0); assert.equal(sourceBefore.paused,false);
  const targetState=await target.evaluate(() => {
    const video=window.__originalB; const frame=document.querySelector('iframe[data-bili-swap]');
    return {sameVideo:video===document.querySelector('#live-player > video'),sameSource:video.currentSrc===window.__originalBSource,
      muted:video.muted,volume:video.volume,paused:video.paused,time:video.currentTime,opacity:frame.style.opacity,z:Number(getComputedStyle(frame).zIndex),danmakuZ:Number(getComputedStyle(document.querySelector('#live-player > .web-player-danmaku')).zIndex),pointerEvents:getComputedStyle(frame).pointerEvents};
  });
  assert.equal(targetState.sameVideo,true); assert.equal(targetState.sameSource,true);
  assert.equal(targetState.muted,false); assert.equal(targetState.volume,.6); assert.equal(targetState.paused,false);
  assert.equal(targetState.opacity,'1'); assert.ok(targetState.z<targetState.danmakuZ); assert.equal(targetState.pointerEvents,'none');
  const sourceAfter=await frame.waitForFunction(time => document.querySelector('video').currentTime>time,sourceBefore.time,{timeout:10_000});
  await sourceAfter.dispose();
  await target.waitForFunction(time => window.__originalB.currentTime>time,targetState.time,{timeout:10_000});
  if (!live) {
    await target.locator('#chat').fill('B interaction still works');
    await target.locator('#control').click();
    assert.equal(await target.locator('#control').textContent(),'B control clicked');
  }
  await target.screenshot({path:`artifacts/${live?'live':'fixture'}-playing.png`});
  await popup.screenshot({path:`artifacts/${live?'live':'fixture'}-popup.png`});
  await popup.locator('#retry-button').click();
  await popup.waitForFunction(() => ['playing','error'].includes(document.querySelector('[data-popup-root]').dataset.phase),undefined,{timeout:60_000});
  assert.equal(await popup.locator('[data-popup-root]').getAttribute('data-phase'),'playing',await popup.locator('#status-message').textContent());
  await popup.locator('#disable-button').click();
  await target.waitForFunction(() => !document.querySelector('iframe[data-bili-swap]'));
  assert.equal(await target.evaluate(() => document.querySelector('#live-player > video')===window.__originalB),true);
  await target.reload({waitUntil:'domcontentloaded'});
  assert.equal(await target.locator('iframe[data-bili-swap]').count(),0);
  const report={mode:live?'live':'fixture',passed:true,sourceBefore,targetState,checks:['real unpacked MV3 injection','source 6 resolution','popup enable/retry/disable','source silence against unmute/volume writes','both media clocks advance','B video/source/audio flags unchanged','A layer below B danmaku','refresh resets'],at:new Date().toISOString()};
  await writeFile(`artifacts/${live?'live':'fixture'}-report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  for(const page of context.pages()) console.error('PAGE',page.url(),(await page.locator('#status-message').textContent({timeout:500}).catch(()=>'')));
  throw error;
} finally { await context.close(); }
