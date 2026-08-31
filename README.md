# Codex Split

Codex Split tracks one shared Codex account across a small team and any number of macOS, Linux, or Windows devices. The web app shows weekly usage, each member's equal share, connected devices, warnings, and a 30-day API-rate cost estimate.

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

Member changes affect the equal allowance at the next weekly reset. Change `TRACKER_WARNING_PERCENT` or `RETENTION_DAYS` in `wrangler.jsonc` if needed.

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

After pairing, the installer starts a launchd agent on macOS, a systemd user service on Linux, or a scheduled task on Windows. It syncs once per minute. The device agent sends token counters and quota metadata only.

To rebuild all six native binaries from any Go development machine:

```sh
npm run build:agent
```

Go cross-compiles the Linux, macOS, and Windows ARM64 and x86_64 binaries without platform SDKs or C toolchains. The outputs and checksums are written to `public/downloads`.

## Attribution

At each weekly reset, active members receive equal shares. Codex Split divides the shared account percentage using the API-rate equivalent value of each member's activity in that weekly window. If a model has no price mapping, it falls back to token counts. If there is no matching activity, the usage stays unattributed.

Dollar values are estimates at published API token rates. They are not Codex subscription charges.
