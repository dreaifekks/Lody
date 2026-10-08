# LAN usage and Prompt Shortcuts

Two hosted services a [LAN](lan.md) does without: usage counted on each
machine, and Prompt Shortcuts synced through the LAN's own hub.

## Usage

The hosted service counts what every agent used from what each machine reports
to it. A LAN has no such service, so each machine counts for itself: on the
local platform the agent service's usage port is a ledger on its own disk
(`apps/cli/src/lib/usage/local-usage-ledger.ts`, `<data dir>/usage-ledger.json`).
It receives the cumulative per-model counters an agent reports, adds what a
reading grew by since the highest one of its accounting scope, which is how the
hosted service counts too, and files the growth under the hour it arrived and
the workspace of the session. Hours older than a week are kept as days.

```text
 Settings > AI Usage ─ lan/machines ─▶ agent service ─ lan/usage ─▶ every member of the LAN
                      lan/usage (self)  of this machine   (direct, else the hub)  answers from its ledger
```

The page asks every machine of the workspace's LAN with `lan/usage`, a request
members put to each other like `lan/update-machine`, and builds the hosted
page's timeline, calendar and day views from the answers
(`packages/components/src/lib/lan-usage.ts`). Every member of a LAN is one user,
so the second chart splits by machine where the hosted page splits by member.
A machine that is offline or runs a build without `lan/usage` is named under
the header and left out; its usage is on its own disk until it answers again.
The `localUsage` platform capability shows the page where `usageAnalytics`
does not.

## Prompt Shortcuts

The hosted service decides who may read a shortcut: it stages and activates
each publication, revokes deleted ones, lists the documents a user may open
and grants a token per document. A LAN needs none of it. Its members are one
user, and whoever reaches the hub may read every document anyway. The desktop
therefore syncs the shortcuts of a LAN workspace through that workspace's own
gateway, the `lody-hub://<lan id>` origin the bridge forwards
(`packages/shared/src/prompt-shortcuts/single-user.ts`):

- A publication uploads its body, then writes its row in the user's private
  index. A deletion is the row's tombstone.
- The index is the directory: every member shows what it holds, and a
  tombstone removes the copy on the other members. When two members change one
  shortcut at once, the later publication wins.
- Whenever a desktop reaches the hub again, it sends the shortcuts that waited
  for it and uploads the bodies it published, which a restored hub may lack.
  A shortcut the index does not know is published again: one saved on this
  machine before its build synced shortcuts, or one a restored hub lost.
- There is nobody to share with, so the sharing switch is hidden and every
  shortcut stays private.

The provider takes this path for a workspace whose platform sync resolves to
a fixed gateway (`streams`) on a platform without `cloudAccount`; no
capability changes. A workspace without a gateway keeps its shortcuts on the
machine.
