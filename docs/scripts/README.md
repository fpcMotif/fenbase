# Docs scripts

The docs site is English-only (`docs/docs/en/`).

| Script | Purpose |
|---|---|
| `check-deprecated-doc-refs.mjs` | Fails when docs reference deprecated pages or terms (rules in `deprecated-doc-rules.mjs`). |
| `normalize-doc-links.mjs` | Verifies `_meta.json` sidebar links resolve; `--write` auto-fixes missing/explicit-index/extra slashes. |
| `normalize-html-output.mjs` | Post-build HTML normalization. |
| `gen_rag.sh` | Generates RAG output from the docs build. |

Run all checks with `./check.sh` from `docs/`. Dead Markdown links are enforced by rspress `checkDeadLinks` at build time.
