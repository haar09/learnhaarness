// Run against an isolated local app: LH_DATA_DIR=/tmp/lh-mobile-data next dev -p 3100
// LH_MOBILE_TEST_URL=http://127.0.0.1:3100 node tests/browser/mobile-layout.mjs
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const url = process.env.LH_MOBILE_TEST_URL || 'http://127.0.0.1:3100';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname), 'Use an isolated local profile: this test creates an empty chat.');
const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
 const page = await browser.newPage();
 const waitClosed = () => page.waitForFunction(() => document.querySelector('#session-sidebar')?.getBoundingClientRect().width === 0);
 const checkWidth = async width => {
  const dimensions = await page.evaluate(() => ({viewport: innerWidth, scroll: document.documentElement.scrollWidth, content: document.querySelector('[data-testid="file-path-drop-zone"]').getBoundingClientRect().width}));
  assert.equal(dimensions.viewport, width);
  assert.ok(dimensions.scroll <= width + 1, 'No horizontal page overflow');
  assert.ok(dimensions.content >= width - 1, 'Sidebar must not squeeze the content');
 };
 for (const width of [320, 360, 412, 768]) {
  await page.setViewport({width, height: 860, isMobile: true, hasTouch: true});
  await page.goto(url, {waitUntil: 'networkidle2', timeout: 180000});
  await page.evaluate(() => localStorage.setItem('lh:sidebar-open', '1'));
  await page.reload({waitUntil: 'networkidle2', timeout: 180000});
  await waitClosed(); await checkWidth(width);
  assert.ok(await page.$$eval('.lh-graph-toolbar button', buttons => buttons.every(button => { const r=button.getBoundingClientRect(); return r.left >= 52 && r.right <= innerWidth; })), 'Graph actions stay clear of navigation and inside the screen');
  await page.click('[aria-label="Open sidebar"]');
  await page.waitForFunction(() => document.querySelector('#session-sidebar')?.getBoundingClientRect().width >= 270);
  await checkWidth(width);
  assert.ok(await page.$eval('[aria-label="Close sidebar"]', button => {const r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}), 'Close button must be above Chains and hit-testable');
  assert.equal(await page.$eval('[data-testid="file-path-drop-zone"]', e=>e.inert), true);
  if(width === 412) {
   await page.screenshot({path:'/tmp/lh-mobile-sidebar-open.png'});
   await page.setViewport({width,height:520,isMobile:true,hasTouch:true});
   assert.equal(await page.$eval('#session-sidebar',e=>e.getAttribute('aria-hidden')), 'false', 'Keyboard height changes must not dismiss navigation');
   await page.setViewport({width,height:860,isMobile:true,hasTouch:true});
  }
  await page.click('[aria-label="Close sidebar"]'); await waitClosed();
  assert.equal(await page.$eval('[data-testid="file-path-drop-zone"]', e=>e.inert), false);
  await page.click('[aria-label="Open sidebar"]');
  await page.keyboard.press('Escape'); await waitClosed();
  await page.click('[aria-label="Open sidebar"]');
  await page.waitForFunction(() => document.querySelector('#session-sidebar')?.getBoundingClientRect().width >= 270);
  await page.mouse.click(width-12, 400); await waitClosed();
  // A mobile dismissal does not overwrite the desktop navigation preference.
  assert.equal(await page.evaluate(()=>localStorage.getItem('lh:sidebar-open')), '1');
  const composer = await page.$('[contenteditable="true"], textarea');
  assert.ok(composer && (await composer.boundingBox()).width >= Math.min(width, 736)-160, 'Composer retains a usable width');
 }
 const { chatId, folderId } = await page.evaluate(async () => {
  const post = async (path, data) => {
   const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
   if (!response.ok) throw new Error(`Fixture request failed for ${path} (${response.status})`);
   return response.json();
  };
  const { id: chatId } = await post('/api/chats', { title: 'Mobile layout verification' });
  const { createdFolderId: folderId } = await post('/api/graph/sources', { action: 'create-folder', name: 'Mobile test folder', parentId: null });
  await post('/api/graph/sources', { action: 'move', kind: 'source', id: chatId, parentId: folderId });
  return { chatId, folderId };
 });
 await page.setViewport({width:412,height:860,isMobile:true,hasTouch:true});
 await page.goto(`${url}/chat/${chatId}`,{waitUntil:'networkidle2',timeout:180000});
 await waitClosed(); await checkWidth(412);
 await page.click('[aria-label="Open sidebar"]');
 await page.waitForFunction(()=>document.querySelector('#session-sidebar')?.getBoundingClientRect().width >= 270);
 await checkWidth(412);
 await page.click('[aria-label="Close sidebar"]'); await waitClosed();
 await page.screenshot({path:'/tmp/lh-mobile-chat.png'});
 await page.click('[aria-label="Open sidebar"]');
 await page.waitForFunction(()=>document.querySelector('#session-sidebar')?.getBoundingClientRect().width >= 270);
 const folder = `[data-testid="sidebar-folder-${folderId}"]`;
 const session = `[data-testid="sidebar-folder-branch-${folderId}"] button[data-session-id="${chatId}"]`;
 await page.waitForSelector(folder, { visible: true });
 await page.click(folder);
 await page.waitForSelector(session, { visible: true });
 await page.click(session);
 await waitClosed();
 assert.equal(new URL(page.url()).pathname, `/chat/${chatId}`, 'Selecting the current session closes the drawer without leaving the chat');
 await page.click('[aria-label="Open sidebar"]');
 await page.waitForFunction(() => document.querySelector('#session-sidebar')?.getBoundingClientRect().width >= 270);
 await page.click('#session-sidebar a[aria-label="Home"]');
 await page.waitForFunction(()=>location.pathname === '/'); await waitClosed();
 await page.setViewport({width:1280,height:900});
 await page.waitForFunction(()=>document.querySelector('#session-sidebar')?.getBoundingClientRect().width === 288);
 assert.equal(await page.$eval('[data-testid="file-path-drop-zone"]',e=>e.getBoundingClientRect().width), 992, 'Desktop sidebar remains inline');
 await page.click('[aria-label="Close sidebar"]'); await waitClosed();
 console.log('PASS: 320/360/412/768px home, overlay hit-testing/close/backdrop/Escape, mobile chat and current session in a folder, 1280px desktop.');
} finally { await browser.close(); }
