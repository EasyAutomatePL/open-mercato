# Per-Tenant Backup & Restore from the Open Mercato CLI

> Status: **Draft / Proposed** — pending implementation
> Scope: Open Source edition. No enterprise overlay.
> Related: `.ai/specs/2026-05-12-railway-one-command-deploy.md` (sibling first-class CLI command; reuse its option-parsing, secret-redaction, and state-file conventions). Supersedes the manual `pg_dump` snippet in `apps/docs/docs/installation/vps.mdx`.

## TLDR

Add two first-class CLI commands — `mercato backup` and `mercato restore` — that produce and consume a **portable, per-tenant logical backup** of an Open Mercato instance.

`mercato backup --tenant <id>` walks every tenant-scoped table (discovered by reflection over MikroORM metadata), exports its rows filtered by `tenant_id` (and the organization subtree), copies the tenant's attachment blobs, and writes a self-describing archive: `manifest.json` + `tables/<table>.jsonl` + `blobs/`. Encrypted columns are exported **as ciphertext**; the manifest records the *fingerprints* of the encryption keys the data depends on — **no secret material is ever written to the archive**.

`mercato restore <archive>` validates that the target instance carries encryption keys matching the manifest's fingerprints, refuses to overwrite an existing tenant, imports the rows in dependency order inside a single transaction preserving the original IDs, restores blobs, and triggers a reindex of the rebuildable search stores.

**Phase 1** ships whole per-tenant export + preserve-ID restore. **Phase 2** adds `--into-new-tenant` (ID remapping / clone-into-same-instance), which is intentionally out of the first PR.

## Overview

### Why now

Open Mercato has **no native backup tooling**. An exhaustive search of the codebase found zero `pg_dump`/`pg_restore`/`backup`/`restore`/`export` implementations in `packages/cli` or anywhere else; the only references are prose in `apps/docs/docs/installation/vps.mdx` (a manual `docker exec … pg_dump > backup.sql` snippet) and a "schedule daily backups" checklist item. Operators who want to move, clone, or archive a single tenant have no supported path.

`mercato deploy railway` established the precedent that lifecycle operations belong **in our own CLI**, versioned with the app. Backup/restore is the natural next member of that family.

### Goals

- `mercato backup --tenant <id>` → a single portable archive containing everything needed to reconstitute that tenant on another instance running compatible code.
- `mercato restore <archive>` → a working tenant on the target, or a clean, actionable failure before any data is written.
- Correct handling of the three architecture traps: row-level multi-tenancy, out-of-database blob storage, and at-rest encryption.
- Reuse the `deploy railway` command conventions (hand-rolled flag parser, secret redaction, `.mercato/*.json` state, `console.log` + emoji UX, `spawnSync` for shell-outs).
- Forward-compatible table coverage: new modules are picked up automatically via MikroORM metadata reflection, not a hand-maintained allowlist.

### Non-goals (Phase 1)

- **Whole-instance `pg_dump`.** Out of scope; per-tenant logical export is the chosen model. (A future `--all-tenants` / physical-dump mode can be a separate spec.)
- **ID remapping / clone-into-same-instance.** Deferred to Phase 2 (`--into-new-tenant`).
- **Exporting rebuildable derived state** (search indexes, vector store, Meilisearch, cache, queues). These are reconstructed on restore via reindex, never carried in the archive.
- **Exporting secret material** (encryption keys, Vault DEKs). The archive records key *fingerprints* only; operators provision keys on the target out of band.
- **Point-in-time / incremental / streaming-to-remote backups.** Single full snapshot to a local path only.

## Problem Statement

Open Mercato is a **single shared PostgreSQL database with row-level tenant scoping** (`packages/shared/src/lib/db/mikro.ts` reads one `DATABASE_URL`; there is no per-tenant DB or schema). Nearly every domain entity carries nullable `tenant_id` and `organization_id` columns (`packages/core/src/modules/directory/data/entities.ts` defines `Tenant`/`Organization`; 40+ `data/entities.ts` files reference the scope columns). This makes a per-tenant backup a **filtered logical export**, not a database copy, and surfaces four problems a naive `pg_dump` cannot solve:

