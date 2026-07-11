# TERYT Location Integration (GUS territorial division)

- **Status**: Draft (pending maintainer review)
- **Scope**: Open Source
- **Author**: Platform team
- **Created**: 2026-07-11
- **Related guides**: `packages/core/src/modules/integrations/AGENTS.md`, `packages/core/src/modules/data_sync/AGENTS.md`, `.ai/skills/om-integration-builder/SKILL.md`, `packages/core/AGENTS.md`
- **Reference implementations**: `packages/gateway-stripe/` (integration package layout), `packages/core/src/modules/currencies/services/providers/nbp.ts` (Polish public-data provider, contrast case)

---

## TLDR

Add a first-class, **toggleable** integration with the Polish **TERYT** register (GUS *Krajowy Rejestr Urzędowego Podziału Terytorialnego Kraju*) that imports the official territorial division — voivodeships, counties, communes (TERC), localities (SIMC) and streets (ULIC) — into local reference tables and exposes a lookup service + cascading autocomplete API for address fields.

The integration is registered through the **Integration Marketplace** framework so operators get, out of the box: per-tenant **enable/disable**, an encrypted **credentials** form (TERYT web-service login is optional — the free GUS file download needs no key), a **health check**, and **operation logs**. Data ingestion runs through the **`data_sync`** hub (streaming import with cursor + progress). No provider-specific code lands in `core`.

---

## Overview

TERYT is the authoritative source for Poland's administrative division and address components. Two access modes exist:

1. **Free bulk files** (`https://eteryt.stat.gov.pl`) — full TERC/SIMC/ULIC catalogs plus a `WMRODZ` locality-type dictionary and monthly "changes" deltas, downloadable as XML/CSV **without authentication**.
2. **TERYT web services (WS1)** — a SOAP API that requires a **login/password** account (a public test account exists). Useful for incremental/online queries.

This spec covers ingesting the territorial dictionary and serving it internally. It deliberately mirrors how the platform already treats external providers (see the Integration Marketplace, SPEC-045) rather than hard-coding a provider like the current NBP currency provider.

### Non-goals (explicit scope boundaries)

- **Postal codes are NOT part of TERYT.** Polish postal codes come from Poczta Polska's separate *Oficjalny Spis Pocztowych Numerów Adresowych*. Postal-code enrichment is out of scope and, if wanted, is a **separate future provider**.
- **NIP/REGON company lookup is NOT TERYT.** That is the GUS **BIR/REGON** service (separate API key). Out of scope here; noted as a sibling future integration because the original request mentioned "location information".
- No automatic rewriting of existing stored addresses. Phase 2 only *assists* address entry; it does not migrate historical data.

---

## Problem Statement

Today the platform has no structured source of Polish territorial data. Address fields across `customers`, `sales`, `staff`, and `resources` are free-text (`city`, `postal_code`, `line1`, …) with no validation, no cascading selection (województwo → powiat → gmina → miejscowość → ulica), and no canonical TERYT codes for downstream reporting/e-invoicing.

Operators also need to **turn this capability on or off per tenant** and **supply credentials only when required** — exactly the contract the `integrations` module already standardizes. Reinventing enable/disable + credential storage (as a bespoke settings page) would duplicate encrypted-credential handling, health checks, and audit logging that the framework already provides.

---

## Proposed Solution

Ship a dedicated npm workspace package **`@open-mercato/sync-teryt`** (module id `sync_teryt`) that:

1. Registers an **`IntegrationDefinition`** (category `data_sync`, hub `data_sync`) so the marketplace renders enable/disable + a dynamic credentials form and runs the health check.
2. Implements a **`DataSyncAdapter`** (`direction: 'import'`) that streams TERC/SIMC/ULIC/WMRODZ into local reference tables via the `data_sync` engine (cursor persistence, progress, batch error logging).
3. Provides a **`terytLocationService`** (DI) and read-only **lookup API** for cascading autocomplete.
4. (Phase 2) Ships an optional **address-autocomplete widget** injectable into address forms, storing TERYT codes on address rows as plain string columns (no cross-module ORM relationship).

