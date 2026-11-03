# Schedule surfaces

`SchedulesWorkspace` owns list selection, repository mutations and the editor;
`schedule-view.tsx` re-exports the presentational list/form. Global navigation
shows rows with no `boardId`; `BoardSchedules` supplies a Board and local selection
callbacks, using the same editor, actions and save rules inside its panel.

The global desktop route opens the upstream detail modal; mobile and Board
panels switch between the list and editor. Both share the Settings / Run history
frame, including scheduled-message editing. The Board passes `board` to
`ScheduleListView` to keep rows compact at any viewport width, omit the duplicate
page title and use destination-neutral empty copy. Search and New remain.
Saving or closing returns to the owning list. The global route remains mounted
across index/detail navigation.

`schedule-scope.ts` filters rows and walks the current epoch’s deterministic
Session ids in order. It skips archived/deleted/detached identities and stops at
the first usable or never-created id. The existing metadata cache supplies
Sessions; the Repo existence index distinguishes tombstones without metadata
from never-created ids. List links and save checks share this result. Existing destinations offer only owned active Sessions, restricted to
that Board's threads when scoped. `schedule-save-blockers.ts` also rejects a
selected target that was archived or removed while editing.

`schedule-navigation.ts` routes provenance and confirmed-proposal links to the
owning Board with a one-time `boardSchedule` search parameter. Both desktop and
mobile pass that request into the panel. The workspace Registry remains complete
so provenance can resolve Board schedules even though the global list hides them.

Stories: `Workspace/Schedules/Board Schedule List` (520px panel wrapper) and `Board Dedicated Thread
Editor`. Rules: [AGENTS.md](AGENTS.md). Intent:
[Board schedules](../../../../../specs/project-coordinator/board-schedules.md).
