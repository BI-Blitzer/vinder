# vInder

Swipe through new videos from your YouTube subscriptions. Tinder-style — keep it, skip it, or save it for later. Push your queue directly to a YouTube playlist when you're ready to watch.

## What it does

1. **Scan** — opens your YouTube subscriptions sidebar and finds channels with new content, then scrapes their latest videos
2. **Swipe** — cards show each new video; swipe right (keep) or left (skip); save for later
3. **Push** — sends your kept videos to a YouTube playlist under your chosen account

## Install

Chrome Web Store link coming soon. For now, sideload:

1. Clone or download this repo
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this folder

## Setup

1. Click the vInder toolbar icon to open the side panel
2. Go to **Settings → YouTube account** and click **Detect** to find your accounts
3. Select the account/channel you want playlists created under and click **Confirm**
4. Set your **Max video age** (how far back to look)
5. Hit **Scan Now** — vInder will open a YouTube tab, read your subscriptions, and queue new videos

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Opens YouTube tabs to read subscriptions and scrape channel pages |
| `scripting` | Runs scripts inside YouTube tabs to read page content and call the YouTube API |
| `cookies` | Reads your YouTube session cookie to authenticate API calls |
| `webRequest` | Captures YouTube's own request headers (needed to route API calls to the right channel account) |
| `storage` | Saves your queue, settings, and scan history locally |
| `sidePanel` | Displays the vInder UI in Chrome's side panel |
| `alarms` | Schedules periodic background scans |

**Your data never leaves your device.** vInder reads your YouTube session and makes API calls on your behalf — everything stays between your browser and YouTube's servers.

## Notes

- Requires you to be logged into YouTube in Chrome
- Brand/delegated channels (e.g. a separate YouTube channel under your Google account) are supported — use **Detect** to find and confirm the right one
- Scan opens a YouTube tab briefly; this is normal
- YouTube rate-limits aggressive scanning — vInder adds random delays between requests to stay under the radar

## Tips

If vInder saves you time and you want to support future projects, tips are welcome: **[paypal.me link]**

No subscription, no paywall — vInder is and will stay free.
