# dsh-session-archive

A DSH Web plugin for **session archive management** — restore archived sessions, delete sessions into a **recoverable trash**, and manage that trash by hand.

> Status: **complete and in real use.** Verified on DSH `0.1.5-rc.2` → `0.2.2-rc.5`;
> 12 suites / 374 assertions plus a 40-check real-runtime e2e all pass.

---

## Why this plugin exists

Three prior plugins of this kind were installed on this machine, and all three failed the same way:

| Plugin | Outcome |
|---|---|
| `dsh-session-xc` | Feature-complete, but its delete path never drove the host lifecycle → **ghost sessions**; every DSH upgrade needed a fresh local patch |
| `dsh-session-manager` | Its host half was written against an old contract (`list()` returning a header array), so on current hosts it **silently did nothing**: delete only hid rows without removing files, restore always returned 404, and both reported `200 ok` |
| `@michengai/dsh-archive-manager` | **Took over** the official `workspace` and `session-projection-cache` rows and replaced their implementations → a half-installed/half-removed state meant "native row disabled + replacement not mounted = nothing works" → **DSH refused to boot**; it also shipped a self-updater that rewrote profile configuration |

This plugin turns those three lessons into design constraints.

## Hard design constraints

1. **Consume native services; never replace them.** It never `disabled`s a native row and never takes over `workspace` / `session-projection-cache` / `ui-workspace`. The worst case is a **missing feature**, never a DSH that will not boot. `install.mjs` re-checks this on every run and refuses to write when violated.
2. **No self-updater.** Upgrades are performed by the user, so cooling-off periods and code review stay in human hands.
3. **No DOM injection.** The client half only uses the official `settings.section` slot (an additive slot with `replaceRisk: none`).
4. **Fail-soft and fail-loud are separated.** A single cleanup failure does not block the main flow; but "delete" either really deletes or returns an explicit error — **"looks deleted but is not" is never acceptable**.
5. **`stat`-verify before deleting.** Path derivation lives in `lib/paths.js`, the only code with a real risk of deleting the wrong thing.
6. **Never silently discard trash entries.** Capacity and retention are only measured and reported; eviction requires explicit human confirmation.

## A key decision: the trash must live **outside** `sessions/`

The host scanners do not filter dot-directories:

```js
listProjectDirs: entries.filter(e => e.isDirectory())   // no dot filter
listSessionDirs: entries.filter(e => e.isDirectory())   // no dot filter
```

And `listArtifacts` contains:

```js
if (ids.has(header.id)) throw new Error(`duplicate JSONL session id ... appears in multiple project directories`)
```

The consequence is concrete: **if the trash keeps a copy of some id while that id also exists elsewhere (not yet deleted in place, or left in a historical directory), DSH fails to start.** `checkRootEncoding()` also walks every project/session directory under the root for encoding validation, so trash leftovers get swept into that too.

The trash therefore lives **outside** the `sessions` root but on the **same device** (under `~/.dsh`), so `rename` takes the atomic fast path with zero copying:

```
~/.dsh/session-archive/
├── index.json                             # cache / human inspection only; each entry is its own source of truth
└── trash/
    └── <epochMillis>-<sessionId>/          # timestamp prefix = deletion order, sorted for free
        ├── session.v<N>.jsonl[.zstd]       # the whole original session directory moved in
        ├── session.lock
        └── .dsh-archive-meta.json          # per-entry metadata travels with the directory
```

## Trash management policy

| Dimension | Default | Behaviour when exceeded |
|---|---|---|
| Entries | 100 | **No automatic deletion**; marked "needs cleanup", the UI explains and offers one-click cleanup of the oldest N |
| Total size | 2 GB | Same |
| Retention | 30 days | Same |
| Single entry | 200 MB | Refuses the move; offers an explicit hard delete instead |

**No automatic eviction.** The whole point of a trash is "I can still get it back if I deleted it by mistake"; silently dropping the oldest entries would turn a recovery guarantee into a lottery.

- **Check before deleting**: crossing a limit returns `trash-full`, and the UI proposes which entries to clear first (with title/time/size).
- **After each delete / at startup**: expired entries are only **counted**, never deleted; a badge appears at the trash entry point.
- **Low disk space**: the delete is refused up front rather than performed and regretted.

