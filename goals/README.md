# San Francisco expansion goals

Orchestration registry for the playable map expansion. Each goal records its
owner, requirements, dependencies, performance budget, visual criteria, and
verification gate. The active goal in the Codex goal tracker mirrors the
current in-flight entry here.

Order and dependency rules:

1. Baseline audit must be green before any implementation goal starts.
2. Geography reference must be accepted before district implementation.
3. District implementation must land before traffic/signal integration.
4. Streaming/visibility tuning follows the district content it must hide.
5. Integration QA and visual critique gate every "complete" claim.

Performance budget is fixed across goals: application-owned frame work at or
below 16.67 ms with no traversal, streaming, signal, or entry spikes above the
application budget on the QA machine and TARGET HARDWARE.
