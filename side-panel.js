let queue = [];
let currentIndex = 0;
let settingsVisible = false;
let listVisible = false;
let watchVisible = false;
let undoStack = [];

const cardContainer = document.getElementById('cardContainer');
const videoCard = document.getElementById('videoCard');
const emptyState = document.getElementById('emptyState');
const actionsBar = document.getElementById('actionsBar');
const queueBadge = document.getElementById('queueBadge');
const footerText = document.getElementById('footerText');
const settingsPanel = document.getElementById('settingsPanel');

const cardThumbnail = document.getElementById('cardThumbnail');
const cardTypeBadge = document.getElementById('cardTypeBadge');
const cardTitle = document.getElementById('cardTitle');
const cardChannel = document.getElementById('cardChannel');
const cardPublished = document.getElementById('cardPublished');

async function loadQueue(resetPosition = true) {
  const currentVideoId = queue[currentIndex]?.videoId;
  queue = await getQueue();

  if (resetPosition) {
    currentIndex = 0;
  } else {
    // Preserve position: find where the current video is in the new queue
    if (currentVideoId) {
      const newIdx = queue.findIndex(item => item.videoId === currentVideoId);
      currentIndex = newIdx >= 0 ? newIdx : Math.min(currentIndex, queue.length);
    }
  }

  updateUI();
  if (listVisible) renderQueueList();
}

function updateUI() {

  const remaining = queue.length - currentIndex;
  queueBadge.textContent = remaining;
  footerText.textContent = `${remaining} item${remaining !== 1 ? 's' : ''} remaining`;

  if (remaining <= 0) {
    videoCard.classList.add('hidden');
    actionsBar.classList.add('hidden');
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');
    showCard(queue[currentIndex]);
  }
}