1. **No schema boundary to lean on.** Every table is shared; the backup must filter each table by `tenant_id` and by the organization subtree, and decide what to do with nullable "global/shared" rows.
2. **Blobs live outside Postgres.** Attachments store only metadata rows in the DB; file bytes live on local disk (`storage/attachments/<partition>/org_<org>/tenant_<tenant>/…`, see `packages/core/src/modules/attachments/lib/storage.ts` + `lib/drivers/localDriver.ts`) or in S3 (`packages/storage-s3/src/modules/storage_s3/lib/s3-driver.ts`). A DB-only export yields dangling `attachments` rows.
3. **Data is encrypted at rest.** With `TENANT_DATA_ENCRYPTION=yes` (default), tenant columns are ciphertext and lookup hashes (`email_hash`) are peppered. A restore without matching `TENANT_DATA_ENCRYPTION_KEY`, `…_FALLBACK_KEY`, `LOOKUP_HASH_PEPPER`, and any Vault-managed DEKs produces unreadable data and broken lookups.
4. **Custom fields are split across four tables.** `custom_field_defs`, `custom_entities`, `custom_entities_storage` (JSONB), and optionally `custom_field_values` (EAV, gated by `ENTITIES_BACKCOMPAT_EAV_FOR_CUSTOM`), plus per-tenant `encryption_maps` (`packages/core/src/modules/entities/data/entities.ts`).

## Proposed Solution

Two top-level CLI commands, registered as built-in CLI modules in the dispatcher alongside `deploy`/`db`/`queue` (`packages/cli/src/mercato.ts`; see the built-in registration block around the `db` module and the generic runner near the end of the file). Both are **bootstrap-free** — added to `BOOTSTRAP_FREE_COMMANDS` in `packages/cli/src/bin.ts` — because they operate on the raw database and filesystem, not the module runtime.

### `mercato backup`

```
mercato backup --tenant <tenantId>
  [--org <orgId>]...            # restrict to specific org subtrees (default: all orgs of the tenant)
  [--out <path>]                # output archive dir/tarball (default: ./backups/<tenant>-<timestamp>)
  [--blobs copy|skip]           # include attachment bytes (default: copy)
  [--gzip]                      # gzip the tarball (default: on for tarball output)
  [--dry-run]                   # print the export plan (tables + row counts + blob count) and exit
  [--yes]                       # skip interactive confirmation
```

Produces an archive (see **Data Models**). In `--dry-run` it opens the consistent snapshot, counts rows per table and blobs, prints the plan, and rolls back without writing.

### `mercato restore`

```
mercato restore <archive>
  [--yes]                       # skip the destructive-action confirmation
  [--blobs restore|skip]        # restore attachment bytes (default: restore)
  [--reindex|--no-reindex]      # rebuild search indexes after import (default: reindex)
  [--dry-run]                   # validate manifest + key fingerprints + tenant-absence, then exit
```

Phase 1 restore is **preserve-ID**: it writes rows with their original `tenant_id`/`org_id`/PKs. It **fails fast** if the target already contains the tenant, if a required encryption-key fingerprint is absent, or if a required global-scope dependency (see below) is missing on the target. Phase 2 adds `--into-new-tenant` for ID remapping.

## Architecture

### 1. Table discovery — reflection, not an allowlist

There is no central registry of tenant-scoped tables. The backup enumerates candidate entities via **`getOrmEntities()`** from `packages/shared/src/lib/db/mikro.ts` and selects those whose metadata declares a `tenant_id` (`tenantId`) property. This auto-covers new modules and honors the "never hand-maintain a table list" principle.

- Tables **with** `tenant_id` → exported filtered by `tenant_id = :tenant` (and, where present, `organization_id ∈ <org subtree>`).
- Tables classified as **rebuildable** (`entity_indexes`, `entity_index_jobs`, `entity_index_coverage`, `search_tokens`, `vector_search`, indexer log tables — all under `packages/core/src/modules/query_index/data/entities.ts` and the pgvector driver) are **excluded** and reconstructed on restore.
- Tables **without** `tenant_id` are not exported as tenant data; where the tenant's rows reference them they are treated as **global-scope dependencies** (below).

The rebuildable-exclusion set and the reindex trigger are declared in one place (`packages/cli/src/lib/backup/tables.ts`) so the two commands share the classification.

### 2. Organization subtree & global-scope rows

`Organization` is a tree (`parent_id`, `root_id`, `ancestor_ids`/`descendant_ids` JSONB in `packages/core/src/modules/directory/data/entities.ts`). Given `--tenant`, the backup resolves the full set of that tenant's org IDs; `--org` narrows to specific subtrees using `descendant_ids`.

