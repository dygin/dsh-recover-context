# Changelog

All notable changes to dsh-recover-context are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-08-20

First release.

### Added

- **Rollback** — an undo icon under every user question. Clicking it (and
  confirming) discards that question and everything after it: the conversation
  context is cut (the old session is archived, a child session continues from
  before the question) and the workspace files those turns produced are
  restored from per-turn checkpoints.
- **Edit & resubmit** — a pencil icon on the most recent question (and in the
  composer toolbar while an answer is still generating). It loads the question
  text into the composer without touching the conversation; the cut happens
  only when the message is actually submitted, so a page refresh before submit
  leaves the conversation untouched.
- **Workspace checkpointing** — the host records a baseline snapshot and a
  differential snapshot per completed turn (`.git`, `node_modules`,
  `.pnpm-store`, `dist` etc. are ignored; small files carry content blobs), so
  rollback can restore added/modified/deleted files exactly as they were at
  the rollback point. Forked child sessions fall back to the nearest earlier
  checkpoint (their baseline) for inherited (seeded) turns.
- **Icon-only UI** — circular ghost buttons with hover chrome, tooltips, and a
  two-step confirm (red check) for the destructive rollback.
- Host JSON API (`/recover-context/api/checkpoints`, `/restore`) and a
  configurable tracker (`~/.dsh/storages/recover-context/config.json`).

### Notes

- Checkpoints are recorded from the moment the plugin is installed; earlier
  turns have no file snapshots (context rollback still works for them).
- Files larger than `blobSizeCap` (default 1 MiB) are not restorable and are
  reported as skipped.

[1.0.0]: https://github.com/dygin/dsh-recover-context/releases/tag/v1.0.0
