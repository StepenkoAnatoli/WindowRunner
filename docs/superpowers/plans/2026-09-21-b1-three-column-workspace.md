B1 contract: Sidebar | Chat | Context
B1 should be a client-side composition refactor, with no new server route and no change to turn, approval, trust, or provider semantics.

The existing server API can create/reattach/delete a session, stream turns, cancel, approve/deny, and inspect trust—but it has no session-list or transcript-list endpoint. Therefore B1’s sidebar is a persisted workspace catalog, not a server-backed history browser.

Explicit B1 boundary
A sidebar “session” means a locally remembered { project root, sessionId }.
Selecting it reattaches through the current createSession() behavior; existing sessions are detected through SESSION_ALREADY_EXISTS.
B1 does not promise to reconstruct previous turn transcripts after a reload.
B1 does not show a post-hoc git/file diff, because the server currently has no completed-file-change event or diff endpoint.
The right-side Changes view shows previews for pending write_file / edit_file approvals only.
Switching projects/sessions while a turn is active is blocked in B1 rather than silently abandoning the visible stream.
That keeps the new shell honest and avoids inventing backend state that does not exist.

1. State contracts
Modify packages/web/src/app-state.ts
Keep the existing turn reducer and TurnView model. Add workspace-navigation and inspector-only state; do not move DOM behavior into this reducer.

