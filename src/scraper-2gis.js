const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { getExportsDir, updateProgress, saveHistoryItem } = require('./storage');

async function getBrowser() {
  const launchOptions = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
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

async function runTwoGis(config, control, log) {
  const { city, query, cap = 0, startPage = 1, initialSaved = 0 } = config;
  const targetLabel = `${city}:${query}`;

  const safeName = targetLabel.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
  const csvPath = path.join(getExportsDir(), `2gis_${safeName}.csv`);
  const fileExists = fs.existsSync(csvPath);

  const csvWriter = createCsvWriter({
    path: csvPath,
    header: [
      { id: 'title', title: 'Business Name' },
      { id: 'category', title: 'Category' },
      { id: 'phone_1', title: 'Primary Phone' },
      { id: 'phone_2', title: 'Secondary Phone' },
      { id: 'website', title: 'Website' },
      { id: 'address', title: 'Address' }
    ],
    append: fileExists
  });

  saveHistoryItem({
    engine: '2gis',
    target: targetLabel,
    lastStep: startPage,
    totalSaved: initialSaved,
    date: new Date().toISOString()
  });

  log(`Searching 2GIS in ${city} for: ${query}`);
  log(`Saving leads to: ${csvPath}`);

  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();

  let totalSaved = initialSaved;
  let currentPage = Number(startPage) || 1;

  try {
    const url = buildSearchUrl(city, query);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(3000);

    while (currentPage <= 150) {
      if (control.cancelled) {
        log('Task paused by user.');
        break;
      }

      if (cap > 0 && totalSaved >= cap) {
        log(`Target limit of ${cap} reached.`);
        break;
      }

      log(`Scraping Page ${currentPage}...`);

      for (let s = 0; s < 4; s++) {
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
        log('No more business listings found.');
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
          await page.waitForTimeout(600);

          try {
            const showBtn = await page.$('span:has-text("Show phone"), button:has-text("phone"), button:has-text("Phone")');
            if (showBtn) {
              await showBtn.click();
              await page.waitForTimeout(300);
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

          let category = lines.length > 1 ? lines[1] : 'General Business';

          await csvWriter.writeRecords([{
            title,
            category,
            phone_1: foundPhones[0] || 'None',
            phone_2: foundPhones[1] || 'None',
            website,
            address
          }]);

          totalSaved++;
          log(`Saved #${totalSaved}: ${title.substring(0, 22)} | ${foundPhones[0] || 'None'}`);

          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        } catch {}
      }

      updateProgress('2gis', targetLabel, currentPage + 1, totalSaved);

      const nextBtn = await page.$('div._5ocwns div:last-child, div[class*="pagination"] div:last-child');
      if (nextBtn) {
        await nextBtn.scrollIntoViewIfNeeded();
        await nextBtn.click();
        currentPage++;
        await page.waitForTimeout(2500);
      } else {
        log('Reached the final catalog page.');
        break;
      }
    }
  } finally {
    try {
      await browser.close();
    } catch {}
    log('Done.');
  }
}

module.exports = { runTwoGis };
