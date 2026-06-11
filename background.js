importScripts('storage.js');

// Open the side panel when the user clicks the toolbar icon
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const CONSECUTIVE_STALE_THRESHOLD = 7;
let scrapeInProgress = false;
let scrapeAborted = false;
let userTabId = null;
let activeScrapeTabs = [];

// --- Randomness helpers ---

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay(minMs, maxMs) {
  const ms = randomInt(minMs, maxMs);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parsePublishedLabel(label) {
  if (!label) return null;
  const match = label.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = {
    second: 1000, minute: 60000, hour: 3600000,
    day: 86400000, week: 604800000, month: 2592000000, year: 31536000000
  };
  return Date.now() - num * (multipliers[unit] || 0);
}

// --- Progress messaging ---

function sendProgress(data) {
  try { chrome.runtime.sendMessage({ action: 'SCRAPE_PROGRESS', ...data }); } catch (e) {}
}

// --- Tab helpers ---

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise(resolve => {
    const listener = (tid, changeInfo) => {
      if (tid === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(true); }, timeoutMs);
  });
}

function waitForTabComplete(tabId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 600); // brief settle after complete
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}


async function openTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: true }, tab => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      activeScrapeTabs.push(tab.id);
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(tab); }, 30000);
    });
  });
}

async function closeTab(tabId) {
  activeScrapeTabs = activeScrapeTabs.filter(id => id !== tabId);
  try { await chrome.tabs.remove(tabId); } catch (e) {}
  if (userTabId) {
    try { await chrome.tabs.update(userTabId, { active: true }); } catch (e) {}
  }
}

async function forceCloseAllScrapeTabs() {
  for (const tabId of activeScrapeTabs) {
    try { await chrome.tabs.remove(tabId); } catch (e) {}
  }
  activeScrapeTabs = [];
  if (userTabId) {
    try { await chrome.tabs.update(userTabId, { active: true }); } catch (e) {}
  }
}

async function injectScraper(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scraper.js']
    });
    return results?.[0]?.result || null;
  } catch (err) {
    console.error(`[vInder] Scraper injection failed:`, err.message);
    return null;
  }
}

// --- Sidebar reading ---

async function waitForSidebar(tabId) {
  for (let i = 0; i < 15; i++) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const sections = document.querySelectorAll('ytd-guide-section-renderer');
        for (const s of sections) {
          for (const a of s.querySelectorAll('a')) {
            if (a.href && a.href.includes('/feed/subscriptions')) return true;
          }
        }
        return false;
      }
    });
    if (results?.[0]?.result) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function expandAndReadSidebar(tabId) {
  // Step 1: Open guide + click "Show more"
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Ensure guide drawer is open
      const drawer = document.querySelector('tp-yt-app-drawer');
      if (drawer && !drawer.hasAttribute('opened')) {
        const btn = document.querySelector('#guide-button button');
        if (btn) btn.click();
      }
      // Find subscriptions section by /feed/subscriptions link and click expander
      const sections = document.querySelectorAll('ytd-guide-section-renderer');
      for (const section of sections) {
        for (const a of section.querySelectorAll('a')) {
          if (a.href && a.href.includes('/feed/subscriptions')) {
            const expander = section.querySelector('ytd-guide-collapsible-entry-renderer #expander-item');
            if (expander) expander.click();
            return;
          }
        }
      }
    }
  });

  await randomDelay(1500, 2000);

  // Step 2: Read all entries
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (threshold) => {
      // Find subscriptions section
      const sections = document.querySelectorAll('ytd-guide-section-renderer');
      let subSection = null;
      for (const section of sections) {
        for (const a of section.querySelectorAll('a')) {
          if (a.href && a.href.includes('/feed/subscriptions')) {
            subSection = section;
            break;
          }
        }
        if (subSection) break;
      }
      if (!subSection) return { error: 'Subscriptions section not found', channels: [] };

      const entries = subSection.querySelectorAll('ytd-guide-entry-renderer');
      const channels = [];
      let consecutiveStale = 0;

      for (const entry of entries) {
        const title = entry.querySelector('yt-formatted-string')?.textContent?.trim() || '';
        const link = entry.querySelector('a')?.href || '';
        if (!link || link.includes('/feed/') || !title || title === 'Show more' || title === 'Show less' || title === 'Subscriptions') continue;

        // "dot" = new content, "badge" = live streaming, "none"/other = stale
        const lineEndStyle = entry.getAttribute('line-end-style');
        const isActive = lineEndStyle === 'dot' || lineEndStyle === 'badge';
        const isLive = lineEndStyle === 'badge';

        if (isActive) {
          consecutiveStale = 0;
          try {
            channels.push({
              channelName: title,
              channelUrl: link,
              channelId: new URL(link).pathname.replace(/^\//, ''),
              isLiveChannel: isLive
            });
          } catch (e) {}
        } else {
          consecutiveStale++;
          if (consecutiveStale >= threshold) break;
        }
      }

      const liveCount = channels.filter(c => c.isLiveChannel).length;
      return { channels, totalEntries: entries.length, liveCount };
    },
    args: [CONSECUTIVE_STALE_THRESHOLD]
  });

  const data = results?.[0]?.result;
  if (!data || data.error) return data || { error: 'Script failed', channels: [] };

  console.log(`[vInder] Sidebar: ${data.totalEntries} entries, ${data.channels.length} active (${data.liveCount} live)`);
  return data;
}

