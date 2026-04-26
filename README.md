# OIC Activity Stream Enhanced Viewer

Chrome extension that replaces Oracle Integration Cloud's built-in Activity Stream view with a faster, fully collapsible single-scroll tree.

## What it does

When you open an OIC instance's Activity Stream, OIC's native viewer paginates and uses nested scroll panes that make large flows hard to navigate. This extension renders the same data as a single, virtualized tree:

- **Single scroll** — entire flow in one viewport, no nested scroll panes.
- **Fully collapsible** — collapse/expand any node, including loops with 1000+ iterations.
- **Lazy rendering** — handles 16K+ nodes without freezing the browser.
- **Themes** — light, dark, high-contrast, solarized.
- **Auto-detect** — optional floating button appears automatically when an Activity Stream page is detected.
- **Import JSON** — load a saved `activityStreamDetails` response offline (e.g. for support cases).

## Installation

### From source (developer mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `oic-activity-viewer-extension/` folder.
4. Pin the extension to your toolbar.

### From Chrome Web Store

_(Pending — will be linked here once published.)_

## Usage

### Open from a monitoring page

1. Navigate to your OIC instance's monitoring page (any `*.oraclecloud.com` URL).
2. Either:
   - Click the floating button (if **Auto-detect** is enabled), or
   - Click the toolbar icon, paste an **Instance ID**, click **Open**.

### Import a saved activity stream JSON

1. Click the toolbar icon → **Import JSON**.
2. Select a `.json` file containing the response of:
   ```
   GET /ic/api/integration/v1/monitoring/instances/{instanceId}/activityStreamDetails
   ```

### Settings

- **Auto-detect button** — show/hide the floating launcher on monitoring pages.
- **Color theme** — light / dark / high-contrast / solarized.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Open viewer overlay on the current OIC tab. |
| `storage` | Persist theme and auto-detect preference. |
| `scripting` | Inject viewer when launched from popup. |
| `*://*.oraclecloud.com/*` | Match OIC console domains. |

The extension does **not** send any data to third-party servers. All activity stream data is fetched directly from your OIC instance using your existing session cookies.

## Compatibility

- Chrome / Edge / Brave (Manifest V3).
- OIC Generation 2 monitoring console (`design.integration.<region>.ocp.oraclecloud.com`).

## Troubleshooting

| Problem | Fix |
|---|---|
| Floating button not appearing | Enable **Auto-detect** in popup; reload the OIC tab. |
| "Open" returns nothing | Verify the **Instance ID** matches a real instance and your session is active. |
| Viewer empty after import | Confirm the JSON is the raw `activityStreamDetails` response (must contain `items[]`). |

## Bug reports & feature requests

- **Bugs:** https://github.com/marat-ak/oic-activity-viewer-extension/issues/new?template=bug_report.yml
- **Feature ideas:** https://github.com/marat-ak/oic-activity-viewer-extension/issues/new?template=feature_request.yml
- **Browse existing:** https://github.com/marat-ak/oic-activity-viewer-extension/issues

Before filing, please scrub any tenant-specific data (instance IDs, payloads, business data).

## License

Internal / unpublished. Contact the maintainer before redistributing.