## Operation semantics

- **Delete** (archived view → Delete) ⇒ files move into the trash; the session is removed from the archive set **and from workspace accounting**
  (accounting must be detached, otherwise the file is gone but the accounting remains, leaving a ghost row).
- **Restore** (trash → Restore) ⇒ files move back to their **original path** and the session is **re-attached to its original workspace**;
  it returns **unarchived**, so it appears in the normal sidebar (not the archive list).
  If the id has been reused or `createdAt` does not match, the restore is **refused** and never overwrites anything.

## Restore semantics (three cases)

| Case | Test | Action |
|---|---|---|
| Normal | `original.sessionDir` exists and is empty; no log with the same id exists | Move the directory back → clear the archive mark |
| Original directory gone | The parent (project) directory does not exist | Recreate the project directory from `header.cwd` and move it back |
| **Id already reused** | The existing log's `createdAt` ≠ the recorded value | **Refuse to restore** (`id-reused`), never overwrite existing data |

## Directory layout

```
patches/dsh-session-archive/
├── package.json              # includes icon / exports (locale, icon) / files
├── cordis.patch.yml          # inserts only its own row, disables nothing native
├── install.mjs               # idempotent install/uninstall (enforces the "no native row disabled" invariant)
├── icon.svg                  # 36×36 plugin icon (marketplace / Settings display)
├── locale/{en,zh}.json       # meta.title / meta.description / meta.detail
├── docs/
│   ├── DETAIL.md             # detail document (a single image line)
│   ├── DETAIL.zh.md
│   └── preview.svg           # 640×300 feature preview (text-free, light/dark safe)
├── lib/
│   ├── index.js              # host: 8 /api routes + the delete pipeline
│   ├── paths.js              # ★ path derivation (the only code that can delete the wrong thing)
│   ├── archive-list.js       # archive list assembly (including title backfill)
│   ├── unarchive.js          # unarchive (native-first, with fallback)
│   ├── trash.js              # trash pure logic (capacity / metadata / identity checks)
│   ├── trash-io.js           # trash file operations (per-file rename + reverse rollback)
│   └── client.js             # client: the settings.section page
└── test/                     # 12 suites + e2e (see "Tests")
```

## Development phases

| Phase | Scope | Status |
|---|---|---|
| **P0** | Package skeleton, composition layer, `install.mjs`, `lib/paths.js` + unit tests, host apply skeleton | ✅ done |
| **P1** | Host read-only: archive list (`lib/archive-list.js` + `list` route) | ✅ done |
| **P2** | Host restore: `unarchive` (`lib/unarchive.js` + route, including stale marks) | ✅ done |
| **P3** | Host delete: the full trash soft-delete chain (`lib/trash.js` + `lib/trash-io.js` + routes + ghost regression tests) | ✅ done |
| **P4** | Client UI: the `settings.section` page (two tabs + two-step confirmation + capacity hints) | ✅ done |
| **P5** | Hardening: configurable capacity, manual batch cleanup, content-integrity tests, documentation | ✅ done |

## Verified / unverified boundary (honest list)

**Verified against real mechanisms** (no DSH restart required):

| Area | How |
|---|---|
| Path encoding matches the host | Cross-checked against **real directory names** under `~/.dsh/sessions` (`paths.disk.test.mjs`) |
| Disk effects of the delete pipeline, failure rollback | Real temporary directories (`trash-io.test.mjs`, `ghost-regression.test.mjs`) |
| The id is entirely gone from the sessions tree after deletion | Recursive scan of real directories (`ghost-regression.test.mjs`) |
| Content integrity (delete → restore byte-identical) | Real file I/O (`hardening.test.mjs`) |
| **The profile configuration that install/uninstall rewrites** | Full lifecycle in a sandboxed profile (`install.test.mjs`) |
| **The real `dsh` loader composes the plugin row** | Isolated `DSH_HOME` + `dsh --dump-config` (`composition.test.mjs`) |
| Client bundle format and slot contract | Real client code executed under a mock environment in Node (`client.test.mjs`) |