// --- Channel scraping ---

async function inlineVideoScrape(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const elements = document.querySelectorAll('ytd-rich-item-renderer');
        const items = [];
        const seen = new Set();
        elements.forEach(el => {
          const linkEl = el.querySelector('a.ytLockupMetadataViewModelTitle') || el.querySelector('a#video-title-link, a#video-title');
          if (!linkEl) return;
          const href = linkEl.getAttribute('href') || '';
          const m = href.match(/[?&]v=([^&]+)/);
          if (!m || seen.has(m[1])) return;
          seen.add(m[1]);
          const meta = el.querySelector('.ytContentMetadataViewModelMediumText') || el.querySelector('#metadata-line span:last-child');
          const rawMeta = meta?.textContent?.trim() || '';
          const parts = rawMeta.split('•').map(s => s.trim());
          const timePart = parts.length > 1 ? parts[parts.length - 1] : rawMeta;
          const publishedLabel = timePart.replace(/^Streamed\s+/i, '').trim();
          const isLive = /\bLIVE\b|watching now/i.test(rawMeta);
          const isStreamed = /\bStreamed\b/i.test(rawMeta);
          const img = el.querySelector('img');
          items.push({
            videoId: m[1],
            title: linkEl.textContent.trim() || 'Untitled',
            thumbnail: img ? (img.getAttribute('src') || '') : '',
            publishedLabel,
            url: 'https://www.youtube.com/watch?v=' + m[1],
            type: (isLive || isStreamed) ? 'stream' : 'video',
            isLive
          });
        });
        return { items, rendererCount: elements.length };
      }
    });
    return results?.[0]?.result || null;
  } catch (err) {
    console.error('[vInder] Inline scrape failed:', err.message);
    return null;
  }
}

async function scrapeChannelPage(channelUrl, pageType) {
  if (scrapeAborted) return null;
  const url = channelUrl.replace(/\/$/, '') + '/' + pageType;
  let tab;
  try {
    tab = await openTab(url);
    await randomDelay(2000, 3000);

    // Try file-based scraper first
    let data = await injectScraper(tab.id);
    let count = data?.items?.length || 0;

    // If file scraper returned nothing, try inline fallback
    if (count === 0) {
      console.log(`[vInder] File scraper returned 0 for ${url}, trying inline...`);
      await randomDelay(1000, 2000);
      const inline = await inlineVideoScrape(tab.id);
      if (inline && inline.items.length > 0) {
        console.log(`[vInder] Inline scraper found ${inline.items.length} items (renderers: ${inline.rendererCount})`);
        data = { type: pageType, items: inline.items };
        count = inline.items.length;
      } else {
        console.log(`[vInder] Inline also returned 0 (renderers: ${inline?.rendererCount || 0})`);
      }
    }

    console.log(`[vInder] ${url} → ${count} items`);
    return data;
  } catch (err) {
    console.error(`[vInder] Failed: ${url}:`, err.message);
    return null;
  } finally {
    if (tab) await closeTab(tab.id);
  }
}

async function scrapeChannelAndQueue(channel, logEntry, settings) {
  const allItems = [];

  for (const pageType of ['videos', 'streams']) {
    if (scrapeAborted) break;
    const data = await scrapeChannelPage(channel.channelUrl, pageType);
    if (data?.items) {
      data.items.forEach(item => {
        item.channelName = channel.channelName;
        item.channelId = channel.channelId;
      });
      allItems.push(...data.items);
    }
    await randomDelay(500, 1000);
  }

  logEntry.channelsProcessed++;
  console.log(`[vInder] ${channel.channelName}: ${allItems.length} items scraped`);

  // Delta detection
  const maxAgeMs = settings.maxAgeDays * 86400000;
  const snapshots = await getSnapshots();
  const snapshot = snapshots[channel.channelId];
  const previousIds = new Set(snapshot?.lastVideoIds || []);
  const currentIds = allItems.map(i => i.videoId);

  const processedResult = await chrome.storage.local.get(StorageKeys.PROCESSED_ITEMS);
  const processedItems = processedResult[StorageKeys.PROCESSED_ITEMS] || {};

  const newItems = [];
  let skipKnown = 0, skipProcessed = 0, skipOld = 0;
  for (const item of allItems) {
    if (previousIds.has(item.videoId)) { skipKnown++; continue; }
    if (processedItems[item.videoId] === 'watched' || processedItems[item.videoId] === 'ignored') { skipProcessed++; continue; }
    const publishedDate = parsePublishedLabel(item.publishedLabel);
    if (publishedDate && (Date.now() - publishedDate) > maxAgeMs) { skipOld++; continue; }
    newItems.push({ ...item, addedAt: Date.now() });
  }
  console.log(`[vInder] Delta: ${allItems.length} total, ${newItems.length} new, ${skipKnown} known, ${skipProcessed} processed, ${skipOld} old`);

  logEntry.channelResults.push({
    name: channel.channelName,
    scraped: allItems.length,
    new: newItems.length,
    known: skipKnown,
    old: skipOld
  });

  await saveSnapshot(channel.channelId, currentIds);

  if (newItems.length > 0) {
    const added = await addToQueue(newItems);
    logEntry.newItemsFound += added;
    try { chrome.runtime.sendMessage({ action: 'QUEUE_UPDATED' }); } catch (e) {}
  }

  return newItems.length;
}

