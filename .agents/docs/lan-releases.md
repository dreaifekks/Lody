# LAN updates, hosting and releases

How a [LAN](lan.md) build replaces itself with a later one, how a server
starts hosting a LAN, and how a fork builds and publishes its releases.

## Updates

The workflow that builds a release stamps its builds with the repository it
ran in and the tag it publishes (`LODY_LAN_REPOSITORY`, `LODY_LAN_TAG` and
`LODY_LAN_COMMIT`, compiled in as `__LODY_LAN_RELEASE_JSON__`). A stamped build
follows `manifest.json` of that release, so a fork of the fork follows its own
releases; a build made anywhere else follows nothing. Builds are ordered by the
upstream version first and the build number second, and only a later build is
installed. Every file is checked against the size and the SHA-256 the manifest
names. A release replaces its files one by one, so a mismatch is what a
download meets while a newer build is being published.

A download has no limit on how long it takes, only on how long it receives
nothing (a minute): a desktop bundle is around 180 MB, which a slow connection
abroad takes half an hour for. A connection that breaks off or stalls is asked
again, with a range, for what is missing, as long as each try still receives
something; a few in a row that receive nothing end it. What arrived stays as
`<file>.partial` beside the digest of the file it belongs to, so the desktop
application continues it with its next download of the same file, also after it
was started again, and discards the part of another build. An agent service
discards it with its staging directory, its file being small. A host that ignores
the range sends the whole file, which replaces the part. The file is checked as
a whole once it is complete.

Who replaces the agent service of a machine is its update channel:

| Channel   | The agent service                                                                     | Who updates it                       |
| --------- | ------------------------------------------------------------------------------------- | ------------------------------------ |
| `service` | Was installed by the install script, and systemd or the daemon runner starts it again | Itself, when a member asks           |
| `desktop` | Is carried by a desktop application                                                   | The application, from its own window |
| `manual`  | Anything else, such as a checkout or a service started by hand                        | Whoever installed it                 |

An agent service installs the newest build beside the running one, starts it
once to see that it reports the version it should, and only then renames it
into place; the replaced build stays as `node_modules.previous` until the next
update. Whatever fails before the rename leaves the installation as it was.
The machine answers a request before it installs, because being done starts it
again, together with the hub if it hosts one. Members follow `lanUpdate`, and
the update is over when the machine registers with the new version.

A desktop application checks when it starts, every quarter of an hour and
when the computer wakes up, and asks before it downloads: a fork publishes a
build for every push. A check in the background leaves an update it already
offers on screen. It is replaced after it quit, by a script that first waits
for it to be gone.

| Platform | How the application is replaced                                           |
| -------- | ------------------------------------------------------------------------- |
| macOS    | The bundle is swapped with one staged beside it, so each move is a rename |
| Windows  | The installer runs without asking and starts the application              |
| Linux    | The downloaded AppImage is renamed over the running one                   |

An application that runs from a disk image, or from the read-only copy the
system makes of a quarantined application, cannot replace itself and says so.
On macOS and Linux a replacement that fails starts the application that was
there and leaves the reason in `lan-updates/last-failure.txt` of the
application data; the application shows it with the update it offers again.
The Windows installer reports nothing.

## Hosting and releases

`lody lan up` turns a server into a host and a member in one step: it installs
and starts the two services, joins the LAN it hosts and prints the invite. The
default address is a private one, an overlay network before the local segment;
a machine with public addresses only has to choose with `--host`, because the
hub speaks plain HTTP unless `lody lan hub` is given a certificate.

`.github/workflows/lan-build.yml` builds a fork: the bundles once on Linux, the
installers per platform from those bundles, and a rolling release whose file
names carry no version. It runs only for a tag `v<upstream>-lan.<n>`, pushed
when the branch is ready, whose build replaces the release; run by hand on a
branch, it builds without publishing. `<upstream>` is the newest release in the synced changelog
(`site-docs/content/changelog/en`, since upstream never bumps its manifests),
and `<n>` restarts at 1 with each upstream release, so the updater's order of
upstream part first, build second always puts a later tag after an earlier one.
`lan-release.mjs version` prints the next tag's version.

