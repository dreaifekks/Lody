# Agent Role machine targets

Status: draft
Translation: stale

[中文](agent-role-machine-targets.zh.md)

A Role shares its name, description, prompt and visibility across stable targets.
Each target owns machine, Agent config, run config and memory. Targets never stand
in for one another. The LAN extension permits several on one machine: the key is
alias when present, otherwise the existing Agent family identity. That key is
unique only within one Role on one machine. Aliases can repeat across machines
and Roles; different unaliased Agent families can share a machine.

Dispatch requires a machine when several machines are configured. Several targets
on that machine require an alias or target id. A target id resolves its own machine;
any machine or work context supplied alongside it must match. Missing/unavailable
pins fail clearly. Ordering, caller machine, Agent type and availability never
break ties. CLI bare aliases resolve only when exactly one target matches.

Both mention and composer menus list every target separately, showing the Agent
name when unaliased. A choice always pins its stable id. `@Role@machine` lists all
of that machine's targets. Text-only hydration requires a unique match. The editor
shows shared fields and individual targets; Settings retains the upstream flat
Role list. Explicit Save reconciles authored run options against capabilities.

Single targets serialize as v1, multiple targets as v2. Old clients skip v2 and
never rewrite it. Catalog opening is read-only. Legacy v1 `instances` rows retain
all targets, their ids, run options and memory; enabled earlier `placements` also
remain readable. Single-target aliases and ids survive later edits. Frozen turns
and Operations retain their accepted config regardless of catalog changes.

Schedules, Boards, MCP and CLI use the same target selection. Existing stored
instance-id references remain exact target pins. Deleted targets never fall back
to an Agent saved beside the Role reference. Permission-capped direct MCP writes
and user-confirmed proposal cards share the same catalog and serialization.

Evidence: [model](../packages/shared/src/agent-role.ts),
[authoring rules](../packages/shared/src/agent-role-form.ts),
[CLI resolution](../apps/cli/src/lib/agent-role-create.ts),
[shared Schedule resolver](../packages/shared/src/schedule-proposal-target.ts).
