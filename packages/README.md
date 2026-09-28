# Packages

Packages in this repository follow the **deep module** pattern: a lot of behavior behind a small interface.

## Layout

```
packages/<name>/
  index.ts        # Entry point (public). Import this from outside.
  client.ts       # Another entry point. Packages may expose SEVERAL small entry points.
  lib/            # Implementation: hidden from outside, free to import each other.
  tests/          # Co-located tests and fixtures (subfolder, so private).
```

Import only through a package's entry points (its root files). Anything in any subfolder is private implementation detail.

**Do not use barrel files.** Expose several small, focused entry points (e.g., `index.ts`, `client.ts`, `server.ts`) instead of re-exporting an entire subtree through a single bloated index.

## The Four Boundary Rules

1. **Entry-point boundary**: Code outside a package (application code or another package) may import only that package's root entry points, never anything inside its subfolders.
2. **Intra-package freedom**: Files within the same package are free to import each other's subfolder modules directly without restriction.
3. **Tests through the entry points**: Test files under `tests/` exercise the package through its public root entry points just like external consumers. Tests may import their own `tests/` fixtures, but may never import internal implementation subfolders directly.
4. **No circular dependencies**: Dependency cycles between modules are strictly forbidden.

## Running Boundary Checks

Run boundary verification using `bun`:

```bash
bun run lint:boundaries
```