**Verified in a real DSH runtime** (`npm run e2e`) — a real web instance is started in a **fully isolated `DSH_HOME`** (on a different port; the running instance is never touched), the plugin's `/api` routes are called for real using the `dsh` launch token exchanged for a browser session cookie:

| Check | Result |
|---|---|
| Plugin mounts in a real runtime, all 7 routes register | ✅ |
| `workspaceRegistry.state.archivedSessionIds` readable at runtime | ✅ |
| All dependent services available (connection / registry / persistence / sessions / projectionCache / agents) | ✅ |
| launch token → cookie authentication chain | ✅ |
| Cross-site `Origin` rejected by the official auth fence (403) | ✅ |
| Unauthenticated / missing-parameter requests fail loud (400 / 404), never fake success | ✅ |
| **Full round trip**: a real session artifact deleted → trashed → restored, **byte-identical** | ✅ |
| Client half: registered in the boot manifest, `client.js` in a preload batch, delivered bundle contains the plugin code in `__ModuleLoader__` form with the settings section id | ✅ |
| **Live session path** (deleted after being opened, via `detachEntered`): no longer live afterwards, restorable, byte-identical | ✅ |
| Restore re-attaches to the original workspace (`reattached: true`, covering `createCanonical` / `attachSession`) | ✅ |

**Browser rendering** has been confirmed by the user on a real page (the tabs appear; archive / delete / restore / purge all work).

### Known limits unrelated to the implementation

- Session artifacts must use the **canonical layout** `session.v<N>.jsonl[.zstd]`. The legacy flat layout `session.jsonl.zstd`
  is rejected by the host's own backend (`legacyLayout`), and this plugin does not handle it either.
- Archived session **titles** come from log backfill: live sessions use `sessionTitle` (zero cost), cold sessions use
  `sessionQuery.observeSession()` (the host caches by revision). To bound the cost, **at most 24 cold sessions are
  backfilled per list call**; the rest fill in on later calls, and the UI falls back to the sessionId when a title is unavailable.

## Host interfaces depended on (for upgrade triage)

`lib/paths.js` replicates **internal** (non-exported) functions from `@deepseek-ai/dsh-session-persistence-jsonl`:
`encodeSegment` / `projectKey` / `projectDir` / `sessionDir` / `logPath`. `paths.disk.test.mjs` cross-checks them against
the **real directory names** under `~/.dsh/sessions`, so any host encoding change turns the tests red immediately.

The remaining interfaces are **internal fields, not public API** — the main risk surface of this project:

| Purpose | Interface | Risk |
|---|---|---|
| Read/write the archive set | `workspaceRegistry.state.archivedSessionIds`, `.setState()`, `.enqueueOperation()` | medium |
| Detach workspace accounting | `WorkspaceEntity.detachSession(id)` | low (public) |
| ~~Clear the projection cache~~ | **Removed**: inspection showed clearing on delete is both unnecessary (a cache row cannot resurrect a deleted session) and harmful (it destroys `title` and other derived data) | — |
| Publish removal | `sessions.get/flush/liveEntryFor/detachEntered` (live)<br>`sessionPersistence.open` → prepare/enter/announce (cold) | low |
| Locate a session directory | `sessionPersistence.locate()` (**not exported**) → falls back to computing the path | **high** |

## Environment variables

| Variable | Effect |
|---|---|
| `DSH_HOME` | DSH home (auto-detected, consistent with `dsh` itself) |
| `DSH_SESSION_ARCHIVE_ROOT` | Overrides the trash root (default `<DSH_HOME>/session-archive`). Used for test isolation or to move the trash to another disk. |
| `DSH_SESSION_ARCHIVE_LIMITS` | JSON override of the capacity policy, e.g. `{"maxEntries":50,"maxBytes":1073741824,"retentionDays":14,"maxSingleBytes":104857600}`. Invalid values fall back to the defaults — **a typo in configuration must never damage data**. |

## API endpoints

All live behind the official `/api` fence (`isTrustedApiRequest` + cookie auth) and accept `POST` only:

