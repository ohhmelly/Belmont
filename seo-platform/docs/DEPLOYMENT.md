# Deployment Guide

Status: **written and spot-checked in Phase 8**, against a real Docker
daemon obtained in this sandbox (see "How this was verified" below) —
not reasoned through statically like Phases 2/3/7's Docker notes had to
be. This doc explains *how* to deploy the platform; it does not deploy
anything anywhere, and per this project's own standing instruction,
**nothing here should be run against a publicly reachable host without
the project owner's own explicit, separate decision to do that.**

This covers the Linux production target (the self-hosted "Dell server"
from the original brief). For Windows dev-machine setup, see the
top-level `README.md` and `scripts/dev-start.ps1` / `dev-stop.ps1`.

---

## 1. How this was verified (read this before trusting the rest)

Every previous phase (2, 3, 7) carried the same caveat: "Docker
build/compose unverified — no usable Docker daemon in this sandbox."
Phase 8 tried harder and this time it worked:

- `dockerd` **does start** in this sandbox instance (it did not need to
  in earlier phases' sandbox instances, or those agents didn't try the
  same way — either way, this is now a known-good path, not a repeat of
  the old caveat). `docker version`, `docker info`, and `docker compose`
  all work normally once the daemon is up.
- This sandbox transparently intercepts container HTTPS egress with its
  own CA (separate from the host-level `HTTPS_PROXY` agent proxy used
  for the rest of this session's tool calls). Two sandbox-specific
  workarounds were needed to let `docker build` actually reach the real
  npm registry and Google Fonts — **neither is present in the committed
  Dockerfiles**, exactly like Phase 2's own note said a prior agent's
  workaround wasn't:
  1. `npm ci` needed `NODE_EXTRA_CA_CERTS` pointed at the sandbox's CA
     bundle in **every** build stage that runs `npm` (a multi-stage
     Dockerfile's later stages are fresh `FROM` layers and do not inherit
     an earlier stage's `ENV`).
  2. `next build` fetches the Geist/Geist Mono fonts from
     `fonts.googleapis.com` at build time. That fetch is issued by
     Turbopack's own (Rust) HTTP client, which does **not** honor
     `NODE_EXTRA_CA_CERTS` at all. The fix was `docker build --network
     host` plus the standard `HTTPS_PROXY`/`HTTP_PROXY` build-args (which
     Docker passes through automatically when set in the invoking
     shell), routing that one request through the sandbox's host-level
     proxy instead of through the intercepted container network path.
- With both workarounds, **a real `docker compose build` of the `app`
  and `worker` images succeeded** (the `postgres` and `ollama` services
  use unmodified upstream images, nothing to build). Both images came
  out non-root (`whoami` inside each: `nextjs`, `worker`) and under the
  CPU/memory limits `docker-compose.yml` sets (confirmed via `docker
  inspect`).
- **A real `docker compose up -d` brought up all three services**
  (`postgres`, `app`, `worker`), and all three reported Docker's own
  `healthy` status within the configured `start_period`/`retries`.
  `curl http://127.0.0.1:3000/api/health` (remapped to a spare port for
  this test, to avoid the sandbox's own already-running dev Postgres on
  5432) returned `{"status":"ok","db":"connected"}` through the
  containerized app, and the worker's `/healthz` returned `{"status":"ok"}`
  both from inside its own container and from the `app` container calling
  it over the Compose network by service name.
- `npx drizzle-kit migrate` run against the containerized Postgres
  applied cleanly from an empty/stale schema to the full current
  16-table schema (confirmed via `psql \dt` before and after).
- **A real gap was found and fixed in this phase**: the `app` service had
  no volume for `/app/storage/reports`, so generated reports lived only
  in the container's writable layer and would be silently lost on every
  rebuild/recreate. Proven with the containers actually running: wrote a
  test file into the running container, force-recreated it, confirmed
  the file survived only after adding the `app_reports` named volume.
  This fix **is** committed in `docker-compose.yml` (unlike the CA/
  network workarounds above, which are sandbox-only and were reverted
  before anything was committed).
- The stack was torn down cleanly (`docker compose down`) afterward, and
  every sandbox-only Dockerfile/compose edit was reverted — `git diff`
  shows only the intentional `app_reports` volume addition and this
  documentation, nothing else.

**What this does *not* prove**: JS-rendering (`--browser`) crawl mode —
no Chromium is in either image yet (carried-forward gap, see
`REMAINING_WORK.md`); a real external HTTPS reverse proxy in front of the
stack (§6 below is reviewed for syntax, not run live); behavior under
the real Dell server's actual hardware/network. A plain `docker compose
up --build` with no sandbox-specific flags, on the real target machine
with normal internet access (no transparent interception to work around),
should just work — the workarounds above exist *only* because of this
particular sandbox's network setup, not because of anything in the
Dockerfiles themselves.

---

## 2. Prerequisites

- A Linux host with Docker Engine and the Compose plugin (`docker compose`,
  not the old standalone `docker-compose`). Docker 24+ recommended.
- Enough RAM for the `deploy.resources.limits` in `docker-compose.yml`
  (currently ~1GB Postgres + 1GB app + 2GB worker + optionally 4GB Ollama
  = up to ~8GB if everything including AI is running) — tune these to the
  real server's actual specs before relying on them; they're conservative
  starting points, not benchmarked (see `docs/SECURITY_REVIEW.md` §4).
- No Redis, no separate message broker — pg-boss (the job queue) runs
  against the same Postgres instance.
- Ollama is **optional**. The app and worker work without it (recommendations
  degrade to a deterministic template); bring it up only if you want local AI.

## 3. First-time setup (Linux production)

```bash
git clone <this repo> && cd seo-platform

# 1. Create your real .env — see .env.example and §7 below for what each
#    variable means. At minimum, set a real BETTER_AUTH_SECRET and a
#    BETTER_AUTH_URL that matches the real public URL this will be
#    reached at (https://... once the reverse proxy in §6 is in place).
cp app/.env.example app/.env
$EDITOR app/.env

# 2. Bring up Postgres first (and only Postgres) so migrations have
#    something to apply to.
docker compose up -d postgres

# 3. Apply migrations. This runs from the host (needs Node/npm installed
#    on the server) rather than inside a container, matching how this
#    project has run it in every phase so far.
cd app && npm install && npx drizzle-kit migrate && cd ..

# 4. Build and start everything else.
docker compose build
docker compose up -d

# 5. Confirm it's healthy.
docker compose ps                      # all three should show "healthy"
curl http://127.0.0.1:3000/api/health  # {"status":"ok","db":"connected"}

# Optional: local AI (off by default)
docker compose --profile ai up -d ollama
docker compose exec ollama ollama pull qwen2.5:0.5b   # or a larger model
```

Fixture test sites (`seo-platform/fixtures/`) are a Phase 3 testing aid,
not part of the deployed product — no need to run them in production.

## 4. Health checks

| Check | Command | Healthy response |
|---|---|---|
| App | `curl http://127.0.0.1:3000/api/health` | `{"status":"ok","db":"connected"}` (200) |
| Worker | internal only — `docker compose exec worker node -e "fetch('http://localhost:3001/healthz').then(r=>r.text().then(console.log))"` | `{"status":"ok"}` (200) |
| Container-level | `docker compose ps` | `STATUS` column shows `healthy` for `app`, `postgres`, `worker` |

The app's `/api/health` does a real `select 1` against Postgres, not a
stub — a `503`/`{"status":"error","db":"disconnected"}` means Postgres is
unreachable, not just that the process is up. The worker's healthcheck
only confirms the process and its internal HTTP listener are alive; it
does not probe pg-boss's own connection separately, so also check
`docker compose logs worker` for `pg-boss started and connected to Postgres.`
on startup.

## 5. Persistent storage

| What | Where | Backed up? | Notes |
|---|---|---|---|
| Postgres data | named volume `postgres_data` | **Yes** — via `pg_dump`, not a raw volume copy | All real state: users, orgs, websites, crawl jobs, findings, reports metadata, audit log, billing records |
| Generated reports | named volume `app_reports` (mounted at `/app/storage/reports` in the `app` container) | **Yes** — via `scripts/backup.sh` | PDF/HTML/CSV/JSON files `generateReport` writes; **this volume did not exist before Phase 8** — see §1's "real gap" note. If you deployed an earlier version of this compose file, add it before relying on backups of this directory |
| Ollama models | named volume `ollama_data` | **No** (not in scope — these are re-downloadable, not user data) | Re-pull with `docker compose exec ollama ollama pull <model>` after a fresh deploy if you use AI recommendations |
| Node modules / build output | inside each image, rebuilt from source | **No** (not user data) | Rebuilt by `docker compose build` |

Nothing else needs backing up — there is no other persistent state
outside Postgres and the reports directory. Logs are stdout-only (§7) and
are not retained by this project beyond whatever `docker compose logs`
or the host's own Docker log driver retains.

## 6. Backup and restore

### Backup

`scripts/backup.sh` is a real, runnable script (not just prose). Run it
from `seo-platform/` with the stack up:

```bash
./scripts/backup.sh                     # writes to ./backups/<UTC timestamp>/
./scripts/backup.sh /mnt/offsite/backup # or a specific destination
```

It does two things, both while the stack stays running:
1. `docker compose exec postgres pg_dump -U postgres -d seo_platform -Fc`
   — a custom-format dump (compressed, supports selective/parallel
   restore), copied out via `docker compose cp`.
2. `tar`s `/app/storage/reports` out of the running `app` container.

Put it on a daily cron entry on the production host, e.g.:

```cron
# /etc/cron.d/seo-platform-backup
0 3 * * * root cd /opt/seo-platform && ./scripts/backup.sh /var/backups/seo-platform/$(date -u +%Y%m%d) >> /var/log/seo-platform-backup.log 2>&1
```

Rotate/prune old backup directories yourselves (not handled by the
script) — e.g. `find /var/backups/seo-platform -maxdepth 1 -mtime +30 -exec rm -rf {} \;`
for a 30-day retention window.

### Restore

```bash
cd seo-platform
docker compose up -d postgres          # Postgres must be running
BACKUP_DIR=/var/backups/seo-platform/20261025   # pick the backup to restore

# 1. Restore the database. pg_restore --clean drops existing objects
#    first, so this is destructive to whatever is currently in the DB —
#    only run it against a database you intend to overwrite (a fresh
#    deploy, or a deliberate rollback).
docker compose cp "$BACKUP_DIR/seo_platform.dump" postgres:/tmp/restore.dump
docker compose exec -T postgres \
  pg_restore -U postgres -d seo_platform --clean --if-exists /tmp/restore.dump
docker compose exec -T postgres rm -f /tmp/restore.dump

# 2. Restore report files into the app_reports volume. Requires the app
#    container to exist (even stopped) so its volume is attached.
docker compose up -d app
docker compose cp "$BACKUP_DIR/reports.tar.gz" app:/tmp/reports.tar.gz
docker compose exec -T app sh -c \
  "rm -rf /app/storage/reports/* && tar -C /app/storage -xzf /tmp/reports.tar.gz && rm /tmp/reports.tar.gz"

# 3. Bring everything up and verify.
docker compose up -d
curl http://127.0.0.1:3000/api/health
```

If the database schema in the backup predates the code you're restoring
onto (e.g. restoring an old dump after an upgrade), run `npx drizzle-kit
migrate` (from `app/`, with `DATABASE_URL` pointed at the restored DB)
immediately after the restore, before starting traffic — see §8.

## 7. Logging

Both the `app` and `worker` processes log to **stdout only** — no log
files inside the containers, no log rotation to manage there. The
worker's job lifecycle events (`enqueued`, `started`, `retrying`,
`completed`, `failed`, `cancelled`) are structured **JSON-lines**
(one JSON object per line: `ts`, `event`, `pid`, `jobId`, `crawlJobId`,
etc. — see Phase 5 of `IMPLEMENTATION_PLAN.md`), which pipes cleanly into
`jq` or a log aggregator if you add one later. The app's logs are plain
Next.js server output plus the health-check's own `console.error` on a
failed DB probe.

```bash
docker compose logs -f app              # follow app logs
docker compose logs -f worker           # follow worker logs (JSON-lines)
docker compose logs --since 1h worker   # last hour only
docker compose logs worker | jq -c 'select(.event=="failed")'  # failed jobs only
```

By default, Docker's `json-file` log driver retains logs on disk
indefinitely per container (confirmed: `docker info` on this sandbox
showed `json-file` as the active driver with no size cap configured).
On a long-running production host, either add `logging: {driver: "json-file",
options: {max-size: "10m", max-file: "3"}}` under each service in
`docker-compose.yml`, or configure a size cap in `/etc/docker/daemon.json`
(`{"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}}`)
so logs can't fill the disk unbounded. Not currently set — a real gap for
long-running deployments, flagged in `REMAINING_WORK.md`.

## 8. Restart policy

Every service in `docker-compose.yml` has `restart: unless-stopped`.
Operationally this means:
- If a container crashes (unhandled exception, OOM kill from the
  `deploy.resources.limits` ceiling, etc.), Docker restarts it
  automatically, with no manual intervention.
- If the **host reboots**, Docker restarts every container that was
  running before the reboot (as long as the Docker daemon itself is
  set to start on boot — `systemctl enable docker` on most distros).
- It does **not** restart a container you stopped on purpose
  (`docker compose stop app`) until you explicitly start it again
  (`docker compose start app` or `up -d`) — "unless-stopped" is the
  point of the policy, not a bug.
- A crash loop (the container keeps failing immediately after each
  restart) is still visible as the container cycling in `docker compose
  ps`/`docker events` — this policy does not hide failures, it just
  retries them. Watch `docker compose logs` if a service seems to be
  restarting repeatedly.

## 9. Updating / upgrading

```bash
cd seo-platform
git pull

# 1. Review what changed — especially any new migration files under
#    app/drizzle/ — before touching production.

# 2. Take a backup first (see §6).
./scripts/backup.sh

# 3. Ideally, run the test suite and apply migrations against a staging
#    copy of the database first, not production directly:
#      - restore a recent backup into a separate scratch Postgres
#      - cd app && npx vitest run && npx drizzle-kit migrate (against the
#        scratch DB's DATABASE_URL)
#      - only once that's clean, proceed against the real database
#    This project's own `npx vitest run` (191 passed, 2 skipped as of
#    Phase 7 — see TEST_RESULTS.md) is the bar to clear before shipping
#    a change; re-run it, don't just trust the last recorded number.

# 4. Apply migrations against production (drizzle-kit migrate only ever
#    adds — it does not drop or rewrite existing data):
cd app && npx drizzle-kit migrate && cd ..

# 5. Rebuild and restart the containers with the new code:
docker compose build
docker compose up -d

# 6. Verify:
docker compose ps                      # all healthy
curl http://127.0.0.1:3000/api/health
docker compose logs --tail 50 worker   # no immediate errors on restart
```

`docker compose up -d` after a `build` only recreates containers whose
image actually changed — `postgres` (using the volume, untouched image)
won't be needlessly restarted, so there's no unnecessary downtime there.
There will be a brief gap in `app`/`worker` availability while they
restart; this project has no blue-green/zero-downtime deploy story, which
is appropriate for a single-operator internal tool but worth knowing.

## 10. Environment variables

Full reference is `app/.env.example` — this section only explains the
parts that aren't self-explanatory from the file itself.

- **`BETTER_AUTH_SECRET` / `BETTER_AUTH_URL`**: `docker-compose.yml` falls
  back to an obviously-fake dev placeholder and `http://localhost:3000`
  if these aren't set in your shell/`.env`. **Always set real values in
  production** — a real random secret, and a `BETTER_AUTH_URL` matching
  wherever this is actually reached (the `https://...` address in front
  of your reverse proxy, once §11 is in place, not `127.0.0.1`).
- **Stripe variables are test-mode only, by design, not by omission.**
  `STRIPE_SECRET_KEY` must start with `sk_test_` — `stripe-provider.ts`
  throws on startup otherwise, with no override. This project's billing
  is explicitly a mocked/test-mode feature per the project owner's own
  direction (see `REMAINING_WORK.md`'s "project direction" note); going
  live with real payments is a deliberate, separate decision the owner
  has not made, not something this deployment doc enables.
- **Rate limiting is single-process, in-memory, by design** — both
  Better Auth's own built-in limiter and this project's additional
  per-user burst limiter on crawl triggering (`src/lib/rate-limit.ts`)
  keep their counters in the process's own memory. This matches the
  project's single-instance deployment target (one `app` container, one
  `worker` container). It will **not** coordinate correctly if you ever
  scale `app` to more than one replica — each replica would enforce its
  own separate limit, effectively multiplying the real limit by the
  replica count. Revisit with a shared store (e.g. a Redis- or
  Postgres-backed limiter) before any multi-instance deployment.
- **Better Auth's rate limiter keys on client IP**, which only works
  correctly behind a reverse proxy that forwards a trustworthy
  `X-Forwarded-For` and that Better Auth is configured to trust (see
  §11) — without that, every request may appear to come from the
  proxy's own IP, defeating the limiter. This is exactly the gap Phase 7
  flagged for this document to cover.
- **`OLLAMA_BASE_URL` is optional.** Unset or unreachable, AI
  recommendations degrade to a deterministic template (see
  `docs/AI_AND_SCORING.md`) — this is tested behavior, not a crash risk.
- **`SMTP_URL` is optional.** Unset, email notifications and
  password-reset emails no-op cleanly; the in-app notification row is
  always written regardless (Phase 5).

## 11. Network bindings and HTTPS (reverse proxy)

By design, `docker-compose.yml` binds every published port to
`127.0.0.1` only — `postgres` (`5432`), `app` (`3000`), `ollama`
(`11434`); `worker` publishes nothing at all (internal-only `expose:
3001`). **This is intentional, from Phase 7's security review**: nothing
in this stack is reachable from outside the host itself without
something else explicitly putting it there. Putting a TLS-terminating
reverse proxy in front of `app`'s `127.0.0.1:3000` is the deployment's
job, not this repo's, and it's what makes the rate limiter's IP-keying
(§10) work correctly too.

**Caddy** is a reasonable default here — automatic HTTPS (via Let's
Encrypt/ZeroSSL), and the whole config below is three real directives.
(nginx works just as well if you already run nginx elsewhere; an
equivalent nginx config is included as well.)

### Option A: Caddy

Install Caddy on the host (not in this Compose file — it needs ports 80/443
on the host network, and keeping it outside Compose keeps TLS cert
storage/renewal independent of this app's own lifecycle). `/etc/caddy/Caddyfile`:

```caddyfile
seo.example.com {
	reverse_proxy 127.0.0.1:3000

	encode gzip zstd

	log {
		output file /var/log/caddy/seo-platform-access.log
	}
}
```

Replace `seo.example.com` with the real hostname; Caddy auto-provisions
and renews the TLS certificate for it on first request, no further
config needed. `reverse_proxy` already forwards `X-Forwarded-For`,
`X-Forwarded-Proto`, and `X-Forwarded-Host` to the upstream by default —
Better Auth's rate limiter (§10) gets a trustworthy client IP with no
extra directives needed (confirmed with `caddy validate`: adding
explicit `header_up X-Forwarded-For`/`-Proto` lines here only produces
an "unnecessary" warning, since it's redundant with that default).
Reload with `sudo systemctl reload caddy` (or `caddy reload --config`
pointed at this file) after any edit.

### Option B: nginx

```nginx
server {
    listen 80;
    server_name seo.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name seo.example.com;

    ssl_certificate     /etc/letsencrypt/live/seo.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/seo.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Forward the real client IP (§10's rate-limiter requirement).
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Next.js uses WebSocket-style long-lived connections for HMR in
        # dev only, but these headers are harmless (and sometimes needed)
        # in production too, e.g. for any future streaming responses.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Obtain the certificate with `certbot --nginx -d seo.example.com` (or any
other ACME client) before the second `server` block will work; certbot
can also rewrite this config automatically if you prefer. Reload with
`sudo nginx -t && sudo systemctl reload nginx`.

Either config terminates TLS at the host level and forwards plain HTTP
to the app's already-`127.0.0.1`-bound port — `postgres`/`ollama` stay
unreachable from outside the host either way, which is correct; nothing
outside this one app route needs to be internet-facing.

**Again: setting this up is explaining *how*, not deploying it.** Do not
point real DNS at a real public IP for this stack, or open port 80/443 on
a real firewall, without the project owner's own explicit, separate
decision to actually go live — consistent with this project's standing
instruction and with `REMAINING_WORK.md`'s "internal tool, not a public
SaaS" direction.
