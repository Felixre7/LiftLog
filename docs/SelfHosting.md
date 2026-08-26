# Self-hosting LiftLog

## Quickstart

Docker is required to run the backend.

To get started with docker compose, create a `docker-compose.yml`:

```yaml
name: liftlog

services:
  api:
    image: ghcr.io/liammorrow/liftlog:api
    ports:
      - "8080:8080"
    environment:
      Database__Provider: Sqlite
      Database__ConnectionString: "Data Source=/var/lib/liftlog/liftlog.db"
    volumes:
      - liftlog_data:/var/lib/liftlog
    restart: unless-stopped

volumes:
  liftlog_data:
```

Then:

```bash
docker compose up -d
curl http://localhost:8080/health   # -> healthy
```

That is a working backend. The schema is created on first boot, and SQLite keeps everything in one
file on the `liftlog_data` volume.

Images are published for `linux/amd64` and `linux/arm64`, so this even works on a Raspberry Pi!

## Pointing the app at it

The server must be reachable over **HTTPS** from your phone - put it behind a reverse proxy that
terminates TLS (Caddy, Traefik, nginx) rather than exposing port 8080 directly. Mobile platforms
block cleartext HTTP, so this is not optional.

How much of the app you can point at your server depends on the feature, eventually all features will be able to target your backend:

| Feature       | Can the app use your server today?                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote backup | **Yes.** Settings → Export, backup, and restore → Automatic remote backup. Set the endpoint to `https://your-host/backup` and the API key to your `Backup__ApiKey`. |
| Social feed   | Not yet - the base URL is compiled in ([`api-consts.ts`](../app/src/services/api-consts.ts)).                                                                       |
| AI planner    | Not yet - same base URL.                                                                                                                                            |

## Turning features off

Every feature is **on** by default. Turn one off with an `Enabled: false` in its configuration
section, and its endpoints answer `423 Locked` instead:

```yaml
Feed__Enabled: "false"
Sharing__Enabled: "false"
Backup__Enabled: "false"
AiPlanner__Enabled: "false"
```

## Turning on the pieces you want

Beyond the flags above, features must be configured to work.

### Social feed

Nothing to configure. It works as soon as the server is running. See [FeedProcess.md](./FeedProcess.md) for a breakdown of the end to end encryption process.

### Remote backup

Accepts a `POST /backup` of a `.liftlogbackup.gz` body, authenticated with an `X-API-Key` header. See
[RemoteBackup.md](./RemoteBackup.md) for the app-side settings.
Backups can be stored in different locations:

#### Directly on disk

Store backups in a directory. **The directory must already exist** - the server fails to start if it
does not, so mount a volume straight at it:

```yaml
environment:
  Backup__Sink: File
  Backup__ApiKey: some-long-random-key
  Backup__SinkOptions__BackupDirectory: /var/lib/liftlog/backups
volumes:
  - liftlog_backups:/var/lib/liftlog/backups
```

#### S3 Bucket Storage

Any S3-compatible bucket (Cloudflare R2, MinIO, S3 itself):

```yaml
Backup__Sink: S3
Backup__ApiKey: some-long-random-key
Backup__SinkOptions__BucketName: liftlog-backups
Backup__SinkOptions__Region: ap-southeast-2
```

`Backup__ApiKey` is what makes the endpoint reachable at all: with no key set, every request to
`/backup` is rejected with 401. With a key set but no sink, it returns 422. Full sink options are in
the [backend README](../backend/README.md#backups).

### AI planner

Bring your own Anthropic API key. This calls a paid API on your own account, and there is no metering
in front of it, so only expose it to people you trust.

```yaml
AiPlanner__AnthropicApiKey: sk-ant-...
AiPlanner__ApiKey: some-long-random-key
```

`AiPlanner__ApiKey` is a shared secret a client presents as its pro token. Leave it unset and
the only way to authorise a planner request is an App Store / Play Store purchase verified through
RevenueCat, which a self-hosted deployment has no way to issue.

`AiPlanner__AnthropicModelId` overrides the model, defaulting to `claude-sonnet-4-6`.

## Using Postgres instead

SQLite is the right default for one household. Switch to Postgres if you expect real traffic:

```yaml
services:
  api:
    image: ghcr.io/liammorrow/liftlog:api
    ports:
      - "8080:8080"
    environment:
      Database__Provider: Postgres
      Database__ConnectionString: "Host=postgres;Port=5432;Database=liftlog;Username=postgres;Password=CHANGE_ME"
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: CHANGE_ME
      POSTGRES_DB: liftlog
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d liftlog"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

volumes:
  postgres_data:
```

There is no migration path between the two providers - pick one before you have data worth keeping.

## Reference

Configuration uses standard ASP.NET Core binding, so any `Section:Key` from the
[backend README](../backend/README.md) becomes `Section__Key` as an environment variable.

| Variable                      | Default             | What it does                                  |
| ----------------------------- | ------------------- | --------------------------------------------- |
| `Feed__Enabled`               | `true`              | `false` makes the feed endpoints return 423.  |
| `Sharing__Enabled`            | `true`              | `false` makes the share endpoints return 423. |
| `Backup__Enabled`             | `true`              | `false` makes `/backup` return 423.           |
| `AiPlanner__Enabled`          | `true`              | `false` makes the AI chat routes return 423.  |
| `Database__Provider`          | `Postgres`          | `Sqlite` or `Postgres`.                       |
| `Database__ConnectionString`  | none (required)     | Connection string for the chosen provider.    |
| `SkipDatabaseMigrations`      | `false`             | Set `true` to apply migrations yourself.      |
| `Backup__ApiKey`              | none                | Value the app must send as `X-API-Key`.       |
| `Backup__Sink`                | none                | `File` or `S3`.                               |
| `AiPlanner__AnthropicApiKey`  | none                | Anthropic key the planner calls with.         |
| `AiPlanner__AnthropicModelId` | `claude-sonnet-4-6` | Overrides the model.                          |
| `AiPlanner__ApiKey`           | none                | Shared secret accepted as a pro token.        |

The container listens on port `8080`, runs as a non-root user, and uses `/var/lib/liftlog` as its
data directory. Health check: `GET /health`.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

## Building the image yourself

Build **from the repository root** - the API embeds `docs/schemas/ai-plan/AiPlan.json`, so a
`backend/` build context is not enough:

```bash
docker build -f backend/Dockerfile -t liftlog-api .
```

For local development on the backend itself, use the compose stack in
[`backend/LiftLog.Api/`](../backend/LiftLog.Api/docker-compose.yml), which builds from source.
