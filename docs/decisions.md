# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the standard repo starter kit.

- 2026-11-10 (owner): the Claude API cost ledger and budgets, designed for the platform's console, become their own plugin, AI Budget, `@extantape/payload-plugin-ai-budget`, agnostic of provider. The site that uses it wires it in. MIT, public from its first push after the audit. Design in [architecture/0001-design.md](architecture/0001-design.md).
- 2026-11-10 (owner): auto-reload stays off. When the credits run out, one notice that Claude services are paused until a prepaid amount is added; after 3 run-out months in a row, the notice also suggests a capped monthly amount. The plugin only suggests.
- 2026-11-10: a job that isn't in the caps is refused, so a new caller can't spend outside the budget by accident.
