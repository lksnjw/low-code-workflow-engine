#!/bin/sh
set -eu

registry_dir="/app/configs/registries"
seed_dir="/opt/agentic-orchestrator/configs/registries"
sample_dir="/app/configs/seed"
sample_source_dir="/opt/agentic-orchestrator/configs/seed"

mkdir -p "$registry_dir"
for registry_file in all_tools_master_registry.json all_rules_master_registry.json; do
  if [ ! -f "$registry_dir/$registry_file" ]; then
    cp "$seed_dir/$registry_file" "$registry_dir/$registry_file"
  fi
done

mkdir -p "$sample_dir"
for sample_file in sample_tools.json sample_rules.json; do
  if [ ! -f "$sample_dir/$sample_file" ]; then
    cp "$sample_source_dir/$sample_file" "$sample_dir/$sample_file"
  fi
done

exec "$@"
