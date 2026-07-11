# Service Orders Module (Serwisy)

## TLDR
**Key Points:**
- New OSS core module `services` that lets an operator create, plan, execute, and template **service orders** ("serwisy" / protokoły serwisowe) — the configurable, runtime-driven generalization of a rigid hardcoded system (reference: Hallster "Service Report Hub", where the `Protocol` aggregate, its 6 sections, and its state machine are all baked into PHP).
- Reuses existing platform engines instead of building new ones: **`workflows`** for the configurable process ("układanie klocków"), **`entities`** (custom fields) for dynamic form fields, **`business_rules`** for transition guards, **`attachments`** for files/photos.

**Scope:**
- Service order aggregate + numbering (`services_orders`).
- Configurable process/stages via the `workflows` visual editor (`sales → planning → execution → verification → finalization → completed`-style chains, fully admin-editable).
- Planning: define which **activities** must be performed and which **dynamic fields** appear on them — field kinds `text (input)`, `select`, `attachment (file)`, `boolean (checkbox)`, `multiline (textarea)`, plus `integer/float/date/datetime/dictionary`.
- Execution: capture the real values against the planned activities, with per-activity status and audit.
- **Service templates**: reusable blueprints binding a workflow definition + an activity/field blueprint.

**Explicitly OUT of scope (by request):**
- External client report generation, HTML→PDF export, and client-portal publication (the Hallster `ClientReportHtmlBuilder` / Gotenberg / `ReportExternal` pipeline). **Not built here.**
- `radio` field kind — modelled as `select` (radio is a render choice, not a distinct kind; the `entities` module has no `radio` kind).

**Concerns (if any):**
- Per-template field schemas do not map 1:1 onto the org-wide EAV custom-field model; resolved with a two-tier approach (see Design Decisions).
- Service-number generation has a concurrency race that must be guarded (unique constraint + retry).

---

## Overview

