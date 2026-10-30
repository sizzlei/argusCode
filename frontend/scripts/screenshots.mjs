// Regenerates the screenshots used on the GitHub Pages docs (docs/assets/screenshots).
//   npm run screenshots
// Starts the Vite dev server (browser mock backend with demo files) and drives
// it with Playwright (`npm i -D playwright && npx playwright install chromium`
// if it is not installed yet).

import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../../docs/assets/screenshots/', import.meta.url));
mkdirSync(out, { recursive: true });

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    ({ chromium } = createRequire(import.meta.url)('playwright')); // global install (NODE_PATH)
  } catch {
    chromium = null;
  }
}
if (!chromium) {
  console.error('playwright가 없습니다: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { port: 5199, strictPort: false },
  logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 760 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
page.on('pageerror', (e) => console.error('page error:', e.message));
const wait = (ms) => page.waitForTimeout(ms);
const shot = async (name, clip, keepMouse = false) => {
  if (!keepMouse) {
    await page.mouse.move(1270, 5); // no hover effects / tooltips
    await wait(300);
  }
  await page.screenshot({ path: out + name, clip });
  console.log('wrote', name);
};
const openTree = async (label) => {
  await page.click(`.row:has-text("${label}")`);
  await wait(300);
};
const clickRow = async (label) => {
  await page.click(`.row .row-name:text-is("${label}")`);
  await wait(900);
};

await page.goto(url);
await wait(1200);

// 1. overview — explorer, split editors, table hover from the folder's DDL
await openTree('sql');
await openTree('docs');
await clickRow('orders.sql');
await page.keyboard.press('Control+\\');
await wait(500);
await clickRow('ddl.sql');
await page.click('.group >> nth=0 >> .cm-content');
await wait(300);
const word = await page.evaluate(() => {
  const root = document.querySelectorAll('.group')[0].querySelector('.cm-content');
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) {
    const i = n.textContent.indexOf('orders');
    if (i >= 0 && /FROM/i.test(n.parentElement.closest('.cm-line').textContent)) {
      const r = document.createRange();
      r.setStart(n, i + 2);
      r.setEnd(n, i + 3);
      const b = r.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
  }
});
await page.mouse.move(word.x, word.y);
await wait(1200);
await shot('overview.png', undefined, true);
await page.mouse.move(1270, 5);
await page.keyboard.press('Control+w'); // close the split's ddl.sql tab
await wait(300);

// 2. execution plan panel (sidebar hidden so every column fits)
await clickRow('explain_tree.txt');
await page.keyboard.press('Control+Alt+E');
await page.keyboard.press('Control+B');
await wait(1500);
await shot('plan.png');
await page.keyboard.press('Control+Alt+E');
await page.keyboard.press('Control+B');
await wait(300);

// 3. settings > DDL 검토 with the demo ruleset
await page.keyboard.press('Control+,');
await wait(300);
await page.click('.set-nav-item:has-text("DDL 검토")');
await page.fill('.set-text.set-wide', '/demo/rules/ddl-rules.yaml');
await page.dispatchEvent('.set-text.set-wide', 'change');
await wait(1200);
const box = await page.locator('.modal.settings').boundingBox();
await shot('settings-ddl.png', { x: box.x - 1, y: box.y - 1, width: box.width + 2, height: box.height + 2 });
await page.keyboard.press('Escape');
await wait(300);

// 4. DDL review panel
await openTree('migration');
await clickRow('V2026_11__coupon.sql');
await wait(1500);
await page.keyboard.press('Control+Shift+M');
await wait(1500);
await shot('ddl-review.png');

await page.keyboard.press('Control+Shift+M'); // close the review panel

// 5. deadlock report (same panel as the plan, sidebar hidden)
await openTree('sql');
await clickRow('deadlock.txt');
await page.keyboard.press('Control+B');
await page.keyboard.press('Control+Alt+E');
await wait(1500);
await shot('deadlock.png');
await page.keyboard.press('Control+Alt+E');
await page.keyboard.press('Control+B');

await browser.close();
await server.close();
