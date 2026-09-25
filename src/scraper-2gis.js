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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US']
  };

  try {
    return await chromium.launch({ ...launchOptions, channel: 'chrome' });
  } catch {
    return await chromium.launch({ ...launchOptions, channel: 'msedge' });
  }
}

function buildSearchUrl(city, query) {
  const cleanCity = city.trim().toLowerCase();
  const encodedQuery = encodeURIComponent(query.trim());

  const viewports = {
    'abu dhabi': '54.756359%2C24.560894%2F9.96',
    'al ain': '55.760559%2C24.207500%2F11.0',
    'sharjah': '55.405556%2C25.357500%2F11.5',
    'ajman': '55.479444%2C25.411111%2F12.0'
  };

  if (viewports[cleanCity]) {
    return `https://2gis.ae/dubai/search/${encodedQuery}?m=${viewports[cleanCity]}`;
  }

  return `https://2gis.ae/${cleanCity}/search/${encodedQuery}`;
}

async function runTwoGis(config, control, notifyProgress, notifyLog) {
  const city = (config.city || 'Dubai').trim();
  const queries = Array.isArray(config.queries) && config.queries.length > 0
    ? config.queries
    : [config.query || 'Companies'];

  const cap = Number(config.cap) || 0;
  const initialSaved = Number(config.initialSaved) || 0;
  let startIdx = Number(config.startIdx) || 0;

  if (startIdx >= queries.length) {
    startIdx = 0;
  }

  const primaryTitle = queries.length > 1
    ? `${city}: ${queries[0]} (+${queries.length - 1} more)`
    : `${city}: ${queries[0]}`;

  const csvPath = config.existingCsvPath && fs.existsSync(config.existingCsvPath)
    ? config.existingCsvPath
    : generateUniqueCsvPath('2GIS', `${city}_${queries[0]}`);

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

  const taskId = config.taskId || `twogis_${Date.now()}`;
  saveHistoryItem({
    id: taskId,
    engine: '2gis',
    title: primaryTitle,
    queries,
    totalQueries: queries.length,
    completedQueries: startIdx,
    currentQueryIdx: startIdx,
    totalSaved: initialSaved,
    status: 'running',
    csvPath,
    cap,
    config: { city, queries, cap, csvPath }
  });

  notifyLog(`Initialised 2GIS search across ${queries.length} queries in ${city}.`);
  notifyProgress({
    status: 'running',
    engine: '2GIS',
    currentQuery: `${queries[startIdx]} (${city})`,
    currentQueryIdx: startIdx + 1,
    totalQueries: queries.length,
    totalSaved: initialSaved,
    percent: Math.round((startIdx / queries.length) * 100),
    csvPath
  });

  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();

  let totalSaved = initialSaved;
  let noPhoneCount = 0;
  let failedQueriesCount = 0;

  try {
    for (let qIdx = startIdx; qIdx < queries.length; qIdx++) {
      if (control.cancelled) {
        notifyLog('Search paused by user.');
        updateHistoryRecord(taskId, {
          status: 'paused',
          currentQueryIdx: qIdx,
          completedQueries: qIdx,
          totalSaved,
          noPhoneCount,
          failedQueriesCount
        });
        saveActiveCheckpoint({
          id: taskId,
          engine: '2gis',
          title: primaryTitle,
          city,
          queries,
          currentQueryIdx: qIdx,
          completedQueries: qIdx,
          totalQueries: queries.length,
          totalSaved,
          csvPath,
          cap
        });
        return {
          status: 'paused',
          engine: '2GIS',
          title: primaryTitle,
          totalSaved,
          completedQueries: qIdx,
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

      const currentQuery = queries[qIdx];
      const progressPercent = Math.min(100, Math.round((qIdx / queries.length) * 100));

      notifyProgress({
        status: 'running',
        engine: '2GIS',
        currentQuery: `${currentQuery} (${city})`,
        currentQueryIdx: qIdx + 1,
        totalQueries: queries.length,
        totalSaved,
        percent: progressPercent,
        csvPath
      });
      notifyLog(`Searching 2GIS [${qIdx + 1}/${queries.length}]: ${currentQuery} in ${city}`);

      try {
        const url = buildSearchUrl(city, currentQuery);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(2500);
      } catch {
        failedQueriesCount++;
        notifyLog(`Failed loading 2GIS search: ${currentQuery}`);
        continue;
      }

      let currentPage = 1;
      const maxPagesPerQuery = 30;

      while (currentPage <= maxPagesPerQuery) {
        if (control.cancelled) break;
        if (cap > 0 && totalSaved >= cap) break;

        for (let s = 0; s < 3; s++) {
          try {
            await page.evaluate(() => {
              const containers = document.querySelectorAll('div._15gu4wr, div[class*="sidebar"]');
              if (containers.length) {
                containers[containers.length - 1].scrollTop += 700;
              } else {
                window.scrollBy(0, 700);
              }
            });
            await page.waitForTimeout(250);
          } catch {}
        }

        const cardHandles = await page.$$('div._1kf6gff, div[class*="_1469e3a"], a[href*="/firm/"]');
        if (cardHandles.length === 0) break;

        for (const card of cardHandles) {
          if (control.cancelled) break;
          if (cap > 0 && totalSaved >= cap) break;

          try {
            const rawText = await card.innerText();
            const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
            if (lines.length === 0) continue;

            const title = lines[0];
            let address = 'None';
            for (let l = 1; l < lines.length; l++) {
              const lower = lines[l].toLowerCase();
              if (lower.includes('street') || lower.includes('road') || lower.includes('tower') || lower.includes('building') || lower.includes('bay')) {
                address = lines[l];
                break;
              }
            }

            await card.click();
            await page.waitForTimeout(500);

            try {
              const showBtn = await page.$('span:has-text("Show phone"), button:has-text("phone"), button:has-text("Phone")');
              if (showBtn) {
                await showBtn.click();
                await page.waitForTimeout(250);
              }
            } catch {}

            const phoneLinks = await page.$$('a[href^="tel:"]');
            const foundPhones = [];
            for (const pl of phoneLinks) {
              const href = await pl.getAttribute('href');
              if (href) {
                const num = href.replace('tel:', '').trim();
                if (num && !foundPhones.includes(num)) foundPhones.push(num);
              }
            }

            let website = 'None';
            const webLinks = await page.$$('a[href^="http"]');
            for (const wl of webLinks) {
              const href = await wl.getAttribute('href');
              if (href && !href.includes('2gis') && !href.includes('google')) {
                website = href;
                break;
              }
            }

            const category = lines.length > 1 ? lines[1] : 'Business';
            const dedupeKey = `${title.toLowerCase()}::${foundPhones[0] || 'None'}`;

            if (!existingLeadKeys.has(dedupeKey)) {
              existingLeadKeys.add(dedupeKey);
              if (foundPhones.length === 0) noPhoneCount++;

              const record = {
                title,
                phone_1: foundPhones[0] || 'None',
                phone_2: foundPhones[1] || 'None',
                website,
                category,
                address,
                query: `${city}: ${currentQuery}`,
                rating: 'None',
                reviews: 'None',
                source: '2GIS'
              };

              await csvWriter.writeRecords([record]);
              totalSaved++;

              notifyProgress({
                status: 'running',
                engine: '2GIS',
                currentQuery: `${currentQuery} (${city})`,
                currentQueryIdx: qIdx + 1,
                totalQueries: queries.length,
                totalSaved,
                percent: Math.min(100, Math.round(((qIdx + (currentPage / (currentPage + 4))) / queries.length) * 100)),
                csvPath
              });
              notifyLog(`Lead captured: ${title}`);
            }

            await page.keyboard.press('Escape');
            await page.waitForTimeout(150);
          } catch {}
        }

        const nextBtn = await page.$('div._5ocwns div:last-child, div[class*="pagination"] div:last-child');
        if (nextBtn) {
          await nextBtn.scrollIntoViewIfNeeded();
          await nextBtn.click();
          currentPage++;
          await page.waitForTimeout(2200);
        } else {
          break;
        }
      }

      updateHistoryRecord(taskId, {
        currentQueryIdx: qIdx + 1,
        completedQueries: qIdx + 1,
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

    notifyLog(`2GIS search task finished. Stored ${totalSaved} leads.`);
    return {
      status: 'completed',
      engine: '2GIS',
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

module.exports = { runTwoGis };
