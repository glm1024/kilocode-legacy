# AI Code Insights API

This service is written against generic SQLAlchemy + PyMySQL behavior and is intended to stay portable across common MySQL deployments.

## MySQL version strategy

- Practical compatibility target: `MySQL >= 5.7`
- Do not treat the project as hard-bound to a single MySQL major version unless a specific production environment requires it

## Current implementation notes

- The schema uses standard tables, indexes, foreign keys, unique constraints, and `NOW()` defaults
- The query layer does not rely on MySQL 8-only features such as CTEs, window functions, or JSON columns
- Timestamps are normalized to UTC in the application layer
- On startup the service will automatically create the target database when it does not exist, run `alembic upgrade head`, and insert idempotent preset rows into `app_settings`

## Docker Compose

The root `docker-compose.yml` only starts the `api` and `web` services. MySQL is expected to be provided by your existing server.

Create a local config file first:

```bash
cp .env.api.sample .env.api
```

Fill in your MySQL connection settings in `.env.api`:

```bash
MYSQL_HOST=10.0.0.12
MYSQL_PORT=3306
MYSQL_DATABASE=ai_code_insights
MYSQL_USER=ai_code
MYSQL_PASSWORD=change-me
APP_SETTINGS_ENCRYPTION_KEY=replace-this-key
API_BASE_URL=http://localhost:18080
```

Optional bootstrap seed:

```bash
SEED_AI_SETTINGS_JSON={"defaultProfile":"internal-openai","profiles":[{"provider":"openai-compatible","name":"internal-openai","baseUrl":"https://llm.example.com/v1","apiKey":"replace-me","model":"gpt-4.1-mini","temperature":0.2,"maxTokens":1200,"enabled":true}]}
```

Then start the services:

```bash
docker compose up -d
```

The API supports two connection styles:

```bash
DATABASE_URL=mysql+pymysql://user:password@host:3306/dbname?charset=utf8mb4
```

or

```bash
MYSQL_HOST=host
MYSQL_PORT=3306
MYSQL_DATABASE=dbname
MYSQL_USER=user
MYSQL_PASSWORD=password
```

## Startup behavior

- If the target MySQL database does not exist, the API will execute `CREATE DATABASE IF NOT EXISTS`
- The API then runs `alembic upgrade head`
- Finally it inserts preset rows into `app_settings` if they are missing
- Existing data is not overwritten, except the bootstrap metadata row which is refreshed when the seed version changes

## Demo data

- A deterministic demo data loader lives at `scripts/seed_demo_data.py`
- It generates 1000 rich events by default across source IPs, projects, languages, IDEs, source types, and roughly 180 days of history
- It posts through the normal ingest API, so aggregate tables are updated automatically

Example:

```bash
cd apps/ai-code-insights-api
python scripts/seed_demo_data.py --api-base-url http://127.0.0.1:18080
```

Optional dry-run and payload export:

```bash
python scripts/seed_demo_data.py --dry-run --output-dir ./demo-output
```
