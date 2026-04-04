# Collector Service Setup

The collector runs as a separate Railway service so that deploying UI changes (server.js, index.html) never interrupts live data collection.

## Create a second Railway service

1. In your Railway project, click **New Service** → **GitHub Repo** → select the same repo.
2. Name the service **collector**.
3. Set the start command:
   ```
   node collector.js
   ```
4. In the service's **Settings → Watch Paths**, set:
   ```
   collector.js,package.json
   ```
   This means the collector only redeploys when `collector.js` or `package.json` changes — not when `server.js` or `index.html` change.

## Environment variables

Add the same variables as the UI service (PORT is not needed for the collector):

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | PAT with `contents:write` |
| `GITHUB_REPO` | `owner/repo` |
| `GITHUB_DATA_BRANCH` | `master` (or your data branch) |
| `DATA_DIR` | `/data` (or leave unset to use `./data`) |

## How it works

- The collector fetches live stats from Footywire every 15 seconds and writes the full pre-computed response to `game_<mid>.json` in `DATA_DIR`, including `savedAt` timestamp.
- The UI server (`server.js`) reads those files directly and returns them to the client. It determines if a game is in-progress by checking whether `savedAt` is within the last 45 seconds.
- Both services share game files via GitHub (same `GITHUB_TOKEN` + `GITHUB_REPO`). On startup each service pulls any missing files from GitHub.
