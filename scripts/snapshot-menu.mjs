#!/usr/bin/env node
/*
 * snapshot-menu.mjs — refresh data/menu.snapshot.json from Tania's Pizza's public
 * Toast online-ordering page (https://taniaspizza.toast.site/order).
 *
 * HOW TO RUN (from the repo root):
 *
 *   # one-time: download a Chromium build for Playwright (skipped automatically
 *   # if Google Chrome is installed; the script prefers channel "chrome")
 *   npx -y -p playwright@latest playwright install chromium
 *
 *   # capture the snapshot
 *   npx -y -p playwright@latest node scripts/snapshot-menu.mjs
 *
 * Playwright is deliberately NOT a dependency of this repo. `npx -p playwright`
 * installs it into npx's cache and puts that cache's node_modules/.bin on PATH;
 * this script finds the `playwright` package from there. Resolution order:
 *   1. $PLAYWRIGHT_MODULE (absolute path to a node_modules/playwright directory)
 *   2. a normal `import("playwright")` (e.g. a global/parent install)
 *   3. node_modules next to any `.../node_modules/.bin` directory on PATH (npx -p)
 *   4. ./node_modules/playwright relative to the current working directory
 *
 * What it does (read-only, like a customer browsing):
 *   - loads /order once (Toast is behind Cloudflare; plain curl gets 403, a real
 *     browser does not), reads the menu Toast server-renders into the page
 *     (window.__OO_STATE__) plus the item links/prices from the rendered cards;
 *   - opens the customization dialog of every item that has modifiers (clicks the
 *     card, reads Toast's own MenuItemDetails response, closes the dialog with
 *     Escape). It never clicks "Add to Cart"/quick-add and never visits cart or
 *     checkout URLs. It waits DELAY_MS (default 3000) between dialogs;
 *   - loads 3 random item URLs to verify item links resolve to the right item;
 *   - writes data/menu.snapshot.json and prints a summary.
 *
 * Env knobs: DELAY_MS (default 3000), MAX_DETAIL_ITEMS (default: all items with
 * modifiers), VERIFY_COUNT (default 3), HEADFUL=1 to watch the browser.
 * Nothing secret is read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ORDER_URL = 'https://taniaspizza.toast.site/order';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'menu.snapshot.json');
const DELAY_MS = Number(process.env.DELAY_MS ?? 3000);
const MAX_DETAIL_ITEMS = process.env.MAX_DETAIL_ITEMS ? Number(process.env.MAX_DETAIL_ITEMS) : Infinity;
const VERIFY_COUNT = Number(process.env.VERIFY_COUNT ?? 3);
const AGE_RESTRICTED = /\b(beer|wine|liquor|spirits?|vodka|whiske?y|tequila|hard cider|hard seltzer|tobacco|cigar|cigarette|vape|vapor|nicotine)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  const norm = (m) => (m.chromium ? m : m.default);
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  else {
    try {
      return norm(await import('playwright'));
    } catch {}
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir.endsWith(path.join('node_modules', '.bin'))) candidates.push(path.join(dir, '..', 'playwright'));
  }
  candidates.push(path.join(process.cwd(), 'node_modules', 'playwright'));
  for (const c of candidates) {
    try {
      const req = createRequire(path.join(c, 'package.json'));
      return norm(await import(pathToFileURL(req.resolve('playwright')).href));
    } catch {}
  }
  throw new Error('Could not find the "playwright" package. Run via: npx -y -p playwright@latest node scripts/snapshot-menu.mjs');
}

async function launch(chromium) {
  const opts = { headless: !process.env.HEADFUL, args: ['--disable-blink-features=AutomationControlled'] };
  try {
    return await chromium.launch({ ...opts, channel: 'chrome' });
  } catch {
    return await chromium.launch(opts);
  }
}

// Extract a `window.NAME = {...}` JSON blob from raw HTML by brace matching.
function extractWindowJson(html, name) {
  const at = html.indexOf(`window.${name}`);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  return null;
}

const parsePrice = (t) => {
  const m = t && t.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
};

function flattenModifierGroups(appliesTo, groups, prefix, out, oos) {
  for (const g of groups || []) {
    const name = prefix ? `${prefix} > ${g.name}` : g.name;
    const min = g.minSelections ?? null;
    out.push({
      appliesTo,
      name,
      required: min == null ? null : min > 0,
      min,
      max: g.maxSelections ?? null,
      options: (g.modifiers || []).map((m) => ({ name: m.name, price: m.price ?? null })),
    });
    for (const m of g.modifiers || []) {
      if (m.outOfStock) oos.add(`${name} > ${m.name}`);
      if (m.modifierGroups?.length) flattenModifierGroups(appliesTo, m.modifierGroups, `${name} > ${m.name}`, out, oos);
    }
  }
}

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${ap}`;
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await launch(chromium);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Detroit',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const warnings = [];
  let pageLoads = 0;

  // ---- 1. menu page -------------------------------------------------------
  // Retries transient network errors (DNS/offline) only; HTTP errors are not retried.
  const gotoWithRetry = async (url) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        pageLoads++;
        return r;
      } catch (e) {
        if (attempt >= 3 || !/net::ERR_/.test(e.message)) throw e;
        await sleep(DELAY_MS * 3);
      }
    }
  };
  const resp = await gotoWithRetry(ORDER_URL);
  if (!resp || resp.status() >= 400) throw new Error(`Toast /order returned HTTP ${resp && resp.status()} (Cloudflare block?)`);
  await page.waitForSelector('[data-testid="menu-item-card"]', { timeout: 45000 });
  await sleep(DELAY_MS);
  const capturedAt = new Date().toISOString();

  let state = await page.evaluate(() => window.__OO_STATE__ || null).catch(() => null);
  if (!state) state = extractWindowJson(await page.content(), '__OO_STATE__');
  if (!state) throw new Error('Could not read window.__OO_STATE__ from the page');
  const rq = state.ROOT_QUERY || {};
  const rqGet = (prefix) => rq[Object.keys(rq).find((k) => k.startsWith(prefix))];
  const deref = (v) => (v && v.__ref ? state[v.__ref] : v);
  const paginated = rqGet('paginatedMenuItems');
  const menus = (paginated?.menus || []).map(deref).filter(Boolean);
  const restaurant = rqGet('restaurantV2') || {};
  const menuQueryKey = Object.keys(rq).find((k) => k.startsWith('paginatedMenuItems')) || '';
  const menuDateTime = (menuQueryKey.match(/"dateTime":"([^"]+)"/) || [])[1] || null;

  // Rendered item cards: real hrefs and the price text customers see.
  const cards = await page.$$eval('a[data-testid^="add-to-cart-"]', (as) =>
    as.map((a) => {
      const guid = a.getAttribute('data-testid').replace('add-to-cart-', '');
      const priceEl = a.querySelector(`[data-testid="price-${guid}"]`);
      return { guid, href: a.href, priceText: priceEl ? priceEl.textContent.trim() : null };
    }),
  );
  const cardByGuid = new Map();
  for (const c of cards) if (!cardByGuid.has(c.guid)) cardByGuid.set(c.guid, c);
  const bodyText = await page.evaluate(() => document.body.innerText);

  // ---- 2. categories ------------------------------------------------------
  const categories = [];
  const seenNames = new Set();
  const allItems = [];
  for (const menu of menus) {
    for (const group of menu.groups || []) {
      if (!group.items?.length) continue; // empty groups are not rendered on the page
      let name = group.name.trim();
      if (seenNames.has(name)) name = `${name} (${menu.name.trim()})`;
      seenNames.add(name);
      const items = group.items.map((it) => {
        const card = cardByGuid.get(it.guid);
        if (!card) warnings.push(`No rendered card/link for "${it.name}" (${it.guid})`);
        const priceText = card?.priceText || null;
        const price = parsePrice(priceText) ?? (it.prices?.length === 1 && !it.hasModifiers ? it.prices[0] : null);
        const item = {
          name: it.name.trim(),
          description: it.description?.trim() || null,
          price,
          priceText,
          url: card?.href || null,
          guid: it.guid || null,
          outOfStock: Boolean(it.outOfStock),
        };
        allItems.push({ item, raw: it });
        return item;
      });
      categories.push({
        name,
        ageRestricted: AGE_RESTRICTED.test(menu.name) || AGE_RESTRICTED.test(group.name),
        items,
      });
    }
  }

  // ---- 3. modifier dialogs ------------------------------------------------
  const modifierGroups = [];
  const oosOptions = new Set();
  const opened = [];
  const seenGuids = new Set();
  const toOpen = allItems.filter(({ raw, item }) => raw.hasModifiers && item.url && !seenGuids.has(raw.guid) && seenGuids.add(raw.guid));
  for (const { raw, item } of toOpen.slice(0, MAX_DETAIL_ITEMS)) {
    try {
      const detailsResp = page.waitForResponse(
        (r) => r.url().includes('/graphql') && (r.request().postData() || '').includes('MenuItemDetails') && (r.request().postData() || '').includes(raw.guid),
        { timeout: 20000 },
      );
      const anchor = page.locator(`a[data-testid="add-to-cart-${raw.guid}"]`).first();
      await anchor.scrollIntoViewIfNeeded();
      await anchor.click();
      const body = await (await detailsResp).json();
      const details = (Array.isArray(body) ? body : [body]).map((b) => b?.data?.menuItemDetails).find(Boolean);
      if (!details) throw new Error('no menuItemDetails in response');
      flattenModifierGroups(item.name, details.modifierGroups, '', modifierGroups, oosOptions);
      opened.push(item.name);
      await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
    } catch (e) {
      warnings.push(`Could not read modifiers for "${item.name}": ${e.message.split('\n')[0]}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(async () => {
      await page.locator('[role="dialog"] button[aria-label="Close"]').first().click().catch(() => {});
    });
    await sleep(DELAY_MS);
  }

  // ---- 4. notes -----------------------------------------------------------
  const notes = [];
  for (const phrase of ['Only accepting scheduled orders', 'Earn 1 point for every $1 spent.', 'Earn 25 points just for signing up']) {
    if (bodyText.includes(phrase)) notes.push(`Shown on page: "${phrase}"`);
  }
  const loc = restaurant.location;
  if (loc) {
    const phone = loc.phone?.replace(/^(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
    notes.push(`Location: ${restaurant.name}, ${loc.address1}, ${loc.city}, ${loc.state} ${loc.zip}. Phone ${phone}.`);
  }
  const spot = restaurant.spotlightConfig;
  if (spot?.headerText) notes.push(`Header banner: "${spot.headerText}"`);
  if (spot?.bodyText) notes.push(`Banner detail ("See More"): "${spot.bodyText.replace(/\s+/g, ' ').trim()}"`);
  const sched = restaurant.schedule;
  if (sched) {
    const localNow = new Date(capturedAt).toLocaleString('en-US', { timeZone: restaurant.timeZoneId || 'America/Detroit' });
    notes.push(
      `At capture time (${localNow} restaurant local time) ASAP ordering was ${sched.asapAvailableForTakeout ? '' : 'not '}available for pickup and ${sched.asapAvailableForDelivery ? '' : 'not '}available for delivery; outside ASAP hours Toast only accepts scheduled orders.`,
    );
    for (const s of sched.upcomingSchedules || []) {
      const label = s.behavior === 'TAKE_OUT' ? 'Pickup' : s.behavior === 'DELIVERY' ? 'Delivery' : s.behavior;
      const days = (s.dailySchedules || []).map((d) => {
        const wd = new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
        const periods = (d.servicePeriods || []).map((p) => `${fmtTime(p.startTime)}-${fmtTime(p.endTime)}`).join(', ') || 'closed';
        return `${wd} ${d.date}: ${periods}${d.overrideDescription ? ` (${d.overrideDescription})` : ''}`;
      });
      notes.push(`${label} hours (Toast schedule, ${restaurant.timeZoneId || 'local time'}): ${days.join('; ')}`);
    }
  }
  if (restaurant.minimumTakeoutTime != null || restaurant.minimumDeliveryTime != null)
    notes.push(`Minimum lead time: pickup ${restaurant.minimumTakeoutTime} min, delivery ${restaurant.minimumDeliveryTime} min.`);
  notes.push('Delivery fee and delivery minimum are not shown on the menu page (Toast only shows them after a delivery address is entered); unknown in this snapshot.');
  if (restaurant.creditCardConfig) notes.push(`Cards: Amex accepted=${restaurant.creditCardConfig.amexAccepted}; tipping enabled=${restaurant.creditCardConfig.tipEnabled}.`);
  const loyalty = Object.entries(restaurant).find(([k]) => k.startsWith('loyaltyConfig'))?.[1];
  if (loyalty?.programName) notes.push(`Loyalty program: ${loyalty.programName}.`);
  if (restaurant.giftCardLinks?.purchaseLink) notes.push(`Gift cards: ${restaurant.giftCardLinks.purchaseLink}`);
  if (menuDateTime) notes.push(`Menu availability as returned by Toast for the next orderable time slot (${menuDateTime}); time-restricted items outside that slot may be missing.`);
  const oosItems = allItems.filter(({ item }) => item.outOfStock).length;
  if (oosItems) notes.push(`${oosItems} items were marked out of stock on Toast at capture time (outOfStock: true).`);
  if (oosOptions.size) notes.push(`Modifier options marked out of stock at capture time: ${[...oosOptions].join('; ')}`);
  const ageCats = categories.filter((c) => c.ageRestricted).map((c) => c.name);
  if (ageCats.length) notes.push(`Age-restricted (21+, ID checked at pickup/delivery) categories: ${ageCats.join(', ')}.`);

  // ---- 5. verify a few item URLs -----------------------------------------
  const verifications = [];
  const withUrl = allItems.filter(({ item }) => item.url);
  for (let i = 0; i < Math.min(VERIFY_COUNT, withUrl.length); i++) {
    const { item } = withUrl[Math.floor(Math.random() * withUrl.length)];
    await sleep(DELAY_MS);
    try {
      const r = await gotoWithRetry(item.url);
      const title = page.locator('[role="dialog"] #menu-item-modal-header').first();
      await title.waitFor({ timeout: 30000 });
      const heading = (await title.textContent())?.trim();
      verifications.push({ name: item.name, url: item.url, status: r?.status(), heading, ok: heading === item.name });
    } catch (e) {
      verifications.push({ name: item.name, url: item.url, ok: false, error: e.message.split('\n')[0] });
    }
  }
  await browser.close();

  // ---- 6. write -----------------------------------------------------------
  const snapshot = {
    schemaVersion: 1,
    capturedAt,
    source: ORDER_URL,
    orderUrl: ORDER_URL,
    categories,
    modifierGroups,
    notes,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');

  const itemCount = categories.reduce((n, c) => n + c.items.length, 0);
  const withUrlCount = categories.reduce((n, c) => n + c.items.filter((i) => i.url).length, 0);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
  console.log(`  categories: ${categories.length} (${ageCats.length} age-restricted)`);
  console.log(`  items: ${itemCount} (with url: ${withUrlCount}, out of stock: ${oosItems}, unique guids: ${new Set(allItems.map((a) => a.item.guid)).size})`);
  console.log(`  modifier groups: ${modifierGroups.length} from ${opened.length}/${toOpen.length} customizable items opened`);
  console.log(`  page loads: ${pageLoads}; dialogs opened: ${opened.length}`);
  for (const v of verifications) console.log(`  verify ${v.ok ? 'OK  ' : 'FAIL'} ${v.name} -> ${v.heading ?? v.error} (${v.url})`);
  for (const w of warnings) console.log(`  warning: ${w}`);
  if (verifications.some((v) => !v.ok)) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
