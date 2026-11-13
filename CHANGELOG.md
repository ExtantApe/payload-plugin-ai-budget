# Changelog

## 0.1.0 (unreleased)

First version, from captive-origins-console ADR 0006 and D37: the ledger, caps that stop jobs cleanly and fail closed, dated prices with an Anthropic adapter, the credits-out pause with an hourly probe and one notice per run-out, the three-month auto-reload suggestion, the spend summary, and seeded test data that never counts toward a cap.

After the security read of 950abe1: answers with no usage are recorded as unpriced (with `recordUsage` for batch results), any job probes when no probe job is named, token counts and price tables are checked, job names match exactly, and run-outs flip the state atomically with a notice that survives failures.

Tested: 22 integration tests with fake answers, and a mutation check on 21 guards. Not tested: a real API call, a real site.
