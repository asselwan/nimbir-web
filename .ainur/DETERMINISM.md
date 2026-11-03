# Determinism manifest

Prompt `prm_988fc86f-f3ed-48d8-86be-947edf859b07` v1. A clean-room run must pin inputs below and compare outputs with volatile fields normalized.

| Input | Consumer | Seed or stub / remaining control |
| --- | --- | --- |
| Checked-in JSON snapshots and appeal references | `app.js`, appeal composer/demo, future trajectory | Pin file hashes in a test run; no runtime fetch from the upstream sources. |
| Browser-provided 835 bytes and filename | `x12/dropzone.js`, parser, de-identification export | Tests use checked-in generated fixtures from `x12/fixtures/_gen.py`; browser runs depend on user bytes. |
| Current time, locale, timezone | `app.js` event clock and formatting; `appeals/compose.js` default date; workspace SLA display | Unit tests supply explicit dates. Set `TZ=UTC` and fixed date in smoke fixtures; UI wall-clock event text remains volatile. |
| Browser event order, animation frame and WebGL capability | `app.js`, `web3d/hero.min.js` | Use a fixed viewport/browser and poster fallback for snapshot tests; animation is visual only. |
| Supabase identity, network and token expiry | `workspace/server.js` | `workspace/server.test.js` and `workspace/browser-smoke.mjs` stub auth with a fixed synthetic user; production identity is external. |
| PostgreSQL sequence IDs, UUID defaults, `now()`, row order, concurrent writes | `migrations/0001_workspace.sql`, `workspace/store.js` | Real-Postgres fixture uses fixed hospital/user UUIDs and explicit sort order; normalize generated IDs/timestamps when comparing runs. |
| PostgreSQL fixture and connection settings | `workspace/integration.test.js`, `workspace/browser-smoke.mjs` | Real local disposable `nimbir_workspace_staging` database counts as the fixture. Both URLs and `NIMBIR_SYNTHETIC_HARNESS=1` are required; `workspace/synthetic-target.js` refuses remote, wrong database, query parameters, and libpq overrides before destructive setup. The fixture is external to the repo and unavailable by default. |
| HTTP arrival order, client address and rate-limit clock | `workspace/server.js` | `createApp({ now })` accepts an injected clock; server tests use synthetic request/auth objects. Concurrent test order is asserted by result counts, not response order. |
| Browser smoke runtime and Playwright installation | `workspace/browser-smoke.mjs` | Pin `PLAYWRIGHT_MODULE`, Chromium version and viewport for visual evidence; browser installation is external. |
| Build/container environment | `Dockerfile`, `.dockerignore`, npm dependencies | Pin `package-lock.json` and image digest for reproducibility; `nginx:alpine` is floating today. No build timestamp should enter source reconciliation. |

The existing workspace test suite has both stubs and a real PostgreSQL integration fixture. A skipped integration test is not evidence that the ledger invariants passed. No seed can make live Supabase or a real deployment deterministic; their receipts must include target, version, and time.