The `services` module gives operators a way to run field-service / servicing work as a **structured, configurable process** rather than a hardcoded one. A **service order** is the central aggregate (analogous to Hallster's `Protocol`): it references a customer, carries a generated number, moves through configurable stages, and collects planned + executed activities with dynamic data capture.

The design's core thesis: **everything Hallster hardcodes, Open Mercato already exposes as a configurable platform capability.** Hallster's fixed Symfony `state_machine`, its six code-baked sections, and its role-gated section access become, respectively: a **DB-backed `WorkflowDefinition`** editable in the React-Flow visual editor, a **runtime custom-field set** managed in the Data Designer, and **`business_rules` guards** on workflow transitions. The new module is therefore a thin **domain aggregate + glue**, not a new engine.

> **Market Reference**: Hallster "Service Report Hub" (documented in the uploaded `tworzenie-serwisu-i-raport-zewnetrzny.md`) as the concrete field-service reference, plus the OSS process-automation pattern already shipped in this repo's `workflows` module (`examples/sales-pipeline-definition.json`). **Adopted**: staged protocol lifecycle, per-stage data capture, activity checklist, template-driven creation, monthly-reset document numbering. **Rejected / deferred**: hardcoded section renderers, the report/PDF/publish pipeline, and a bespoke state machine — all replaced by configurable platform primitives or deferred out of scope.

## Problem Statement

Open Mercato has no way to model a service/servicing job. Confirmed by codebase search: no `service trip`, `wyjazd`, `serwis`, or `service visit` concept exists. Adjacent modules cover fragments but none model the job:
- `planner` — availability rules only (RRULE windows); no assignment or job entity.
- `resources` — bookable assets with capacity; no booking/appointment entity.
- `staff` — team members; no work assignment to a job.
- `sales` — commercial documents (quotes/orders/invoices); not operational service work.

Meanwhile the reference system (Hallster) proves the demand but is **rigid**: adding a stage, a section, or a field requires a backend deploy. We want the same business capability with **runtime configurability** and **maximum reuse** of existing engines.

## Proposed Solution

Introduce `packages/core/src/modules/services/` with three code-defined entities — `ServiceOrder`, `ServiceOrderActivity`, `ServiceTemplate` — and wire them to existing platform engines:

1. **Process (point 1 — "flow / układanie klocków")** → a `ServiceTemplate` references a `WorkflowDefinition` (by `workflowId`, cross-module FK id only). Creating an order from a template calls `workflowExecutor.startWorkflow()` and stores the returned `workflow_instance_id`. Stage changes are mirrored back onto `ServiceOrder.current_stage` via a workflow event subscriber. Admins design/edit the stage graph in the existing React-Flow visual editor — no code change.
2. **Planning + dynamic fields (point 2)** → two tiers (see Design Decisions): (a) org-wide runtime custom fields on `services:service_order` via the `entities` Data Designer; (b) per-template **activity blueprint** whose fields use the `entities` field-definition shape (kinds minus `radio`), snapshotted onto each `ServiceOrderActivity.field_schema`.
3. **Execution (point 3)** → each planned activity becomes a `ServiceOrderActivity` row with `status` (`planned → in_progress → done|skipped`), captured `field_values`, `completed_by_user_id`, `completed_at`. Workflow `USER_TASK` steps and the existing task inbox drive human execution; per-step audit is the workflow `WorkflowEvent` log plus per-activity timestamps.
4. **Templates (point 4)** → `ServiceTemplate` bundles the workflow definition + the activity/field blueprint + defaults; "create from template" snapshots the blueprint onto the order so later template edits don't mutate live orders.

### Design Decisions
| Decision | Rationale |
|----------|-----------|
| New **core** module `services` (not an app module) | Reusable platform capability, sits alongside `customers`/`sales`; follows "core platform features in `packages/core`". |
| Aggregate class named `ServiceOrder`, table `services_orders` | Avoids the DI/"service" prose collision that a bare `Service` class would cause; mirrors `sales_orders` naming precedent. |
| Process runs on the **`workflows`** engine (not a bespoke status enum) | It is exactly what `workflows` is for; gives the runtime visual "klocki" editor, `USER_TASK` execution, `business_rules` guards, and event triggers for free. A minimal default definition is seeded so the module works out of the box. |
| **Two-tier** dynamic fields: org-wide EAV custom fields **and** per-template JSON `field_schema` snapshots | Org-wide fields (filterable, indexed, list-visible) belong in the `entities` EAV model; but Hallster-style *per-template* forms cannot pollute a single global entity def, so they are stored as a JSON schema (reusing the same `CustomFieldDefinition` shape + the same `FieldDefinitionsEditor` UI) and snapshotted per activity. Values for the per-template tier are stored as JSON on the activity (`field_values`), matching the workflow `USER_TASK` `formData` pattern. |
| Reuse `entities` field-kind vocabulary, excluding `radio` | No new field-type surface; `radio` intentionally excluded per request and absent from `CUSTOM_FIELD_KINDS`. |
| Light planning fields (`scheduled_at`, `assigned_to_user_id`) on the order; **full booking deferred** | The four requested points don't include calendar dispatch; full time-booking against `planner`/`resources` availability is a named future phase, not MVP. |

### Alternatives Considered
| Alternative | Why Rejected |
|-------------|-------------|
| Model the service order as a runtime **custom entity** (`custom_entities_storage` JSON doc) | Loses first-class relations, command/undo semantics, optimistic locking, and clean cross-module FK ids; the aggregate deserves a real table. |
| Bespoke status-enum state machine inside `services` (Hallster-style) | Reproduces the very rigidity we're replacing; `workflows` already provides a superior, admin-configurable engine. |
| Store per-template fields as global `custom_field_defs` on `services:service_order` | Every order would surface every template's fields; per-template isolation requires the JSON-snapshot tier. |
| Generate reports/PDF now | Explicitly out of scope by request; large independent concern (builder + Gotenberg + versioning + portal publish). |

## User Stories / Use Cases
- **A service coordinator** wants to **create a service order for a customer from a template** so that **the correct stages, activities, and fields are pre-populated without manual setup**.
- **A planner** wants to **define which activities and fields a service requires** so that **technicians capture consistent data every time**.
- **A technician** wants to **work through the planned activities and fill their fields (text, select, file, checkbox, textarea)** so that **the real execution is recorded against the plan**.
- **An admin** wants to **edit the service process (stages) visually and add new fields at runtime** so that **process changes don't require a developer or a deploy**.

## Architecture

```
Create from template            Process (workflows)            Execution
──────────────────              ───────────────────            ─────────
POST /api/services/orders
  { templateId, customerId }
        │
        │ command: services.service_order.create
        ▼
  ServiceOrder (services_orders)  ── workflow_instance_id ──►  WorkflowInstance
        │  service_number (generator)                              │ USER_TASK / AUTOMATED steps
        │  snapshot template.activity_blueprint                    │ (task inbox, business_rules guards)
        ▼                                                          │
  ServiceOrderActivity[] (services_order_activities)               │ instance status/step events
        │  field_schema (JSON, from template)                      ▼
        │  status: planned                              subscriber: services updates
        ▼                                               ServiceOrder.current_stage
  Technician executes:                                            │
   PATCH …/activities/{id}  { status: done, field_values }        │
        │  command: services.order_activity.complete              │
        ▼                                                         ▼
   emits services.order_activity.completed          emits services.service_order.stage_changed

Org-wide dynamic fields:  entities Data Designer → custom_field_defs on `services:service_order`
                          → auto-rendered by CrudForm, stored in custom_field_values (EAV), indexed via query_index
```

Module isolation: cross-module links are **FK ids only** (`customer_id`, `workflow_definition_id`, `workflow_instance_id`, `assigned_to_user_id`); side effects flow through the **event bus** and the **command bus**, never direct ORM relations or imports of workflow internals (`workflowExecutor` resolved via DI).

### Commands & Events
Declared with `createModuleEvents` in `services/events.ts` (`as const`):
- **Commands**: `services.service_order.create` / `.update` / `.delete`; `services.order_activity.complete` / `.reopen`; `services.template.create` / `.update` / `.delete`. Each mutation defines an **undo** path (soft-delete / status revert / value restore).
- **Events**: `services.service_order.created` / `.updated` / `.deleted` / `.stage_changed`; `services.order_activity.completed` / `.reopened`; `services.template.created` / `.updated` / `.deleted`.
- `services.service_order.stage_changed` MAY set `clientBroadcast: true` for live board updates (DOM Event Bridge).

## Data Models

### ServiceOrder (`services_orders`)
- `id`: string (UUID, PK)
- `organization_id`: string (FK id, indexed) — mandatory tenant scope
- `tenant_id`: string (FK id, indexed)
- `service_number`: string (unique per tenant/month; see numbering)
- `title`: string
- `template_id`: string | null (FK id → `services_templates`)
- `customer_id`: string | null (FK id → customers)
- `workflow_definition_id`: string | null (FK id → workflows)
- `workflow_instance_id`: string | null (FK id → workflows)
- `current_stage`: string | null (mirrored from workflow current step; denormalized display state)
- `priority`: enum(`low`|`standard`|`high`|`urgent`) default `standard`
- `assigned_to_user_id`: string | null (FK id → auth user / staff)
- `scheduled_at`: timestamptz | null (light planning; NOT a booking)
- `notes`: text | null (operational only — see encryption note)
- `created_by_user_id`: string
- `created_at` / `updated_at`: timestamptz
- `deleted_at`: timestamptz | null (soft delete)

`updated_at` is returned as `updatedAt` in list/detail APIs for **optimistic locking** (default ON).

### ServiceOrderActivity (`services_order_activities`)
- `id`: string (UUID, PK)
- `organization_id` / `tenant_id`: string (FK id)
- `service_order_id`: string (FK id → `services_orders`, indexed)
- `key`: string (stable key from blueprint)
- `title`: string
- `description`: text | null
- `sequence`: integer (ordering)
- `status`: enum(`planned`|`in_progress`|`done`|`skipped`) default `planned`
- `field_schema`: jsonb — snapshot of the blueprint field defs (reuses the `entities` `CustomFieldDefinition` shape; kinds ∈ {`text`,`multiline`,`integer`,`float`,`boolean`,`select`,`attachment`,`date`,`datetime`,`dictionary`}, **no `radio`**)
- `field_values`: jsonb — captured at execution (keyed by field key)
- `completed_by_user_id`: string | null
- `completed_at`: timestamptz | null
- `created_at` / `updated_at` / `deleted_at`

### ServiceTemplate (`services_templates`)
- `id`: string (UUID, PK)
- `organization_id` / `tenant_id`: string (FK id)
- `name`: string
- `description`: text | null
- `workflow_definition_id`: string | null (FK id → workflows)
- `default_priority`: enum default `standard`
- `activity_blueprint`: jsonb — ordered `[{ key, title, description, sequence, fieldSchema: CustomFieldDefinition[] }]`
- `is_active`: boolean default true
- `created_at` / `updated_at` / `deleted_at`

### Custom fields (`entities` integration)
`services/ce.ts` registers `services:service_order` as an entity so admins can add **org-wide** custom fields at runtime (Data Designer) that are filterable/indexed and auto-rendered by `CrudForm`. Default field set may ship empty. Values live in `custom_field_values` (EAV); indexed fields flow through `query_index` via `makeCrudRoute({ indexer: { entityType: 'services:service_order' } })`.

### Numbering
`ServiceNumberGenerator` (DI service) produces `{counter}/{MM}/{YYYY}` (Hallster-style monthly reset), tenant/org-scoped, computed from the max in the current month inside a transaction. Uniqueness enforced by a DB unique constraint `(tenant_id, service_number)`; on collision, retry.

## API Contracts

All routes: `makeCrudRoute` where possible, `export const openApi`, Zod validators in `data/validators.ts`, `requireFeatures` guards, `organization_id` scoping, optimistic locking (409 conflict body) default ON.

### Service Orders
- `GET /api/services/orders` — list (filters: `status`/`current_stage`, `customerId`, `priority`, `assignedToUserId`, `ids=`, custom-field `cf:` selectors). Returns `updatedAt`, `customValues`, `customFields`.
- `POST /api/services/orders` — create. Request: `{ title, templateId?, customerId?, priority?, scheduledAt?, assignedToUserId?, protocol? }` (optional nested `protocol` seeds initial custom values). Command `services.service_order.create`: generate number, snapshot template blueprint → activities, `startWorkflow()` if a definition is bound.
- `GET /api/services/orders/{id}` — detail (order + activities + custom fields + workflow instance summary).
- `PATCH /api/services/orders/{id}` — update (optimistic-lock header required).
- `DELETE /api/services/orders/{id}` — soft delete.

### Activities
- `GET /api/services/orders/{id}/activities` — planned + executed list.
- `PATCH /api/services/orders/{id}/activities/{activityId}` — update status / `field_values`. Command `services.order_activity.complete` when `status=done` (stamps `completed_by_user_id`/`completed_at`, emits `services.order_activity.completed`). `.reopen` reverses it.

### Stage advancement
- Driven by the **workflows** module APIs (task inbox `POST /api/workflows/tasks/{id}/complete`, etc.). The `services` module does **not** re-implement transitions; it subscribes to workflow instance events and updates `current_stage`, emitting `services.service_order.stage_changed`.
- Optional convenience `POST /api/services/orders/{id}/advance` MAY wrap the workflow transition for a simple UI, guarded by `enforceCommandOptimisticLock` on the order aggregate.

### Templates
- `GET /api/services/templates`, `POST /api/services/templates`, `GET/PATCH/DELETE /api/services/templates/{id}` — CRUD (blueprint + workflow binding).

## Internationalization (i18n)
- Namespace `services.*` in `services/i18n/en.json` (+ `pl.json`): entity labels, stage/status labels, activity statuses, priorities, form labels, error keys (`services.errors.*`). No hardcoded user-facing strings; internal-only `throw`/`toast` prefixed `[internal]`.

## UI/UX
Backend pages under `services/backend/` using DS primitives only (semantic tokens, `CrudForm`, `DataTable`, `apiCall`/`useGuardedMutation`, `LoadingMessage`/`ErrorMessage`, `StatusBadge`, lucide icons, dialog `Cmd/Ctrl+Enter` / `Escape`):
- **Orders list** — `DataTable` (number, title, customer, stage badge, priority, assignee, scheduledAt); row + bulk actions.
- **Order detail** — header (number/stage/priority) + stage indicator (from workflow) + **activities checklist** (each activity renders its `field_schema` for execution capture) + org-wide custom fields via `CrudForm`.
- **Templates list + editor** — activity blueprint editor with drag-order; **field-schema editor reuses `@open-mercato/ui/backend/custom-fields/FieldDefinitionsEditor`** (kind options filtered to exclude `radio`); workflow-definition selector.

**Frontend Architecture Contract**: pages are Server Components by default; `"use client"` limited to interactive editors (activity checklist form, template blueprint/field editor, DataTable client bits) — each justified in the `"use client"` ledger. No heavy client blobs; workflow graph editing reuses the existing `workflows` client components rather than duplicating them.

## Migration & Compatibility
- New tables only (`services_orders`, `services_order_activities`, `services_templates`) — additive, no breaking changes. `yarn db:generate`; review SQL + `migrations/.snapshot-open-mercato.json` (keep only intended tables).
- `services/setup.ts`: declare ACL features, seed a **default service workflow definition** (so the module works before any custom definition exists), register `services:service_order` custom-entity, seed example template (optional, dev only).
- New module is opt-in via `enabledModules`; no impact on existing modules. `yarn generate` after adding module files.

## Implementation Plan

### Phase 1 — Aggregate + CRUD (works standalone, own status)
1. Scaffold `services` module (`index.ts`, `acl.ts`, `data/entities.ts`, `data/validators.ts`, `di.ts`, `events.ts`, `setup.ts`, `i18n/`).
2. Entities `ServiceOrder`, `ServiceOrderActivity`, `ServiceTemplate` + migrations + snapshot.
3. `ServiceNumberGenerator` (DI) + unique constraint + retry.
4. `makeCrudRoute` APIs for orders/activities/templates + `openApi` + Zod + optimistic locking.
5. Commands + events (`createModuleEvents`), undo paths.
6. Backend list + detail + template CRUD (DS-compliant). A minimal built-in status enum drives the order until Phase 3 wires workflows.
7. Integration tests: order CRUD, numbering uniqueness, activity complete/reopen, tenant isolation.

### Phase 2 — Dynamic fields
1. `services/ce.ts` registers `services:service_order`; `makeCrudRoute` indexer wiring; org-wide fields render in detail via `CrudForm`.
2. Per-template `field_schema` model + snapshot onto activities; execution capture (`field_values`) with the shared field renderer (kinds minus `radio`); `attachment` fields via `attachments`.
3. Field-schema editor in the template UI (reuse `FieldDefinitionsEditor`, filter kinds).
4. Integration tests: define fields → create order → capture values → list filter by `cf:` selector.

### Phase 3 — Process on workflows
1. Bind `ServiceTemplate.workflow_definition_id`; `startWorkflow()` on create; store `workflow_instance_id`.
2. Subscriber on workflow instance/step events → update `ServiceOrder.current_stage` + emit `stage_changed`.
3. Seed default service workflow in `setup.ts`; optional `business_rules` guard example on a transition.
4. Optional `POST …/advance` convenience wrapper (optimistic-lock guarded).
5. Integration tests: create-from-template starts instance; completing a `USER_TASK` advances stage and mirrors `current_stage`.

### Phase 4 — Templates end-to-end
1. Activity blueprint editor (ordering, per-activity field schema).
2. Create-from-template snapshotting (template edits don't mutate live orders).
3. Integration tests: template → order snapshot fidelity; template edit isolation.

### Future (explicitly NOT in this spec)
- Full time-booking / dispatch against `planner` availability + `resources` capacity (new booking entity).
- External client report generation, HTML→PDF (Gotenberg), report versioning, and client-portal publication.
- `radio` field kind.

### File Manifest (indicative)
| File | Action | Purpose |
|------|--------|---------|
| `packages/core/src/modules/services/index.ts` | Create | Module metadata + feature exports |
| `packages/core/src/modules/services/data/entities.ts` | Create | `ServiceOrder`, `ServiceOrderActivity`, `ServiceTemplate` |
| `packages/core/src/modules/services/data/validators.ts` | Create | Zod schemas |
| `packages/core/src/modules/services/acl.ts` | Create | Feature ids |
| `packages/core/src/modules/services/events.ts` | Create | `createModuleEvents` declarations |
| `packages/core/src/modules/services/di.ts` | Create | `ServiceNumberGenerator`, services |
| `packages/core/src/modules/services/ce.ts` | Create | Register `services:service_order` custom entity |
| `packages/core/src/modules/services/setup.ts` | Create | ACL sync, default workflow seed |
| `packages/core/src/modules/services/api/**` | Create | CRUD routes (`makeCrudRoute`) + `openApi` |
| `packages/core/src/modules/services/backend/**` | Create | List/detail/template pages |
| `packages/core/src/modules/services/subscribers/**` | Create | Workflow event → `current_stage` mirror |
| `packages/core/src/modules/services/migrations/**` | Create | Tables + snapshot |
| `packages/core/src/modules/services/i18n/{en,pl}.json` | Create | Translations |
| `packages/core/src/modules/services/__integration__/**` | Create | Integration tests |

### Testing Strategy
- Unit: number generator (monthly reset, collision retry), blueprint snapshot, activity status transitions, undo paths.
- Integration (self-contained, API fixtures, cleaned up in teardown): order CRUD + tenant isolation; dynamic-field capture + `cf:` filtering; create-from-template starts a workflow and stage mirroring; optimistic-lock 409 on concurrent edit.

## Risks & Impact Review

### Data Integrity Failures
- **Create-from-template is multi-step** (number + order + activities + `startWorkflow`): wrap order+activities+number in a single DB transaction; `startWorkflow` runs after commit and, on failure, leaves the order in `draft`/unbound state (retriable) rather than rolling back the order. Idempotent retry keyed by order id.
- **Concurrent edits** on an order/activity: optimistic locking (default ON) returns a structured 409; UI surfaces via `surfaceRecordConflict`.
- **Dangling FK ids** (customer/template/workflow deleted): FK-id-only links + defensive reads; deletions in other modules don't cascade — order keeps the id and degrades gracefully (label fallback).

### Cascading Failures & Side Effects
- **Workflow event subscriber failure** must not corrupt the order: `current_stage` mirroring is best-effort and event-driven; a dropped event is reconciled by reading the live instance on next detail load. No circular dependency (services depends on workflows one-way, via DI + events).
- **`startWorkflow` unavailable**: order still exists with its own minimal status (Phase 1 fallback); process can be (re)started later.

### Tenant & Data Isolation Risks
- Every query scoped by `organization_id`/`tenant_id`; number sequence and uniqueness are per-tenant. No shared global counters across tenants. Custom-field values inherit the `entities` module's tenant scoping.

### Migration & Deployment Risks
- Additive tables only; backward-compatible; no backfill. Module is opt-in. Re-runnable migration.

### Operational Risks
- **JSONB growth**: `field_schema`/`field_values`/`activity_blueprint` are bounded per order/template; monitor row sizes; large attachment payloads go through `attachments`, not JSON.
- **Blast radius**: isolated to the new module; failure does not affect `sales`/`customers`/`workflows` core paths.

### Risk Register

#### Service-number race under concurrent creation
- **Scenario**: Two orders created in the same tenant/month simultaneously compute the same next counter.
- **Severity**: Medium
- **Affected area**: `services_orders` creation, `ServiceNumberGenerator`.
- **Mitigation**: Unique constraint `(tenant_id, service_number)`; generate inside the create transaction; on unique-violation, recompute and retry (bounded).
- **Residual risk**: Rare extra retries under extreme contention; acceptable.

#### Template edits mutating live orders
- **Scenario**: Editing a template's activity/field blueprint changes already-running orders.
- **Severity**: Medium
- **Affected area**: `ServiceOrderActivity.field_schema`, execution integrity.
- **Mitigation**: Snapshot blueprint onto activities at creation; live orders never read the template again.
- **Residual risk**: Orders don't inherit later template improvements — by design; a future "re-sync" action can be added.

#### Per-template JSON fields are not natively queryable
- **Scenario**: Reporting needs to filter services by a per-template field value.
- **Severity**: Low
- **Affected area**: `field_values` JSON tier.
- **Mitigation**: Fields needing cross-service filtering are modelled as **org-wide** custom fields (EAV, indexed via `query_index`), not per-template JSON.
- **Residual risk**: Per-template fields remain non-indexed; acceptable for MVP (matches Hallster `formData`).

#### Stage mirror drift
- **Scenario**: A workflow event is missed; `current_stage` diverges from the live instance.
- **Severity**: Low
- **Affected area**: Order display state.
- **Mitigation**: `current_stage` is denormalized display only; detail view reconciles from the live instance; source of truth remains the workflow instance.
- **Residual risk**: Brief stale badge on list views until next event/read; acceptable.

## Final Compliance Report — 2026-07-11

### AGENTS.md Files Reviewed
- `AGENTS.md` (root)
- `packages/core/AGENTS.md`
- `packages/core/src/modules/workflows/AGENTS.md`
- `packages/core/src/modules/sales/AGENTS.md` (numbering/document precedent)
- `packages/ui/AGENTS.md`, `packages/shared/AGENTS.md`
- `.ai/skills/om-spec-writing/SKILL.md`, `.ai/specs/AGENTS.md`

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | No direct ORM relationships between modules | Compliant | FK ids only (`customer_id`, `workflow_*_id`, `assigned_to_user_id`) |
| root AGENTS.md | Filter by `organization_id` | Compliant | All queries + numbering tenant-scoped |
| root AGENTS.md | Singular entity/event/feature naming | Compliant | `services.service_order.*`, features singular |
| root AGENTS.md | Optimistic locking default ON | Compliant | `updated_at` + `updatedAt` in APIs; `CrudForm` header |
| packages/core/AGENTS.md | API routes export `openApi`, use `makeCrudRoute` | Compliant | All CRUD routes |
| packages/core/AGENTS.md | Zod validators, `z.infer` types, no `any` | Compliant | `data/validators.ts` |
| workflows/AGENTS.md | Resolve `workflowExecutor` via DI; never call lib directly | Compliant | DI-only; no workflow-internal imports |
| root AGENTS.md | Events via `createModuleEvents`, `as const` | Compliant | `events.ts` |
| root AGENTS.md | i18n, no hardcoded strings; `apiCall`/`useGuardedMutation`, DS tokens | Compliant | `services.*` namespace; DS primitives only |
| root AGENTS.md | Encryption for PII columns | Compliant (by avoidance) | Contact/PII stays in `customers`; only `customer_id` referenced. `notes` operational; if any contact/address free-text is later added it MUST get an `encryption.ts` map + `findWithDecryption`. |

### Internal Consistency Check
| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | Orders/activities/templates aligned |
| API contracts match UI/UX section | Pass | List/detail/template pages map to routes |
| Risks cover all write operations | Pass | Create, update, activity complete, template edit |
| Commands defined for all mutations | Pass | Create/update/delete + activity + template |
| Scope exclusions honoured | Pass | No report/PDF/publish; no `radio` |

### Non-Compliant Items
- None blocking. Encryption is satisfied by keeping PII in `customers`; a guard note is recorded should contact/address free-text be added later.

### Verdict
- **Fully compliant** — ready for implementation (skeleton/architecture level). Phase 1 may begin; each phase ships with its integration tests.

## Changelog
### 2026-07-11
- Initial specification. Scope: `services` module (service orders, activities, templates) on `workflows` + `entities` + `business_rules`. Excludes external report/PDF/publication and the `radio` field kind by request; full time-booking deferred to a future phase.