// --- Main scan ---

async function runScrape() {
  if (scrapeInProgress) {
    console.log('[vInder] Scrape already in progress');
    return;
  }
  scrapeInProgress = true;
  scrapeAborted = false;
  activeScrapeTabs = [];

  const logEntry = { timestamp: Date.now(), channelsProcessed: 0, newItemsFound: 0, errors: [], channelResults: [] };

  // Save user's active tab for focus restoration
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    userTabId = activeTab?.id || null;
  } catch (e) { userTabId = null; }

  const scrapeSettings = await getSettings();
  const scrapeAccountName = scrapeSettings.confirmedAccountName || null;
  sendProgress({ phase: 'starting', message: `Opening YouTube${scrapeAccountName ? ` as "${scrapeAccountName}"` : ''}...` });

  try {
    // Step 1: Open YouTube (active session — ?authuser doesn't work in extension tabs)
    const ytTab = await openTab('https://www.youtube.com/');
    await randomDelay(3000, 4000); // extra wait — account switch needs time to settle

    // Diagnostic: confirm which account actually loaded
    const diagResult = await chrome.scripting.executeScript({
      target: { tabId: ytTab.id }, world: 'MAIN',
      func: () => ({
        name: window.ytcfg?.get?.('USER_DISPLAY_NAME') || null,
        idx: window.ytcfg?.get?.('SESSION_INDEX') ?? -1
      })
    }).catch(() => [{ result: { name: null, idx: -1 } }]);
    const diag = diagResult?.[0]?.result || {};
    sendProgress({ phase: 'reading_sidebar', message: `Tab loaded as: ${diag.name || 'unknown'} (SESSION_INDEX=${diag.idx}) — waiting for sidebar...` });
    const sidebarOk = await waitForSidebar(ytTab.id);
    if (!sidebarOk) {
      logEntry.errors.push('Sidebar did not load');
      sendProgress({ phase: 'error', message: 'YouTube sidebar did not load' });
      return;
    }

    sendProgress({ phase: 'reading_sidebar', message: 'Reading subscriptions...' });
    const sidebar = await expandAndReadSidebar(ytTab.id);
    await closeTab(ytTab.id);

    if (sidebar.error) {
      logEntry.errors.push(sidebar.error);
      sendProgress({ phase: 'error', message: sidebar.error });
      return;
    }

    const channels = sidebar.channels;
    if (channels.length === 0) {
      sendProgress({ phase: 'done', message: 'No channels with new content', percent: 100 });
      return;
    }

    console.log(`[vInder] Found ${channels.length} channels with newness dots`);
    sendProgress({ phase: 'channels_found', message: `Found ${channels.length} channels with new content`, totalChannels: channels.length });

    // Step 2: Scrape each channel
    const settings = await getSettings();
    const shuffled = shuffleArray(channels);

    for (let i = 0; i < shuffled.length; i++) {
      if (scrapeAborted) break;

      const channel = shuffled[i];
      sendProgress({
        phase: 'scraping',
        message: `Scanning ${channel.channelName}`,
        channelsDone: i + 1,
        totalChannels: shuffled.length,
        percent: Math.round(((i + 1) / shuffled.length) * 100)
      });

      try {
        const newCount = await scrapeChannelAndQueue(channel, logEntry, settings);
        if (newCount > 0) {
          sendProgress({
            phase: 'scraping',
            message: `+${newCount} new from ${channel.channelName}`,
            channelsDone: i + 1,
            totalChannels: shuffled.length,
            percent: Math.round(((i + 1) / shuffled.length) * 100)
          });
        }
      } catch (err) {
        logEntry.errors.push(`${channel.channelName}: ${err.message}`);
        console.error(`[vInder] Error: ${channel.channelName}:`, err);
      }

      if (i < shuffled.length - 1 && !scrapeAborted) {
        await randomDelay(2000, 4000);
      }
    }

    const msg = scrapeAborted
      ? `Stopped — ${logEntry.newItemsFound} videos from ${logEntry.channelsProcessed} channels`
      : `Done — ${logEntry.newItemsFound} new video${logEntry.newItemsFound !== 1 ? 's' : ''} from ${logEntry.channelsProcessed} channels`;
    sendProgress({ phase: 'done', message: msg, percent: 100, newItems: logEntry.newItemsFound });

  } catch (err) {
    logEntry.errors.push(`Fatal: ${err.message}`);
    console.error('[vInder] Fatal error:', err);
    sendProgress({ phase: 'error', message: `Error: ${err.message}` });
  } finally {
    await forceCloseAllScrapeTabs();
    userTabId = null;
    scrapeInProgress = false;
    await addScrapeLog(logEntry);
    console.log('[vInder] Scan complete:', logEntry);
    try { chrome.runtime.sendMessage({ action: 'QUEUE_UPDATED' }); } catch (e) {}
  }
}

// --- YouTube Playlist Push (API-based, no tabs needed) ---

let pushInProgress = false;
let pushAborted = false;

function sendPushProgress(data) {
  try { chrome.runtime.sendMessage({ action: 'PUSH_PROGRESS', ...data }); } catch (e) {}
}