Many definition rows are **nullable-scope / global** (`tenant_id IS NULL`): global `custom_field_defs`, roles/ACL, currencies. Phase 1 **does not duplicate** them into the archive. Instead the manifest records them as **`globalDependencies`** (table + natural key), and restore **validates their presence** on the target, failing fast with an actionable message if missing. Rationale: duplicating shared definitions into a live target causes conflicts/duplicates; validation keeps restore idempotent and safe.

### 3. Custom fields

Exported together, all filtered by tenant/org where the column exists:

- `custom_field_defs` — tenant-scoped defs **plus** the global defs referenced by exported records (recorded as `globalDependencies`, not copied).
- `custom_entities` — the tenant's custom-entity registry rows.
- `custom_entities_storage` — the primary JSONB value store (`doc` column).
- `custom_field_values` — the legacy EAV store, exported **only when** `ENTITIES_BACKCOMPAT_EAV_FOR_CUSTOM=true`. The manifest records the flag; restore refuses if the target's flag disagrees (data would be written to the wrong store).
- `encryption_maps` — per entity/tenant/org record of which fields are encrypted at rest.

### 4. Encryption & the secret manifest

Encrypted columns are exported **verbatim as ciphertext** — the backup never decrypts. What makes restore safe is a **secret manifest**, not secret material:

- The manifest's `encryption` block lists every key the exported ciphertext depends on **by fingerprint** (e.g. SHA-256 of the key bytes, truncated): `TENANT_DATA_ENCRYPTION_KEY`, `TENANT_DATA_ENCRYPTION_FALLBACK_KEY`, `LOOKUP_HASH_PEPPER`, and any Vault DEK reference (`VAULT_KV_PATH` + key id) discovered from `encryption_maps` / env.
- On restore the target's live keys are fingerprinted the same way and compared. A missing or mismatched fingerprint aborts the restore **before any write**, with a message naming the exact env var / Vault path to provision.
- No plaintext key ever touches the archive or the logs. Log redaction reuses `redactText`/`assertSafeVariables` patterns from `packages/cli/src/lib/deploy/railway/redaction.ts`.

### 5. Blob store

Attachment metadata rows are exported like any tenant table; the **bytes** are handled separately:

- **Local driver:** resolve the real partition roots via the attachments storage helper (roots can be relocated by `<PARTITION>_…` env overrides — never assume `./storage`), then copy the `…/tenant_<id>/…` subtrees into the archive's `blobs/` tree, keyed by `attachment.id`.
- **S3 driver:** stream objects under the tenant prefix into `blobs/` (or, with `--blobs skip`, record only their keys). Reuse the S3 client from `packages/storage-s3/src/modules/storage_s3/lib/s3-driver.ts`.
- On restore, bytes are written back through the target's configured driver. If the target's partition layout differs, `storage_path` is rewritten to match; `attachment.id` is the stable join key.
- `--blobs skip` records blob references in the manifest without bytes (metadata-only backup) and restore warns that attachments will be dangling.

### 6. Consistency — one snapshot

The export runs inside a single **`REPEATABLE READ` read-only transaction** (or an exported Postgres snapshot) so cross-table state is coherent and no half-written FK relationships are captured. Blob copies are taken after the DB snapshot opens; a blob referenced by an exported row but already deleted from storage is recorded as a `missingBlob` warning rather than failing the whole run.

### 7. Restore ordering & atomicity

- Restore imports inside a single transaction. FKs are predominantly **intra-module** (cross-module direct ORM relations are forbidden — links are by-ID), so a per-module topological order suffices; as a safety net the importer uses `SET CONSTRAINTS ALL DEFERRED`.
- Preserve-ID import writes original PKs/`tenant_id`/`org_id`. Tenant-absence is checked first (`SELECT 1 FROM tenants WHERE id = :id`); a present tenant aborts unless a future `--force` is explicitly designed (not in Phase 1).
- Schema-version guard: the manifest records the per-module migration ledger state (`mikro_orm_migrations_<module>`). Restore compares against the target and aborts on incompatibility with guidance to migrate first. (Same-version and forward-only-additive targets are accepted.)

### 8. Rebuildable stores & reindex

After a successful import, restore triggers a reindex of the query index / search stores (the existing `reindex` CLI path → `query_index reindex`, scoped to the restored tenant). Cache and queue state are never restored. This keeps the archive small and avoids importing stale derived data.

### 9. CLI integration & reused building blocks

