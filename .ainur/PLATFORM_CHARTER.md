# Nimbir platform charter

Re-scope on build-doctrine tripwires T1/T2/T6, 2026-11-03. Prompt `prm_988fc86f-f3ed-48d8-86be-947edf859b07` v1.

## Promise and name

Nimbir is the one public revenue cycle management solution for tracing claims from evidence to a human-reviewed next step; MergeAct, ClaimAct, and Tickmark are its modules, and Recall is an internal data-engine name (founder 2026-10-28, `prm_eb07b4a6` v75).

## State inventory

| store | path | cache/ledger | readers | delete-safe |
| --- | --- | --- | --- | --- |
| Work queue preview | `claim-lines.json` | cache: checked-in de-identified snapshot | `app.js` via `fetch('./claim-lines.json')` | yes, if regenerated from the approved source |
| Internal cohort source slices | `nimbir-real-recall-slice.json`, `nimbir-real-recall-slice-classified.json` | cache: checked-in de-identified snapshots | no runtime code reader in this repo; source for the derived `claim-lines.json` | yes, if approved source and derivation are retained |
| Rule findings | `data/rules-findings.json` | cache: checked-in findings snapshot | no runtime code reader in this repo | yes, if regenerated from the approved source |
| Appeal reference text | `appeals/codes.json` | cache: checked-in reference snapshot | `appeals/compose.js` `loadDefaultCodes()`, `appeals/composer-demo.html` via `fetch`, appeal tests | yes, if source versions remain recoverable |
| Synthetic 835 fixtures | `x12/fixtures/*.835` | cache: generated test fixtures | `x12/*.test.js`; generator `x12/fixtures/_gen.py` writes them | yes |
| Browser-loaded 835 and de-identified export | browser memory; optional user download via `x12/dropzone.js`, `x12/deid-export.js` | transient user input/output | `x12/dropzone.js`, `x12/parse835.js`, `x12/to-nimbir.js`, `app.js` | browser copy: yes; user's downloaded copy: under user control |
| Browser review simulation | in-memory `claims` and `events` in `app.js` | transient cache | `app.js` queue, detail, report, CSV export | yes |
| Workspace work items and audit | PostgreSQL `nimbir.hospital`, `hospital_member`, `work_item`, `work_item_audit`; schema in `migrations/0001_workspace.sql` | ledger: audit and human work state are delete-unsafe | `workspace/store.js` through `workspace/server.js`; `workspace/app.js` through the HTTP API | **no** |
| Workspace identity | Supabase Auth via `@supabase/supabase-js`; `SUPABASE_URL`, `SUPABASE_ANON_KEY` | external ledger | `workspace/server.js` `getUser()` and `signInWithPassword()` | **no** |
| Workspace database connection | PostgreSQL via `pg`; `DATABASE_URL` | external ledger dependency | `workspace/server.js`, `workspace/store.js`; `workspace/integration.test.js` and `workspace/browser-smoke.mjs` use guarded staging URLs | **no** |
| Static UI and visual assets | `index.html`, `surface.css`, `app.js`, `web3d/`, `appeals/*.html`, `brand/` | reproducible build assets | browser; `web3d/hero.min.js` is loaded from `index.html` when WebGL is available | yes |

The Docker static image excludes `workspace/`, `migrations/`, package files and `node_modules/` through `.dockerignore`; `workspace/server.js` is a separate Node service. The migration is an authoritative schema for the workspace ledger, not a cache.

## Seeded invariants

`prose` means an explicit unautomated gate debt; it is not counted as a passing doctrine §3 gate.

| ID | falsifiable invariant | executable check or prose | pager / status |
| --- | --- | --- | --- |
| N1 | Public UI uses only Nimbir as the product name; Recall remains an internal engine name; no public `Internal` tag. | `node scripts/check-public-names.mjs` (existing checker covers forbidden name pairings; `Internal` tag coverage still needed) | gate block; partial |
| N2 | Static JSON contains no direct patient identifiers or raw PHI. | `prose`: source metadata says `real_deidentified`; slice fields are hashes, demo IDs, dates, codes and aggregate claim attributes, and `claim-lines.json` has de-identified claim IDs. No raw 835, name, address, DOB, member ID or MRN fields were found in the inspected JSON key sets. This is schema-level evidence, not an independent re-identification audit. | gate block; audit pending |
| N3 | Workspace schema changes are append-only migration files; applied migration content is never edited. | `prose`: require a migration-history comparison in CI before next schema change. | gate block; pending |
| N4 | A second deployment of the same build leaves schema and data correct; the repeated Coolify redeploy error signature is recorded and eliminated. | `prose`: deploy twice against a disposable target, compare schema and data fingerprints, and capture both receipts. `0001_workspace.sql` has non-idempotent `CREATE TABLE` and `CREATE ROLE` statements, so this is currently open. | founder incident; open T6 |
| N5 | Workspace writes are scoped to a hospital membership, with row-level security and an actor-stamped audit row. | `node --test workspace/integration.test.js` with guarded local staging fixture; `node --test workspace/store.test.js` | gate block; fixture-dependent |
| N6 | Audit rows cannot be updated or deleted by the runtime role. | `node --test workspace/integration.test.js` with guarded local staging fixture | gate block; fixture-dependent |
| N7 | Destructive test setup cannot target a production or remote database. | `node --test workspace/synthetic-target.test.js` | gate block; wired test needed |
| N8 | A dropped 835 is parsed in browser memory and does not upload itself. | `prose`: `x12/dropzone.js` uses `FileReader` and contains no network call; add a browser network assertion before treating this as gated. | gate block; pending |
| N9 | An appeal draft quotes only present reference text and labels missing evidence for human review. | `node --test appeals/no-invented-fact.test.js appeals/compose.test.js` | gate block; wired test needed |
| N10 | The god's-eye trajectory reconciles exactly to its source rows and explains every movement between stages. | `prose`: Part B must supply the executable reconcile script and its command; this row becomes executable in commit 2. | gate block; pending Part B |

## Scope wall: what Nimbir is NOT

Nimbir is not an EMR, a clearinghouse, or a BPO replacement. The god's-eye is a trajectory view over RCM data, not a claims editor. The static workbench and local 835 drop-in do not submit claims, appeals, or payer transactions. The workspace ledger records synthetic work items and their audit history; it does not establish a live payer outcome.

## Estimate against the invariant list

The former tool estimate is void. Slice 1 needs a source definition and reconcile script for N10; UI and evidence work then follow. N2 requires a separate data review. N3 and N4 require migration and deployment harness work. N1, N7, N8, and N9 require gate wiring or coverage completion. N5 and N6 require the guarded local PostgreSQL fixture. No calendar estimate is credible until the missing slice spec and deployment receipts are available.

## Open findings

- The specified charter template and slice 1 spec were absent at their supplied paths in this environment. The headings here follow the user's section list; Part B remains blocked on its exact spec.
- T6's repeated Coolify error signature and deployment logs are not in this checkout. No deploy-idempotence receipt can be claimed.
- The public-name checker covers forbidden paired names but does not yet enforce every public `Internal` label or all module naming drift.
- The static cohort is de-identified real data, not synthetic data. The schema inspection above supports absence of direct identifiers but does not prove zero re-identification risk. A release gate must verify the full values and provenance.
- There is no repo-wide gate runner or `npm test` script in `package.json`; existing checks are individual commands.
