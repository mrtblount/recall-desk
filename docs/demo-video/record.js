const PW = '/Users/tonyblount/.npm/_npx/86170c4cd1c5da32/node_modules/playwright-core';
const { chromium } = require(PW);
const fs = require('fs');
const path = require('path');
const V = __dirname;
const SITE = 'https://tremendous-bullfrog-311.convex.site/';
const DEMO = 'recalldesk-demo@agentmail.to';
const SENDER = 'tony-0143@agentmail.to';
const KEY = process.env.AGENTMAIL_API_KEY;
const HEIC = '/Users/tonyblount/Downloads/IMG_7178.HEIC';
const dur = JSON.parse(fs.readFileSync(path.join(V, 'durations.json'), 'utf8'));
const seeded = JSON.parse(fs.readFileSync(path.join(V, 'seeded.json'), 'utf8'));
if (!KEY) throw new Error('AGENTMAIL_API_KEY missing');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marks = [];
let t0 = 0;
const now = () => (Date.now() - t0) / 1000;
function mark(seg) { marks.push({ seg, t: now() }); console.log(`mark ${seg} @ ${now().toFixed(2)}s`); }
async function holdUntil(t) { const ms = (t - now()) * 1000; if (ms > 0) await sleep(ms); }

const CURSOR = `
(() => {
  if (window.__cur) return;
  const d = document.createElement('div');
  d.id = '__cursor';
  d.style.cssText = 'position:fixed;left:-100px;top:-100px;width:22px;height:22px;border-radius:50%;background:rgba(242,75,35,.92);border:3px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);transition:transform .12s ease';
  document.documentElement.appendChild(d);
  window.__cur = d;
  window.addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  window.addEventListener('mousedown', () => { d.style.transform = 'translate(-50%,-50%) scale(.7)'; }, true);
  window.addEventListener('mouseup', () => { d.style.transform = 'translate(-50%,-50%) scale(1)'; }, true);
})();`;