// Capture the exact InnerTube request BODY that YouTube builds for this session/channel.
// YouTube dynamically constructs the context (including brand-account routing) at request time,
// so reading ytcfg fields like DELEGATED_SESSION_ID or INNERTUBE_CONTEXT.user is not enough —
// the live request body is the only reliable source of truth.
function captureYouTubeInnerTubeContext(tabId) {
  return new Promise((resolve) => {
    const tid = setTimeout(() => {
      try { chrome.webRequest.onBeforeRequest.removeListener(onRequest); } catch (e) {}
      resolve(null);
    }, 12000);

    function onRequest(details) {
      if (details.tabId !== tabId) return;
      const raw = details.requestBody?.raw;
      if (!raw?.length) return;
      try {
        const bytes = raw.reduce((acc, chunk) => {
          const part = new Uint8Array(chunk.bytes);
          const merged = new Uint8Array(acc.length + part.length);
          merged.set(acc); merged.set(part, acc.length);
          return merged;
        }, new Uint8Array(0));
        const body = JSON.parse(new TextDecoder().decode(bytes));
        // Only accept a fully-formed context with at least a client object
        if (body?.context?.client?.clientName) {
          clearTimeout(tid);
          try { chrome.webRequest.onBeforeRequest.removeListener(onRequest); } catch (e) {}
          resolve(body.context);
        }
      } catch (e) {}
    }

    chrome.webRequest.onBeforeRequest.addListener(
      onRequest,
      { urls: ['https://www.youtube.com/youtubei/v1/*'] },
      ['requestBody']
    );
  });
}

// Capture ALL request headers from YouTube's first authenticated InnerTube request on this tab.
// This preserves brand-account-specific routing headers like X-Goog-PageId that we can't
// derive from ytcfg alone, and that the InnerTube API uses to route requests to the right channel.
function captureYouTubeHeaders(tabId) {
  return new Promise((resolve) => {
    const tid = setTimeout(() => {
      try { chrome.webRequest.onBeforeSendHeaders.removeListener(onHeaders); } catch (e) {}
      resolve(null);
    }, 12000);

    function onHeaders(details) {
      if (details.tabId !== tabId) return;
      const hdrs = details.requestHeaders || [];
      // Only accept requests with a SAPISIDHASH Authorization header (authenticated InnerTube calls)
      if (!hdrs.some(h => h.name.toLowerCase() === 'authorization' && h.value?.startsWith('SAPISIDHASH'))) return;
      clearTimeout(tid);
      try { chrome.webRequest.onBeforeSendHeaders.removeListener(onHeaders); } catch (e) {}
      resolve(hdrs);
    }

    chrome.webRequest.onBeforeSendHeaders.addListener(
      onHeaders,
      { urls: ['https://www.youtube.com/youtubei/v1/*'] },
      ['requestHeaders', 'extraHeaders']
    );
  });
}

async function getYouTubeAuth(tabId) {
  // Compute everything in the page's MAIN world so SAPISID is read from the live session cookies.
  // Service-worker cookie access can be stale when the session switches accounts (?authuser=N).
  // SAPISID is not HttpOnly on youtube.com — YouTube's own scripts read it for SAPISIDHASH.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      const apiKey = window.ytcfg?.get?.('INNERTUBE_API_KEY');
      const clientVersion = window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION');
      const sessionIndex = window.ytcfg?.get?.('SESSION_INDEX') ?? 0;
      if (!apiKey) return null;

      const origin = 'https://www.youtube.com';

      // Read SAPISID from document.cookie (not HttpOnly — accessible to same-origin JS)
      let sapisid = null;
      for (const prefix of ['__Secure-3PAPISID=', 'SAPISID=', '__Secure-1PAPISID=']) {
        const part = (document.cookie || '').split('; ').find(c => c.startsWith(prefix));
        if (part) { sapisid = part.split('=').slice(1).join('='); break; }
      }
      if (!sapisid) sapisid = window.ytcfg?.get?.('SAPISID') || null;
      if (!sapisid) return null;

      // INNERTUBE_CONTEXT.user carries onBehalfOfUser when the active YouTube channel is a
      // brand/delegated account. Without it, playlist creation falls through to the primary
      // Google account's default channel (Alexander Markow) instead of KoR-Blitz.
      let userContext = null;
      try {
        const raw = window.ytcfg?.get?.('INNERTUBE_CONTEXT');
        if (raw?.user && typeof raw.user === 'object') {
          userContext = JSON.parse(JSON.stringify(raw.user));
        }
      } catch (e) { /* not serialisable — skip */ }

      // Fallback: DELEGATED_SESSION_ID is the older per-request brand-account token
      const delegatedSessionId = window.ytcfg?.get?.('DELEGATED_SESSION_ID') || null;

      const displayName = window.ytcfg?.get?.('USER_DISPLAY_NAME') || null;

      const timestamp = Math.floor(Date.now() / 1000);
      const data = new TextEncoder().encode(`${timestamp} ${sapisid} ${origin}`);
      const buf = await crypto.subtle.digest('SHA-1', data);
      const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      return { apiKey, clientVersion, sessionIndex, userContext, delegatedSessionId, displayName, authHeader: `SAPISIDHASH ${timestamp}_${hash}`, origin };
    }
  });

  const auth = results?.[0]?.result || null;
  if (auth) return auth;

  // Fallback: service-worker cookie access (for cases where MAIN world execution fails)
  const pageBase = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => ({
      apiKey: window.ytcfg?.get?.('INNERTUBE_API_KEY'),
      clientVersion: window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION'),
      sessionIndex: window.ytcfg?.get?.('SESSION_INDEX') ?? 0
    })
  });
  const { apiKey, clientVersion, sessionIndex } = pageBase?.[0]?.result || {};
  if (!apiKey) return null;

  let sapisid = null;
  for (const name of ['__Secure-3PAPISID', 'SAPISID', '__Secure-1PAPISID']) {
    const c = await chrome.cookies.get({ url: 'https://www.youtube.com', name });
    if (c?.value) { sapisid = c.value; break; }
  }
  if (!sapisid) return null;

  const timestamp = Math.floor(Date.now() / 1000);
  const origin = 'https://www.youtube.com';
  const data = new TextEncoder().encode(`${timestamp} ${sapisid} ${origin}`);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { apiKey, clientVersion, sessionIndex, authHeader: `SAPISIDHASH ${timestamp}_${hash}`, origin };
}

