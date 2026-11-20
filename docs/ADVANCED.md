# Advanced configuration

The features below are configured in the profile's `cordis.patch.yml`, not in the Settings panel.
They are generic connector capabilities with no service-specific names, and most are still marked
**unreleased**: they passed the connector suite but not a full Web acceptance run.

### Temporary agents and server instructions

The **Scope** tab also controls **Temporary agents**. Access defaults to **Allow** for compatibility. Select **Block** for personal-memory servers or any service that should belong only to the primary conversation (`delegation: deny` in configuration). The connector hides the server's tools and instructions from delegated sessions and rejects their calls before dispatch. A workspace restriction is also checked at dispatch time. A forked primary conversation remains eligible; missing session metadata is rejected when delegation is blocked.

MCP `initialize.instructions` are forwarded as a literal, server-labelled system-prompt section, without template interpolation. The section follows workspace/delegation access, is cleared on disconnection, and is absent when all server tools are blocked or hidden. Instructions exceeding 32 KiB including the label fail connection. These instructions guide the model; they do not force tool calls before every answer. Each service must describe its own lifecycle consistently.

## Automatic turn context (unreleased)

For services that must refresh context after a conversation first loads them,
configure `turnContext` in the server's profile configuration. This is generic
connector functionality: the connector does not recognize service names or parse
state from prose. It requires dsh's `storageDomain` and scoped tool executor
(validated with dsh 0.2.2-rc.5).

```yaml
turnContext:
  tool: load_context
  arguments: {}
  state:
    session: /session
  pins:
    - /owner/id
  maxBytes: 131072
```

`state` maps next-call argument names to JSON pointers in MCP `structuredContent`.
`pins` identifies immutable scalar values; changed pins reject the result before
delivery. Use bounded scalar values, and keep secrets out of these fields. The
text context is limited to `maxBytes` (default 128 KiB, maximum 1 MiB).

Start a new, unseeded conversation with the feature enabled. It stays neutral
until a successful call to the configured tool. Later turns and mid-turn user
messages refresh before model generation; intermediate tool steps do not. The
automatic call uses the conversation's normal scoped executor and permission
pipeline. The context tool must have policy **Allow**; automatic refresh never
changes a tool's policy. Timeout, cancellation, invalid output, changed endpoint
or pins, scope denial, and storage errors block the step instead of allowing a
response based on stale context. Other executor modes that refuse native calls
also block; they are not silently bypassed.

The `mcp_connector_context` durable domain stores per-session endpoint
fingerprints, mapped arguments and pins, not response text. Successful refresh
text is recorded in the conversation as connector-authored context. Missing
state for old/seeded/forked conversations is rejected. Keep this sidecar with the
profile; fork, restore, migration and deletion integration are not automatic.
Turning off or uninstalling the plugin removes enforcement. This facility does
not establish a server-authenticated identity binding or guarantee that a
service's bounded context contains every change.

## Incremental delivery and trusted runtime metadata (unreleased)

For a paged, read-only context tool, extend `turnContext` with:

```yaml
turnContext:
  tool: refresh_context
  state:
    cursor: /cursor
  pins: [/identity/id, /identity/instance]
  pagination:
    complete: /complete
    maxPages: 128
  delivery:
    reloadArguments: { reload: true }
  maxBytes: 1048576
```

Pagination follows managed state until the completion field is exactly `true`.
All pages must preserve pins and fit the total byte/page limits; stalled pages,
partial failure, and overflow block delivery. The complete response text includes
every page; `structuredContent` contains the final page's state.

With `delivery`, a read position stays pending until its exact tool result or
connector-authored context is present on the actual model surface. The durable
sidecar stores only cursors, random message IDs, content hashes, and the surface
revision, never response bodies. A restart or failed generation before admission
re-reads from the last admitted position. A replacement/compaction of existing
model context triggers `reloadArguments`; reload applies only to the first page.
Intermediate steps repair undelivered context but do not refresh an already
admitted result unnecessarily. This observes recorded model input, not human
viewing or model understanding. It requires the public dsh `Session` surface and
message projection APIs. PTC or another executor can still reject the automatic
native call, in which case generation is blocked.

Automatic context notices explicitly tell the model that the required refresh
already ran. Empty deltas do not suppress useful new memory writes from the
current conversation. This guidance reduces redundant model calls; it is not a
guarantee that a model will never repeat a read. Exact delivery receipts from
older notice formats remain valid.

A server that authenticates the connector may also accept host-derived MCP
request metadata. Configuration is independent of service/tool names:

```yaml
runtimeMetadata:
  namespace: io.example/conversation
  captureTools: [activate_context]
  historyTools: [initialize_context]
  captureRollback:
    pointer: /activationEstablished
    value: false
```

Every request includes the actual persistent session ID, creation time, parent
ID, temporary/seeded flags and current user-turn identity under the configured
`_meta` namespace. Model arguments cannot override it. Reserved MCP namespaces
are rejected. Keep the server's connector credential outside model context.
Metadata by itself is not authentication; a server must authenticate and trust
the connector that supplies these facts.

`captureTools` freeze completed conversation exchanges immediately before the
explicit activation call. Ordinary queries and local history reads never create
a boundary. The candidate is durable before dispatch and becomes ready only on
success. An uncertain transport result retains it for retry. `captureRollback`
releases a pending boundary only when a response explicitly matches the
configured **no-binding/no-effect** statement; do not configure it for a generic
error field. A recovery probe can make that statement on success. Ambiguous
retries and already-established history never release the boundary.

`historyTools` receive the fixed manifest, and `mcp_connector_history` reads the
matching original text in bounded pages. Both require successful capture. This
uses the retained completed conversation log, including original exchanges
shadowed by compaction; it excludes replacement summaries, system prompts,
private reasoning and tool output. Nontext/missing material and unattributed
inherited prefixes are explicit gaps. Digests reject changed or missing originals.
The history sidecar stores references and metadata only. The current limit is
5,000 manifest items and 100 gaps; a single delivered original is limited to
256 KiB. Temporary agents cannot export history. Metadata/history require dsh's
`sessionQuery` and `storageDomain` services.

### Initialization workflows

Opt in to a generic server-reported initialization workflow with `lifecycle`:

```yaml
delegation: deny
runtimeMetadata:
  namespace: io.example/conversation
  captureTools: [start_context, resume_context]
  historyTools: [initialize_context]
  captureRollback: { pointer: /established, value: false }
# Also configure turnContext with delivery as described above.
lifecycle:
  group: personal-context
  startTools: [start_context]
  probe: resume_context
  allowedTools: [initialize_context, process_history, finish_context]
  localTools: [mcp_connector_history]
  blockedTools: [subagent_fork]
  ready:
    start_context: /ready
    resume_context: /ready
    initialize_context: /ready
    process_history: /ready
    finish_context: /ready
```

All tool names and JSON pointers are configuration. Start and probe tools must
be explicit capture tools. A start persists ownership before dispatch; another
server in the same group cannot take over that conversation. Interrupted starts
are checked through the configured probe. It must have `allow` policy for
automatic recovery; other permissions are not elevated.

`blockedTools` lists host tool names that must remain unavailable after this
conversation starts the workflow, including after readiness. For example,
`subagent_fork` copies parent history in the standard dsh profile. The shared
tool guard and dispatch recheck stop configured tools before their bodies run;
use the fresh `subagent` tool with task materials only. List every equivalent
copy tool enabled in your profile. These names are configuration, not built-in
service assumptions. Changing this deny policy preserves existing ownership
and read cursors. Neutral conversations are not restricted by this list.

For hosts implementing the proposed `sessions.preparationAdmissionVersion = 1`
contract, the connector also checks the synchronous `session/preparing` event.
This rejects inherited temporary destinations and unknown seeded persistent
conversations before the destination Session is constructed or handed to a
persistence owner. The event carries immutable metadata, not transcript text.
Set `lifecycle.requireCreationAdmission: true` to require this stronger tier;
startup fails when it is unavailable. The policy does not change existing
workflow fingerprints or force extra per-turn writes. Fresh neutral roots and
fresh helpers remain usable. Restoration relies on trusted host metadata and
intact local ownership storage; it does not defend against privileged plugins
or an operator forging or removing that storage.

Stock dsh 0.2.2-rc.5 does not provide this event. A reviewable upstream source
proposal is in [contrib/dsh-session-admission](../contrib/dsh-session-admission/README.md).
It is not installed or applied automatically. Fork preparation can read the
source within the trusted host before admission; the guarantee concerns the
destination's construction and persistence, not all source reads.

Before readiness, monotonic tool guards and a dispatch recheck reject ordinary
work. The model stream is buffered and releases only complete permitted tool
calls, dropping text, reasoning and layout-dependent replay state. An ordinary
answer, invalid call, cancellation or partial stream releases no output. This
requires dsh's public `llm/stream` middleware and shared tool pipeline. Custom
executors that bypass that pipeline and other in-process plugins are outside
this guarantee. Once the server reports readiness, the controller forces the
first complete context refresh even on an intermediate step. Ordinary work
resumes only after that content is present on the actual model surface.