### Why the Integration Marketplace (and not a currencies-style provider)

| Requirement | NBP-style hard-coded provider | Integration Marketplace (chosen) |
|---|---|---|
| Per-tenant enable/disable | ✗ always on | ✓ `IntegrationState` + `PUT /state` |
| Credentials (only when needed) | ✗ none | ✓ `credentials.fields`, encrypted at rest |
| Health check + logs | ✗ | ✓ `healthCheck.service` + `IntegrationLog` |
| Admin UI | ✗ | ✓ `/backend/integrations/sync_teryt` (auto) |
| Env preconfiguration | manual | ✓ provider-owned `OM_INTEGRATION_TERYT_*` |

NBP needs none of these (public, keyless, always-useful), so it stays a `currencies` provider. TERYT needs all of them, so it belongs in the framework.

---

## Architecture

### Package / module layout

```
packages/sync-teryt/
├── package.json                     # @open-mercato/sync-teryt
├── tsconfig.json
└── src/
    ├── index.ts
    └── modules/sync_teryt/
        ├── index.ts                 # module metadata (ejectable)
        ├── integration.ts           # IntegrationDefinition (marketplace registration)
        ├── acl.ts                   # features: view, configure, lookup
        ├── setup.ts                 # default role features + env preset apply
        ├── di.ts                    # registerDataSyncAdapter + terytHealthCheck + terytLocationService
        ├── events.ts                # sync_teryt.dictionary.refreshed
        ├── data/
        │   ├── entities.ts          # teryt_admin_unit / teryt_locality / teryt_street / teryt_locality_type
        │   ├── validators.ts        # Zod schemas for lookup query params
        │   └── enrichers.ts         # (Phase 2) resolve teryt codes → names on address responses
        ├── lib/
        │   ├── adapter.ts           # TerytDataSyncAdapter (streamImport)
        │   ├── sources/
        │   │   ├── file-source.ts   # GUS bulk file download + XML/CSV parse (keyless)
        │   │   └── ws-source.ts     # TERYT WS1 SOAP client (login/password)
        │   ├── parse/               # TERC/SIMC/ULIC/WMRODZ row parsers
        │   ├── location-service.ts  # terytLocationService (cascading lookups)
        │   ├── health.ts            # createTerytHealthCheck
        │   └── preset.ts            # applyTerytEnvPreset(...)
        ├── api/
        │   ├── openapi.ts
        │   └── get/teryt/
        │       ├── voivodeships.ts
        │       ├── counties.ts
        │       ├── communes.ts
        │       ├── localities.ts
        │       └── streets.ts
        ├── cli.ts                   # `configure-from-env`, `refresh` (rerunnable)
        ├── widgets/                 # (Phase 2) address autocomplete injection
        └── i18n/{en,pl}.json
```

### Data ingestion flow

```
Operator enables sync_teryt (per tenant) ──▶ saves credentials (optional)
        │
        ▼
POST /api/data_sync/run { integrationId: 'sync_teryt', entityType: 'teryt_streets' }
        │  (data_sync hub — never inline)
        ▼
queue: data-sync-import ──▶ sync-import worker ──▶ dataSyncEngine.streamImport(adapter)
        │                                              │
        │                                              ├─ TerytDataSyncAdapter.streamImport()
        │                                              │     source = file | webservice
        │                                              │     yields ImportBatch { items, cursor, hasMore }
        │                                              ▼
        │                                        batch upsert into teryt_* reference tables
        │                                        (system advisory lock; cursor persisted per batch)
        ▼
ProgressTopBar (progress.job.* SSE) + IntegrationLog entries + sync_teryt.dictionary.refreshed event
```

### Reference-data scope decision (**needs maintainer sign-off**)

TERYT is national, immutable public reference data: ~16 voivodeships, ~380 counties, ~2 500 communes, ~100 000 localities (SIMC), **~250 000 streets (ULIC)**. Storing a full copy **per tenant** would multiply hundreds of thousands of rows by tenant count for identical data.

