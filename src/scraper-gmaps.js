const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const {
  generateUniqueCsvPath,
  getExistingLeadKeys,
  saveHistoryItem,
  updateHistoryRecord,
  saveActiveCheckpoint,
  clearActiveCheckpoint
} = require('./storage');

async function getBrowser() {
  const launchOptions = {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--lang=en-US',
      '--no-first-run',
      '--disable-blink-features=AutomationControlled'
    ]
  };

  try {
    return await chromium.launch({ ...launchOptions, channel: 'chrome' });
  } catch {
    return await chromium.launch({ ...launchOptions, channel: 'msedge' });
  }
}

function rankPhones(phones) {
  const cleanList = Array.from(new Set(phones.map((p) => p.trim()).filter(Boolean)));
  const score = (p) => {
    const num = p.replace(/[^\d+]/g, '');
    if (num.startsWith('+9715') || num.startsWith('009715') || num.startsWith('05')) return 0;
    if (/^(\+91|91|0)?[6-9]\d{9}$/.test(num)) return 1;
    if (num.startsWith('+447') || num.startsWith('07')) return 2;
    if (/800|\+971800|1800/.test(num)) return 10;
    return 5;
  };
  return cleanList.sort((a, b) => score(a) - score(b));
}

async function extractActivePane(page) {
  const data = {
    title: 'Unknown',
    phone_1: 'None',
    phone_2: 'None',
    website: 'None',
    category: 'Business',
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
    const catEl = await page.$('button.DkEaL, span.fontBodyMedium button');
    if (catEl) {
      data.category = (await catEl.innerText()).trim();
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

async function returnToFeed(page) {
  try {
    const backBtn = page.locator('div[role="main"] button[aria-label="Back to results"], button[jsaction*="pane.back"], div[role="main"] button[aria-label="Back"]').first();
    if (await backBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await backBtn.click().catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
  }

  await page.waitForSelector('div[role="feed"]', { timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(200);
}

async function executeSearch(page, query) {
  const searchUrl = query.startsWith('http')
    ? query
    : `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`;

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

  try {
    const consent = await page.$('button[aria-label*="Accept all"], form button');
    if (consent) await consent.click();
  } catch {}

  await page.waitForTimeout(1600);

  const isBlank = await page.evaluate(() => {
    const input = document.querySelector('#searchboxinput');
    const empty = !input || !input.value.trim();
    const isRoot = window.location.href.includes('/@') && !window.location.href.includes('/search/') && !window.location.href.includes('/place/');
    return empty && isRoot;
  });

  if (isBlank) {
    const inputLocator = page.locator('#searchboxinput');
    if (await inputLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
      await inputLocator.fill(query);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2500);
    }
  }
}

async function runGmaps(config, control, notifyProgress, notifyLog) {
  const queries = Array.isArray(config.queries) && config.queries.length > 0
    ? config.queries
    : [config.query || config.target];

  const cap = Number(config.cap) || 0;
  const initialSaved = Number(config.initialSaved) || 0;
  let startIdx = Number(config.startIdx) || 0;

  if (startIdx >= queries.length) {
    startIdx = 0;
  }

  const primaryTitle = queries.length > 1
    ? `${queries[0]} (+${queries.length - 1} more)`
    : queries[0];

  const csvPath = config.existingCsvPath && fs.existsSync(config.existingCsvPath)
    ? config.existingCsvPath
    : generateUniqueCsvPath('GoogleMaps', queries[0]);

  const fileExists = fs.existsSync(csvPath);
  const existingLeadKeys = getExistingLeadKeys(csvPath);

  const csvWriter = createCsvWriter({
    path: csvPath,
    header: [
      { id: 'title', title: 'Business Name' },
      { id: 'phone_1', title: 'Phone' },
      { id: 'phone_2', title: 'Secondary Phone' },
      { id: 'website', title: 'Website' },
      { id: 'category', title: 'Category' },
      { id: 'address', title: 'Address' },
      { id: 'query', title: 'Search Keyword' },
      { id: 'rating', title: 'Rating' },
      { id: 'reviews', title: 'Reviews' },
      { id: 'source', title: 'Source' }
    ],
    append: fileExists
  });

  const taskId = config.taskId || `gmaps_${Date.now()}`;
  saveHistoryItem({
    id: taskId,
    engine: 'gmaps',
    title: primaryTitle,
    queries,
    totalQueries: queries.length,
    completedQueries: startIdx,
    currentQueryIdx: startIdx,
    totalSaved: initialSaved,
    status: 'running',
    csvPath,
    cap,
    config: { queries, cap, csvPath }
  });

  notifyLog(`Initialised Google Maps task with ${queries.length} search query items.`);
  notifyProgress({
    status: 'running',
    engine: 'Google Maps',
    currentQuery: queries[startIdx],
    currentQueryIdx: startIdx + 1,
    totalQueries: queries.length,
    totalSaved: initialSaved,
    percent: Math.round((startIdx / queries.length) * 100),
    csvPath
  });

  const browser = await getBrowser();
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();

  let totalSaved = initialSaved;
  let noPhoneCount = 0;
  let failedQueriesCount = 0;

  try {
    for (let i = startIdx; i < queries.length; i++) {
      if (control.cancelled) {
        notifyLog('Search paused by user.');
        updateHistoryRecord(taskId, {
          status: 'paused',
          currentQueryIdx: i,
          completedQueries: i,
          totalSaved,
          noPhoneCount,
          failedQueriesCount
        });
        saveActiveCheckpoint({
          id: taskId,
          engine: 'gmaps',
          title: primaryTitle,
          queries,
          currentQueryIdx: i,
          completedQueries: i,
          totalQueries: queries.length,
          totalSaved,
          csvPath,
          cap
        });
        return {
          status: 'paused',
          engine: 'Google Maps',
          title: primaryTitle,
          totalSaved,
          completedQueries: i,
          totalQueries: queries.length,
          csvPath,
          noPhoneCount,
          failedQueriesCount
        };
      }

      if (cap > 0 && totalSaved >= cap) {
        notifyLog(`Lead cap of ${cap} reached.`);
        break;
      }

      const currentQuery = queries[i];
      const progressPercent = Math.min(100, Math.round((i / queries.length) * 100));

      notifyProgress({
        status: 'running',
        engine: 'Google Maps',
        currentQuery,
        currentQueryIdx: i + 1,
        totalQueries: queries.length,
        totalSaved,
        percent: progressPercent,
        csvPath
      });
      notifyLog(`Running search ${i + 1} of ${queries.length}: "${currentQuery}"`);

      try {
        await executeSearch(page, currentQuery);
      } catch {
        failedQueriesCount++;
        notifyLog(`Search query failed to load: ${currentQuery}`);
        continue;
      }

      if (page.url().includes('/maps/place/')) {
        const details = await extractActivePane(page);
        if (details.title && details.title !== 'Unknown') {
          const dedupeKey = `${details.title.toLowerCase()}::${details.phone_1}`;
          if (!existingLeadKeys.has(dedupeKey)) {
            existingLeadKeys.add(dedupeKey);
            if (details.phone_1 === 'None') noPhoneCount++;
            await csvWriter.writeRecords([{ ...details, query: currentQuery, source: 'Google Maps' }]);
            totalSaved++;
            notifyProgress({
              status: 'running',
              engine: 'Google Maps',
              currentQuery,
              currentQueryIdx: i + 1,
              totalQueries: queries.length,
              totalSaved,
              percent: Math.min(100, Math.round(((i + 1) / queries.length) * 100)),
              csvPath
            });
            notifyLog(`Lead captured: ${details.title} (${details.phone_1})`);
          }
        }
        continue;
      }

      const seenUrls = new Set();
      let scrollRounds = 0;
      let idleScrolls = 0;

      while (scrollRounds < 40) {
        if (control.cancelled) break;
        if (cap > 0 && totalSaved >= cap) break;

        let visibleHrefs = [];
        try {
          visibleHrefs = await page.$$eval(
            'div[role="feed"] a.hfpxzc, div[role="feed"] a[href*="/maps/place/"]',
            (elements) => elements.map((el) => el.href).filter(Boolean)
          );
        } catch {
          visibleHrefs = [];
        }

        if (visibleHrefs.length === 0) {
          const isDead = await page.$('span:has-text("No more results"), div:has-text("Partial match"), div:has-text("No results found")');
          if (isDead) break;
        }

        const unvisited = visibleHrefs.filter((h) => !seenUrls.has(h));

        if (unvisited.length > 0) {
          idleScrolls = 0;

          for (const href of unvisited) {
            if (control.cancelled) break;
            if (cap > 0 && totalSaved >= cap) break;

            seenUrls.add(href);

            try {
              const card = page.locator(`div[role="feed"] a[href="${href}"]`).first();
              await card.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
              await card.click({ timeout: 2500 }).catch(() => {});

              await page.waitForSelector('h1.DUwDvf, button[data-item-id="address"]', { timeout: 4500 }).catch(() => {});

              const details = await extractActivePane(page);
              if (details.title && details.title !== 'Unknown') {
                const dedupeKey = `${details.title.toLowerCase()}::${details.phone_1}`;
                if (!existingLeadKeys.has(dedupeKey)) {
                  existingLeadKeys.add(dedupeKey);
                  if (details.phone_1 === 'None') noPhoneCount++;
                  await csvWriter.writeRecords([{ ...details, query: currentQuery, source: 'Google Maps' }]);
                  totalSaved++;
                  notifyProgress({
                    status: 'running',
                    engine: 'Google Maps',
                    currentQuery,
                    currentQueryIdx: i + 1,
                    totalQueries: queries.length,
                    totalSaved,
                    percent: Math.min(100, Math.round(((i + (seenUrls.size / (seenUrls.size + 10))) / queries.length) * 100)),
                    csvPath
                  });
                  notifyLog(`Lead captured: ${details.title}`);
                }
              }

              await returnToFeed(page);
            } catch {
              await returnToFeed(page);
            }
          }
        } else {
          idleScrolls++;
        }

        let isEndOfFeed = false;
        try {
          const marker = await page.$('span:has-text("reached the end of the list"), div.HlvSq, div:has-text("Partial match"), div:has-text("No more results")');
          if (marker) isEndOfFeed = true;
        } catch {}

        if (isEndOfFeed || idleScrolls >= 2) {
          break;
        }

        try {
          const feed = page.locator('div[role="feed"]').first();
          if (await feed.isVisible().catch(() => false)) {
            await feed.evaluate((el) => el.scrollBy(0, 1100));
          } else {
            await page.evaluate(() => window.scrollBy(0, 1100));
          }
          await page.waitForTimeout(900);
        } catch {
          break;
        }

        scrollRounds++;
      }

      updateHistoryRecord(taskId, {
        currentQueryIdx: i + 1,
        completedQueries: i + 1,
        totalSaved,
        noPhoneCount,
        failedQueriesCount
      });
    }

    clearActiveCheckpoint();
    updateHistoryRecord(taskId, {
      status: 'completed',
      currentQueryIdx: queries.length,
      completedQueries: queries.length,
      totalSaved,
      noPhoneCount,
      failedQueriesCount
    });

    notifyLog(`Search queue completed successfully. ${totalSaved} leads stored.`);
    return {
      status: 'completed',
      engine: 'Google Maps',
      title: primaryTitle,
      totalSaved,
      completedQueries: queries.length - failedQueriesCount,
      totalQueries: queries.length,
      csvPath,
      noPhoneCount,
      failedQueriesCount
    };
  } finally {
    try {
      await browser.close();
    } catch {}
  }
}

module.exports = { runGmaps };