async function createPlaylist(tabId, auth, name, firstVideoId) {
  // Fetch must run inside the YouTube tab (MAIN world) so the browser sends session cookies
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (auth, name, firstVideoId) => {
      try {
        // Start from YouTube's captured headers (preserves X-Goog-PageId and other brand-account
        // routing headers), then override with freshly computed values for our request.
        const headers = {};
        if (auth.capturedHeaders) {
          for (const h of auth.capturedHeaders) {
            const lname = h.name.toLowerCase();
            if (lname === 'content-type' || lname === 'content-length' || lname === 'authorization') continue;
            headers[h.name] = h.value;
          }
        }
        headers['Content-Type'] = 'application/json; charset=UTF-8';
        headers['Authorization'] = auth.authHeader;
        if (!headers['X-Origin']) headers['X-Origin'] = auth.origin;
        if (!headers['X-Youtube-Client-Name']) headers['X-Youtube-Client-Name'] = '1';
        if (!headers['X-Youtube-Client-Version']) headers['X-Youtube-Client-Version'] = auth.clientVersion;
        // Prefer the context captured from YouTube's own page requests (most accurate for brand
        // accounts); fall back to ytcfg-derived context or a plain client-only context.
        const userCtx = auth.userContext
          || (auth.delegatedSessionId ? { onBehalfOfUser: auth.delegatedSessionId } : null);
        const context = auth.innerTubeContext || {
          client: { clientName: 'WEB', clientVersion: auth.clientVersion },
          ...(userCtx ? { user: userCtx } : {})
        };
        const response = await fetch(
          `https://www.youtube.com/youtubei/v1/playlist/create?prettyPrint=false&key=${auth.apiKey}`,
          {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({
              context,
              title: name,
              privacyStatus: 'UNLISTED',
              videoIds: firstVideoId ? [firstVideoId] : undefined
            })
          }
        );
        const text = await response.text();
        const idMatch = text.match(/"playlistId":"([^"]+)"/);
        return { ok: response.ok, status: response.status, playlistId: idMatch?.[1] || null, raw: text.substring(0, 400) };
      } catch (e) {
        return { ok: false, status: 0, playlistId: null, raw: e.message };
      }
    },
    args: [auth, name, firstVideoId]
  });
  return results?.[0]?.result || null;
}

async function addVideoToPlaylistAPI(tabId, auth, playlistId, videoId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (auth, playlistId, videoId) => {
      try {
        const headers = {};
        if (auth.capturedHeaders) {
          for (const h of auth.capturedHeaders) {
            const lname = h.name.toLowerCase();
            if (lname === 'content-type' || lname === 'content-length' || lname === 'authorization') continue;
            headers[h.name] = h.value;
          }
        }
        headers['Content-Type'] = 'application/json; charset=UTF-8';
        headers['Authorization'] = auth.authHeader;
        if (!headers['X-Origin']) headers['X-Origin'] = auth.origin;
        if (!headers['X-Youtube-Client-Name']) headers['X-Youtube-Client-Name'] = '1';
        if (!headers['X-Youtube-Client-Version']) headers['X-Youtube-Client-Version'] = auth.clientVersion;
        const userCtx = auth.userContext
          || (auth.delegatedSessionId ? { onBehalfOfUser: auth.delegatedSessionId } : null);
        const context = auth.innerTubeContext || {
          client: { clientName: 'WEB', clientVersion: auth.clientVersion },
          ...(userCtx ? { user: userCtx } : {})
        };
        const response = await fetch(
          `https://www.youtube.com/youtubei/v1/browse/edit_playlist?prettyPrint=false&key=${auth.apiKey}`,
          {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({
              context,
              playlistId,
              actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }]
            })
          }
        );
        const text = await response.text();
        return { ok: response.ok, status: response.status, raw: text.substring(0, 200) };
      } catch (e) {
        return { ok: false, status: 0, raw: e.message };
      }
    },
    args: [auth, playlistId, videoId]
  });
  return results?.[0]?.result || null;
}

