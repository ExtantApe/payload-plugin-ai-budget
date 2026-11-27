# Changelog

## Unreleased

- Test audit after 0.1.0: 15 more tests, with no change to the plugin's code. They cover signed-out visitors, no updates or deletes through the API, the state collection's access, the ledger's fields, logs that carry no key or prompt, two more fail-closed reads, caps summed over many records, a $0 cap, the Notifications path with its fallbacks, the start-up warning, and the 75% and 90% marks. Tested: 37 integration tests with fake answers and a stand-in for Notifications, and a one-line mutation of the source for each new test. Not tested: a real API call, the real Notifications plugin, a real site.

## 0.1.0 (2026-11-13)

First version, from the platform's API cost ledger design and the owner's decision to make it a plugin: the ledger, caps that stop jobs cleanly and fail closed, dated prices with an Anthropic adapter, the credits-out pause with an hourly probe and one notice per run-out, the three-month auto-reload suggestion, the spend summary, and seeded test data that never counts toward a cap.

After the security read of 950abe1: answers with no usage are recorded as unpriced (with `recordUsage` for batch results), any job probes when no probe job is named, token counts and price tables are checked, job names match exactly, and run-outs flip the state atomically with a notice that survives failures.

Tested: 22 integration tests with fake answers, and a mutation check on 21 guards. Not tested: a real API call, a real site.