| Endpoint | Purpose |
|---|---|
| `sessionArchive.list` | List archived sessions (including stale marks as `state:'missing'`) |
| `sessionArchive.unarchive` | Unarchive (stale marks are only cleared with `allowStale:true`) |
| `sessionArchive.delete` | Delete into the trash (refused while the session is running) |
| `sessionArchive.trash` | List the trash (including a `broken` entry report) |
| `sessionArchive.restore` | Restore from the trash to the original location |
| `sessionArchive.purge` | Permanently remove one entry (irreversible) |
| `sessionArchive.purgeExpired` | Batch cleanup; requires an explicit `sessionIds` / `oldestCount` / `onlyExpired` |
| `sessionArchive.repairOrphans` | Re-attach sessions that exist on disk but are accounted by no workspace (idempotent) |

## Install

```bash
node install.mjs --dry-run     # preflight: print the changes only
node install.mjs               # the regular bundle channel (automatic backups)
node install.mjs --remove      # uninstall
```

**Restart DSH** afterwards (bundles are read at startup).

## Version compatibility

**Fully verified on DSH 0.2.2-rc.5** (previously 0.2.0-rc.2 / 0.1.7-rc.2 / 0.1.5-rc.2).

Host interfaces depended on (each was checked to exist with an unchanged shape):

| Service / interface | Purpose |
|---|---|
| `connection.fetch.register({path, methods, requestBody, fetch})` | Register `/api` routes (paths must match `ENDPOINT_SEGMENT_PATTERN`) |
| `workspaceRegistry.{list,get,resolveByPath,state,setState,enqueueOperation}` | Archive set read/write (through the serial queue) |
| `workspace.{record.sessionIds,record.path,attachSession,detachSession}` | Accounting for delete/restore |
| `registry.unarchiveSession()` | Unarchive (**preferred**, it emits `workspace/session-unarchiving`) |
| `sessionPersistence.{list,root,stat}` | Session enumeration and path derivation |
| `sessions.{get,detachEntered}` / `agents.get(id).status` | Running-state detection and detaching |
| `sessionTitle.get(session)` / `sessionQuery.observeSession(id)` | Title resolution (live / cold) |
| events `session/disposed` → `api-session/removed` | Tell the browser to drop a row |
| `sessions.{prepare,enter,announce,liveEntryFor,detachEntered}` | Detaching live sessions (deleting a session you opened) |
| `registry.createCanonical` / `workspace.attachSession` | Re-attach on restore |
| client `ctx.get('sessions').refresh()` | Re-list core sessions after a restore |
| client slot `settings.section` | Render the settings page |

### Why there is no `dsh.engines.dsh`

An early version declared `dsh.engines.dsh: ">=0.1.5-rc.1"`. **That was wrong:**

- Under node-semver rules, a prerelease version satisfies a range only when the range contains a prerelease comparator with the
  **same `major.minor.patch` tuple**. So `>=0.1.5-rc.1` does **not** match `0.1.7-rc.2`, and `*` and `>=0.1.5` exclude every
  prerelease as well. **No static range can express "any rc".**
- A full recursive check confirmed that **nothing in DSH 0.1.7-rc.2 reads `dsh.engines`**, and official packages
  (`dsh-base` / `dsh-web-app` and friends) do not declare it either.

It was therefore removed (`dsh` keeps only the `bundle` and `client` fields the host actually reads), and the verified
versions are recorded in the table above instead.

## Tests

```bash
node test/run.mjs        # 12 suites / 374 assertions (fast, no external dependencies)
npm run coverage         # coverage report (exact V8 coverage)
npm run e2e              # real DSH runtime end-to-end (40 checks, isolated instance, ~1–2 min)
```

`npm run e2e` starts a real web instance in a temporary `DSH_HOME`, so it is **not part of the default suite**.
It does not modify the real profile and never touches a running instance.

## Cleaning up runtime data after uninstalling

```bash
rm -rf ~/.dsh/session-archive      # trash + index (permanently discards trash contents)
```

Archive state lives in `~/.dsh/storages/workspace.json` under `archivedSessionIds` (owned by the host; uninstalling this
plugin does not affect it).

## License

MIT
