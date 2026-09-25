const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const {
  getExportsDir,
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
  const { city, query, cap = 0, startPage = 1, initialSaved = 0, taskId } = config;
  const label = `${city}: ${query}`;

  const safeName = `${city}_${query}`.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 24);
  const csvFileName = `2GIS_${safeName}.csv`;
  const csvPath = config.existingCsvPath && fs.existsSync(config.existingCsvPath)
    ? config.existingCsvPath
    : path.join(getExportsDir(), csvFileName);

  const fileExists = fs.existsSync(csvPath);

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

  const recordId = taskId || `twogis_${Date.now()}`;
  saveHistoryItem({
    id: recordId,
    engine: '2gis',
    target: label,
    label,
    totalQueries: 1,
    currentQueryIdx: startPage,
    totalSaved: initialSaved,
    status: 'running',
    csvPath,
    config: { city, query, cap, startPage, initialSaved, csvPath }
  });

  notifyLog(`Searching 2GIS for ${query} in ${city}...`);
  notifyProgress({
    status: 'running',
    engine: '2gis',
    currentQuery: label,
    currentQueryIdx: startPage,
    totalQueries: 1,
    totalSaved: initialSaved,
    percent: 10,
    csvPath
  });

  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();

  let totalSaved = initialSaved;
  let currentPage = Number(startPage) || 1;
  let noPhoneCount = 0;
  const maxPages = 50;

  try {
    const url = buildSearchUrl(city, query);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2500);

    while (currentPage <= maxPages) {
      if (control.cancelled) {
        notifyLog('Search paused by user.');
        updateHistoryRecord(recordId, {
          status: 'paused',
          currentQueryIdx: currentPage,
          totalSaved,
          noPhoneCount
        });
        saveActiveCheckpoint({
          id: recordId,
          engine: '2gis',
          target: label,
          label,
          city,
          query,
          currentQueryIdx: currentPage,
          totalQueries: 1,
          totalSaved,
          csvPath,
          cap
        });
        return {
          status: 'paused',
          engine: '2gis',
          totalSaved,
          completedQueries: 1,
          totalQueries: 1,
          csvPath,
          noPhoneCount,
          failedQueries: 0
        };
      }

      if (cap > 0 && totalSaved >= cap) {
        notifyLog(`Reached limit of ${cap} leads.`);
        break;
      }

      const calculatedPercent = Math.min(95, Math.round((currentPage / (currentPage + 4)) * 100));
      notifyProgress({
        status: 'running',
        engine: '2gis',
        currentQuery: `${label} (Page ${currentPage})`,
        currentQueryIdx: currentPage,
        totalQueries: 1,
        totalSaved,
        percent: calculatedPercent,
        csvPath
      });
      notifyLog(`Reading 2GIS page ${currentPage}...`);

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

      if (cardHandles.length === 0) {
        notifyLog('No further listings found.');
        break;
      }

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
          if (foundPhones.length === 0) noPhoneCount++;

          const leadObj = {
            title,
            phone_1: foundPhones[0] || 'None',
            phone_2: foundPhones[1] || 'None',
            website,
            category,
            address,
            query: label,
            rating: 'None',
            reviews: 'None',
            source: '2GIS'
          };

          await csvWriter.writeRecords([leadObj]);
          totalSaved++;

          notifyProgress({
            status: 'running',
            engine: '2gis',
            currentQuery: label,
            currentQueryIdx: currentPage,
            totalQueries: 1,
            totalSaved,
            latestLead: leadObj,
            percent: calculatedPercent,
            csvPath
          });
          notifyLog(`Found lead: ${title}`);

          await page.keyboard.press('Escape');
          await page.waitForTimeout(150);
        } catch {}
      }

      updateHistoryRecord(recordId, {
        currentQueryIdx: currentPage,
        totalSaved,
        noPhoneCount
      });

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

    clearActiveCheckpoint();
    updateHistoryRecord(recordId, {
      status: 'completed',
      currentQueryIdx: currentPage,
      totalSaved,
      noPhoneCount
    });

    notifyLog(`Search completed. Total leads found: ${totalSaved}`);
    return {
      status: 'completed',
      engine: '2gis',
      totalSaved,
      completedQueries: 1,
      totalQueries: 1,
      csvPath,
      noPhoneCount,
      failedQueries: 0
    };
  } finally {
    try {
      await browser.close();
    } catch {}
  }
}

module.exports = { runTwoGis };