function showCard(item) {
  videoCard.classList.remove('hidden', 'swipe-left', 'swipe-right', 'swipe-up');
  actionsBar.classList.remove('hidden');

  const thumbSrc = item.thumbnail || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
  cardThumbnail.src = thumbSrc;
  cardThumbnail.onerror = () => {
    cardThumbnail.src = `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
  };

  cardTitle.textContent = item.title;
  cardChannel.textContent = item.channelName;
  cardPublished.textContent = item.publishedLabel || '';

  // Watched progress bar + badge
  const progress = document.getElementById('cardProgress');
  const watchedBadge = document.getElementById('cardWatchedBadge');
  if (item.watchedPercent > 0) {
    progress.style.width = item.watchedPercent + '%';
    progress.style.display = 'block';
  } else {
    progress.style.display = 'none';
  }
  watchedBadge.style.display = item.watchedPercent >= 90 ? 'block' : 'none';

  if (item.isLive) {
    cardTypeBadge.textContent = 'LIVE';
    cardTypeBadge.className = 'type-badge live';
  } else if (item.type === 'stream') {
    cardTypeBadge.textContent = 'STREAM';
    cardTypeBadge.className = 'type-badge stream';
  } else {
    cardTypeBadge.textContent = 'VIDEO';
    cardTypeBadge.className = 'type-badge video';
  }

  void videoCard.offsetWidth;
  videoCard.style.transform = '';
  videoCard.style.opacity = '';
}

let actionInProgress = false;

async function handleAction(action) {
  if (actionInProgress) return;
  if (currentIndex >= queue.length) return;
  actionInProgress = true;

  const item = queue[currentIndex];
  const animClass = action === 'watched' ? 'swipe-right'
                  : action === 'ignored' ? 'swipe-left'
                  : 'swipe-up';

  videoCard.classList.add(animClass);

  if (action === 'watched') {
    await addToWatchLater(item);
  }

  undoStack.push({ videoId: item.videoId, action, index: currentIndex });
  await markItem(item.videoId, action);
  currentIndex++;

  setTimeout(() => {
    updateUI();
    actionInProgress = false;
  }, 300);
}

async function undoLast() {
  if (undoStack.length === 0) return;
  const last = undoStack.pop();

  // Remove the status from processedItems
  const result = await chrome.storage.local.get('processedItems');
  const processed = result.processedItems || {};
  delete processed[last.videoId];
  await chrome.storage.local.set({ processedItems: processed });

  // If it was a watch, also remove from watch later
  if (last.action === 'watched') {
    await removeFromWatchLater([last.videoId]);
  }

  // Reload queue from storage so the un-processed item reappears
  queue = await getQueue();
  // Find the item's position in the refreshed queue
  const idx = queue.findIndex(item => item.videoId === last.videoId);
  currentIndex = idx >= 0 ? idx : Math.min(last.index, queue.length);
  updateUI();
}

// Action button listeners
document.getElementById('btnWatch').addEventListener('click', () => handleAction('watched'));
document.getElementById('btnIgnore').addEventListener('click', () => handleAction('ignored'));
document.getElementById('btnSkip').addEventListener('click', () => handleAction('skipped'));
document.getElementById('btnUndo').addEventListener('click', () => undoLast());

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (settingsVisible) return;
  if (e.key === 'l' || e.key === 'L') { toggleListView(); return; }
  if (e.key === 'z' || e.key === 'Z') { undoLast(); return; }
  if (listVisible) return;
  if (e.key === 'ArrowRight' || e.key === 'w') handleAction('watched');
  else if (e.key === 'ArrowLeft' || e.key === 'x') handleAction('ignored');
  else if (e.key === 'ArrowDown' || e.key === 's') handleAction('skipped');
});

// Run / Stop buttons
let scanning = false;

async function triggerRun() {
  const btn = document.getElementById('btnRunNow');

  if (scanning) {
    // Stop the scan
    chrome.runtime.sendMessage({ action: 'STOP_SCAN' });
    btn.textContent = 'Stopping...';
    btn.disabled = true;
    return;
  }

  scanning = true;
  btn.textContent = 'Stop';
  btn.classList.add('running');

  try {
    chrome.runtime.sendMessage({ action: 'RUN_NOW' });
  } catch (e) {
    console.error('[vInder] Run failed:', e);
    scanning = false;
    btn.textContent = 'Scan';
    btn.classList.remove('running');
  }
}

document.getElementById('btnRunNow').addEventListener('click', triggerRun);
document.getElementById('btnEmptyRun').addEventListener('click', triggerRun);

// List view
const queueListPanel = document.getElementById('queueListPanel');

function hideAllPanels() {
  settingsVisible = false;
  listVisible = false;
  watchVisible = false;
  settingsPanel.classList.remove('visible');
  queueListPanel.classList.remove('visible');
  document.getElementById('watchPanel').classList.remove('visible');
  cardContainer.classList.remove('hidden');
  actionsBar.classList.toggle('hidden', queue.length - currentIndex <= 0);
}

function toggleListView() {
  if (listVisible) { hideAllPanels(); return; }
  hideAllPanels();
  listVisible = true;
  queueListPanel.classList.add('visible');
  cardContainer.classList.add('hidden');
  actionsBar.classList.add('hidden');
  renderQueueList();
}

function renderQueueList() {
  const remaining = queue.slice(currentIndex);
  if (remaining.length === 0) {
    queueListPanel.innerHTML = '<div style="text-align:center; padding:30px; color:#666;">Queue is empty</div>';
    return;
  }
  queueListPanel.innerHTML = remaining.map((item, i) => {
    const thumbSrc = item.thumbnail || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
    const typeClass = item.isLive ? 'live' : item.type === 'stream' ? 'stream' : 'video';
    const typeLabel = item.isLive ? 'LIVE' : item.type === 'stream' ? 'STREAM' : 'VIDEO';
    const isActive = i === 0 ? 'active' : '';
    const progressBar = item.watchedPercent > 0
      ? `<div style="position:absolute;bottom:0;left:0;height:2px;background:#f00;width:${item.watchedPercent}%"></div>`
      : '';
    return `
      <div class="queue-list-item ${isActive}" data-index="${currentIndex + i}">
        <div style="position:relative;flex-shrink:0">
          <img class="queue-list-thumb" src="${thumbSrc}" onerror="this.src='https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg'" alt="">
          ${progressBar}
        </div>
        <div class="queue-list-info">
          <div class="queue-list-title">${item.title}</div>
          <div class="queue-list-channel">${item.channelName}${item.publishedLabel ? ' · ' + item.publishedLabel : ''}</div>
        </div>
        <span class="queue-list-type ${typeClass}">${typeLabel}</span>
      </div>
    `;
  }).join('');

  // Click to jump to that item in card view
  queueListPanel.querySelectorAll('.queue-list-item').forEach(el => {
    el.addEventListener('click', () => {
      currentIndex = parseInt(el.dataset.index, 10);
      listVisible = false;
      queueListPanel.classList.remove('visible');
      cardContainer.classList.remove('hidden');
      actionsBar.classList.remove('hidden');
      updateUI();
    });
  });
}

document.getElementById('btnListView').addEventListener('click', toggleListView);

// Settings toggle
document.getElementById('btnSettings').addEventListener('click', () => {
  if (settingsVisible) { hideAllPanels(); return; }
  hideAllPanels();
  settingsVisible = true;
  settingsPanel.classList.add('visible');
  cardContainer.classList.add('hidden');
  actionsBar.classList.add('hidden');
  loadSettings();
  loadScrapeLog();
});

// Watch Later panel
const watchPanel = document.getElementById('watchPanel');
const watchList = document.getElementById('watchList');
const watchSelectCount = document.getElementById('watchSelectCount');
let watchSelected = new Set();

document.getElementById('btnWatchLater').addEventListener('click', () => {
  if (watchVisible) { hideAllPanels(); return; }
  hideAllPanels();
  watchVisible = true;
  watchPanel.classList.add('visible');
  cardContainer.classList.add('hidden');
  actionsBar.classList.add('hidden');
  renderWatchLater();
});

async function renderWatchLater() {
  const items = await getWatchLater();
  watchSelected.clear();
  updateWatchSelectCount(items.length);

  if (items.length === 0) {
    watchList.innerHTML = '<div class="watch-empty">No videos in Watch Later.<br>Hit the green check on cards to add them here.</div>';
    return;
  }

  watchList.innerHTML = items.map(item => {
    const thumbSrc = item.thumbnail || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
    const progressBar = item.watchedPercent > 0
      ? `<div style="position:absolute;bottom:0;left:0;height:2px;background:#f00;width:${item.watchedPercent}%"></div>`
      : '';
    return `
      <div class="watch-item" data-vid="${item.videoId}">
        <input type="checkbox" data-vid="${item.videoId}">
        <div style="position:relative;flex-shrink:0">
          <img class="watch-item-thumb" src="${thumbSrc}" onerror="this.src='https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg'" alt="">
          ${progressBar}
        </div>
        <div class="watch-item-info">
          <div class="watch-item-title">${item.title}</div>
          <div class="watch-item-channel">${item.channelName || ''}</div>
        </div>
      </div>
    `;
  }).join('');

  // Checkbox toggles
  watchList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const vid = e.target.dataset.vid;
      const row = e.target.closest('.watch-item');
      if (e.target.checked) {
        watchSelected.add(vid);
        row.classList.add('selected');
      } else {
        watchSelected.delete(vid);
        row.classList.remove('selected');
      }
      updateWatchSelectCount(items.length);
    });
  });

  // Click row to toggle (not just checkbox)
  watchList.querySelectorAll('.watch-item').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const cb = row.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
  });
}

function updateWatchSelectCount(total) {
  const count = watchSelected.size;
  watchSelectCount.textContent = count > 0 ? `${count} of ${total} selected` : `${total} video${total !== 1 ? 's' : ''}`;
}

document.getElementById('btnSelectAll').addEventListener('click', async () => {
  const items = await getWatchLater();
  const checkboxes = watchList.querySelectorAll('input[type="checkbox"]');
  const allChecked = watchSelected.size === items.length;
  checkboxes.forEach(cb => {
    cb.checked = !allChecked;
    const vid = cb.dataset.vid;
    const row = cb.closest('.watch-item');
    if (!allChecked) { watchSelected.add(vid); row.classList.add('selected'); }
    else { watchSelected.delete(vid); row.classList.remove('selected'); }
  });
  updateWatchSelectCount(items.length);
});

document.getElementById('btnOpenSelected').addEventListener('click', async () => {
  if (watchSelected.size === 0) return;
  const vids = [...watchSelected];
  // First video opens in the current active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab) {
    chrome.tabs.update(activeTab.id, { url: `https://www.youtube.com/watch?v=${vids[0]}` });
  }
  // Remaining videos open in new tabs
  for (let i = 1; i < vids.length; i++) {
    chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${vids[i]}`, active: false });
  }
});

document.getElementById('btnRemoveSelected').addEventListener('click', async () => {
  if (watchSelected.size === 0) return;
  await removeFromWatchLater([...watchSelected]);
  renderWatchLater();
});

// Push to YouTube playlist
let pushing = false;

document.getElementById('btnPushPlaylist').addEventListener('click', async () => {
  const btn = document.getElementById('btnPushPlaylist');

  if (pushing) {
    chrome.runtime.sendMessage({ action: 'STOP_PUSH' });
    btn.textContent = 'Stopping...';
    btn.disabled = true;
    return;
  }

  // Get selected videos, or all if none selected
  const allWL = await getWatchLater();
  let videos;
  if (watchSelected.size > 0) {
    videos = allWL.filter(v => watchSelected.has(v.videoId));
  } else {
    videos = allWL;
  }

  if (videos.length === 0) return;

  const settings = await getSettings();
  const playlistName = settings.playlistName || 'vInder';

  pushing = true;
  btn.textContent = 'Stop';
  btn.classList.add('running');

  chrome.runtime.sendMessage({
    action: 'PUSH_TO_PLAYLIST',
    videos,
    playlistName
  });
});

function populateAccountDropdown(accounts, selectedIndex, confirmedName) {
  const list = document.getElementById('accountPickerList');
  if (!list) return;

  // Selection is driven by confirmed name when available — index alone is unreliable
  // because Confirm may update accountIndex to a verified authuser that doesn't match
  // the provisional indices assigned during detection.
  const selectByName = !!confirmedName;

  if (!accounts?.length) {
    list.innerHTML = [0, 1].map(i => `
      <div class="account-option${!selectByName && i === (selectedIndex ?? 0) ? ' selected' : ''}" data-index="${i}" data-name="">
        <div class="account-avatar-placeholder">?</div>
        <span>Account ${i}</span>
      </div>`).join('');
  } else {
    list.innerHTML = accounts.map(a => {
      const isSelected = selectByName ? a.name === confirmedName : a.index === (selectedIndex ?? 0);
      const imgHtml = a.photoUrl
        ? `<img src="${a.photoUrl}" onerror="this.style.display='none'">`
        : `<div class="account-avatar-placeholder">${a.name[0] || '?'}</div>`;
      return `
        <div class="account-option${isSelected ? ' selected' : ''}" data-index="${a.index}" data-name="${a.name}">
          ${imgHtml}
          <span>${a.name}</span>
        </div>`;
    }).join('');
  }

  list.querySelectorAll('.account-option').forEach(card => {
    card.addEventListener('click', async () => {
      list.querySelectorAll('.account-option').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const settings = await getSettings();
      settings.accountIndex = parseInt(card.dataset.index, 10);
      settings.confirmedAccountName = null; // needs re-confirm after manual selection change
      await saveSettings(settings);
      showConfirmedBanner(null);
    });
  });
}

function showConfirmedBanner(name) {
  const banner = document.getElementById('confirmedAccountBanner');
  if (!banner) return;
  if (name) {
    banner.textContent = `✓ Verified: ${name}`;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

async function loadSettings() {
  const settings = await getSettings();
  document.getElementById('settingMaxAge').value = settings.maxAgeDays;
  document.getElementById('settingPlaylistName').value = settings.playlistName || 'vInder';
  populateAccountDropdown(settings.accountNames || null, settings.accountIndex ?? 0, settings.confirmedAccountName || null);
  showConfirmedBanner(settings.confirmedAccountName || null);
}

document.getElementById('settingPlaylistName').addEventListener('change', async (e) => {
  const settings = await getSettings();
  const newName = e.target.value.trim() || 'vInder';
  if (newName !== settings.playlistName) {
    settings.playlistName = newName;
    settings.playlistId = null;
    await saveSettings(settings);
  }
});

document.getElementById('settingMaxAge').addEventListener('change', async (e) => {
  const settings = await getSettings();
  settings.maxAgeDays = parseInt(e.target.value, 10);
  await saveSettings(settings);
});

document.getElementById('btnConfirmAccount').addEventListener('click', async () => {
  const btn = document.getElementById('btnConfirmAccount');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    // Pass the visually-selected card's index so Confirm can't use stale stored state
    const selectedCard = document.querySelector('#accountPickerList .account-option.selected');
    const selectedIndex = selectedCard ? parseInt(selectedCard.dataset.index, 10) : null;
    const resp = await chrome.runtime.sendMessage({ action: 'CONFIRM_ACCOUNT', selectedIndex });
    if (resp?.name) {
      // background already saved accountIndex + confirmedAccountName; just refresh the banner
      const label = resp.authuser != null ? `${resp.name} (authuser=${resp.authuser})` : resp.name;
      showConfirmedBanner(label);
      // Re-render picker so the confirmed card stays highlighted
      const settings = await getSettings();
      populateAccountDropdown(settings.accountNames || null, settings.accountIndex ?? 0, settings.confirmedAccountName || null);
    } else {
      btn.textContent = 'Not found';
      setTimeout(() => { btn.textContent = 'Confirm'; }, 2000);
    }
  } catch (e) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Confirm'; }, 2000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm';
  }
});

document.getElementById('btnDetectAccounts').addEventListener('click', async () => {
  const btn = document.getElementById('btnDetectAccounts');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'DETECT_ACCOUNTS' });
    if (resp.accounts?.length) {
      const settings = await getSettings();
      settings.accountNames = resp.accounts;
      await saveSettings(settings);
      populateAccountDropdown(resp.accounts, settings.accountIndex ?? 0, settings.confirmedAccountName || null);
    } else {
      btn.textContent = 'None found';
      setTimeout(() => { btn.textContent = 'Detect'; }, 2000);
      return;
    }
  } catch (e) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Detect'; }, 2000);
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Detect';
  }
});

async function loadScrapeLog() {
  const log = await getScrapeLog();
  const container = document.getElementById('logContainer');

  if (log.length === 0) {
    container.innerHTML = '<div class="log-entry"><span class="log-stat">No scans yet</span></div>';
    return;
  }

  container.innerHTML = log.map(entry => {
    const date = new Date(entry.timestamp);
    const timeStr = date.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    const errors = entry.errors.length > 0
      ? `<div class="log-error">${entry.errors.join('; ')}</div>`
      : '';
    const chResults = (entry.channelResults || []).map(ch =>
      `<div style="font-size:11px;color:#777;padding-left:8px;">${ch.name}: ${ch.scraped} scraped, ${ch.new} new${ch.old ? ', ' + ch.old + ' old' : ''}${ch.known ? ', ' + ch.known + ' known' : ''}</div>`
    ).join('');
    return `
      <div class="log-entry">
        <span class="log-time">${timeStr}</span> —
        <span class="log-stat">${entry.channelsProcessed} channels, ${entry.newItemsFound} new</span>
        ${errors}
        ${chResults}
      </div>
    `;
  }).join('');
}

function appendPushLog(phase, message) {
  const container = document.getElementById('pushLogContainer');
  if (!container) return;

  // Remove the "No pushes yet" placeholder on first real entry
  if (container.querySelector('.log-placeholder')) container.innerHTML = '';

  const timeStr = new Date().toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  const isError = phase === 'error';
  const entry = document.createElement('div');
  entry.className = `log-entry ${isError ? 'log-fail' : 'log-ok'}`;

  // Extract playlist URL if present (appended after " | ")
  const urlMatch = message.match(/^([\s\S]*?)\s*\|\s*(https:\/\/www\.youtube\.com\/playlist\?list=\S+)$/);
  const displayMsg = urlMatch ? urlMatch[1] : message;
  const playlistUrl = urlMatch ? urlMatch[2] : null;

  // Split out the raw API response if present
  const rawMatch = displayMsg.match(/^(.*?)\s*\(HTTP (\S+?):\s*([\s\S]*)\)$/);
  if (rawMatch) {
    entry.innerHTML = `
      <span class="log-time">${timeStr}</span> — HTTP ${rawMatch[2]}
      <div class="log-error">${rawMatch[1]}</div>
      <div class="log-raw">${rawMatch[3]}</div>`;
  } else {
    const linkHtml = playlistUrl
      ? `<div style="margin-top:4px"><a href="${playlistUrl}" target="_blank" style="color:#4af;font-size:11px;word-break:break-all;">${playlistUrl}</a></div>`
      : '';
    entry.innerHTML = `
      <span class="log-time">${timeStr}</span>
      <div class="${isError ? 'log-error' : 'log-stat'}">${displayMsg}</div>${linkHtml}`;
  }

  container.prepend(entry); // newest first

  // Keep at most 10 entries
  while (container.children.length > 10) container.removeChild(container.lastChild);
}

// Progress bar
const progressPanel = document.getElementById('progressPanel');
const progressStatus = document.getElementById('progressStatus');
const progressCounts = document.getElementById('progressCounts');
const progressFill = document.getElementById('progressFill');

function showProgress(data) {
  progressPanel.classList.add('visible');

  progressStatus.textContent = data.message || '';

  if (data.phase === 'starting') {
    progressFill.classList.add('indeterminate');
    progressFill.style.width = '';
    progressCounts.textContent = '';
  } else if (data.totalChannels) {
    progressFill.classList.remove('indeterminate');
    progressFill.style.width = (data.percent || 0) + '%';
    progressCounts.textContent = `${data.channelsDone || 0} / ${data.totalChannels} channels`;
  }

  if (data.phase === 'done' || data.phase === 'error') {
    progressFill.classList.remove('indeterminate');
    progressFill.style.width = '100%';
    if (data.phase === 'done') {
      progressFill.style.background = '#44bb44';
    } else {
      progressFill.style.background = '#ff6666';
    }
    scanning = false;
    setTimeout(() => {
      progressPanel.classList.remove('visible');
      progressFill.style.background = '';
      progressFill.style.width = '0%';
      const btn = document.getElementById('btnRunNow');
      btn.disabled = false;
      btn.textContent = 'Scan';
      btn.classList.remove('running');
    }, 4000);
  }
}

// Listen for queue updates and progress from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'QUEUE_UPDATED') {
    loadQueue(false);
  }
  if (message.action === 'SCRAPE_PROGRESS') {
    showProgress(message);
  }
  if (message.action === 'PUSH_PROGRESS') {
    // Reuse the progress bar for push updates
    progressPanel.classList.add('visible');
    progressStatus.textContent = message.message || '';
    if (message.total) {
      progressFill.classList.remove('indeterminate');
      progressFill.style.width = (message.percent || 0) + '%';
      progressCounts.textContent = `${message.current || 0} / ${message.total} videos`;
    }
    if (message.phase === 'info') {
      // Diagnostic-only — persist to log but don't change bar state
      appendPushLog('info', message.message || '');
    }
    if (message.phase === 'done' || message.phase === 'error') {
      progressFill.classList.remove('indeterminate');
      progressFill.style.width = '100%';
      progressFill.style.background = message.phase === 'done' ? '#44bb44' : '#ff6666';
      pushing = false;

      // Log result persistently in settings push log
      appendPushLog(message.phase, message.message || '');

      setTimeout(() => {
        progressPanel.classList.remove('visible');
        progressFill.style.background = '';
        progressFill.style.width = '0%';
        progressCounts.textContent = '';
        const btn = document.getElementById('btnPushPlaylist');
        btn.disabled = false;
        btn.textContent = '▶ YouTube';
        btn.classList.remove('running');
      }, 4000);
    }
  }
});

// Diagnostics
document.getElementById('btnRunDiag').addEventListener('click', async () => {
  const btn = document.getElementById('btnRunDiag');
  const container = document.getElementById('diagResults');
  btn.disabled = true;
  btn.textContent = 'Testing...';
  container.innerHTML = '<div class="diag-test"><span class="diag-label" style="color:#888">Opening YouTube and testing selectors...</span></div>';

  try {
    const response = await chrome.runtime.sendMessage({ action: 'RUN_DIAGNOSTICS' });
    const { results, passed } = response;

    const icons = { pass: '✅', fail: '❌', warn: '⚠️' };
    const classes = { pass: 'diag-pass', fail: 'diag-fail', warn: 'diag-warn' };

    let html = results.map(r => `
      <div class="diag-test">
        <span class="diag-icon">${icons[r.status]}</span>
        <span class="diag-label">${r.label}</span>
        <span class="diag-value ${classes[r.status]}">${r.value}</span>
      </div>
    `).join('');

    const failCount = results.filter(r => r.status === 'fail').length;
    const warnCount = results.filter(r => r.status === 'warn').length;

    if (failCount === 0) {
      html += `<div class="diag-summary pass">${results.length} tests passed${warnCount > 0 ? `, ${warnCount} warnings` : ''} — selectors are working</div>`;
    } else {
      html += `<div class="diag-summary fail">${failCount} test${failCount > 1 ? 's' : ''} failed — YouTube DOM may have changed. Update content-scraper.js selectors.</div>`;
    }

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="diag-summary fail">Diagnostic error: ${err.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Selector Test';
  }
});

// Clear snapshots
document.getElementById('btnClearSnapshots').addEventListener('click', async () => {
  await chrome.storage.local.set({ channelSnapshots: {}, scrapeLog: [] });
  document.getElementById('btnClearSnapshots').textContent = 'Cleared!';
  loadScrapeLog();
  setTimeout(() => { document.getElementById('btnClearSnapshots').textContent = 'Reset Snapshots'; }, 2000);
});

// Refresh queue when side panel becomes visible again
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    loadQueue(false);
  }
});

// Recent scans collapse toggle
document.getElementById('recentScansToggle').addEventListener('click', () => {
  const container = document.getElementById('logContainer');
  const chevron = document.getElementById('recentScansChevron');
  const isHidden = container.style.display === 'none';
  container.style.display = isHidden ? 'block' : 'none';
  chevron.innerHTML = isHidden ? '&#9650;' : '&#9660;';
});

// Initialize
loadQueue();