- **Dispatch:** register `backup` and `restore` as built-in CLI module ids in `packages/cli/src/mercato.ts` (mirror the `deploy` block) and add them to `BOOTSTRAP_FREE_COMMANDS` in `bin.ts`.
- **DB access:** reuse `getClientUrl()` and `getSslConfig()` from `packages/cli/src/lib/db/commands.ts` / `packages/shared/src/lib/db/ssl.ts`; open a raw `pg` `Client` for the snapshot export exactly as `dbGreenfield` does, and a MikroORM instance only where metadata reflection is needed.
- **Options/redaction/state:** mirror `packages/cli/src/lib/deploy/railway/{options.ts,redaction.ts,state.ts}` for the flag parser, secret redaction, and any resumable state.
- **New code lives under** `packages/cli/src/lib/backup/` (`index.ts` orchestrators `runBackup`/`runRestore`, `tables.ts` classification, `manifest.ts` schema + fingerprinting, `blobs.ts`, `archive.ts`).

## Data Models

### Archive layout

```
<archive>/                     # directory, or a (optionally gzipped) tarball of it
  manifest.json
  tables/
    <table_name>.jsonl         # one JSON row object per line, ciphertext left intact
  blobs/
    <attachment_id>            # raw bytes (omitted when --blobs skip)
```

### `manifest.json`

```jsonc
{
  "schemaVersion": 1,
  "kind": "open-mercato-tenant-backup",
  "createdAt": "2026-07-11T00:00:00.000Z",   // stamped by the command, not the script
  "source": { "databaseLabel": "host:port/db", "appVersion": "0.6.x" },
  "tenant": { "id": "<uuid>", "organizationIds": ["<uuid>", "..."] },
  "tables": [
    { "name": "customers", "module": "customers", "rowCount": 1234, "checksum": "sha256:…" }
    // rebuildable tables are absent by design
  ],
  "customFields": { "eavBackcompat": false },
  "encryption": {
    "required": [
      { "kind": "env", "name": "TENANT_DATA_ENCRYPTION_KEY", "fingerprint": "sha256:ab12…" },
      { "kind": "env", "name": "LOOKUP_HASH_PEPPER", "fingerprint": "sha256:cd34…" },
      { "kind": "vault", "path": "secret/data/mercato", "keyId": "dek-1", "fingerprint": "sha256:ef56…" }
    ]
  },
  "globalDependencies": [
    { "table": "custom_field_defs", "naturalKey": { "entity_id": "…", "field_key": "…" } }
  ],
  "blobs": { "mode": "copy", "count": 42, "driver": "local", "missing": [] },
  "schema": { "migrations": { "customers": "Migration2026…", "sales": "Migration2026…" } }
}
```

No `Date.now()`/`Math.random()` inside any workflow/generator script path — timestamps and any random archive suffix are produced by the command process itself.

## API / CLI Contracts

- **New commands:** `mercato backup`, `mercato restore` (additive; no existing command changes). Additive CLI surface per `BACKWARD_COMPATIBILITY.md` (CLI commands are ADDITIVE-ONLY).
- **Exit codes:** `0` success; non-zero on validation failure (missing key fingerprint, tenant already present, schema mismatch, missing global dependency) with an actionable message via `formatCliFailureMessage`. Restore never partially commits — validation failures occur before the write transaction.
- **No new HTTP API routes.** This is a CLI/DB/filesystem feature only.
- **Env consumed:** `DATABASE_URL`, `TENANT_DATA_ENCRYPTION*`, `LOOKUP_HASH_PEPPER`, `ENTITIES_BACKCOMPAT_EAV_FOR_CUSTOM`, `VAULT_*`, attachment `<PARTITION>_…` root overrides, S3 `OM_INTEGRATION_STORAGE_S3_*` when the S3 driver is active.

## Phasing

- **Phase 1 (this PR):** table discovery via metadata; per-tenant filtered export with org-subtree resolution; custom-fields (4 tables + EAV flag) + `encryption_maps`; ciphertext export + secret-fingerprint manifest + restore-time validation; local + S3 blob copy; consistent snapshot; preserve-ID restore with tenant-absence + schema-version + global-dependency guards; post-restore reindex; `--dry-run` for both commands.
- **Phase 2 (follow-up spec/PR):** `--into-new-tenant` ID remapping (FKs, EAV `record_id`, JSONB-embedded IDs in `custom_entities_storage.doc`, org-tree `ancestor_ids`/`descendant_ids`), enabling clone-into-same-instance; optional `--force` overwrite of an existing tenant.

