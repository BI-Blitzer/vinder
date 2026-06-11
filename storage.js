const StorageKeys = {
  CHANNEL_SNAPSHOTS: 'channelSnapshots',
  REVIEW_QUEUE: 'reviewQueue',
  PROCESSED_ITEMS: 'processedItems',
  WATCH_LATER: 'watchLater',
  SETTINGS: 'settings',
  SCRAPE_LOG: 'scrapeLog'
};

const DEFAULT_SETTINGS = {
  cadenceMinutes: 60,
  maxAgeDays: 5,
  playlistName: 'vInder',
  playlistId: null,
  accountIndex: 0,
  accountNames: null,
  confirmedAccountName: null
};

async function getSettings() {
  const result = await chrome.storage.local.get(StorageKeys.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...result[StorageKeys.SETTINGS] };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [StorageKeys.SETTINGS]: settings });
}

async function getQueue() {
  const [queueResult, processedResult] = await Promise.all([
    chrome.storage.local.get(StorageKeys.REVIEW_QUEUE),
    chrome.storage.local.get(StorageKeys.PROCESSED_ITEMS)
  ]);
  const queue = queueResult[StorageKeys.REVIEW_QUEUE] || [];
  const processed = processedResult[StorageKeys.PROCESSED_ITEMS] || {};
  return queue.filter(item => {
    const status = processed[item.videoId];
    return status !== 'watched' && status !== 'ignored';
  });
}

async function addToQueue(items) {
  const result = await chrome.storage.local.get(StorageKeys.REVIEW_QUEUE);
  const queue = result[StorageKeys.REVIEW_QUEUE] || [];
  const existingIds = new Set(queue.map(item => item.videoId));
  const newItems = items.filter(item => !existingIds.has(item.videoId));
  if (newItems.length > 0) {
    await chrome.storage.local.set({
      [StorageKeys.REVIEW_QUEUE]: [...queue, ...newItems]
    });
  }
  return newItems.length;
}

async function markItem(videoId, status) {
  const result = await chrome.storage.local.get(StorageKeys.PROCESSED_ITEMS);
  const processed = result[StorageKeys.PROCESSED_ITEMS] || {};
  processed[videoId] = status;
  await chrome.storage.local.set({ [StorageKeys.PROCESSED_ITEMS]: processed });
}

async function clearSkipped() {
  const result = await chrome.storage.local.get(StorageKeys.PROCESSED_ITEMS);
  const processed = result[StorageKeys.PROCESSED_ITEMS] || {};
  for (const [videoId, status] of Object.entries(processed)) {
    if (status === 'skipped') {
      delete processed[videoId];
    }
  }
  await chrome.storage.local.set({ [StorageKeys.PROCESSED_ITEMS]: processed });
}

async function getSnapshots() {
  const result = await chrome.storage.local.get(StorageKeys.CHANNEL_SNAPSHOTS);
  return result[StorageKeys.CHANNEL_SNAPSHOTS] || {};
}

async function saveSnapshot(channelId, videoIds) {
  const snapshots = await getSnapshots();
  snapshots[channelId] = {
    lastVideoIds: videoIds,
    lastRun: Date.now()
  };
  await chrome.storage.local.set({ [StorageKeys.CHANNEL_SNAPSHOTS]: snapshots });
}

async function getWatchLater() {
  const result = await chrome.storage.local.get(StorageKeys.WATCH_LATER);
  return result[StorageKeys.WATCH_LATER] || [];
}

async function addToWatchLater(item) {
  const list = await getWatchLater();
  if (list.some(v => v.videoId === item.videoId)) return false;
  list.push({ ...item, addedToWatchAt: Date.now() });
  await chrome.storage.local.set({ [StorageKeys.WATCH_LATER]: list });
  return true;
}

async function removeFromWatchLater(videoIds) {
  const idSet = new Set(videoIds);
  const list = await getWatchLater();
  const filtered = list.filter(item => !idSet.has(item.videoId));
  await chrome.storage.local.set({ [StorageKeys.WATCH_LATER]: filtered });
  return videoIds.length - (list.length - filtered.length);
}

async function addScrapeLog(entry) {
  const result = await chrome.storage.local.get(StorageKeys.SCRAPE_LOG);
  const log = result[StorageKeys.SCRAPE_LOG] || [];
  log.unshift(entry);
  await chrome.storage.local.set({
    [StorageKeys.SCRAPE_LOG]: log.slice(0, 5)
  });
}

async function getScrapeLog() {
  const result = await chrome.storage.local.get(StorageKeys.SCRAPE_LOG);
  return result[StorageKeys.SCRAPE_LOG] || [];
}

if (typeof module !== 'undefined') {
  module.exports = {
    StorageKeys, DEFAULT_SETTINGS, getSettings, saveSettings,
    getQueue, addToQueue, markItem, clearSkipped,
    getWatchLater, addToWatchLater, removeFromWatchLater,
    getSnapshots, saveSnapshot, addScrapeLog, getScrapeLog
  };
}
