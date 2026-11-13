# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the ops starter kit, area `co-plugins`.

- 2026-11-10 (D37, owner, Helm's question dialog): "AI Budget (Recommended)". The Claude API cost ledger and budgets from captive-origins-console ADR 0006 is its own plugin, `@extantape/payload-plugin-ai-budget`, agnostic of provider, led by the Plugins Lead (task K334, P1 scale plan). The Site lead wires it in and closes K250. MIT, public from its first push (D5) after the audit. Design in [architecture/0001-design.md](architecture/0001-design.md).
- 2026-11-10 (owner, ADR 0006 section 6, relayed by Helm): auto-reload stays off. When the credits run out, one notice that Claude services are paused until a prepaid amount is added; after 3 run-out months in a row, the notice also suggests a capped monthly amount. The plugin only suggests.
- 2026-11-10: a job that isn't in the caps is refused, so a new caller can't spend outside the budget by accident.
