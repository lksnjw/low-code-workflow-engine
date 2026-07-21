#!/bin/sh
set -eu

registry_dir="/app/configs/registries"
seed_dir="/opt/agentic-orchestrator/configs/registries"

mkdir -p "$registry_dir"
for registry_file in all_tools_master_registry.json all_rules_master_registry.json; do
  if [ ! -f "$registry_dir/$registry_file" ]; then
    cp "$seed_dir/$registry_file" "$registry_dir/$registry_file"
  fi
done

exec "$@"
