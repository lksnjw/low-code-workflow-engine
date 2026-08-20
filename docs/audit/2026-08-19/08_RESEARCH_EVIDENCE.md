# Research evidence

## Metric integrity

- A semantic registry backfill assigns a hardcoded relevance score of `0.99`; it is not a measured similarity and is therefore MOCKED as a metric (`backend/internal/core/orchestrator/chat_orchestrator.go:276-303`).
- Synthesis confidence is always the constant `0`; this is a disclosed placeholder rather than a measured confidence (`backend/internal/core/synthesizer/ollama_client.go:54-58`, `backend/internal/core/synthesizer/ollama_client.go:91-102`).
- Generation cost is always `0.0`, so cost dashboards do not measure provider billing (`backend/internal/core/synthesizer/ollama_client.go:91-102`, `backend/internal/api/handlers/analytics_handler.go:89-103`).
- Projected monthly cost and runtime F1 are explicitly zero/unavailable, not fabricated success metrics (`backend/internal/api/handlers/analytics_handler.go:48-53`, `backend/internal/api/handlers/analytics_handler.go:160-165`).
- Provider token counts are read from Gemini, Ollama, and OpenAI-compatible response usage fields and mark whether they were measured (`backend/internal/core/synthesizer/gemini_client.go:100-121`, `backend/internal/core/synthesizer/openai_client.go:63-80`, `backend/internal/core/synthesizer/ollama_client.go:287-308`).

Model/provider and usage are logged for synthesis, but model version, prompt version, prompt hash, and registry hash are not durably linked to each invocation (`backend/internal/core/synthesizer/ollama_client.go:83-132`). Gate audit records contain registry/workflow hashes and timestamps but no model/prompt fields (`backend/internal/core/validator/registry_validator.go:1042-1065`). Validation latency is measured by the experiment harness but is not a separate durable runtime field (`backend/dataset/eval/experiment.go:202-249`, `backend/internal/models/state.go:36-52`).

## Experiments and datasets

Gate-on/gate-off modes, machine-readable CSV/JSON metrics, a fixed seed, and exact frozen registry paths are IMPLEMENTED (`backend/dataset/eval/generator.go:20-24`, `backend/dataset/eval/experiment.go:28-50`, `backend/dataset/eval/experiment.go:282-335`, `backend/cmd/run-experiment/main.go:21-56`). The dataset generator itself documents six self-approval false-negative probes when no SOD rule exists (`backend/dataset/eval/generator.go:58-69`, `backend/dataset/eval/experiment.go:28-36`). This directly weakens the claim that approval/SOD is enforced.

Repository datasets exist: generated safe/unsafe experiment JSONL plus the separate 5,000-record semantic-validation dataset and batch files (`backend/dataset/eval/generator.go:20-24`, `datasets/semantic_validation/README.md:1-39`). Train/test separation for the semantic-validation corpus is `UNDETERMINED`; searches for `train split`, `test split`, and split manifests did not find a code-enforced partition (`datasets/semantic_validation/generate_dataset.py:1-80`).

## Missing evidence for a defensible results table

The minimum missing set is: a gate-on production binary with no gate-off switch; real approval and idempotency trials; a held-out independently labeled dataset; end-to-end real MCP trials; per-invocation model/prompt/registry/policy provenance; separate model/gate/network latency; nonzero measured cost where available; multiple-run confidence intervals; and adversarial cases for templated SOD and direct dispatch (`backend/internal/api/handlers/gate_invariant_test.go:215-237`, `backend/internal/core/validator/registry_validator.go:402-500`, `backend/internal/tools/mcp_client.go:60-101`).
