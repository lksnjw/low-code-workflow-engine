# Frozen evaluation registries

`configs/registries` is the immutable input boundary for the research
experiment. Runtime server CRUD, bulk import, first-boot seeding, and rollback
must never write into this directory.
Changing either frozen file invalidates the committed experiment results and
requires a deliberate re-run and review of every reported metric.

The frozen files and their required SHA-256 hashes are:

```text
c1bc1f5ddd4f342e26ff0dae5133358bb660205f8cdd15ecc636b3cf26dcef39  configs/registries/all_rules_master_registry.json
ddde364d42ba7ae98ca95fa4ac1520077b851ce196d75b158ae755d403790a1f  configs/registries/all_tools_master_registry.json
```

Run the frozen evaluation from the backend directory:

```sh
APP_ENV=experiment go run -buildvcs=false ./cmd/run-experiment
```

The command's registry flag defaults are hardcoded to `configs/registries`.
Runtime registry environment variables do not participate in its path
selection.
