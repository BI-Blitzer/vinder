(async () => {
  const MAX_WAIT_MS = 10000;
  const POLL_INTERVAL_MS = 500;

  function waitForElements(selector, minCount = 1) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const elements = document.querySelectorAll(selector);
        if (elements.length >= minCount) {
          resolve(elements);
          return;
        }
        if (Date.now() - start > MAX_WAIT_MS) {
          console.warn(`[vInder] Timeout waiting for selector: ${selector} (found ${elements.length})`);
          resolve(elements);
          return;
        }
        setTimeout(check, POLL_INTERVAL_MS);
      };
      check();
    });
  }

  function extractChannelIdFromUrl(url) {
    const match = url.match(/\/@([^/]+)/) || url.match(/\/channel\/([^/]+)/) || url.match(/\/c\/([^/]+)/);
    return match ? match[1] : url;
  }

  function parseMetaText(text) {
    if (!text) return { publishedLabel: '', isStreamed: false, isLive: false };
    const isLive = /\bLIVE\b|watching now/i.test(text);
    const isStreamed = /\bStreamed\b/i.test(text);
    // Extract the time part after the bullet: "32K views • 3 days ago" → "3 days ago"
    const parts = text.split('•').map(s => s.trim());
    const timePart = parts.length > 1 ? parts[parts.length - 1] : text;
    // Strip "Streamed " prefix if present
    const publishedLabel = timePart.replace(/^Streamed\s+/i, '').trim();
    return { publishedLabel, isStreamed, isLive };
  }

  async function scrapeSubscriptions() {
    // Try new-style renderers first, then old-style
    const selectors = [
      'ytd-channel-renderer',
      'ytd-grid-channel-renderer'
    ];
    let renderers = [];
    for (const sel of selectors) {
      renderers = await waitForElements(sel, 0);
      if (renderers.length > 0) break;
    }

    if (renderers.length === 0) {
      console.warn('[vInder] No channel renderers found on /feed/channels');
      return { type: 'subscriptions', channels: [] };
    }

    const channels = [];
    renderers.forEach(renderer => {
      const link = renderer.querySelector('a[href*="/@"], a[href*="/channel/"], a#main-link, a.channel-link, a#avatar-link');
      const nameEl = renderer.querySelector('#text.ytd-channel-name, #channel-title, yt-formatted-string.ytd-channel-name, yt-formatted-string#text');
      if (link) {
        const href = link.getAttribute('href') || '';
        channels.push({
          channelId: extractChannelIdFromUrl(href),
          channelName: nameEl ? nameEl.textContent.trim() : 'Unknown',
          channelUrl: href.startsWith('http') ? href : `https://www.youtube.com${href}`
        });
      }
    });

    return { type: 'subscriptions', channels };
  }

  function extractVideoItems(elements, defaultType) {
    const items = [];
    const seen = new Set();

    elements.forEach(el => {
      // New YouTube DOM (2025+): class-based selectors
      const titleLink = el.querySelector('a.ytLockupMetadataViewModelTitle');
      // Fallback to old selectors
      const titleLinkOld = el.querySelector('a#video-title-link, a#video-title');
      const linkEl = titleLink || titleLinkOld;

      if (!linkEl) return;

      const href = linkEl.getAttribute('href') || '';
      const videoIdMatch = href.match(/[?&]v=([^&]+)/);
      if (!videoIdMatch) return;
      if (seen.has(videoIdMatch[1])) return;
      seen.add(videoIdMatch[1]);

      const title = linkEl.textContent.trim() || 'Untitled';

      // Thumbnail: first img in the renderer
      const img = el.querySelector('img');
      const thumbnail = img ? (img.getAttribute('src') || '') : '';

      // Metadata: new style ".ytContentMetadataViewModelMediumText" or old style "#metadata-line"
      const metaNew = el.querySelector('.ytContentMetadataViewModelMediumText');
      const metaOld = el.querySelector('#metadata-line span:last-child, .inline-metadata-item:last-child');
      const rawMeta = (metaNew || metaOld)?.textContent?.trim() || '';
      const { publishedLabel, isStreamed, isLive } = parseMetaText(rawMeta);

      // Duration / LIVE badge
      const badgeEl = el.querySelector('.ytBadgeShapeText');
      const badgeText = badgeEl ? badgeEl.textContent.trim() : '';
      const badgeIsLive = /^LIVE$/i.test(badgeText);

      // Watched progress bar
      let watchedPercent = 0;
      const progressEl = el.querySelector('#progress, ytd-thumbnail-overlay-resume-playback-renderer');
      if (progressEl) {
        const width = progressEl.style?.width;
        watchedPercent = width ? (parseInt(width, 10) || 1) : 1;
      }

      // Determine type
      let type = defaultType;
      if (badgeIsLive || isLive) type = 'stream';
      else if (isStreamed) type = 'stream';

      items.push({
        videoId: videoIdMatch[1],
        title,
        thumbnail,
        publishedLabel,
        url: `https://www.youtube.com/watch?v=${videoIdMatch[1]}`,
        type,
        isLive: badgeIsLive || isLive,
        watchedPercent
      });
    });

    return items;
  }

  async function scrapeVideoList(pageType) {
    const selectors = [
      'ytd-rich-item-renderer',
      'ytd-grid-video-renderer',
      'ytd-video-renderer'
    ];
    let elements = [];
    for (const sel of selectors) {
      elements = await waitForElements(sel, 0);
      if (elements.length > 0) break;
    }

    if (elements.length === 0) {
      console.warn(`[vInder] No video renderers found on channel /${pageType} page`);
      return { type: pageType, items: [] };
    }

    const defaultType = (pageType === 'streams' || pageType === 'live') ? 'stream' : 'video';
    return { type: pageType, items: extractVideoItems(elements, defaultType) };
  }

  const path = window.location.pathname;

  if (path === '/feed/channels') {
    return await scrapeSubscriptions();
  } else if (path.endsWith('/streams') || path.endsWith('/live')) {
    return await scrapeVideoList('streams');
  } else if (path.endsWith('/videos')) {
    return await scrapeVideoList('videos');
  } else {
    // Channel home/featured page — scrape whatever videos are visible
    return await scrapeVideoList('videos');
  }
})();
