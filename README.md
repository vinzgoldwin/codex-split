# Codex Split

Codex Split tracks one shared Codex account across a small team and any number of macOS, Linux, or Windows devices. The web app shows weekly account and member usage percentages, connected devices, and API-rate cost estimates.

The collector uploads token counters, model names, device status, and weekly quota metadata. It never uploads prompts, responses, repository paths, or OpenAI credentials.

## Cloudflare stack

- React SPA and API on Cloudflare Pages
- One D1 database
- One private Worker with a daily cleanup Cron Trigger

The project has no always-on server and fits Cloudflare's free plan for a small private tracker.

## Local development

Requirements: Node 22+. Go 1.23+ is only needed to build the device agent.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

The migration creates `Kevin`, `Darius`, and `Albert`. The example local tracker password is `Akashi`.

## First Cloudflare deployment

1. Authenticate and create the database:

    ```sh
    npx wrangler login
    npx wrangler d1 create codex-split
    ```

2. Copy the returned `database_id` into `wrangler.jsonc` and `pages/wrangler.jsonc`.

3. Create the Pages project:

    ```sh
    npx wrangler pages project create codex-split --production-branch main
    ```

4. Store the production password, signing secret, and shared ChatGPT account email in Pages:

    ```sh
    npx wrangler pages secret put TRACKER_PASSWORD --project-name codex-split --cwd pages
    npx wrangler pages secret put AUTH_SECRET --project-name codex-split --cwd pages
    npx wrangler pages secret put CHATGPT_ACCOUNT_EMAIL --project-name codex-split --cwd pages
    ```

5. Apply the schema and deploy Pages plus the private cleanup Worker:

    ```sh
    npm run db:migrate:remote
    npm run deploy:pages
    npm run deploy:worker
    ```

The public app runs at `https://codex-split.pages.dev`. The Worker has no public route and only runs the cleanup schedule.

Pushes to `main` run the web checks and agent tests, then apply D1 migrations and deploy both the scheduled Worker and Pages app. Pull requests and pushes to `develop` only run checks. Deployments run one at a time.

For automatic deployment, add a `CLOUDFLARE_API_TOKEN` repository secret in GitHub Settings > Secrets and variables > Actions. The token needs Cloudflare Pages Edit, Workers Scripts Edit, and D1 Edit permissions for the account configured in `.github/workflows/tests.yml`. The workflow uses the existing project and its saved application secrets. Device binaries are deployed as checked-in assets and are not rebuilt by the workflow.

Member changes update the equal allowance immediately. This allowance is not a measurement of quota consumed. Change `RETENTION_DAYS` in `wrangler.jsonc` to adjust data retention.

## Register a device

Sign in to the shared ChatGPT account through Codex first:

```sh
codex login
```

Then install and register the collector:

```sh
curl -fsSL https://codex-split.pages.dev/install | sh
```

On Windows PowerShell:

```powershell
irm https://codex-split.pages.dev/install.ps1 | iex
```

The installer downloads the correct x86_64 or ARM64 binary and verifies its checksum. The agent confirms that local Codex is signed in to the configured shared ChatGPT account, opens a short-lived pairing page, and waits while you choose the member in the browser. Existing local sessions are baselined during setup, so the assigned member only receives usage produced after registration.

After pairing, the installer starts a launchd agent on macOS, a systemd user service on Linux, or a scheduled task on Windows. The launcher checks locally once per minute. Usage uploads normally run every five minutes, with fifteen-minute heartbeats when idle. The server controls both intervals through `SYNC_INTERVAL_SECONDS` and `IDLE_INTERVAL_SECONDS` in `pages/wrangler.jsonc`. Idle devices may take up to fifteen minutes to report their first new activity. No prompts, responses, or paths are uploaded.

To rebuild all six native binaries from any Go development machine:

```sh
npm run build:agent
```

Go cross-compiles the Linux, macOS, and Windows ARM64 and x86_64 binaries without platform SDKs or C toolchains. The outputs, checksums, and `latest.json` release manifest are written to `public/downloads`. Set `COLLECTOR_VERSION` for a new release and update the installer version constants. Keep previous release assets available. Deploy the API before publishing a collector that requires a new protocol.