**Proposed**: store `teryt_*` tables as **system/global reference data** (`tenant_id` / `organization_id` nullable, single shared copy), refreshed by whichever tenant runs the sync under a **system-level advisory lock**. Enable/disable, credentials, health, logs, lookup ACL and the lookup API stay **tenant-scoped**; only the immutable dictionary is shared.

This is a deliberate, documented exception to "always scope by tenant/organization" (which targets *tenant business data*, not public reference dictionaries — cf. how currency codes / dictionaries are treated). It is flagged in Risks and is the single decision requiring explicit approval before implementation. Fallback if rejected: per-tenant tables (accept the storage cost) — no code-shape change beyond scope columns.

---

## Data Models

New entities in module `sync_teryt` (tables prefixed `teryt_`). All include `id uuid pk`, `created_at`, `updated_at`, `deleted_at`. Scope columns `tenant_id` / `organization_id` are **nullable** per the decision above.

### `teryt_locality_type` (WMRODZ dictionary)

| Column | Type | Notes |
|---|---|---|
| `rm` | varchar | locality-type code (WMRODZ `RM`) |
| `name` | varchar | e.g. *miasto*, *wieś*, *osada* |

### `teryt_admin_unit` (TERC — units)

| Column | Type | Notes |
|---|---|---|
| `teryt_code` | varchar | composite code `woj[pow[gmi[rodz]]]` (unique per level) |
| `level` | enum | `voivodeship` \| `county` \| `commune` |
| `woj` / `pow` / `gmi` / `rodz` | varchar null | raw TERC components |
| `name` | varchar | official name |
| `parent_code` | varchar null | code of the parent unit (self-reference by code, **not** FK relation) |
| `valid_from` | date null | TERC `STAN_NA` |

Indexes: `(level, parent_code)`, `(teryt_code)`, `name` (trigram/prefix for search).

### `teryt_locality` (SIMC — localities)

| Column | Type | Notes |
|---|---|---|
| `sym` | varchar(7) | SIMC identifier (unique) |
| `parent_sym` | varchar(7) null | parent locality `SYMPOD` |
| `commune_code` | varchar | TERC commune code (`woj+pow+gmi+rodz`) |
| `name` | varchar | locality name |
| `type_rm` | varchar | FK-by-value to `teryt_locality_type.rm` |

Indexes: `(commune_code)`, `(sym)`, `name` (prefix search).

### `teryt_street` (ULIC — streets)

| Column | Type | Notes |
|---|---|---|
| `sym` | varchar(7) | locality SIMC identifier |
| `sym_ul` | varchar(5) | street identifier (unique with `sym`) |
| `cecha` | varchar null | street prefix (ul., al., pl., …) |
| `name_1` | varchar | primary name part (ULIC `NAZWA_1`) |
| `name_2` | varchar null | secondary name part (ULIC `NAZWA_2`) |
| `full_name` | varchar | derived, indexed for search |

Indexes: `(sym)`, `(sym, sym_ul)`, `full_name` (prefix search).

### Address linkage (Phase 2, optional, additive)

Add nullable string columns to consuming address entities via each module's own `data/extensions.ts` (never mutate core entities from this package): `teryt_commune_code`, `teryt_locality_sym`, `teryt_street_sym_ul`. Stored as **plain codes**, no cross-module ORM relationship (per architecture rules). These are optional metadata; free-text address fields remain the source of truth.

---

## Integration Definition & Credentials (enable/disable + keys)

`integration.ts`:

```typescript
import type { IntegrationDefinition } from '@open-mercato/shared/modules/integrations'

export const integration: IntegrationDefinition = {
  id: 'sync_teryt',
  title: 'GUS TERYT',
  description: 'Polish territorial division (voivodeships, counties, communes, localities, streets).',
  category: 'data_sync',
  hub: 'data_sync',
  providerKey: 'teryt',
  package: '@open-mercato/sync-teryt',
  version: '1.0.0',
  docsUrl: 'https://eteryt.stat.gov.pl',
  tags: ['poland', 'address', 'reference-data', 'gus'],
  credentials: {
    fields: [
      { key: 'dataSource', label: 'Data source', type: 'select', required: true,
        options: [
          { value: 'file', label: 'GUS bulk files (no key required)' },
          { value: 'webservice', label: 'TERYT Web Service (login required)' },
        ] },
      { key: 'wsUsername', label: 'TERYT WS username', type: 'text', required: false,
        visibleWhen: { field: 'dataSource', equals: 'webservice' } },
      { key: 'wsPassword', label: 'TERYT WS password', type: 'secret', required: false,
        visibleWhen: { field: 'dataSource', equals: 'webservice' } },
      { key: 'environment', label: 'Environment', type: 'select', required: false,
        options: [
          { value: 'test', label: 'Test (public account)' },
          { value: 'production', label: 'Production' },
        ],
        visibleWhen: { field: 'dataSource', equals: 'webservice' } },
    ],
  },
  healthCheck: { service: 'terytHealthCheck' },
}
```

