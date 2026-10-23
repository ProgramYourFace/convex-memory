# Changelog

## 0.1.0

The first release:

- The record, background ingest (gate, extraction, checks, relate, commit), `context`, `recall`, `remember`, `forget`,
  `restore`, `searchHistory`, `list`, `history` and `get`.
- Tags, filters and layers: every write names a tag set (a scope) and every read a nested `all` / `any` / `not` filter,
  with optional ranked layers.
- Purge by tag or by exact tag set, and `reopen`.
- Model access through the app's transport action: the Convex AI Gateway by default, or any OpenAI-compatible API.
- The maintenance sweep, run from the app's crons.