## Attribution

All account quota remains unattributed. Collectors report account-wide quota and their own token usage, but no per-device quota consumption. The server does not distribute account quota increases among members, even when they report activity at the same time. The dashboard shows member quota as "Not attributed" and tracks each member's recorded tokens and estimated API costs separately. Account-wide usage from an untracked device cannot inflate another member's quota share.

Both collector protocols are supported. Protocol 2 uses request timestamps; protocol 1 uses quota sample timestamps when available, otherwise upload timestamps, so delayed legacy uploads are less accurate. Dollar costs remain API-rate estimates, and token totals remain the counts reported by each member's paired devices. Cached input and reasoning are subsets of input and output respectively, not extra tokens. Daily summaries use UTC.

Migration 0006 clears the current window's unsupported member percentages and retires pending estimates without changing token or cost totals. Older saved estimates remain in the database for history but are not displayed or used. The old interval tables and columns remain for deployment compatibility. Both collector protocols continue working without a binary update. The dashboard API keeps `used` and `shareUsed` at zero for already-open clients; these fields mean no quota has been assigned, not that a member did no work.

New collectors preserve request sizes, timestamps, model names, cache reads/writes, reasoning counters, and the requested service tier. Dollar estimates apply API rates, including long-context pricing and Fast mode. The recorded tier is the requested setting; server-side downgrades may not be visible in local logs. Unknown model prices produce an incomplete cost estimate without changing token counts. Older collectors report batch timestamps rather than request timestamps.

Dollar values are estimates at published API token rates. They are not Codex subscription charges.

## Upgrade existing devices

Run the same install command above once on every existing device. Version 0.2.0 preserves the device pairing, token, and usage checkpoint. It does not repeat pairing or baseline away unsent usage. Run the installer as the same OS user who installed the original collector. Do not remove the collector config directory.

The installer replaces the old long-running binary service with a small launcher. It checks for a release daily, verifies SHA-256 and the new executable's version, then replaces the binary between syncs. The previous binary is retained locally for startup recovery. Failed update checks back off for a day; syncing continues with the installed binary. Future price and threshold changes only require a server deployment. Future collector releases update automatically while the device is online.

Check the installed version:

```sh
~/.local/bin/codex-split version
```

```powershell
& "$env:LOCALAPPDATA\CodexSplit\codex-split.exe" version
```

On Linux the service runs while the user's systemd session is available. On Windows it starts at logon. macOS uses the user's launchd agent. A custom manual `codex-split run` process does not receive launcher-managed automatic updates; use the installer-managed service.

## Uploads, retention, and corrections

Protocol 2 keeps at most 128 request records from one UTC day in each upload. It writes one JSON batch row plus daily/weekly summaries. Pending uploads and their next checkpoints are saved atomically before sending. Retries reuse the same sequence and ID; the server's device checkpoint survives raw-data pruning. Offline backlogs drain in bounded uploads. Usage dates determine daily and weekly attribution, not upload dates. Records outside the 30-day summary window are acknowledged without restoring expired summaries.

The cleanup Worker retains detailed batches for seven days after receipt and summaries for thirty days. Both Pages and the private scheduled Worker must be deployed so cleanup actually runs. Existing legacy records remain at their original estimates because their request boundaries and service tiers are unavailable. The dashboard API returns `pricingIncomplete` when missing tier/model information or legacy usage affects an estimate. Unknown service tiers use standard-rate estimates and retain their original tier string; they are never silently labeled as confirmed Standard.

Prices live in `worker/pricing.ts`. Increment `PRICING_VERSION` when correcting pricing rules. To recalculate retained batches, an authenticated tracker session can repeatedly POST `/api/reprice` until it returns `{"repriced":false}`. Each call processes one batch and applies only the difference to existing summaries. Data already pruned cannot be repriced. Ordinary future rate changes should preserve the historical rates applicable to each request's `recorded_at` rather than rewriting past prices.

Free-tier budgets are shared with other workloads in the Cloudflare account. Monitor D1 row metrics and database size. The server uses bounded batches, indexed cleanup, and summary reads. Raw upload storage grows with actual request volume; the seven-day retention is not a guarantee against exceeding storage under unlimited activity.
