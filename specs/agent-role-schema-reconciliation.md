# Agent Role schema reconciliation on Save

Status: draft
Translation: pending

Opening a workspace or Role catalog never rewrites saved Roles. The former automatic
startup reconciliation hook is not mounted. The editor owns reconciliation on an
explicit Save, per target, using that target's machine and Agent capabilities.

Only authoritative capabilities can change saved option selections. Failed or
unavailable probes preserve the stored configuration. Model and permission pins
remain visible when incompatible, preventing a silent change to runtime defaults.
The editor filters sensitive options and checks the resulting values before saving.

Only the Role owner may save. The editor receives the complete catalog Role so an
edit to one target retains all other targets and their memory bindings. Effective
changes advance the revision once; a no-op save retains it. Writes serialize one
target as v1 and multiple targets as v2, resolve on local durability, and upload
independently. Accepted Operations keep their frozen configuration.

Evidence: [editor](../packages/components/src/components/settings/agent-role-editor-dialog.tsx),
[explicit-save preparation](../packages/components/src/lib/agent-role-form.ts), and
[shared authoring](../packages/shared/src/agent-role-form.ts).