let page; let context;
let mouse = { x: 960, y: 540 };
async function glide(x, y, steps = 28) { await page.mouse.move(x, y, { steps }); mouse = { x, y }; }
async function smoothClick(locator, opts = {}) {
  await locator.first().scrollIntoViewIfNeeded();
  await sleep(150);
  const box = await locator.first().boundingBox();
  if (!box) throw new Error('no box for click target');
  const x = box.x + box.width * (opts.fx ?? 0.5), y = box.y + box.height * (opts.fy ?? 0.5);
  await glide(x, y);
  await sleep(180);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
}
async function smoothScrollTo(y, ms = 1800) {
  await page.evaluate(([y]) => new Promise((res) => {
    const start = window.scrollY, dist = y - start, t0 = performance.now();
    const ease = (t) => t < .5 ? 2*t*t : -1+(4-2*t)*t;
    function step(t) { const p = Math.min(1, (t - t0) / MS); window.scrollTo(0, start + dist * ease(p)); if (p < 1) requestAnimationFrame(step); else res(); }
    requestAnimationFrame(step);
  }), [y]);
}
async function am(pathname, init) {
  const r = await fetch('https://api.agentmail.to/v0' + pathname, { ...init, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  if (!r.ok) throw new Error(`AgentMail ${pathname} ${r.status}: ${txt.slice(0, 200)}`);
  return j;
}
async function waitForCode(sinceIso) {
  for (let i = 0; i < 40; i++) {
    const j = await am(`/inboxes/${encodeURIComponent(DEMO)}/messages?limit=3`);
    const msgs = j.messages || j.data || [];
    for (const m of msgs) {
      const c = (m.subject || '').match(/^(\d{8}) is your Recall Desk/);
      if (c && (m.timestamp || m.created_at) >= sinceIso) return c[1];
    }
    await sleep(1500);
  }
  throw new Error('OTP not received');
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Users/tonyblount/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
  context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
    recordVideo: { dir: path.join(V, 'raw'), size: { width: 1920, height: 1080 } },
    reducedMotion: 'no-preference',
  });
  await context.addInitScript(CURSOR);
  page = await context.newPage();
  t0 = Date.now();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text().slice(0, 160)); });

  // ---- S1: intro card, then the hero while narration continues
  await page.goto('file://' + path.join(V, 'cards', 'intro.html'));
  mark(1);
  await holdUntil(4.6);
  await page.goto(SITE + '?rec=1', { waitUntil: 'networkidle' });
  await page.evaluate(CURSOR);
  await glide(1200, 620, 10);
  const s1end = marks[0].t + dur[1] + 0.6;
  await holdUntil(s1end);

  // ---- S2: down to the board
  mark(2);
  await page.evaluate(() => { window.MS = 2200; });
  await page.evaluate(([y]) => new Promise((res) => { const start = window.scrollY, dist = y - start, t0 = performance.now(); const ease = (t) => t < .5 ? 2*t*t : -1+(4-2*t)*t; function step(t) { const p = Math.min(1, (t - t0) / 2200); window.scrollTo(0, start + dist * ease(p)); if (p < 1) requestAnimationFrame(step); else res(); } requestAnimationFrame(step); }), [await page.evaluate(() => document.querySelector('#recalls')?.getBoundingClientRect().top + window.scrollY - 40 || 900)]);
  await sleep(2500);
  await page.evaluate(() => new Promise((res) => { const start = window.scrollY, dist = 520, t0 = performance.now(); function step(t) { const p = Math.min(1, (t - t0) / 3500); window.scrollTo(0, start + dist * p); if (p < 1) requestAnimationFrame(step); else res(); } requestAnimationFrame(step); }));
  await holdUntil(marks[1].t + dur[2] + 0.5);

  // ---- S3: search + detail
  mark(3);
  await page.evaluate(() => new Promise((res) => { const start = window.scrollY, dist = -520, t0 = performance.now(); function step(t) { const p = Math.min(1, (t - t0) / 900); window.scrollTo(0, start + dist * p); if (p < 1) requestAnimationFrame(step); else res(); } requestAnimationFrame(step); }));
  const search = page.getByRole('searchbox');
  await smoothClick(search);
  await search.pressSequentially('ladder', { delay: 95 });
  await sleep(1800);
  const card = page.getByRole('button', { name: /Louisville Ladder/i }).first();
  await smoothClick(card);
  await sleep(600);
  await holdUntil(marks[2].t + dur[3] + 1.2);
  await page.keyboard.press('Escape');
  await sleep(500);

  // ---- S4: sign in as a brand-new account
  const getStarted = page.getByRole('banner').getByRole('button', { name: /Get started/i });
  await smoothClick(getStarted);
  await sleep(700);
  await smoothClick(page.getByRole('button', { name: /Create my desk/i }));
  await sleep(900);
  const email = page.getByRole('textbox', { name: /Email address/i });
  await smoothClick(email);
  await email.pressSequentially(DEMO, { delay: 55 });
  await sleep(400);
  const since = new Date(Date.now() - 2000).toISOString();
  mark(4);
  await smoothClick(page.getByRole('button', { name: /Email me a code/i }));
  await page.getByText(/We sent an 8-digit code/i).waitFor({ timeout: 30000 });
  const code = await waitForCode(since);
  await sleep(600);
  const codeBox = page.getByRole('textbox', { name: /Sign-in code/i });
  await smoothClick(codeBox);
  await codeBox.fill(''); await codeBox.pressSequentially(code, { delay: 110 });
  await sleep(300);
  await codeBox.press('Enter');
  await Promise.race([
    page.getByText(/Signed in/i).first().waitFor({ timeout: 30000 }),
    page.getByText(/didn't match/i).first().waitFor({ timeout: 30000 }).then(() => { throw new Error('code rejected'); }),
  ]);
  await sleep(1200);
  await holdUntil(marks[3].t + dur[4] + 0.5);

  // ---- S5: photo upload (HEIC)
  const fileInput = page.locator('input[type=file]').first();
  const drop = page.getByText(/Take a photo or choose from your/i).first();
  await glide((await drop.boundingBox()).x + 200, (await drop.boundingBox()).y + 60);
  mark(5);
  await fileInput.setInputFiles(HEIC);
  await page.getByText(/rubber mallet/i).first().waitFor({ timeout: 90000 });
  await sleep(800);
  await page.evaluate(() => new Promise((res) => { const el = [...document.querySelectorAll('*')].find((e) => /WATCHED ITEMS/i.test(e.textContent || '') && e.children.length < 6 && (e.textContent||'').length < 60); const y = el ? el.getBoundingClientRect().top + window.scrollY - 120 : window.scrollY; const start = window.scrollY, dist = y - start, t0 = performance.now(); function step(t) { const p = Math.min(1, (t - t0) / 1400); window.scrollTo(0, start + dist * p); if (p < 1) requestAnimationFrame(step); else res(); } requestAnimationFrame(step); }));
  await holdUntil(marks[4].t + dur[5] + 0.6);

  // ---- S6: forward a receipt — live arrival
  const alias = await page.evaluate(() => (document.body.innerText.match(/recalldesk\+[a-z0-9]+@agentmail\.to/i) || [null])[0]);
  if (!alias) throw new Error('alias not found on desk');
  console.log('alias', alias);
  await page.evaluate(() => new Promise((res) => { const start = window.scrollY, t0 = performance.now(); function step(t) { const p = Math.min(1, (t - t0) / 900); window.scrollTo(0, start * (1 - p)); if (p < 1) requestAnimationFrame(step); else res(); } requestAnimationFrame(step); }));
  await sleep(300);
  mark(6);
  await am(`/inboxes/${encodeURIComponent(SENDER)}/messages/send`, { method: 'POST', body: JSON.stringify({ to: [alias], subject: seeded.subject, text: seeded.text, html: seeded.html }) });
  await page.getByText(/Elmo Silicone Teether/i).first().waitFor({ timeout: 90000 });
  console.log('items landed @', now().toFixed(1));
  await page.getByText(/Skip Hop Recalls Baby Sesame Street Elmo/i).first().waitFor({ timeout: 90000 });
  console.log('match landed @', now().toFixed(1));
  await holdUntil(marks[5].t + dur[6] + 0.4);

  // ---- S7: the matches
  mark(7);
  const matchesHead = page.getByText(/RECALL MATCHES/i).first();
  await matchesHead.scrollIntoViewIfNeeded();
  const mb = await page.getByText(/AI assessment/i).first().boundingBox();
  if (mb) await glide(mb.x + 300, mb.y + 10);
  await holdUntil(marks[6].t + dur[7] + 0.4);

  // ---- S8: remedy checklist
  mark(8);
  const remedyLink = page.getByRole('button', { name: /remedy checklist/i }).first();
  await smoothClick(remedyLink);
  await sleep(1500);
  await page.evaluate(() => { const d = document.querySelector('[role=dialog]'); if (d) { const sc = [...d.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 40) || d; let y = 0; const t0 = performance.now(); (function step(t) { const p = Math.min(1, (t - t0) / 7000); sc.scrollTop = 520 * p; if (p < 1) requestAnimationFrame(step); })(t0); } });
  await holdUntil(marks[7].t + dur[8] + 0.8);
  await page.keyboard.press('Escape');
  await sleep(600);

  // ---- S9: claim draft
  mark(9);
  const claimLink = page.getByRole('button', { name: /email a claim instead/i }).first();
  await smoothClick(claimLink);
  await page.getByRole('dialog').waitFor({ timeout: 20000 });
  await sleep(1000);
  const draftBtn = page.getByRole('dialog').getByRole('button', { name: /Draft my claim/i }).first();
  if (await draftBtn.count()) { await smoothClick(draftBtn); }
  await page.getByRole('dialog').getByRole('textbox').first().waitFor({ timeout: 60000 }).catch(() => {});
  await holdUntil(marks[8].t + dur[9] + 2.5);
  await page.keyboard.press('Escape');
  await sleep(400);

  // ---- S10: outro
  mark(10);
  await page.goto('file://' + path.join(V, 'cards', 'outro.html'));
  await holdUntil(marks[9].t + dur[10] + 1.5);

  fs.writeFileSync(path.join(V, 'marks.json'), JSON.stringify(marks, null, 2));
  const vid = page.video();
  await context.close();
  const p = await vid.path();
  console.log('video', p, 'total', now().toFixed(1));
  await browser.close();
})().catch(async (e) => { console.error('FAILED', e); try { await page.screenshot({ path: path.join(V, 'failure.png') }); console.error('page text:', (await page.evaluate(() => document.body.innerText)).slice(0, 1500)); } catch {} fs.writeFileSync(path.join(V, 'marks.json'), JSON.stringify(marks, null, 2)); try { await context.close(); } catch {} process.exit(1); });