**Behavior**
- **Enable/disable** and **credentials** are provided *entirely* by the framework — no bespoke UI. Toggle: `PUT /api/integrations/sync_teryt/state`. Credentials: `GET/PUT /api/integrations/sync_teryt/credentials` (encrypted via `integrationCredentialsService`, per-tenant).
- In **`file` mode** the integration is fully functional **with no key**; the health check verifies reachability of the GUS download endpoint and returns `healthy`.
- In **`webservice` mode** missing username/password ⇒ health check returns `unconfigured`; with the public test account it returns `healthy`.
- Secrets (`wsPassword`) use `type: 'secret'`, are never logged (log service strips secret fields), and are resolved fresh per call — never cached in memory.

### Env preconfiguration (deployment-managed)

Provider-owned, applied from `setup.ts`, rerunnable via `sync_teryt configure-from-env`:

| Env var | Maps to |
|---|---|
| `OM_INTEGRATION_TERYT_DATA_SOURCE` | `dataSource` (`file` \| `webservice`) |
| `OM_INTEGRATION_TERYT_WS_USERNAME` | `wsUsername` |
| `OM_INTEGRATION_TERYT_WS_PASSWORD` | `wsPassword` |
| `OM_INTEGRATION_TERYT_ENVIRONMENT` | `environment` |
| `OM_INTEGRATION_TERYT_AUTO_ENABLE` | enable integration on tenant creation |

---

## API Contracts

### Data-sync (existing hub routes — reused, no new surface)

- `POST /api/data_sync/run` — body `{ integrationId: 'sync_teryt', entityType: 'teryt_units' | 'teryt_localities' | 'teryt_streets', direction: 'import' }`. Returns `{ runId, progressJobId }`.
- `POST /api/data_sync/validate` — validates the configured source (file reachability or WS login).
- Progress, cancel, retry, run listing: existing `data_sync` endpoints.

`supportedEntities = ['teryt_units', 'teryt_localities', 'teryt_streets']` (WMRODZ is fetched implicitly as a prerequisite of localities).

### New read-only lookup routes (module `sync_teryt`)

All export `openApi`, are `GET`, feature-gated by `sync_teryt.lookup`, tenant-scoped, and return `{ items, total }` with `pageSize ≤ 100`. Inputs validated with Zod in `data/validators.ts`.

| Method / Path | Query | Returns |
|---|---|---|
| `GET /api/teryt/voivodeships` | — | `[{ code, name }]` |
| `GET /api/teryt/counties` | `voivodeship=<code>` | `[{ code, name }]` |
| `GET /api/teryt/communes` | `county=<code>` | `[{ code, name }]` |
| `GET /api/teryt/localities` | `commune=<code>&q=<prefix>` | `[{ sym, name, type }]` |
| `GET /api/teryt/streets` | `locality=<sym>&q=<prefix>` | `[{ symUl, cecha, name }]` |

### DI service — `terytLocationService`

```typescript
interface TerytLocationService {
  listVoivodeships(): Promise<TerytUnit[]>
  listCounties(voivodeshipCode: string): Promise<TerytUnit[]>
  listCommunes(countyCode: string): Promise<TerytUnit[]>
  searchLocalities(input: { communeCode?: string; q?: string; limit?: number }): Promise<TerytLocality[]>
  searchStreets(input: { localitySym: string; q?: string; limit?: number }): Promise<TerytStreet[]>
  resolveByCodes(input: { communeCode?: string; localitySym?: string; streetSymUl?: string }): Promise<ResolvedLocation>
}
```

