const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { getExportsDir, updateProgress, saveHistoryItem } = require('./storage');

function loadTargetList(targetInput) {
  const clean = targetInput.replace(/["']/g, '').trim();
  if (fs.existsSync(clean) && fs.statSync(clean).isFile()) {
    const ext = path.extname(clean).toLowerCase();
    if (ext === '.csv') {
      const content = fs.readFileSync(clean, 'utf8');
      return content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const workbook = xlsx.readFile(clean);
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const json = xlsx.utils.sheet_to_json(firstSheet, { header: 1 });
      const items = [];
      for (const row of json) {
        if (Array.isArray(row)) {
          const combined = row.map((cell) => String(cell || '').trim()).filter(Boolean).join(' ');
          if (combined) items.push(combined);
        }
      }
      return items.length ? items : [clean];
    }
    const content = fs.readFileSync(clean, 'utf8');
    return content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return [clean];
}

async function getBrowser() {
  const launchOptions = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US']
  };

  try {
    return await chromium.launch({ ...launchOptions, channel: 'chrome' });
  } catch {
    return await chromium.launch({ ...launchOptions, channel: 'msedge' });
  }
}

function rankPhones(phones) {
  function score(p) {
    const clean = p.replace(/[^\d+]/g, '');
    if (clean.startsWith('+9715') || clean.startsWith('009715') || clean.startsWith('05')) return 0;
    if (/^(\+91|91|0)?[6-9]\d{9}$/.test(clean)) return 1;
    if (clean.startsWith('+447') || clean.startsWith('07')) return 2;
    if (/800|\+971800|1800/.test(clean)) return 10;
    return 5;
  }
  const unique = Array.from(new Set(phones.map((p) => p.trim()).filter(Boolean)));
  return unique.sort((a, b) => score(a) - score(b));
}

async function extractActivePane(page) {
  const data = {
    title: 'Unknown',
    phone_1: 'None',
    phone_2: 'None',
    website: 'None',
    address: 'None',
    rating: 'None',
    reviews: 'None'
  };

  try {
    const titleEl = await page.$('h1.DUwDvf');
    if (titleEl) {
      data.title = (await titleEl.innerText()).trim();
    }
  } catch {}

  try {
    const phoneHandles = await page.$$('button[data-item-id^="phone:"], button[aria-label*="Phone"], a[href^="tel:"]');
    const rawPhones = [];
    for (const el of phoneHandles) {
      try {
        const text = await el.innerText();
        const href = await el.getAttribute('href');
        if (text) rawPhones.push(text.replace('Phone:', '').trim());
        if (href && href.startsWith('tel:')) rawPhones.push(href.replace('tel:', '').trim());
      } catch {}
    }
    const ranked = rankPhones(rawPhones);
    if (ranked.length > 0) data.phone_1 = ranked[0];
    if (ranked.length > 1) data.phone_2 = ranked[1];
  } catch {}

  try {
    const addrEl = await page.$('button[data-item-id="address"], button[aria-label*="Address"]');
    if (addrEl) {
      data.address = (await addrEl.innerText()).replace('Address:', '').trim();
    }
  } catch {}

  try {
    const webEl = await page.$('a[data-item-id="authority"], a[aria-label*="Website"]');
    if (webEl) {
      data.website = (await webEl.getAttribute('href')) || 'None';
    }
  } catch {}

  try {
    const ratingEl = await page.$('div.F7nice span[aria-hidden="true"]');
    if (ratingEl) {
      data.rating = (await ratingEl.innerText()).trim();
    }
    const revsEl = await page.$('div.F7nice span[aria-label*="reviews"]');
    if (revsEl) {
      const text = await revsEl.innerText();
      data.reviews = text.replace(/[^\d]/g, '');
    }
  } catch {}

  return data;
}

async function runGmaps(config, control, log) {
  const { target, cap = 0, startIdx = 0, initialSaved = 0 } = config;
  const queries = loadTargetList(target);

  const safeName = target.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
  const csvPath = path.join(getExportsDir(), `gmaps_${safeName}.csv`);
  const fileExists = fs.existsSync(csvPath);

  const csvWriter = createCsvWriter({
    path: csvPath,
    header: [
      { id: 'query', title: 'Query' },
      { id: 'title', title: 'Business Name' },
      { id: 'phone_1', title: 'Primary Phone' },
      { id: 'phone_2', title: 'Secondary Phone' },
      { id: 'website', title: 'Website' },
      { id: 'address', title: 'Address' },
      { id: 'rating', title: 'Rating' },
      { id: 'reviews', title: 'Reviews' }
    ],
    append: fileExists
  });

  saveHistoryItem({
    engine: 'gmaps',
    target,
    lastStep: startIdx,
    totalSaved: initialSaved,
    date: new Date().toISOString()
  });

  log(`Target queue: ${queries.length} queries`);
  log(`Output: ${csvPath}`);

  const browser = await getBrowser();
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();

  let totalSaved = initialSaved;

  try {
    for (let i = startIdx; i < queries.length; i++) {
      if (control.cancelled) {
        log('Execution paused.');
        break;
      }

      if (cap > 0 && totalSaved >= cap) {
        log(`Harvest threshold of ${cap} records satisfied.`);
        break;
      }

      const q = queries[i];
      log(`[${i + 1}/${queries.length}] Searching: ${q}`);

      const searchUrl = q.startsWith('http')
        ? q
        : `https://www.google.com/maps/search/${encodeURIComponent(q)}?hl=en`;

      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      } catch (navErr) {
        log(`Navigation timeout for: ${q}. Skipping.`);
        updateProgress('gmaps', target, i + 1, totalSaved);
        continue;
      }

      try {
        const acceptBtn = await page.$('button[aria-label*="Accept all"], form button');
        if (acceptBtn) await acceptBtn.click();
      } catch {}

      await page.waitForTimeout(1500);

      const isDirectPlace = page.url().includes('/maps/place/');

      if (isDirectPlace) {
        log('Entity resolved directly into place view.');
        const details = await extractActivePane(page);
        if (details.title && details.title !== 'Unknown') {
          await csvWriter.writeRecords([{ query: q, ...details }]);
          totalSaved++;
          log(`Saved #${totalSaved}: ${details.title} | ${details.phone_1}`);
        }
        updateProgress('gmaps', target, i + 1, totalSaved);
        continue;
      }

      const seenUrls = new Set();
      let scrollCycles = 0;
      let stagnantCount = 0;

      while (scrollCycles < 25) {
        if (control.cancelled) break;
        if (cap > 0 && totalSaved >= cap) break;

        let visibleHrefs = [];
        try {
          visibleHrefs = await page.$$eval(
            'div[role="feed"] a[href*="/maps/place/"], a[href*="/maps/place/"]',
            (elements) => elements.map((el) => el.href).filter(Boolean)
          );
        } catch {
          visibleHrefs = [];
        }

        if (visibleHrefs.length === 0) {
          const isDeadEnd = await page.$('span:has-text("No more results"), div:has-text("Partial match"), div:has-text("No results found")');
          if (isDeadEnd) break;
        }

        let newRecordsThisCycle = 0;

        for (const href of visibleHrefs) {
          if (control.cancelled) break;
          if (cap > 0 && totalSaved >= cap) break;
          if (seenUrls.has(href)) continue;
          seenUrls.add(href);

          try {
            const cardLocator = page.locator(`a[href="${href}"]`).first();
            await cardLocator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
            await cardLocator.click({ timeout: 3000 }).catch(() => {});

            await page.waitForSelector('h1.DUwDvf, button[data-item-id="address"]', { timeout: 6000 }).catch(() => {});

            const details = await extractActivePane(page);
            if (details.title && details.title !== 'Unknown') {
              await csvWriter.writeRecords([{ query: q, ...details }]);
              totalSaved++;
              newRecordsThisCycle++;
              log(`Saved #${totalSaved}: ${details.title.substring(0, 22)} | ${details.phone_1}`);
            }

            const backBtn = await page.$('button[aria-label="Back"], button[jsaction*="pane.back"], button[aria-label="Close"]');
            if (backBtn) {
              await backBtn.click().catch(() => {});
            } else {
              await page.goBack().catch(() => {});
            }

            await page.waitForSelector('div[role="feed"]', { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(400);
          } catch (cardError) {
            try {
              await page.goBack().catch(() => {});
              await page.waitForTimeout(500);
            } catch {}
          }
        }

        let hasReachedEnd = false;
        try {
          const endMarker = await page.$('span:has-text("reached the end of the list"), div.HlvSq, div:has-text("Partial match")');
          if (endMarker) hasReachedEnd = true;
        } catch {}

        if (hasReachedEnd) {
          log('Directory feed exhausted.');
          break;
        }

        if (newRecordsThisCycle === 0) {
          stagnantCount++;
        } else {
          stagnantCount = 0;
        }

        if (stagnantCount >= 2) {
          break;
        }

        try {
          const feedElement = await page.$('div[role="feed"]');
          if (feedElement) {
            await feedElement.evaluate((el) => el.scrollBy(0, 900));
          } else {
            await page.evaluate(() => window.scrollBy(0, 900));
          }
          await page.waitForTimeout(1200);
        } catch {
          break;
        }

        scrollCycles++;
      }

      updateProgress('gmaps', target, i + 1, totalSaved);
    }
  } finally {
    try {
      await browser.close();
    } catch {}
    log('Google Maps process finished.');
  }
}

module.exports = { runGmaps };