A tag `dev-v<upstream>-lan.<n>` builds the same way and replaces `lan-dev`
instead, a prerelease that only installations made from it follow: its builds
are stamped with that tag, and its install scripts install from it. A branch
is tried on a few machines that way before it is merged and released to
everyone. Dev builds number themselves on their own
(`lan-release.mjs version --channel dev`), since a build only compares itself
with the builds of the release it follows; an agent service changes channel by
installing from the other release, a desktop in Settings > LAN.

A dev tag ending in `-cli` (or a run by hand with `build: cli`) builds the CLI
tarball only and skips the desktop packaging. The release keeps the files of
its last whole build, `lody-lan-cli.tgz` included, and its manifest goes on
describing that build at the top level. That is all a desktop, the install
script and an agent service older than this read, so none of them is offered a
file that reports another version. The new tarball goes beside it as
`lody-lan-cli-<version>.tgz`; `cli` names it with its build, and a newer agent
service installs that one (`readLanCliRelease`, `resolveLanCliAssetName`).
Publishing is serialized per release (the `release` job's concurrency group),
since a CLI-only build lists files another tag may be replacing meanwhile;
GitHub cancels a publish still waiting when a later one queues behind it.
Tarballs of earlier CLI-only builds stay in the release unlisted.

A release tag whose version and commit are those of the whole build `lan-dev`
carries publishes that build again instead of building it a second time; any
other release tag builds everything. The version is inside every file (a macOS
update refuses a bundle that names another one, an agent service the build
that reports another), so a dev build is released under its own number. The
CLI tarball is stamped again to follow `lan-latest`. The desktop installers
cannot be and keep the stamp of `lan-dev`, so a desktop does not follow its
stamp: it records the release it follows (`lan-release.json` of its data) on
its first start, and an update keeps the record. A build is reused only once
both releases carry builds that record it (their manifests have `cli`). An
accepted gap: a desktop that skipped every newer build and updates straight to
a reused one, or one installed afresh from a reused installer, follows
`lan-dev` and has to be switched by hand in Settings > LAN.

`scripts/lan-release.mjs` names the build and assembles
the release; `scripts/lan/install.sh` and `install-mac.sh` are published with
it. A fork build may carry no publisher's signature, which neither the updater
of the platform nor the one of the framework accepts, so every fork build
[updates itself](#updates).
The update service of the publisher stays off on the local platform: a fork
build is never replaced by an upstream release.

A fork publishes no `lody-code-review-viewer` package, so the CLI build copies
the viewer it pinned beside its bundle (`code-review-viewer.html`), and
`lody review` reads it from there before it asks a CDN; the hash it was built
with still decides.

A fork that stores a code-signing certificate as the secrets
`LAN_MAC_SIGNING_P12` and `LAN_MAC_SIGNING_PASSWORD` signs its macOS builds
with it: macOS keys the permissions a user grants to the identity an
application is signed with, which an unsigned build changes with every build.
`lan-release.mjs signing` reads the certificate, and the workflow signs by what
it finds:

| Certificate       | Team ID | What the workflow does                                                        |
| ----------------- | ------- | ----------------------------------------------------------------------------- |
| Developer ID      | Yes     | Signs with the entitlements as they are and keeps its owner's name out of log |
| Of the fork's own | No      | Trusts it on the runner and signs the application with `LODY_MAC_SELF_SIGNED` |

Under the hardened runtime a process loads only what Apple signed or what
carries its own Team ID. For a certificate without one, `LODY_MAC_SELF_SIGNED`
has `package-electron.mjs` sign the application with the exception from library
validation its nested binaries have; without it the application ends in dyld
before it runs. The packaging probes run before signing, so the workflow starts
the signed application and its helper once and publishes nothing that does not
start.

The certificate always comes from the secrets. Signing that asks Apple for one
uses up one of the few an account may have with every build, because a runner
keeps no key. No build is notarized: Gatekeeper stops a copy downloaded with a
browser, while the install script and an update leave no quarantine mark.
Changes to a submodule the fork cannot push to live in `patches/submodules/`;
`scripts/apply-submodule-patches.mjs` applies them before the adapters build,
and fails the build once an upstream update conflicts with one.

## Limits

- A desktop application is updated from its own window, and an agent service
  that nothing starts again by whoever started it; no member can ask either to
  update, nor the latter to restart.
- The desktop application cannot host a LAN; it does not ship the Streams
  server.