### Events

| Event ID | When | Notes |
|---|---|---|
| `sync_teryt.dictionary.refreshed` | A register finishes importing | `category: 'system'`; payload `{ entityType, imported, changed }`. Reuses `data_sync.run.*` for run lifecycle. |

### ACL features

- `sync_teryt.view` — view integration/config
- `sync_teryt.configure` — edit credentials / trigger refresh (plus `data_sync.run` to start the job)
- `sync_teryt.lookup` — call lookup API / use autocomplete

Add all to `setup.ts` `defaultRoleFeatures` (`admin`, `superadmin`; `lookup` also to `employee`) and run `yarn mercato auth sync-role-acls`.

---

## Integration & Test Coverage

Per repo rule, tests ship with the feature and are self-contained (fixtures via API, cleanup in `finally`).

### Unit tests (`packages/sync-teryt/src/modules/sync_teryt/__tests__/`)

- **Parsers**: TERC/SIMC/ULIC/WMRODZ row → normalized record (fixture rows; malformed rows skipped, not fatal).
- **Health check**: `file` mode reachable → healthy; `webservice` missing creds → unconfigured; bad login → unhealthy.
- **Location service**: cascading lookups + prefix search against seeded rows; `resolveByCodes` returns names.
- **Env preset**: `applyTerytEnvPreset` writes credentials + state idempotently.
- **Adapter**: `streamImport` yields batches with monotonic cursor and `hasMore` termination.

### Integration tests (`__integration__/`)

| Case | Asserts |
|---|---|
| `TC-TERYT-STATE` | enable via `PUT /state`; disabled integration rejects lookup |
| `TC-TERYT-CREDENTIALS` | save WS creds; secret redacted in `GET /credentials` and in logs |
| `TC-TERYT-IMPORT` | `POST /data_sync/run` (small fixtured source) → run `completed`, reference rows present, cursor persisted |
| `TC-TERYT-LOOKUP` | cascading endpoints return expected chain for a seeded commune/locality/street |
| `TC-TERYT-HEALTH` | health endpoint returns `healthy` / `unconfigured` per mode |
| `TC-TERYT-ACL` | user without `sync_teryt.lookup` gets 403 on lookup routes |

Import tests use a **small bundled fixture source** (a few rows), never the live GUS endpoint, to stay deterministic and offline-safe.

---

## Risks & Impact Review

| # | Risk | Severity | Area | Failure scenario | Mitigation | Residual |
|---|---|---|---|---|---|---|
| 1 | Global (non-tenant) reference tables deviate from tenant-scoping rule | High | Data model / governance | A reviewer treats shared `teryt_*` rows as a tenant-isolation violation; or a future field accidentally stores tenant data there | Explicit maintainer sign-off (this spec); tables hold only immutable public data; lookup API + credentials remain tenant-scoped; add a guard test asserting no tenant PII columns on `teryt_*` | Low after approval |
| 2 | ULIC volume (~250k rows) | Medium | Performance / memory | Loading the full file into memory OOMs the worker; slow upserts block the queue | Stream + parse incrementally; batch upserts (e.g. 1–5k); persist cursor per batch; run under `data-sync-import` concurrency limits | Low |
| 3 | Concurrent refresh from multiple tenants on shared tables | Medium | Correctness | Two tenants trigger a refresh simultaneously → duplicate/partial writes | System-level advisory lock around dictionary refresh; overlap detection in `data_sync` per (integration, entityType) | Low |
| 4 | GUS file format / endpoint changes | Medium | Reliability | Column reorder or endpoint move breaks parsing | Defensive parsers (skip+log bad rows), pinned column mapping in `parse/`, health check on reachability, integration logs surface failures | Medium |
| 5 | TERYT WS SOAP complexity | Low | Scope | WS mode harder than file mode | Ship `file` mode as default and primary path; `webservice` mode optional and behind `visibleWhen` | Low |
| 6 | Scope creep to postal codes / REGON | Medium | Product | Users expect postal-code autocomplete or NIP lookup | Explicit non-goals; documented as separate future providers | Low |
| 7 | Stale dictionary | Low | Data freshness | TERYT changes monthly; local copy drifts | Optional monthly `SyncSchedule`; `configure-from-env` + CLI `refresh`; changes-file delta import in a later phase | Low |
| 8 | Licensing/attribution of GUS data | Low | Legal | Missing attribution | Document GUS/TERYT as the source in docs and integration description | Low |

