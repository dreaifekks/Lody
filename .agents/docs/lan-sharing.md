# LAN shared conversations

How a [LAN](lan.md) publishes a conversation as a read-only copy that the hub
keeps and serves to readers without the credential.

## Shared conversations

The hosted product publishes a conversation as a frozen, read-only copy that
anyone with its link opens ([static sharing](../../specs/session-sharing.md)).
In a LAN the hub keeps that copy and serves it, to whoever reaches the hub
and, through a tunnel such as Cloudflare's, to the internet.

```text
 window ── capture ─▶ shell ─ temp dir ─▶ agent service ─ credential ─▶ hub gate :8788
 (upstream export,                       lan/share-publish            /lan/shares/…
  attachments off)                                                    shares/ in its data dir
                                                                           │
 reader ◀──────────────── hub share listener :18790, no credential ────────┘
                          /s/<id>, /s/<id>/share.json, /s/<id>/d/<deployment>/<object>
```

**Publishing.** The window captures the conversation and the conversations
under it with the upstream exporter (`prepareSharePackage`), with file
attachments omitted by the upstream switch and history left uncompressed, so
the reader needs no Zstd. A picture of a LAN conversation is a file of an
image type, so it is omitted too; a typed image block, which only the hosted
store backs, fails the capture. Only the answers are published: before the
exporter sees a history, `projectLanShareHistory`
(`packages/shared/src/lan-share-visible.ts`) keeps the user's messages and,
of each assistant turn, what the reader shows with the work folded (the
closing text, earlier text of 300 characters or with structure, and the
answer's pictures and files). Every entry and item is rebuilt from the
fields the reader reads (a text keeps its text, an assistant turn its id and
times, never its input configuration), so nothing rides along in another
field. Thinking, tool calls with their commands and diffs, short narration,
subagent tasks, plans and notices never leave the window; a turn that shows
no answer (still running, or ending in work) keeps only its substantive
text, and one left empty is dropped. The reader folds by the same file, so a published turn shows what
it would have shown folded, and no row to open. A share published before
this keeps its full history until it is updated. The shell writes the frozen package to a
temporary directory and hands it to the agent service of its own machine
(`lan/share-publish`), as it hands over the files of a message; the agent
service uploads it to the hub of the workspace's LAN with the credential and
answers with the link. The window never addresses the hub for a share and
never holds the credential; it learns the share listener's address only as
part of a link, which is what a reader needs. Settings > Share management lists the shares of
the workspace (`lan/shares`) and revokes them (`lan/share-revoke`); the
conversation header and the `…` menu open the upstream share dialog, which a
fork hook (`packages/components/src/lib/lan-session-share.ts`) feeds instead of
the hosted operations. Both appear on the `lanSharing` platform capability, in
a workspace of a LAN only.

**Storage.** A share is content-addressed in `shares/` of the hub's data
directory: `objects/<sha256>` holds the manifest, each history and each image
once, and `index.json` the shares, each with its title, the source
conversations (for the next update), a revision and its current deployment,
which is the digest of its manifest. An upload sends the objects the hub lacks
(`PUT /lan/shares/objects/<sha256>`, checked against its digest) and then
commits the manifest (`POST /lan/shares`); the hub checks the manifest with the
upstream schema, refuses a compressed history or a file attachment, and
requires every object it names. Nothing is published before the commit, which
replaces `index.json` in one rename.

**Update and revoke.** An update commits a new manifest to the same share id,
so the link stays; it names the revision it replaces and is refused (409) when
another update came first. A reader that opened the previous deployment keeps
reading its objects for ten minutes, never a mix: the reader asks for objects
under the deployment it started with. Revoking removes the share from
`index.json` at once, with its retired deployments, so its link and every
object path under it answer 404 from that moment; objects no share names are
deleted when the hub next collects, an upload younger than an hour excepted.
Bytes a reader already downloaded cannot be recalled.

**Reading.** The hub serves readers on a listener of its own, by default port
18790 (`lody lan hub --share-port`; the port after the gate's, 8789, is the
member port of the agent service on the same machine), on the same address and
with the same certificate. That listener knows no credential and has exactly
these routes: `/s/<id>` (the reader page), `/s/<id>/share.json` (title,
deployment and manifest), `/s/<id>/d/<deployment>/<object id>` (an object of
that manifest), the page's script and style, Lody's icon (`/_lody/lody-icon.png`)
and the pages' favicon and preview picture (`/_lody/icon`, `/_lody/preview`)
under `/_lody/`. Everything else,
`/ds/` included, answers 404, so a tunnel pointed at this port can reach
nothing else of the hub; the gate, for its part, serves no `/s/` route. The
id is 24 random bytes. Answers are `no-store`, `noindex`, never framed, and
the page runs under a CSP that allows only its own origin, so a link or image
in a conversation loads nothing from elsewhere; an object answers with
`sandbox`. The reader (`packages/lan-share-reader`) is a small page of its
own, no part of the desktop: it renders the messages as Markdown (micromark,
which drops raw HTML and unsafe link targets) and lists the conversations
when there are several. It reads like the desktop's share page. A run of
tool calls is one folded row that says what it did ("Ran 3 commands · Edited
1 file", counted as the desktop counts); thinking is counted but never shown.
A finished turn shows its answer (with earlier text of 300 characters or with
structure), and the work before it folds into one "Worked for …" row, or a
step count when the history holds no duration; opened, each group returns to
its place. The page leads with Lody's mark. The CLI build copies the page and
the icon beside its bundle, where the hub reads them.

**Page head.** The hub writes the head of `/s/<id>` itself, since a link
preview runs no script: the title (`<title> · Lody`), the favicon, and Open
Graph and Twitter tags. `og:url` and `og:image` are absolute, on the public
address, or else the address the request came by; the description is a fixed
sentence, so a preview shows nothing of the conversation but its title. The
favicon and the preview picture are Lody's icon until a member sets its own
in Settings > Share management (`lan/share-image`, through the shell as a
file, then `PUT /lan/shares/images/icon|preview`); a preview a member did not
set shows their icon. The hub reads the type from the bytes and takes PNG,
JPEG or WebP, ICO for an icon, never SVG (it can carry script), up to 256 KB
for an icon and 2 MB for a preview. The images are objects named in
`images.json` beside `index.json`, which keeps the format a hub of an older
build reads; the handover, the standby's copy and collection treat that file
as part of the shares. `DELETE` takes one back, and with none set the file
goes.

**Following the hub.** `shares/` travels with the hub. A take-over asks the
current host for it (`/lan/handover?shares=1`) after the other files, so a
host of an older build simply sends none; the hub waits for a running commit
before it hands over, and answers 503 to a commit, revoke or setting whose body
arrives after the handover began, so whatever it answered 200 reached the new
host. The standby copies it after each copy of the database
(`POST /lan/shares/copy`): it says which objects it holds, receives
`index.json`, `images.json` and the objects it lacks, and keeps the others from its previous
copy; a failover starts the new hub with them. A hub that hands over, moved
or was superseded serves no share, so a link revoked on the new hub does not
live on at the old address. The public address of the links,
set with `lody lan share-url <url>` or in Settings > Share management
(`lan/share-settings`, which reads it and the hub's own address from
`GET /lan/shares/settings`), is kept in `index.json` too; without one, a link
names the address of the hub with the share port. A tunnel has to follow the
hub to its new machine; the links stay the same once it does.

The agent's `lody_session_share` tool stays unavailable on the local platform:
upstream lets an agent only ask, and a person approve on a card in the app,
and a LAN has no such card yet.
