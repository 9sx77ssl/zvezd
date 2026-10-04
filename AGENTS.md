# AGENTS.md

`zvezd` — Bun + TypeScript bot for the lolz.team forum. In a watched thread users
post links to their Telegram channel/post; the bot gives each submission a paid
Telegram Star (through a dedicated mtcute user session), leaves a confirmation
comment and an ad comment, and maintains a live "stats" thread with the
leaderboard. It is a self-hosted promo/engagement tool, not a library or
framework. There is no build step — Bun runs TypeScript directly.

How it works end to end: `ScannerService` walks/polls the watched thread ->
`IssuanceService` runs checks and a persisted state machine per post
(star -> confirmation comment -> ad) -> `StatsService` rewrites the stats thread
every minute. Forum access uses a bearer token behind an `AuthGate` that parks
requests on 401 and hot-reloads the token from `auth.tokenFile`; Telegram uses a
logged-in session created by `bun run login`. All state lives in SQLite.

## Rule #1 — definition of done
For EVERY feature or fix, all of these, in order:
1. implement it;
2. add/update tests in `tests/` — no untested behaviour ships;
3. keep docs truthful: update `README.md`, this `AGENTS.md`, `config.yml`
   (short Russian comments) and `.env.example` whenever commands, config,
   architecture or behaviour change;
4. run `bun run typecheck && bun run lint && bun test` until green;
5. commit, push, deploy (see Deploy).
A change is not done until tests and docs are updated and checks pass.

## Commands
- Install: `bun install` (Bun >= 1.4, pinned via `packageManager`).
- Run: `bun run start` | `bun run dry` (simulate, uses `--dry`) | `bun run dev`.
- One-time Telegram auth: `bun run login` (writes `telegram.sessionPath`).
- Verify before committing, in this order: `bun run typecheck && bun run lint && bun test`.
- Single test file: `bun test tests/issuance-service.test.ts`; by name: `bun test -t "no Telegram link"`.
- `bun run lint` is read-only (`biome check .`); use `bun run lint:fix` to apply fixes.

## Configuration
- `config.yml` (tracked) holds ALL behaviour; every key has a short Russian comment.
- `.env` (gitignored) holds ONLY `FORUM_TOKEN`, `TG_API_ID`, `TG_API_HASH`. Do NOT
  re-add behaviour overrides to `.env`/`envSchema` — that was deliberately removed.
- `bun run dry` toggles dry-run via the `--dry` CLI flag, not an env var.
- Gitignored reference dumps / artifacts: `forum.json`, `resp.json`, `bbcode.html`, `data/`.

## Architecture
- Entrypoint `src/index.ts` -> `src/app/Application.ts` (composition root: one shared
  `Cooldown` plus read/write rate limiters).
- Layout: `src/forum/*` HTTP client + zod schemas + auth gate; `src/telegram/*` mtcute
  wrapper; `src/services/*` issuance/scanner/stats; `src/db/*` bun:sqlite.
- Per-post state machine: star -> confirmation comment -> ad, persisted each step.
  Statuses/reasons/notices are declared once in `src/core/vocab.ts` (`NOTICES` maps a
  kind -> code/reason/config text key). Post checks: `src/issuance/checks.ts`.
  Add a notice = `NOTICES` entry + `comment.*` text + `NoticeError` subclass; add a
  silent check = a `PRE_CHECKS` entry.
- DB migrations are the in-code `MIGRATIONS` array in `src/db/Database.ts` (no `.sql`
  files, no down migrations). Add a numbered entry and update `IssuanceRow`/`mapRow`/`IssuanceRecord`.

## Gotchas
- TS is strict: `noUncheckedIndexedAccess` (index access is `T | undefined`),
  `verbatimModuleSyntax` and Biome `useImportType: error` (type-only imports MUST use
  `import type`), `noUnusedLocals`/`noUnusedParameters`.
- Forum API: request params are unchanged, but RESPONSE fields were renamed in 2026-10
  (`post_body` -> `message`, `poster_user_id` -> `user_id`, `post_create_date` ->
  `post_date`, `post_is_first_post` -> `is_first_post`, `links.first_post` ->
  `first_post_id`, publish/delete flags -> `message_state`). `tests/forum-api-shape.test.ts`
  encodes real captured responses — treat it as the source of truth.
- 401 handling lives in `AuthGate`: it re-reads `FORUM_TOKEN` from `auth.tokenFile` and
  parks every request. Don't add token refresh anywhere else.
- Link parsing works on raw `message_html`, so links inside revealed "hidden content"
  (`bbCodeHide`) blocks are found; only genuinely link-less posts trigger the notice.
- Tests use in-memory SQLite and stub `globalThis.fetch` (see `tests/auth-gate.test.ts`,
  `tests/cooldown.test.ts`); fixtures live in `tests/helpers.ts` (`makeConfig`, `makePost`).
- `config.yml` and `.env.example` comments are Russian; schema JSDoc stays English.

## Deploy
- Host via `ssh new-server`, app dir `/root/zvezd`, pm2 process `zvezd`.
- Push `main`, then: `ssh new-server 'cd /root/zvezd && git pull --ff-only && pm2 startOrRestart ecosystem.config.cjs'`.
- Another machine also pushes stats commits; run `git pull --rebase origin main` before pushing.
- Post-deploy check: `pm2 describe zvezd` (online) and
  `grep -aE "ERROR|Bot started|Stats page updated" /root/.pm2/logs/zvezd-out.log`.