## Integration & Test Coverage

Per repo policy, tests ship in the same PR as the feature and are self-contained (fixtures created in setup, cleaned up in teardown, no reliance on seeded data). See `.ai/qa/AGENTS.md`.

**Unit (`packages/cli/src/lib/backup/__tests__/`):**
- Table classification — a fake entity-metadata set → correct tenant-scoped vs rebuildable partition; a newly added tenant-scoped entity is auto-included.
- Manifest fingerprinting — same key bytes → same fingerprint; different bytes → different; no plaintext leaks into the serialized manifest.
- Options parsing + secret redaction (mirror the railway option/redaction tests).
- Org-subtree resolution from `descendant_ids`.
- Restore guards (pure): missing key fingerprint, present tenant, EAV-flag disagreement, schema-version mismatch, missing global dependency → each returns the expected typed failure.

**Integration (`packages/cli/src/lib/backup/__integration__/`, gated like the railway live test):**
- **Round-trip:** seed a tenant (customers + custom fields + an encrypted field + one attachment) via API fixtures → `backup` → drop the tenant → `restore` into the same DB → assert row counts, decrypted values, a working `email_hash` lookup, and the attachment bytes match.
- **Cross-instance:** `backup` from DB A → `restore` into DB B that shares the encryption keys → same assertions.
- **Failure paths:** restore aborts (no writes) when a key fingerprint is absent, when the tenant already exists, and when a global dependency is missing.
- **Blob modes:** `--blobs skip` produces a metadata-only archive; restore warns and leaves no orphaned bytes.

## Risks & Impact Review

| Risk | Severity | Affected area | Mitigation | Residual |
|------|----------|---------------|------------|----------|
| Silent data loss on restore into a live instance | High | Restore | Tenant-absence guard; validation before any write; single transaction | Operator can still target the wrong DB — mitigated by printing the `host:port/db` label and requiring `--yes` |
| Encrypted data unreadable after restore (missing keys) | High | Encryption | Secret-fingerprint manifest + fail-fast validation naming the exact key/Vault path | Fingerprint collision is negligible (SHA-256) |
| Incomplete backup — attachment rows without bytes | Medium | Blobs | `--blobs copy` default; `missingBlob` warnings; metadata-only mode is explicit + warned | Bytes deleted between snapshot and copy are recorded, not silently lost |
| New tenant-scoped table missed by the exporter | Medium | Table discovery | Metadata reflection (not an allowlist) + a guard test asserting new tenant-scoped entities are auto-included | A table that omits `tenant_id` but is conceptually tenant data would be missed — documented; add to classification if it arises |
| Restore into a schema-incompatible target | Medium | Schema | Per-module migration-ledger comparison + abort with guidance | Forward-only-additive drift accepted; complex diverging schemas require manual migration |
| Global-scope dependency absent on target → dangling refs | Medium | Global rows | `globalDependencies` recorded + validated pre-import | Operator must provision global defs first (documented) |
| Secret leakage via archive or logs | High | Security | No secret material in archive (fingerprints only); log redaction reused from railway; archive is not encrypted but contains no keys | Ciphertext archive still holds sensitive data — operators should protect it at rest (documented) |
| Inconsistent snapshot under load | Low | Consistency | Single `REPEATABLE READ` snapshot for the whole export | Very long exports hold a snapshot — acceptable for a maintenance operation |

## Backward Compatibility

Additive only. New CLI commands (`BACKWARD_COMPATIBILITY.md`: CLI commands are ADDITIVE-ONLY), no changes to existing commands, types, event IDs, DB schema, DI keys, ACL features, or API routes. No migrations. The archive `schemaVersion` is versioned so future formats can be read/upgraded without breaking Phase-1 archives.

## Final Compliance Report

_To be completed at implementation time:_ validation commands run (`yarn workspace @open-mercato/cli test`, `yarn workspace @open-mercato/cli build`, `yarn typecheck`, `yarn lint`), round-trip integration evidence, secret-redaction proof, and confirmation that no rebuildable/derived data or secret material is written to the archive.

## Changelog

- 2026-07-11 — Draft created. Scope fixed to per-tenant logical export; artifact = DB (ciphertext) + blobs + secret-fingerprint manifest; Phase-1 restore is preserve-ID, ID remapping (`--into-new-tenant`) deferred to Phase 2. Verified against the codebase that no native backup tooling exists and that the data model is single-DB row-level multi-tenant with out-of-DB blob storage and at-rest encryption.