async function pushToYouTubePlaylist(videos, playlistName) {
  if (pushInProgress) return { error: 'Push already in progress' };
  pushInProgress = true;
  pushAborted = false;

  const results = { saved: 0, failed: 0, errors: [] };
  let ytTab = null;

  try {
    const settings0 = await getSettings();
    const confirmedName = settings0.confirmedAccountName || null;
    sendPushProgress({ phase: 'starting', message: `Connecting to YouTube${confirmedName ? ` as "${confirmedName}"` : ''}...` });

    // Create the tab first so we have its ID before the page makes any InnerTube requests.
    // We can't use openTab() here because it awaits status='complete' — by then the initial
    // requests are already done. Instead we grab the ID from the create callback immediately,
    // set up the tab-filtered webRequest listener, then wait for load completion separately.
    const { earlyTabId, loadPromise } = await new Promise((resolve, reject) => {
      chrome.tabs.create({ url: 'https://www.youtube.com/', active: true }, (tab) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        activeScrapeTabs.push(tab.id);
        const lp = new Promise((res) => {
          const onUpdated = (tabId, changeInfo) => {
            if (tabId === tab.id && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              res(tab);
            }
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
        });
        resolve({ earlyTabId: tab.id, loadPromise: lp });
      });
    });
    ytTab = { id: earlyTabId };

    // Both listeners filtered to our specific tab, started before the page loads so they
    // catch the InnerTube requests YouTube fires during initial page load.
    const headersPromise = captureYouTubeHeaders(earlyTabId);
    const contextPromise = captureYouTubeInnerTubeContext(earlyTabId);

    // Wait for the page to fully load, then let it settle
    ytTab = await loadPromise;
    await randomDelay(1500, 2000);

    // Collect both captures — should have fired during page load
    const capturedHeaders = await Promise.race([headersPromise, new Promise(r => setTimeout(() => r(null), 1000))]);
    const capturedContext = await Promise.race([contextPromise,  new Promise(r => setTimeout(() => r(null), 500))]);

    // Get auth credentials
    const auth = await getYouTubeAuth(ytTab.id);
    if (!auth) {
      sendPushProgress({ phase: 'error', message: 'Could not get YouTube auth — are you logged in?' });
      return { error: 'Auth failed' };
    }

    if (capturedHeaders) {
      auth.capturedHeaders = capturedHeaders;
      const authUserHdr = capturedHeaders.find(h => h.name.toLowerCase() === 'x-goog-authuser');
      if (authUserHdr?.value !== undefined) auth.authUser = authUserHdr.value;
    }
    if (capturedContext) auth.innerTubeContext = capturedContext;

    const pageIdHdr = capturedHeaders?.find(h => h.name.toLowerCase() === 'x-goog-pageid');
    const diagParts = [
      auth.displayName ? `user=${auth.displayName}` : null,
      auth.authUser !== undefined ? `authUser=${auth.authUser}` : 'no authUser',
      auth.innerTubeContext?.user?.onBehalfOfUser
        ? `onBehalf=${auth.innerTubeContext.user.onBehalfOfUser.slice(0, 10)}…`
        : (auth.userContext?.onBehalfOfUser ? `ytcfg-onBehalf=${auth.userContext.onBehalfOfUser.slice(0, 10)}…` : null),
      auth.delegatedSessionId ? `delegated=${auth.delegatedSessionId.slice(0, 8)}…` : null,
      capturedContext ? 'ctx=captured' : 'ctx=none',
      capturedHeaders ? `hdrs=captured(${capturedHeaders.length})` : 'hdrs=none',
      pageIdHdr ? `pageId=${pageIdHdr.value.slice(0, 10)}…` : 'no-pageId',
    ].filter(Boolean).join(', ');
    const diagMsg = `Auth — ${diagParts}`;
    const capturedHeaderNames = capturedHeaders?.map(h => h.name).join(', ') || 'none';
    console.log('[vInder] push', diagMsg, JSON.stringify({
      capturedContextUser: capturedContext?.user,
      ytcfgUser: auth.userContext,
      delegatedSessionId: auth.delegatedSessionId,
      capturedHeaderNames,
      pageId: pageIdHdr?.value || null
    }));
    sendPushProgress({ phase: 'info', message: diagMsg });

    // Create playlist seeded with the first video (empty playlists may not persist)
    const settings = await getSettings();
    sendPushProgress({ phase: 'starting', message: `Creating playlist "${playlistName}"...` });
    const firstVideoId = videos[0]?.videoId;
    const created = await createPlaylist(ytTab.id, auth, playlistName, firstVideoId);
    if (!created?.playlistId) {
      const detail = created?.raw ? ` (HTTP ${created?.status}: ${created?.raw})` : ` (HTTP ${created?.status ?? '?'})`;
      sendPushProgress({ phase: 'error', message: `Failed to create playlist${detail}` });
      return { error: 'Playlist creation failed' };
    }
    const playlistId = created.playlistId;
    settings.playlistId = playlistId;
    await saveSettings(settings);
    console.log(`[vInder] Created playlist "${playlistName}" → ${playlistId}`);

    // First video was seeded at creation; count it and start loop at index 1
    if (firstVideoId) results.saved++;

    // Add remaining videos via API — refresh auth every 10 videos to prevent token expiry
    let currentAuth = auth;
    for (let i = 1; i < videos.length; i++) {
      if (pushAborted) break;
      const video = videos[i];

      // Refresh auth every 10 videos — preserve captured headers/context from initial page load
      if (i > 0 && i % 10 === 0) {
        const freshAuth = await getYouTubeAuth(ytTab.id);
        if (freshAuth) {
          freshAuth.capturedHeaders = currentAuth.capturedHeaders;
          freshAuth.innerTubeContext = currentAuth.innerTubeContext;
          freshAuth.authUser = currentAuth.authUser;
          currentAuth = freshAuth;
        }
      }

      sendPushProgress({
        phase: 'pushing',
        message: `Adding "${video.title?.substring(0, 35)}..." (${i + 1}/${videos.length})`,
        current: i + 1,
        total: videos.length,
        percent: Math.round(((i + 1) / videos.length) * 100)
      });

      try {
        const result = await addVideoToPlaylistAPI(ytTab.id, currentAuth, playlistId, video.videoId);
        if (result?.ok) {
          results.saved++;
        } else {
          // If auth expired (401/403), refresh and retry once — preserve captures
          if (result?.status === 401 || result?.status === 403) {
            const retryAuth = await getYouTubeAuth(ytTab.id);
            if (retryAuth) {
              retryAuth.capturedHeaders = currentAuth.capturedHeaders;
              retryAuth.innerTubeContext = currentAuth.innerTubeContext;
              retryAuth.authUser = currentAuth.authUser;
              currentAuth = retryAuth;
              const retry = await addVideoToPlaylistAPI(ytTab.id, currentAuth, playlistId, video.videoId);
              if (retry?.ok) { results.saved++; continue; }
            }
          }
          results.failed++;
          const errDetail = `HTTP ${result?.status}${result?.raw ? ': ' + result.raw : ''}`;
          results.errors.push(`${video.title}: ${errDetail}`);
          console.error(`[vInder] Push failed: ${video.title} → ${errDetail}`);
        }
      } catch (err) {
        results.failed++;
        results.errors.push(`${video.title}: ${err.message}`);
      }

      // Small delay between API calls to avoid rate limiting
      if (i < videos.length - 1 && !pushAborted) {
        await randomDelay(500, 1000);
      }
    }

    const playlistUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
    const firstErr = results.errors[0] ? ` | ${results.errors[0].substring(0, 120)}` : '';
    const msg = pushAborted
      ? `Stopped — ${results.saved} added | ${playlistUrl}`
      : `Done — ${results.saved} added to "${playlistName}"${results.failed ? ', ' + results.failed + ' failed' + firstErr : ''} | ${playlistUrl}`;
    sendPushProgress({ phase: results.failed && !results.saved ? 'error' : 'done', message: msg, percent: 100 });



  } catch (err) {
    results.errors.push(err.message);
    sendPushProgress({ phase: 'error', message: `Error: ${err.message}` });
  } finally {
    if (ytTab) await closeTab(ytTab.id);
    pushInProgress = false;
  }

  return results;
}

