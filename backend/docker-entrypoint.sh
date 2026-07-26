#!/bin/sh
set -eu

sample_dir="/app/configs/seed"
sample_source_dir="/opt/agentic-orchestrator/configs/seed"

mkdir -p "$sample_dir"
for sample_file in sample_tools.json sample_rules.json; do
  if [ ! -f "$sample_dir/$sample_file" ]; then
    cp "$sample_source_dir/$sample_file" "$sample_dir/$sample_file"
  fi
done

exec "$@"
