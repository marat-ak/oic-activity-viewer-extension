# OIC Activity Stream Enhanced Viewer

Chrome extension that replaces Oracle Integration Cloud's built-in Activity Stream view with a faster, fully collapsible single-scroll tree.

## What it does

When you open an OIC instance's Activity Stream, OIC's native viewer paginates and uses nested scroll panes that make large flows hard to navigate. This extension renders the same data as a single, virtualized tree:

- **Single scroll** — entire flow in one viewport, no nested scroll panes.
- **Fully collapsible** — collapse/expand any node, including loops with 1000+ iterations.
- **Lazy rendering** — handles 16K+ nodes without freezing the browser.
- **Themes** — light, dark, high-contrast, solarized.
- **Auto-detect** — optional floating launcher button on OIC pages. The Instance ID is auto-captured **only when clicked from Oracle's native Activity Stream view** (the panel that exposes the `Instance ID: …` label / Copy-instance-id button). On other pages, you'll be prompted to paste the ID manually.
- **Import JSON** — load a saved `activityStreamDetails` response offline (e.g. for support cases).
- **Search across runs** — find *all executions* of an integration (all versions) in a time window, list them in a sidebar, and search their activity-stream **content** — useful when you don't know which run did the work (e.g. a scheduled FTP poller where most runs are idle and Oracle's native search can't see inside).

## Search across runs

Oracle's native monitor lets you list executions but not search *inside* their activity streams. This mode does. Master-detail layout:

- **Left sidebar** — every execution matching integration code (+ optional version) and time window, with status, version, timestamp, and (after a scan) per-run match counts.
- **Right pane** — the full enhanced viewer for the selected run, rendered from cache (no refetch when you switch back).

### How to use

1. Toolbar icon → **Search across runs**.
2. Optionally pick a **Project** (autocomplete) to scope the search — this narrows the Code autocomplete to that project and adds `projectCode` to the query. Then start typing in **Code** — an autocomplete searches integrations by **name or code** (project-scoped when a project is selected) and shows matches; pick one to fill the code and populate the **Version** dropdown (defaults to *All versions*). Code is also auto-filled from the page when possible. Then set any of the **server-side filters** and click **Fetch**:
   - **Window** — fixed values `1h, 6h, 1d, 2d, 3d, 8d, 32d`, or **Full retention**.
   - **From / To** — an exact UTC range (sent as `startdate`/`enddate`, and used *instead of* Window).
   - **Status** — Completed / Failed / Aborted.
   - **Duration ms** — min/max (`minDuration`/`maxDuration`).
   - **Purged** — exclude / include / only purged.
   - **Tracking variables** (Advanced) — search by business ID or primary/secondary/tertiary tracking values (with optional exact name). Use `[brackets]` for exact match, `"quotes"` for multi-word.

   All of these are real OIC query parameters, so they filter **before** the 550-record cap — you get 550 *matching* runs, not 550 then narrowed. Changing any of them needs a re-**Fetch**.
3. **Fetch** — the sidebar fills with executions.
4. Click any run to open its stream on the right. Use **Scan all** to fetch the listed runs' streams so the top search box can filter the list to runs whose *content* matches (e.g. an FTP filename present in only one run). A banner shows how many of the runs are fetched.
5. Inside a selected run, use **Download All Payloads** to make large-payload content searchable for that run.

> **Notes:** The monitoring API only supports **relative** time windows and has no server-side content or status search — status filtering and absolute-date filtering are applied in the browser. Content search covers only runs already fetched (selected or scanned); narrow the window before scanning large result sets.
>
> **Purged runs:** an instance can still be listed after Oracle has purged its activity data. Those runs are tagged **"no activity"** and dimmed — their stream can't be fetched (the server returns `410`). Scan reports how many were unavailable.

### Why not OCI Logging?

A logs-based approach (searching OCI Logging by date/code) was considered and **parked**: OCI Logging is not configured on the target tenant, uses separate OCI IAM auth the extension's session-cookie model can't carry, and — critically — holds platform/diagnostic logs, **not** activity-stream payload/message content, so it cannot satisfy content search. All data here comes from the OIC monitoring REST API using your existing session.

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

1. Open the **native Oracle Activity Stream** for the instance you want to inspect (the page that shows the `Instance ID: …` label and Copy-instance-id button).
2. Either:
   - Click the floating button (if **Auto-detect** is enabled) — Instance ID is captured automatically from the page, or
   - Click the toolbar icon, paste an **Instance ID**, click **Open**.

> **Note:** auto-capture only works when the floating button is clicked from Oracle's native Activity Stream view. On other OIC pages the button still appears (when **Auto-detect** is on), but you'll be asked to paste the Instance ID manually.

### Import a saved activity stream JSON

1. Click the toolbar icon → **Import JSON**.
2. Select a `.json` file containing the response of:
   ```
   GET /ic/api/integration/v1/monitoring/instances/{instanceId}/activityStreamDetails
   ```

### Settings

- **Auto-detect button** — show/hide the floating launcher on OIC pages. (Auto-capture of Instance ID requires Oracle's native Activity Stream view to be open; otherwise the button prompts for manual input.)
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
