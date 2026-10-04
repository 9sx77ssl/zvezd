# zvezd

Авто-раздача звёзд в халява-разделе форума lolz.team. Пользователи кидают в
отслеживаемую тему ссылку на свой Telegram-пост или канал; бот выдаёт за это
оплаченную звезду, подтверждает выдачу комментарием, добавляет рекламу и ведёт
публичную тему со статистикой (лидерборд, баланс, пересечения каналов). Взамен
участники ставят симпатии/активность — это self-hosted промо-инструмент.

Стек: [Bun](https://bun.sh) + TypeScript, без сборки. Состояние — SQLite, форум —
через API по токену, звёзды — через твою Telegram-сессию (mtcute).

---

## Требования

- **Bun >= 1.4**
- **аккаунт lolz.team** с API-токеном (права `read` и `post`) — форумный аккаунт, от
  которого бот комментирует.
- **Telegram-аккаунт**, с которого бот ставит звёзды: данные приложения
  (`api_id`, `api_hash`) с https://my.telegram.org/apps и сессия (создаётся ниже).
- на балансе этого Telegram-аккаунта должны быть **звёзды** (по `star.count` за пост).

> Можно использовать один и тот же Telegram-аккаунт для сессии бота, но форумный
> токен — от того аккаунта, который будет писать комментарии.

---

## Быстрый старт

```bash
# 1. зависимости
bun install

# 2. секреты
cp .env.example .env
$EDITOR .env          # впиши FORUM_TOKEN, TG_API_ID, TG_API_HASH

# 3. настройки (темы, тексты, лимиты) — важно указать forum.threadId и stats.threadId
$EDITOR config.yml

# 4. один раз авторизовать Telegram-сессию (интерактивно: телефон → код → 2FA)
bun run login

# 5. проверить без трат и запустить
bun run dry           # симуляция: звёзды не списываются
bun run start         # рабочий запуск
```

Порядок 2→3→4 важен: `bun run login` читает `config.yml` и `.env`, поэтому они
должны быть заполнены до входа.

---

## 1. Секреты (`.env`)

`.env` хранит **только ключи** (в git не попадает):

```dotenv
FORUM_TOKEN=<bearer-токен API lolz.team>
TG_API_ID=<число>
TG_API_HASH=<строка>
```

- **FORUM_TOKEN** — токен API из настроек аккаунта lolz.team (раздел с
  API/токенами). Нужны права `read` и `post`.
- **TG_API_ID / TG_API_HASH** — создай приложение на https://my.telegram.org/apps
  и скопируй значения оттуда.

Все остальные настройки живут в `config.yml`, а не в `.env`.

## 2. Настройки (`config.yml`)

У каждого ключа короткий русский комментарий. Главное:

| Ключ | Что значит |
|---|---|
| `forum.threadId` | id темы, которую бот читает (из ссылки `/threads/<id>/`). |
| `stats.enabled` | вести ли публичную тему статистики. |
| `stats.threadId` | id темы для статистики (создай отдельную; заголовок и первый пост переписываются). |
| `star.count` | сколько звёзд ставить за пост. |
| `comment.text` / `comment.template` | текст и шаблон комментария-подтверждения (`{user_id} {username} {text} {stars} {link}`). |
| `comment.ad.*` | рекламный комментарий (можно выключить `enabled: false`). |
| `comment.*Text` | уведомления при неудаче (нет ссылки, выключены реакции, ...). |
| `database.path` | путь к SQLite (по умолчанию `./data/star.db`). |
| `telegram.sessionPath` | путь к файлу Telegram-сессии (по умолчанию `./data/tg.session`). |
| `pacing.cooldownMs` | общая пауза между действиями (антифлуд). |
| `rateLimit.*` | лимиты запросов к API форума. |

`data/` (база + сессия) в git не попадает — там личные данные, не коммить.

## 3. Авторизация Telegram

```bash
bun run login
```

Спросит телефон, код и пароль 2FA. Сессия сохранится в `telegram.sessionPath`.
Файл сессии — как пароль: не коммить и не отдавать. После этого бот работает
headless.

Если сессия пропала/отозвана, бот при старте скажет об этом — просто повтори
`bun run login`.

## 4. Запуск

```bash
bun run start     # рабочий запуск
bun run dry       # симуляция без трат звёзд (флаг --dry)
bun run dev       # запуск с авто-перезагрузкой при изменении кода
```

Проверь логи: должно быть `Bot started`, затем каждую минуту `Stats page updated`
и `Scanner Idle heartbeat`. Скан первой страницы выводит `Backfill page processed`
/ `Catch-up complete`.

## Команды

| Команда | Что делает |
|---|---|
| `bun run start` | запустить бота |
| `bun run dry` | симуляция без реальных трат |
| `bun run dev` | dev-режим (watch) |
| `bun run login` | авторизовать Telegram-сессию |
| `bun run typecheck` | проверка типов (`tsc --noEmit`) |
| `bun run lint` / `lint:fix` | линт/формат через Biome |
| `bun test` | тесты |

---

## Как это работает

1. **Сканер** обходит тему (на старте — беклог, дальше — опрос новых страниц;
   незавершённые посты периодически повторяются).
2. Для каждого нового поста идут проверки: первый/удалённый/скрытый/свой пост
   отбрасываются; нет ссылки, выключены платные реакции, пустой канал или
   нерезолвящаяся ссылка → пользователю уходит уведомление, всё равно ставится
   реклама, пост закрывается.
3. Если в посте **несколько ссылок**, бот перебирает их по порядку (не-TG хосты
   вроде YouTube игнорируются) и ставит звезду только на **первую подходящую**.
   Если рабочих ссылок несколько — звезда одна, а в подтверждение дописывается
   `comment.multipleLinksText`.
4. Успех: звезда (идемпотентно, состояние в SQLite) → комментарий-подтверждение →
   реклама.
5. Все действия разнесены общим кулдауном (`pacing.cooldownMs`), лимиты API — через
   токен-бакеты (`rateLimit.*`).
6. **Статистика** каждые `stats.intervalMs` переписывает заголовок и первый пост
   темы статистики.
7. Если форум отвечает `401`, `AuthGate` паркует запросы и перечитывает `FORUM_TOKEN`
   из `auth.tokenFile` — бот не падает, а ждёт свежий токен.

---

## Ставим бота на сервер (пошагово, для кентов)

Ниже — от чистого сервера до работающего бота под pm2. Команды можно копировать
по порядку. Предполагается свежий Linux-сервер и доступ `root`.

### 0. Подключиться к серверу

```bash
ssh root@<IP-сервера>
```

### 1. Поставить Bun

```bash
curl -fsSL https://bun.sh/install | bash
exec -l "$SHELL"
bun --version          # должно быть >= 1.4
```

Если пишет `bun: command not found` — пропиши PATH и перезайди:

```bash
echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.bashrc
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
bun --version
```

### 2. Поставить PM2

```bash
bun add -g pm2         # или, если так не выйдет: npm i -g pm2
pm2 -v
```

### 3. Скачать код

```bash
cd /root
git clone git@github.com:9sx77ssl/zvezd.git zvezd
cd zvezd
```

Если нет SSH-ключа к GitHub — клонируй по HTTPS:

```bash
git clone https://github.com/9sx77ssl/zvezd.git zvezd
```

> Репозиторий приватный — нужен доступ (SSH-ключ или токен). Попроси его выдать.

### 4. Установить зависимости

```bash
bun install
```

### 5. Заполнить секреты `.env`

```bash
cp .env.example .env
nano .env
```

Впиши свои значения (только эти три строки):

```dotenv
FORUM_TOKEN=<токен API lolz.team, права read и post>
TG_API_ID=<число>
TG_API_HASH=<строка>
```

Сохранить: `Ctrl+O`, `Enter`, выйти: `Ctrl+X`.

### 6. Настроить `config.yml`

```bash
nano config.yml
```

Обязательно проверь:

- `forum.threadId` — id **твоей** темы раздачи (из ссылки `/threads/<id>/`);
- `stats.enabled` и `stats.threadId` — тема статистики (или `stats.enabled: false`);
- при желании `star.count`, `comment.text`, `comment.ad`.

Сохранить: `Ctrl+O`, `Enter`, выйти: `Ctrl+X`.

### 7. Залогиниться в Telegram (один раз)

```bash
bun run login
```

Спросит телефон → код → пароль 2FA. Сессия сохранится в `data/tg.session`.

### 8. Проверить без трат

```bash
bun run dry
```

Оставь на ~30 секунд, убедись, что в логах нет ошибок, затем `Ctrl+C`.
Звёзды при этом **не** списываются.

### 9. Запустить под pm2

```bash
pm2 start ecosystem.config.cjs
pm2 logs zvezd
```

Должно появиться `Bot started`, а дальше каждую минуту `Stats page updated`.
Выйти из логов: `Ctrl+C` (бот продолжит работать — логи это просто просмотр).

### 10. Автозапуск после перезагрузки сервера

```bash
pm2 save
pm2 startup systemd
```

`pm2 startup` выведет команду вида
`sudo env PATH=... pm2 startup systemd -u root --hp /root` — **выполни её**, затем
ещё раз `pm2 save`.

### Обновление после `git push`

```bash
cd /root/zvezd
git pull --ff-only
bun install
pm2 startOrRestart ecosystem.config.cjs   # перечитывает конфиг и перезапускает
```

> После смены настроек в `config.yml` тоже запускай `pm2 startOrRestart ecosystem.config.cjs`
> (обычный `pm2 restart zvezd` конфиг не перечитывает).

### Шпаргалка pm2

| Команда | Что делает |
|---|---|
| `pm2 list` | список процессов и статусы |
| `pm2 logs zvezd` | логи в реальном времени (`Ctrl+C` — выйти) |
| `pm2 logs zvezd --lines 100` | последние 100 строк логов |
| `pm2 describe zvezd` | статус, число рестартов, путь, uptime |
| `pm2 restart zvezd` | перезапустить (без перечитывания конфига) |
| `pm2 stop zvezd` | остановить |
| `pm2 delete zvezd` | убрать из pm2 |
| `pm2 monit` | живой монитор CPU/RAM |
| `pm2 save` | сохранить список процессов для автозапуска |

Логи лежат в `/root/.pm2/logs/zvezd-out.log` и
`/root/.pm2/logs/zvezd-error.log`. PM2-конфиг сам ищет `bun` (`BUN_PATH` →
`/usr/local/bin/bun` → `/root/.bun/bin/bun` → PATH), перезапускает бота при падении
и следит за памятью (`max_memory_restart: 400M`).

> **`bun run login` лучше сделать на сервере** (он интерактивный). Либо залогинься
> локально и перенеси файл `telegram.sessionPath` на сервер. Сессия привязана к
> аккаунту, а не к машине.

---

## Если ставишь раздачу нескольким людям («кентам»)

Один инстанс = один форумный аккаунт + одна Telegram-сессия + одна SQLite. На
каждого человека нужно своё:

1. свой форумный аккаунт с API-токеном (`FORUM_TOKEN`);
2. своя тема для раздачи (`forum.threadId`) и своя тема статистики
   (`stats.threadId`), либо `stats.enabled: false`;
3. своё Telegram-приложение (`TG_API_ID/HASH`) и **своя сессия** (`bun run login`);
4. пополненный баланс звёзд на том Telegram-аккаунте.

**Нельзя** запускать два инстанса на одном `data/` и одной Telegram-сессии —
SQLite-сессия не терпит параллельной записи. Для каждого — свой каталог/сервер и свои
`database.path` + `telegram.sessionPath`.

---

## Диагностика

| Симптом | Что делать |
|---|---|
| `Telegram session is missing or revoked` | `bun run login` заново. |
| Логи «всё ещё ждём токен», 401 | обнови `FORUM_TOKEN` в `.env` (файл `auth.tokenFile`). Бот подхватит сам. |
| `Not enough Telegram Stars, pausing` | пополни баланс — бот сам возобновит. |
| Комментарии/звёзды не появляются | проверь `forum.threadId`, права токена (`read`+`post`), что аккаунт не забанен и не «свой» для бота. |
| Ошибка `Forum API returned an unexpected payload` | форум сменил поля ответа — обнови схему `src/forum/types.ts` и тест `tests/forum-api-shape.test.ts`. |
| Не идёт статистика | задан ли `stats.threadId`, включён `stats.enabled`, есть ли права на правку темы. |

Полезные файлы: логи — `pm2 logs zvezd`, база — `database.path`, сессия —
`telegram.sessionPath`.