Recovery uses durable workflow ownership. A verified persistent parent header
can inherit the parent's same service and fixed original-history references,
but never its context cursor. The child reloads independently. Unknown seeded
transcripts cannot infer a parent from similar messages. Stock dsh's ordinary UI fork
does not currently persist `parentSession`, so that fork remains blocked for
this capability; use the original conversation. Restore with missing ownership,
changed endpoint or changed parent creation time is also blocked. Temporary
helpers cannot see or use the workflow server or its scoped history reader.
Seeded temporary helpers are also rejected at agent creation and before model
generation if their parent has workflow ownership or they enter an enabled
workflow workspace. That fallback can occur after the seed was stored; only
the configured tool gate prevents copying before execution. Direct host APIs,
UI fork commands, unlisted copy tools and in-process plugins are outside that
copy-before-storage guarantee. A universal guarantee needs a host admission
hook before creating any inherited seed. Fresh helpers remain supported.

The sidecars contain references, fingerprints, cursors and delivery markers,
not persona or memory bodies. Service-specific approval and binding rules stay
on the server. Full real Web acceptance remains in progress.

### Explicit recovery to a restored instance

An activated conversation cannot follow a changed endpoint or instance by
configuration alone. For a service with a private, exact recovery authorization,
the connector supports operator-configured `recoveries`. This is a control-plane
operation, not a model tool. Stop the affected conversation before changing its
configuration; retain the same server name, session log, and all durable domains.

Configure the approved target endpoint, then use the authenticated Host API
`POST /mcp-connector/api/action` with
`{"action":"inspect-recovery","server":"subject_a","sessionId":"CHAT_ID"}`.
It returns the actual creation time, parent, old pins, target `configuration`
digest, and three `expected` record hashes, without history bodies or credentials.
Use those exact values in the plugin's top-level configuration:

```yaml
recoveries:
  - operationId: approved-request-1
    server: subject_a
    sessionId: CHAT_ID
    createdAt: 1795161600000
    configuration: <target configuration digest from inspection>
    expected:
      context: <context record digest from inspection>
      lifecycle: <workflow record digest from inspection>
      runtime: <history record digest from inspection>
    fromPins: [subject-id, old-instance]
    toPins: [subject-id, restored-instance]
    stablePins: [0]
    tool: recover_instance
    arguments: { requestId: approved-request-1 }
    metadata:
      io.example/recovery: { requestId: approved-request-1 }
    proof:
      operationId: /reassociation/requestId
      before: [/reassociation/from/identityId, /reassociation/from/instance]
      after: [/reassociation/to/identityId, /reassociation/to/instance]
```

Tool names, extra private metadata and proof pointers are service-specific
configuration. `stablePins` must include the permanent subject identity; these
values cannot change. Every pin must have an old/new proof mapping. The server
must separately authenticate and authorize the exact operation, actual host
conversation, old instance and restored target. Configuration is not a substitute
for that authorization. Do not put credentials or memory bodies in operation
arguments, metadata, pins or proof values. The configured tool must be connected
and **Allow**. Private metadata cannot override actual conversation metadata or
MCP protocol namespaces.

The `mcp_connector_recovery` journal is durable before the remote request. After
an exact structured proof, it advances monotonically through remote completion
and each local record update. It preserves ownership/history, resets cursors,
delivery receipts and persona acknowledgments, then re-enters initialization.
Persona acknowledgment precedes the required full refresh; ordinary work stays
blocked until both finish. The journal retains hashes and operation identifiers,
not the returned context body. A completed operation is only a receipt: keeping
it in configuration cannot rewind a later recovery.

Lost responses or partial writes keep generation and tools blocked. Restore the
connection and retry the unchanged operation through plugin restart or the
private `retry-recovery` action. Removing a pending operation from configuration
does not release its gate; never delete sidecars to bypass recovery. Changed
fields under the same operation ID cannot overwrite an existing journal. The settings panel preserves
configured operations when editing unrelated options; profiles overridden by a
home patch must be changed in that patch, as the Host editor reports. Recovery
does not revoke other hosts, merge writable copies, or prove model understanding.

When the host replaces its system prompt between refresh and model dispatch,
the connector may confirm the pending incremental result only if every prior
non-system message remains in order as the same immutable object and the exact
new result is present. This proof is bound to the live Session and held only in
memory; it stores no transcript copy. A changed, reordered or missing message,
a different Session object, or a process restart without proof cannot use this
exception. Compaction still requires a full reload of the same service.