// --- Diagnostics ---

async function runDiagnostics() {
  const results = [];
  const pass = (l, v) => results.push({ status: 'pass', label: l, value: v });
  const fail = (l, v) => results.push({ status: 'fail', label: l, value: v });
  const warn = (l, v) => results.push({ status: 'warn', label: l, value: v });
  let tab;

  const diagSettings = await getSettings();
  const diagAuthuser = diagSettings.accountIndex ?? 0;

  try {
    // Test 1: Open YouTube
    tab = await openTab(`https://www.youtube.com/?authuser=${diagAuthuser}`);
    await randomDelay(2000, 3000);

    const sidebarOk = await waitForSidebar(tab.id);
    sidebarOk ? pass('Sidebar loads', 'Found') : fail('Sidebar loads', 'Not found after 15s');

    if (sidebarOk) {
      // Test 2: Read subscriptions
      const sidebar = await expandAndReadSidebar(tab.id);
      if (sidebar.error) {
        fail('Subscriptions', sidebar.error);
      } else {
        const liveCount = sidebar.channels.filter(c => c.isLiveChannel).length;
        const dotCount = sidebar.channels.length - liveCount;
        pass('Subscriptions', `${dotCount} new + ${liveCount} live = ${sidebar.channels.length} channels`);

        if (sidebar.channels.length > 0) {
          // Test 3: Scrape a channel
          const testCh = sidebar.channels[0];
          await closeTab(tab.id);
          tab = await openTab(testCh.channelUrl + '/videos');
          await randomDelay(2000, 3000);

          // Test 4: Video renderers
          const rResult = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.querySelectorAll('ytd-rich-item-renderer').length
          });
          const rCount = rResult?.[0]?.result || 0;
          rCount > 0 ? pass('Video renderers', `${rCount} found`) : fail('Video renderers', '0 found');

          // Test 5: Title selector
          const tResult = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const el = document.querySelector('ytd-rich-item-renderer');
              if (!el) return null;
              const a = el.querySelector('a.ytLockupMetadataViewModelTitle') || el.querySelector('a#video-title-link');
              return a ? { title: a.textContent.trim().substring(0, 40), href: a.getAttribute('href') } : null;
            }
          });
          const tData = tResult?.[0]?.result;
          tData ? pass('Title selector', `"${tData.title}"`) : fail('Title selector', 'Not matched');

          if (tData?.href) {
            const vidMatch = tData.href.match(/[?&]v=([^&]+)/);
            vidMatch ? pass('Video URL', vidMatch[1]) : fail('Video URL', 'No video ID in href');
          }

          // Test 6: Metadata selector
          const mResult = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const el = document.querySelector('ytd-rich-item-renderer');
              if (!el) return null;
              const m = el.querySelector('.ytContentMetadataViewModelMediumText') || el.querySelector('#metadata-line span:last-child');
              return m ? m.textContent.trim().substring(0, 50) : null;
            }
          });
          mResult?.[0]?.result ? pass('Metadata', mResult[0].result) : fail('Metadata', 'Not found');

          // Test 7: Full scraper
          const scraperResult = await injectScraper(tab.id);
          if (scraperResult?.items?.length > 0) {
            pass('Full scraper', `${scraperResult.items.length} videos extracted`);
          } else {
            fail('Full scraper', `${scraperResult?.items?.length || 0} items`);
          }
        }
      }
    }
  } catch (err) {
    fail('Error', err.message);
  } finally {
    if (tab) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
      activeScrapeTabs = activeScrapeTabs.filter(id => id !== tab.id);
    }
    if (userTabId) {
      try { await chrome.tabs.update(userTabId, { active: true }); } catch (e) {}
    }
  }

  return { results, passed: results.every(r => r.status !== 'fail') };
}

