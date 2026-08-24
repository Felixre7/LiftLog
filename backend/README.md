## LiftLog Backend

The LiftLog backend is written in C# on the latest .NET. The backend is responsible for storing and serving user feeds (which are end-to-end encrypted) and serving the AI planner. It requires a PostgreSQL database.

### Prerequisites

#### Installing .NET SDK

Install the latest .NET SDK for your platform:

**macOS:**

```bash
brew install dotnet
```

**Windows:**
Download and install from [dotnet.microsoft.com/download](https://dotnet.microsoft.com/download)

**Linux (Ubuntu/Debian):**

```bash
wget https://dot.net/v1/dotnet-install.sh -O dotnet-install.sh
chmod +x ./dotnet-install.sh
./dotnet-install.sh --channel 9.0
```

For other Linux distributions, see the [official installation guide](https://learn.microsoft.com/en-us/dotnet/core/install/linux).

#### PostgreSQL Database

Optionally, to run a local PostgreSQL instance, use the provided Docker Compose file (requires Docker installed).

### Configuration

Before running the backend, you need to create a configuration file at [LiftLog.Api/appsettings.Development.json](LiftLog.Api/appsettings.Development.json).

Here is an example configuration that works with the Docker Compose setup:

```json
{
  "ConnectionStrings": {
    "UserDataContext": "Host=localhost;Port=5400;Database=liftlog;Username=postgres;Password=password",
    "RateLimitContext": "Host=localhost;Port=5400;Database=liftlog;Username=postgres;Password=password"
  },
  "AnthropicApiKey": "sk-test-key",
  "WebAuthApiKey": "test-web-auth-key-12345",

  // Optional
  "RevenueCatApiKey": "test-key",
  "RevenueCatProjectId": "test-project",
  "RevenueCatProEntitlementId": "pro"
}
```

**Note:** The `RevenueCatApiKey` can be omitted if a `WebAuthApiKey` is provided. It is used only for validating in-app purchases for the AI planner.

### Backups

All backup configuration lives under the `Backup` section. The `/backup` endpoint accepts a backup
body authenticated with `Backup:ApiKey`, and stores it through a sink chosen by `Backup:Sink`.
The chosen sink is configured by `Backup:SinkOptions`. No sink is configured by default, and the
endpoint returns 422 until one is.

Writing to a directory on disk:

```json
{
  "Backup": {
    "Sink": "File",
    "ApiKey": "some-long-random-key",
    "SinkOptions": {
      "BackupDirectory": "/srv/liftlog-backups"
    }
  }
}
```

Writing to S3 (or an S3 compatible service such as Cloudflare R2 or MinIO):

```json
{
  "Backup": {
    "Sink": "S3",
    "ApiKey": "some-long-random-key",
    "SinkOptions": {
      "BucketName": "liftlog-backups",
      "KeyPrefix": "prod",
      "Region": "ap-southeast-2"
    }
  }
}
```

Backups are stored as `{KeyPrefix}/{authenticated name}/{timestamp}.liftlogbackup.gz`.

`Region` is required unless `ServiceUrl` points at an S3 compatible endpoint, in which case it becomes
the signing region. Set `ForcePathStyle` to `true` for services that do not support virtual host style
buckets. Credentials come from the ambient AWS chain (environment variables, profile, instance role)
unless `AccessKeyId` and `SecretAccessKey` are both set.

### Running the Backend

Start the PostgreSQL database and run the backend:

```bash
cd ./backend/LiftLog.Api
docker compose up -d
dotnet run
```

The backend should now be running at `http://localhost:5264`!

### Running the Tests

The API tests need PostgreSQL and a LocalStack S3 endpoint, both provided by the compose file in
[tests](../tests/docker-compose.yml):

```bash
cd ./tests
docker compose up -d
cd ./LiftLog.Tests.Api
dotnet run
```

### Connecting the Development App

When running the app in development mode (as specified in the [root README](../README.md)), it will automatically connect to your local backend instance.