packages/web/src/app-state.ts
v1
export interface ProjectCatalogEntry {
  /** Stable client-generated id; never derived from an untrusted path directly. */
  id: string;
  /** Absolute project root selected by the user. No token, provider key, or file contents. */
  root: string;
  /** Display-only basename or user label. */
Add this to AppState:

packages/web/src/app-state.ts
v2
workspace: WorkspaceUiState;

Initial state:

packages/web/src/app-state.ts
v3
export const initialWorkspaceUiState: WorkspaceUiState = {
  catalog: { version: 1, projects: [], sessions: [] },
  inspectorTab: "context",
  inspectorSelection: { kind: "none" },
  sidebarOpen: true,
  inspectorOpen: true,
New reducer actions
packages/web/src/app-state.ts
v4
| { type: "workspace_catalog_loaded"; catalog: WorkspaceCatalog }
| { type: "project_selected"; projectId: string }
| { type: "project_upserted"; project: ProjectCatalogEntry }
| { type: "session_selected"; sessionId: string }
| { type: "session_upserted"; session: SessionCatalogEntry }
| { type: "inspector_tab_selected"; tab: InspectorTab }
Reducer invariants
A selected session must belong to the selected project.
project_selected clears the active server session display until the selected session is attached.
session_selected must not mutate existing turns itself; the coordinator decides whether switching is allowed and then dispatches session_created.
session_created continues to clear turns, activeTurnId, and trust prompt exactly as it does today.
Receiving a turn_event for the active turn should set inspector selection to that turn only if the user has not manually selected another tool/approval.
Any newly pending approval selects:
ts
{ kind: "approval", turnId, requestId }
and opens the inspector on the approvals tab.
A terminal turn must not be overwritten by late cancel UI state—the existing terminal handling remains the authority.
2. Persisted workspace catalog
Create packages/web/src/workspace-catalog.ts
This module owns only non-secret navigation metadata.

packages/web/src/workspace-catalog.ts
export interface WorkspaceCatalogStore {
  load(): Promise<WorkspaceCatalog>;
  save(catalog: WorkspaceCatalog): Promise<void>;
}

export function validateWorkspaceCatalog(value: unknown): WorkspaceCatalog;
Storage policy
Runtime	Store	Persistence
Browser	localStorage	Browser-local only
Electron desktop	Fixed preload IPC methods	Electron userData, outside installation directory
Tests	In-memory fake	None
Never persist:

bearer tokens;
API keys;
tool inputs;
tool output;
transcript text;
filesystem snapshots;
provider configuration.
Browser implementation
Use one local-storage key:

Text
windows-runner.workspace-catalog.v1
Malformed data must produce an empty catalog—not crash the UI.

Desktop bridge extension
Modify packages/desktop/src/preload.ts
Add only fixed-schema methods, not generic filesystem APIs:

packages/desktop/src/preload.ts
interface DesktopBridge {
  getBootstrap(): { baseUrl: string; token: string };
  chooseProjectFolder(): Promise<string | null>;
  openExternalEditor(path: string): Promise<void>;
  getAppInfo(): Promise<{ version: string; platform: string }>;

Modify packages/desktop/src/main.ts
Handle only:

Text
window-runner:workspace-catalog:load
window-runner:workspace-catalog:save
The main process validates the catalog before writing it atomically below Electron’s existing app.getPath("userData") location:

Text
%APPDATA%\WindowRunner\workspace-catalog.json
A renderer cannot choose the path and cannot ask Electron to read arbitrary files.

3. Desktop capability contract
Create packages/web/src/desktop-bridge.ts
This is the browser-safe adapter. It must not import Electron.

packages/web/src/desktop-bridge.ts
export interface DesktopCapabilities {
  chooseProjectFolder(): Promise<string | null>;
  openExternalEditor(path: string): Promise<void>;
  loadWorkspaceCatalog(): Promise<WorkspaceCatalog | null>;
  saveWorkspaceCatalog(catalog: WorkspaceCatalog): Promise<void>;
}
Behavior:

Returns undefined in the ordinary browser app.
Returns the validated preload bridge in Electron.
Never attempts to fall back to a browser file picker: the server needs a filesystem path, not browser-uploaded files.
4. Component contracts
All B1 components remain plain-DOM render functions. They receive state and callbacks; they do not construct ApiClient, call fetch, or mutate global state directly.

Create packages/web/src/app-shell.ts
Owns the fixed page geometry.

packages/web/src/app-shell.ts
export interface AppShellProps {
  header: HTMLElement;
  sidebar: HTMLElement;
  workspace: HTMLElement;
  inspector: HTMLElement;
  sidebarOpen: boolean;
Required stable regions:

HTML
<div class="workspace-shell" data-testid="workspace-shell">
  <aside data-testid="project-sidebar">…</aside>
  <main data-testid="conversation-workspace">…</main>
  <aside data-testid="context-inspector">…</aside>
</div>
The shell owns responsive layout and panel visibility only. It must not own:

authentication effects;
session creation;
streaming;
approval decisions;
provider API calls.
Create packages/web/src/project-sidebar.ts
Owns project and session navigation.

packages/web/src/project-sidebar.ts
export interface ProjectSidebarProps {
  catalog: WorkspaceCatalog;
  selectedProjectId?: string;
  selectedSessionId?: string;
  hasActiveTurn: boolean;
  desktopAvailable: boolean;
Required UI behavior
Desktop: Choose folder… calls chooseProjectFolder().
Browser: render an absolute-path input plus Open project.
Opening a project:
adds/updates the catalog entry;
selects it;
does not call the server until a session is chosen or created.
Creating a session:
creates a client-side sessionId;
stores metadata;
calls current createSession(sessionId, root).
Selecting an existing session:
calls current attach/create behavior.
When hasActiveTurn:
session/project selection controls are disabled;
show an explicit explanation: “Finish or stop the active turn before switching sessions.”
Do not expose “delete project” in B1; permit only a future “forget recent project” action.
Required test IDs:

Text
project-sidebar
choose-project
project-path-input
open-project
project-item
new-session
session-item
session-switch-blocked
Create packages/web/src/workspace.ts
This replaces the current conversationPanel() composition while preserving its behavior.

packages/web/src/workspace.ts
export interface ConversationWorkspaceProps {
  session?: AppState["session"];
  turns: TurnView[];
  activeTurn?: TurnView;
  busy: boolean;
  trustPrompt?: TrustPrompt;
Required behavior
Reuse:
activeTurn();
describeTurn();
pendingApprovals();
previewApproval();
the existing Stop/cancellation effect;
existing trust prompt behavior.
Send remains disabled while an active turn exists.
Stop remains available while active.
Turn cards become selectable, but no click should interfere with Approve, Deny, Send, Stop, or form controls.
Approval cards remain visible in the center conversation and are shown in the inspector. They are one state source, two views.
Selecting an approval must also select it in the inspector.
Required test IDs retained:

Text
conversation
turn-form
message-input
send
cancel
turn
turn-message
turn-text
turn-status
approval
approve
deny
approval-preview
trust-prompt
grant-trust
revoke-trust
Do not rename existing E2E selectors in B1.

Create packages/web/src/tool-timeline.ts
Owns the inspector’s activity list.

packages/web/src/tool-timeline.ts
export interface ToolTimelineProps {
  turn?: TurnView;
  selectedCallId?: string;
  onSelectTool(callId: string): void;
}

Render, in call order:

tool name;
called, running, or done;
success/failure state;
failure code/message where relevant;
output only when it is already exposed through ToolEntry.result.output.
Do not show arbitrary raw tool input in the activity list. For pending approval input, use previewApproval() only.

Required test IDs:

Text
tool-timeline
tool-activity-item
tool-activity-status
Create packages/web/src/inspector.ts
Owns the right context panel.

packages/web/src/inspector.ts
export interface InspectorProps {
  tab: InspectorTab;
  selection: InspectorSelection;
  session?: AppState["session"];
  turn?: TurnView;
  turns: TurnView[];
Inspector tabs
Tab	B1 content	Explicit non-goal
approvals	Pending approvals for selected/current turn, rendered with existing safe previews and Approve/Deny actions	Separate approval state machine
activity	Tool timeline and turn status	Full terminal emulator
context	Session ID, project root, trust status, selected turn status	File-tree browser
changes	Pending edit_file / write_file approval previews	Claimed committed-file diff/history
For changes, show this empty state when no pending write/edit approval exists:

“No pending file change preview. Completed file-change history is not available in this release.”

That is important: B1 must not imply that it can prove a completed change exists on disk.

Required test IDs:

Text
context-inspector
inspector-tab-approvals
inspector-tab-activity
inspector-tab-context
inspector-tab-changes
inspector-empty
inspector-approval
inspector-change-preview
5. Main coordinator contract
Refactor packages/web/src/main.ts
main.ts becomes the only module that owns side effects:

Text
connect / sign out
load and save workspace catalog
desktop folder picker
create or reattach session
stream lifecycle
cancel turn
approve / deny
grant / revoke trust
render scheduling
It should import render modules and call:

packages/web/src/main.ts
v1
renderAppShell({
  header: renderHeader(...),
  sidebar: renderProjectSidebar(...),
  workspace: renderConversationWorkspace(...),
  inspector: renderInspector(...),
  sidebarOpen: state.workspace.sidebarOpen,
Session attach contract
Implement a coordinator helper:

packages/web/src/main.ts
v2
async function selectSession(entry: SessionCatalogEntry): Promise<void> {
  if (activeTurn(state)) {
    dispatch({
      type: "error",
      code: "SESSION_SWITCH_BLOCKED",
      message: "Finish or stop the active turn before switching sessions.",
The current createSession() already handles SESSION_ALREADY_EXISTS by loading trust information. Preserve that behavior.

Catalog save contract
After each catalog-mutating reducer action:

derive the new catalog from state;
save it through the runtime-appropriate store;
if persistence fails, show a non-blocking error banner;
do not roll back a successfully created/attached server session.
Stream contract
B1 supports exactly one visible/active stream. Consequently:

do not switch session while a stream is active;
do not start a second turn while a stream is active;
do not replace the one streamAbort controller with background streaming yet.
This is intentionally conservative and avoids a half-built multi-session stream manager.

6. API contract
No server route changes in B1
Do not add:

Text
GET /api/projects
GET /api/sessions
GET /api/sessions/:id/transcript
GET /api/diffs
Those would need persistence, authorization, retention, and privacy decisions beyond B1.

packages/web/src/api.ts
No change is required for existing server endpoints. Keep:

packages/web/src/api.ts
createSession(sessionId, cwd)
deleteSession(sessionId)
startTurn(sessionId, message, cwd?)
cancelTurn(sessionId, turnId, reason?)
approve(sessionId, requestId, decision)
getTrust(sessionId)
The existing in-memory ApiClientBootstrap remains the desktop integration boundary. B1 must not put the Electron token in local storage, URLs, or catalog files.

7. File plan
New files
Text
packages/web/src/app-shell.ts
packages/web/src/project-sidebar.ts
packages/web/src/workspace.ts
packages/web/src/tool-timeline.ts
packages/web/src/inspector.ts
packages/web/src/workspace-catalog.ts
packages/web/src/desktop-bridge.ts

packages/web/test/workspace-catalog.test.ts
packages/web/test/app-shell.test.ts
packages/web/test/project-sidebar.test.ts
packages/web/test/inspector.test.ts
packages/web/e2e/workspace.spec.ts
Modified files
Text
packages/web/src/main.ts
packages/web/src/app-state.ts
packages/web/public/app.css
packages/web/test/app-state.test.ts
packages/web/e2e/ui.spec.ts

packages/desktop/src/preload.ts
packages/desktop/src/main.ts
packages/desktop/src/desktop-bridge.ts   # if A1 has this abstraction
packages/desktop/test/preload.test.ts
packages/desktop/test/main-flow.test.ts
No server behavior change is needed.

8. Test contracts
Unit tests
workspace-catalog.test.ts
rejects malformed catalog data;
migrates absent storage to empty v1 catalog;
never accepts token-like unknown fields into the persisted shape;
preserves selected project/session only when references exist;
sorts project/session lists by lastOpenedAt.
app-state.test.ts
selecting project/session obeys ownership invariants;
session selection does not synthesize transcript history;
newly pending approval switches inspector to approvals;
selected terminal turn remains selected;
existing cancellation race regression remains green.
project-sidebar.test.ts
desktop picker callback creates/selects project;
browser path fallback works;
active turn disables session switch;
session entries are scoped to selected project.
inspector.test.ts
approval preview is byte-for-byte the same previewApproval() output used by the center card;
Changes tab lists only pending write/edit approvals;
empty Changes state does not claim completed diffs;
trust status reflects existing AppState.session.trust.
Browser E2E: workspace.spec.ts
Authenticate and verify three stable regions render.
Create/open a project and create a session.
Run a mock turn; stream text appears in center and tool activity appears in inspector.
Trigger an approval; inspect preview in both center and inspector; approve/deny works.
Start slow turn; verify Stop works.
Verify project/session controls are disabled during active turn.
Verify the right inspector collapses below the responsive breakpoint without breaking Send/Stop.
Verify /dashboard retains current provider-dashboard behavior through the existing E2E suite.
9. CSS/layout contract
Modify packages/web/public/app.css
At desktop width:

Text
grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(280px, 360px)
At narrower widths:

under roughly 1100px: inspector is collapsible;
under roughly 800px: sidebar becomes collapsible;
center conversation remains primary;
no horizontal page scrolling;
focused controls remain visible after render.
Do not use a UI framework or introduce a router in B1.

B1 completion criteria
B1 is ready for review only when:

Sidebar, chat, and inspector render as distinct regions.
Desktop folder picker works; browser path fallback still works.
Current sessions can be created and reattached from the local catalog.
Active-turn session switching is visibly blocked.
Existing SSE, reconnect, approval, trust, Stop, and retry behavior remains intact.
Inspector uses existing turn/tool/approval state—not duplicate state.
/dashboard remains unchanged and existing E2E tests stay green.
New tests document the intentional limits: no transcript recovery and no completed-file diff claim.