// --- Lifecycle ---

chrome.runtime.onInstalled.addListener(() => {
  console.log('[vInder] Installed — use Scan button to run');
});

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// --- Message handler ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'RUN_NOW') {
    runScrape().then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
    return true;
  }
  if (message.action === 'STOP_SCAN') {
    scrapeAborted = true;
    forceCloseAllScrapeTabs();
    sendResponse({ success: true });
    return false;
  }
  if (message.action === 'GET_SCRAPE_STATUS') {
    sendResponse({ inProgress: scrapeInProgress });
    return false;
  }
  if (message.action === 'PUSH_TO_PLAYLIST') {
    const { videos, playlistName } = message;
    pushToYouTubePlaylist(videos, playlistName).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (message.action === 'STOP_PUSH') {
    pushAborted = true;
    forceCloseAllScrapeTabs();
    sendResponse({ success: true });
    return false;
  }
  if (message.action === 'RUN_DIAGNOSTICS') {
    runDiagnostics().then(r => sendResponse(r)).catch(e => sendResponse({ results: [{ status: 'fail', label: 'Error', value: e.message }], passed: false }));
    return true;
  }
  if (message.action === 'DETECT_ACCOUNTS') {
    detectYouTubeAccounts().then(async r => {
      const s = await getSettings();
      s.accountNames = r.accounts || [];
      // Preserve confirmed name if it still exists in the new list; update its index.
      // This prevents re-runs of Detect from losing the user's selection.
      if (s.confirmedAccountName) {
        const match = (r.accounts || []).find(a => a.name === s.confirmedAccountName);
        if (match) {
          s.accountIndex = match.index; // refresh index in case it shifted
        } else {
          s.confirmedAccountName = null; // account no longer detected — reset
          s.accountIndex = 0;
        }
      } else {
        s.accountIndex = 0;
      }
      await saveSettings(s);
      sendResponse(r);
    }).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (message.action === 'CONFIRM_ACCOUNT') {
    confirmAccount(message.selectedIndex ?? null).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

async function detectYouTubeAccounts() {
  // Open ONE tab (active YouTube session) and read all accounts from the Switch Account menu.
  // ?authuser=N probing is unreliable in Chrome extension tabs — all URLs open as the active session.
  let tab = null;
  try {
    tab = await openTab('https://www.youtube.com/');
    await randomDelay(2500, 3000);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        const GOOGLE_PHOTO = ['ggpht', 'googleusercontent'];
        const accounts = [];

        const avatarBtn = document.querySelector('#avatar-btn');
        if (!avatarBtn) return accounts;

        avatarBtn.click();
        await new Promise(r => setTimeout(r, 1200));

        // Click "Switch account" to expand the full account list
        const switchItem = Array.from(document.querySelectorAll('ytd-account-item-renderer, ytd-compact-link-renderer'))
          .find(el => el.textContent.trim().toLowerCase() === 'switch account');
        if (switchItem) {
          switchItem.click();
          await new Promise(r => setTimeout(r, 1000));
        }

        // Read every account item in order
        for (const item of document.querySelectorAll('ytd-account-item-renderer')) {
          const photoUrl = item.querySelector('yt-img-shadow')?.getAttribute('src')
                       || item.querySelector('img')?.src || '';
          if (!GOOGLE_PHOTO.some(d => photoUrl.includes(d))) continue;
          const name = Array.from(item.querySelectorAll('yt-formatted-string'))
            .map(el => el.textContent.trim())
            .find(t => t && t.length < 60 && !t.startsWith('@') && !/^\d|subscriber/i.test(t));
          if (name && !accounts.find(a => a.name === name)) {
            accounts.push({ index: accounts.length, name, photoUrl });
          }
        }

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, keyCode: 27 }));
        return accounts;
      }
    });

    return { accounts: results?.[0]?.result || [] };
  } finally {
    if (tab) await closeTab(tab.id);
  }
}

async function confirmAccount(selectedIndex) {
  const settings = await getSettings();
  const accountNames = settings.accountNames || [];

  if (!accountNames.length) return { name: null };

  // selectedIndex comes directly from the visually-selected card in the UI (most reliable source).
  // Fall back to stored accountIndex only if the UI didn't provide one.
  const idx = selectedIndex ?? settings.accountIndex ?? 0;
  const targetAccount = accountNames.find(a => a.index === idx) || accountNames[0];
  if (!targetAccount) return { name: null };

  const fresh = await getSettings();
  fresh.accountIndex = targetAccount.index;
  fresh.confirmedAccountName = targetAccount.name;
  await saveSettings(fresh);

  return { name: targetAccount.name, authuser: targetAccount.index };
}