---

## Backward Compatibility

- **Purely additive.** New package, new module, new tables, new API routes, new ACL features, new event id. No existing contract surface changes.
- New event `sync_teryt.dictionary.refreshed` and new ACL ids follow naming conventions and are additive.
- Phase 2 address columns are added through consuming modules' own `data/extensions.ts` as **nullable** columns — no change to existing address semantics; free-text stays authoritative.
- The package is `ejectable` and optional; disabling it must leave the app fully functional (covered by the module-decoupling test pattern).

---

## Rollout Phases

1. **Phase 1 — Foundation & ingestion (this spec's core).** Package scaffold, `integration.ts` (enable/disable + credentials), reference entities + migration, `file` source + parsers, `DataSyncAdapter`, health check, env preset, unit + integration tests. Lookup service + lookup API. **Gate: maintainer approval of the global-table scope decision (Risk #1).**
2. **Phase 2 — Address assist (optional).** Cascading autocomplete widget injected into address forms; additive TERYT-code columns via `data/extensions.ts`; response enricher resolving codes → names. Behind `sync_teryt.lookup`.
3. **Phase 3 — WS mode + deltas (optional).** TERYT WS1 SOAP source; monthly scheduled refresh; incremental "changes" file import.

Each phase is independently shippable; Phase 1 delivers the requested enable/disable + credentials capability end-to-end.

---

## Open Questions (decision needed before coding)

1. **Reference-table scope** — approve **global/shared** `teryt_*` tables (recommended) vs per-tenant copies? (Risk #1.) This is the only blocker for Phase 1.
2. **Default data source** — ship `file` as the default (recommended) and keep `webservice` optional?
3. **Autocomplete host** — which address forms get the Phase 2 widget first (`customers`, `sales`, `staff`, `resources`)?

---

## Final Compliance Report

*(to be completed at implementation time — verify before merge)*

- [ ] Provider lives in its own workspace package under `packages/`; no provider code in `packages/core/src/modules/`.
- [ ] `integration.ts` exports a valid `IntegrationDefinition`; secrets use `type: 'secret'`; `visibleWhen` used for WS-only fields.
- [ ] Credentials encrypted at rest via `integrationCredentialsService`; never logged; resolved fresh per call.
- [ ] Ingestion runs only through the `data_sync` hub/queue (never inline); cursor persisted per batch; item-level errors logged, not fatal.
- [ ] All lookup API routes export `openApi`, validate inputs with Zod, gate on `sync_teryt.lookup`, `pageSize ≤ 100`.
- [ ] No cross-module ORM relationships; address linkage is plain code columns via `data/extensions.ts`.
- [ ] ACL features declared in `acl.ts` and wired in `setup.ts` `defaultRoleFeatures`; `sync-role-acls` documented.
- [ ] Provider-owned env preset (`OM_INTEGRATION_TERYT_*`) applied from `setup.ts` + rerunnable CLI.
- [ ] No hard-coded user-facing strings; i18n `en`/`pl` present.
- [ ] `updated_at` on user-editable entities where applicable; reference tables documented as append/refresh (locking rules noted).
- [ ] Unit + integration tests present and self-contained; import tests use bundled fixtures, not the live endpoint.
- [ ] `yarn generate`, `yarn build:packages`, `yarn typecheck`, `yarn lint`, `yarn test` pass.

---

## Changelog

- **2026-07-11** — Initial draft. Defines TERYT integration via the Integration Marketplace (enable/disable + optional credentials) and `data_sync` ingestion, reference data model, lookup API/service, test coverage, risks, and phased rollout. Pending maintainer decision on global vs per-tenant reference-table scope.
