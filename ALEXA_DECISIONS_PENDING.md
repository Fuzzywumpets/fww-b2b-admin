# Pending decisions / autonomous fixes log

## 2026-05-26 23:50 UTC — Loop crashed (E2BIG)
- Iters 8-20 all exited 126 due to `/usr/bin/claude: Argument list too long`
- Root cause: loop.sh inlined `$(cat HANDOFF.md)` as a CLI arg; HANDOFF.md grew to 158KB after Phase 19/19E/20/21/22/23 appends, exceeding Linux's 128KB per-argument limit (MAX_ARG_STRLEN)
- **Fix applied**: removed the inlining from loop.sh line 33. CONT prompt already instructs agent to "Read HANDOFF.md in full" so no behavior change.
- Backup at loop.sh.bak (kept for safety)
- **Restarted loop** at 23:51 UTC with MAX_ITERS=20

## Pre-crash status
- ✅ Phase 18 (Xero accounting) SHIPPED before crash — 222 tests green
- Remaining queue: 15 (catalogs+teams), 16D (backorder), 19D (persistent cart), 21 (Xero customer sync), 22 (impersonation), 23 (activity warehouse)
- Phase 18 used mock ensureXeroContact; Phase 21 will add real customer sync — agent should reconcile when 21 ships
