# AGENTS.md

`zvezd` — Bun + TypeScript bot for the lolz.team giveaway ("халява") section. In
a watched thread users post links to their Telegram channel/post; the bot gives
each submission a paid Telegram Star (through a dedicated mtcute user session),
leaves a confirmation comment and an ad comment, and maintains a live "stats"
thread with the leaderboard. In return users like/reply — it is a self-hosted
promo/engagement tool, not a library or framework. There is no build step — Bun
runs TypeScript directly.

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
- Per-post state machine: star -> confirmation comment -> ad, persisted each step.
  Statuses/reasons/notices are declared once in `src/core/vocab.ts` (`NOTICES` maps a
  kind -> code/reason/config text key). Post checks: `src/issuance/checks.ts`.

Module map:

| Path | Responsibility |
|---|---|
| `src/index.ts` | process entrypoint: load config, apply `--dry`, build `Application`, signals |
| `src/app/Application.ts` | composition root: DB/repos/forum/telegram/services, shared `Cooldown`, shutdown |
| `src/config/schema.ts` | zod schemas + defaults for `config.yml` and the 3 env secrets |
| `src/config/index.ts` | `loadConfig()`: parse YAML, inject secrets, validate -> `AppConfig` |
| `src/config/env-file.ts` | `parseEnvToken`/`readEnvToken` (used by the auth gate) |
| `src/core/vocab.ts` | SINGLE source of statuses, reasons and the `NOTICES` registry |
| `src/core/errors.ts` | error hierarchy + `NoticeError` subclasses |
| `src/core/async.ts` | `sleep`, `backoffDelay`, `ActionGate`/`Cooldown` (global pacing) |
| `src/core/logger.ts`, `src/core/fs.ts` | pino wrapper + `errorToLog`; `ensureParentDir` |
| `src/forum/ForumClient.ts` | typed HTTP client: rate limiters, GET-only retries, zod validation, 401/429 |
| `src/forum/AuthGate.ts` | parks every request on 401, hot-reloads `FORUM_TOKEN` from `auth.tokenFile` |
| `src/forum/RateLimiter.ts` | serialized token bucket honouring server `rate_limit` |
| `src/forum/types.ts` | zod response schemas (truth: `tests/forum-api-shape.test.ts`) |
| `src/telegram/TelegramService.ts` | mtcute wrapper: init, balance, resolve, paid reactions, retries |
| `src/telegram/link-parser.ts` | public TG link parse/extract (runs on raw `message_html`) |
| `src/services/ScannerService.ts` | thread backfill/poll walk, balance gate, pending retries |
| `src/services/IssuanceService.ts` | per-post state machine: checks, star, comments, notices |
| `src/issuance/checks.ts` | `PRE_CHECKS` pipeline (silent ignores) |
| `src/services/comment-renderer.ts` | `{placeholder}` template rendering |
| `src/services/StatsService.ts` | rewrites the stats thread title + first post on an interval |
| `src/services/stats-builder.ts` | pure BBCode stats body/title + channel-overlap aggregation |
| `src/db/Database.ts` | bun:sqlite connection + in-code `MIGRATIONS` array |
| `src/db/repositories/*` | `IssuanceRepository` (state transitions + aggregates), `StateRepository` |
| `src/login.ts` | one-time interactive Telegram login (separate from the bot) |

Data model (`src/db/Database.ts`):
- `issuances` — one row per forum post (`post_id` UNIQUE). Lifecycle:
  `pending -> star_sent -> confirmed -> commented`, else `skipped` / `failed`.
  Key columns: `attempts`, `skip_reason` (`IssuanceReason`), `tg_baseline` (our paid
  reactions on the TG post before the first attempt, makes stars idempotent),
  `tg_chat_id`/`tg_message_id`, `comment_id`/`ad_comment_id`, timestamps.
- `app_state` — key/value; `backfill_completed` gates the one-time full backfill.

## How to extend
- **New config key**: add to `fileConfigSchema` with a `.default(...)`, add it to
  `config.yml` with a short Russian comment, mirror it in `tests/helpers.ts`
  (`makeConfig`), and read it via `config.<section>.<key>` — never hardcode.
- **New user notice**: add a `NOTICES` entry in `vocab.ts`, a `comment.*` text
  (schema default + `config.yml`), and a `NoticeError` subclass; throw it where
  detected. It automatically gets the notice + ad + terminal `skipped` handling.
- **New silent pre-check**: add a `PRE_CHECKS` entry in `issuance/checks.ts`
  returning an `IgnoreReason`/`SkipReason`.
- **New DB column**: add a numbered `MIGRATIONS` entry in `Database.ts` (no `.sql`
  files, no down migrations) and update `IssuanceRow`/`mapRow`/`IssuanceRecord`.
- **New forum response field**: extend the zod schema in `forum/types.ts` and add a
  captured fixture to `tests/forum-api-shape.test.ts`.

## Repo conventions
- All tunables live in `config.yml`; services never hardcode intervals/thresholds.
- Extract pure decision logic for unit tests (`stats-builder`, `link-parser`,
  `issuance/checks`, `vocab`); I/O is mocked with in-memory SQLite and a stubbed
  `globalThis.fetch` — tests stay hermetic, no network/DB fixtures.
- TS comments explain "why" in English; `config.yml` / `.env.example` comments are
  Russian and short; schema JSDoc stays English.
- Commit style: `type(scope): lowercase imperative` (`feat`/`fix`/`refactor`/`test`/
  `docs`/`chore`), matching recent history. Only push `main` when you intend to deploy.
- Don't add behaviour env overrides; don't add token refresh outside `AuthGate`;
  don't edit `tests/forum-api-shape.test.ts` fixtures unless the real API changed.

## Gotchas
- TS is strict: `noUncheckedIndexedAccess` (index access is `T | undefined`),
  `verbatimModuleSyntax` and Biome `useImportType: error` (type-only imports MUST use
  `import type`), `noUnusedLocals`/`noUnusedParameters`.
- Forum API: request params are unchanged, but RESPONSE fields were renamed in 2026-10
  (`post_body` -> `message`, `poster_user_id` -> `user_id`, `post_create_date` ->
  `post_date`, `post_is_first_post` -> `is_first_post`, `links.first_post` ->
  `first_post_id`, publish/delete flags -> `message_state`).
- 401 handling lives in `AuthGate`: it re-reads `FORUM_TOKEN` from `auth.tokenFile` and
  parks every request. Don't add token refresh anywhere else.
- Link parsing works on raw `message_html`, so links inside revealed "hidden content"
  (`bbCodeHide`) blocks are found; only genuinely link-less posts trigger the notice.
- Comments are deduped by exact body (`findOwnCommentByBody`, visible only) and stars
  are idempotent via `tg_baseline`, so retries after a partial failure never double-post.
- `config.yml` and `.env.example` comments are Russian; schema JSDoc stays English.

## Deploy
- Host via `ssh new-server`, app dir `/root/zvezd`, pm2 process `zvezd`.
- Push `main`, then: `ssh new-server 'cd /root/zvezd && git pull --ff-only && pm2 startOrRestart ecosystem.config.cjs'`.
- Another machine also pushes stats commits; run `git pull --rebase origin main` before pushing.
- Post-deploy check: `pm2 describe zvezd` (online) and
  `grep -aE "ERROR|Bot started|Stats page updated" /root/.pm2/logs/zvezd-out.log`.
