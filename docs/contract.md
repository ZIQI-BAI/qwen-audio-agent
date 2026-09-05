# Gateway contract

This file is the single index of what an external client — the desktop app,
the CLI, the WebUI, or a platform integrating qwen-audio-agent — may rely on.
Everything not listed here (internal module paths, file layouts inside the
config directory other than what is named below, database and state file
formats) is not contract and may change in any release.

Every promise in this file is locked by a test; the table in each section
names it.

## Protocol version and capabilities

`GET /api/health` reports `protocolVersion` and `capabilities`. Clients should
branch on a capability, not compare product versions — a Gateway that predates
a feature then degrades instead of failing.

Versioning follows SemVer: the minor rises for an additive capability, the
major for a breaking change to any endpoint or event named below.

The current version is `2.1.0`. It succeeds the `1.x` line of the
`feat/embedded-gateway-host-contract` fork (which ended at `1.7.0`): the major
bump records that capabilities that line advertised — such as
`gateway.embedded-lifecycle` and `desktop.settings-window` — are not part of
this contract. A host migrating from the fork re-checks the capability table
below instead of assuming the old list.

| Capability | Meaning | Locked by |
| --- | --- | --- |
| `web.same-origin-ui` | The Gateway statically hosts the web UI at its own origin; a webview pointed at the Gateway URL needs no extra configuration | `test/consumer-install.test.mjs` |
| `web.skin-assets` | Imported orb skins are served at `/skins/<id>/` on the Gateway origin, so the orb page's same-origin asset fetches work without a separate static server | `test/consumer-install.test.mjs` |
| `gateway.instance-lease` | A lease in the config directory names the running instance; `/api/health` echoes `gatewayInstanceId` so a foreign process on the same port is never mistaken for this Gateway | `test/consumer-install.test.mjs` |
| `gateway.setup-gate` | An unconfigured start is refused with `QWAUDIO_GATEWAY_SETUP_REQUIRED` and a `missing` list instead of serving an instance whose voice cannot work | `test/gateway-setup.test.mjs` |
| `gateway.settings-store` | Configuration persistence is owned by this package: `createSettingsStore({ configDir })` — a host names no setting and no file of its own | `desktop/test/settings-store.test.mjs` |
| `host.electron-entry` | `qwen-audio-agent/electron`: a CommonJS entry an Electron main process can `require`, loading every ESM contract through one `load()` | `test/consumer-install.test.mjs` |
| `host.gateway-process` | `GatewayProcess` ships: forking, port fallback, the readiness handshake, restart, and telling a planned exit from a crash — the desktop app runs the same implementation | `desktop/test/gateway-process.test.mjs` |
| `input.suspend-protocol` | `POST /api/input/suspend\|resume`, `GET /api/input`; the Gateway relays the suspension to clients through `input.suspend` / `input.resume` | `server/test/input-suspend-protocol.test.mjs` |
| `input.suspend-clears-playback` | Suspending also clears playback so host recording stays clean | `server/test/input-suspend-protocol.test.mjs` |
| `input.suspend-ttl` | A suspension expires on its own when the holder never resumes | `server/test/input-arbitration.test.mjs` |
| `input.suspend-ack` | Clients confirm a suspension with `input.suspend.ack` (status display only — never wait for it) | `server/test/input-suspend-protocol.test.mjs` |
| `task.incremental-stream-v1` | `task.stream` publishes versioned, correlated progress/text/audio frames with independent category sequence numbers; terminal waits for task and response/audio barriers | `server/test/task-stream-protocol.test.mjs` |
| `desktop.orb-shell` | The orb form's main-process contract ships: `bindOrbShell` answers the channels the shipped preload sends | `desktop/test/orb-shell.test.mjs` |
| `desktop.orb-window-factory` | `createOrbWindow` owns the orb window recipe; its `destroy()` is the host's synchronous teardown path (renderer exit is what releases the microphone) | `desktop/test/orb-window.test.mjs` |
| `desktop.orb-placement` | `createOrbPlacement` covers the default anchor, display clamping and drop persistence | `desktop/test/orb-placement.test.mjs` |
| `desktop.orb-position-store` | The orb's position is remembered by this package (settings store ui-state) | `desktop/test/settings-store.test.mjs` |
| `desktop.skin-store` | Importing, listing, removing and resolving orb skins is a published library surface | `desktop/test/skin-store.test.mjs` |

The list itself is `GATEWAY_CAPABILITIES` in
`server/src/core/gateway-protocol.mjs`; `test/gateway-contract.test.mjs` fails
whenever a capability and this document drift apart.

## Package entry points

Only the subpaths below are contract; importing anything by its internal path
is unsupported and breaks without notice.

| Entry | Exports |
| --- | --- |
| `qwen-audio-agent/electron` | **CJS**: `load()` (every contract in one namespace), `PRELOAD_PATH` |
| `qwen-audio-agent/gateway-protocol` | `GATEWAY_PROTOCOL_VERSION`, `GATEWAY_CAPABILITIES` |
| `qwen-audio-agent/gateway-setup` | `gatewaySetupStatus`, `assertGatewaySetup` |
| `qwen-audio-agent/gateway-process` | `GatewayProcess`, `createGatewayProcess`, `GATEWAY_READY_MESSAGE`, `DEFAULT_GATEWAY_ENTRY`, `validateGatewayOrigin`, `portInUse` |
| `qwen-audio-agent/gateway-lease` | `readGatewayLease`, `findRunningGateway`, `acquireGatewayLease` |
| `qwen-audio-agent/realtime-events` | `GatewayClientEvent`, `GatewayServerEvent`, `GatewayTaskEvent` |

Codex delegated speech streams publish ordered `task.stream.segment` events,
followed by `task.stream.done` only after ACP termination and speech drain.
`task.stream.fallback` retains the reason for complete-result replay,
`task.stream.aborted` closes cancelled streams, and `task.stream.first_audio`
reports the first segment's start-to-first-frame latency plus the server log's
bounded 100-sample P95 window.

### Delivering a task's final answer

A delegated task's answer is authoritative content, so the realtime model reads
it rather than re-authoring it, and the reading is checked before anyone hears
it. A result that arrives complete is one utterance, so a whole answer has one
final transcript, one TTS and one `audio.done`.

Every utterance is held at the Gateway until its transcript has been compared
with the text it was asked to read. A rewritten one is dropped whole — the
client never receives a frame of it — and the delivery falls through a fixed
order: retry the reading (`QWEN_AUDIO_AGENT_TERMINAL_SPEECH_RETRIES`, default
1), then deterministic text-to-speech (`QWEN_AUDIO_AGENT_TTS_MODEL`, empty
disables it), then the answer as text with
`streaming_fallback_reason: speech_not_verbatim`. No step narrates the answer in
the model's own words.

`task.stream.done` and the lifecycle terminal carry `delivery`
(`verbatim` / `synthesized` / `null`) and `verbatim`, so a run is judged from its
frames rather than by ear. Both describe **audible** delivery: a response whose
transcript matched but which carried no audio reports `null`, because nobody
heard it. Only an audible delivery marks the task notification delivered; every
other outcome releases the claim instead of spending it.

Frame order is unchanged: the lifecycle terminal still waits for the task and
the response/audio drain, and `task.stream.done` is the last frame of the task
stream. The hold sits inside that barrier rather than moving it — it decides
*whether* an utterance is released, not *when* the terminal is written. That
holds on every branch: when speech is withheld, `task.stream.fallback` is sent
**before** the lifecycle terminal, because the terminal and `task.stream.done`
close the stream and nothing may follow them.
| `qwen-audio-agent/settings` | `createSettingsStore` |
| `qwen-audio-agent/skin-store` | `importSkin`, `listSkins`, `removeSkin`, `effectiveOrbSkin`, `skinsDirectory`, `validateSkinPackage` |
| `qwen-audio-agent/orb/main` | `bindOrbShell`, `configureOrbWindow`, `ORB_CHANNELS` |
| `qwen-audio-agent/orb/window` | `createOrbWindow`, `orbWindowOptions`, `ORB_PRELOAD_PATH`, `ORB_WINDOW_SIZE` |
| `qwen-audio-agent/orb/placement` | `createOrbPlacement`, `ORB_PLACEMENT_MARGIN` |
| `qwen-audio-agent/orb/presence` | `DesktopPresence` |
| `qwen-audio-agent/orb/preload` | The renderer preload both orb and settings pages use |
| `qwen-audio-agent/orb/url` | `desktopOrbUrl` |
| `qwen-audio-agent/web-dist/*` | The prebuilt web assets |

All entries are ESM except `qwen-audio-agent/electron` and
`qwen-audio-agent/orb/preload`, which are CommonJS because their boundaries
demand it.

## The embedding flow

```js
const audioAgent = require('qwen-audio-agent/electron')
const api = await audioAgent.load()

const settings = api.createSettingsStore({ configDir })
if (!settings.ready()) { /* collect settings.status().missing, settings.save(...) */ }

const gateway = api.createGatewayProcess({ configDir, wakeWord: false })
const origin = await gateway.start()

const placement = api.createOrbPlacement({
  getDisplays: () => screen.getAllDisplays(),
  orbSize: api.ORB_WINDOW_SIZE,
  loadState: () => settings.orbPosition.load(),
  saveState: state => settings.orbPosition.save(state),
})
const orb = await api.createOrbWindow({
  pageUrl: () => api.desktopOrbUrl(origin, { orbSkin: settings.load().orbSkin }),
  placement,
  partition: 'persist:my-host',
})
const presence = new api.DesktopPresence({ getWindow: () => orb.window() })
const shell = api.bindOrbShell({
  ipc: ipcMain,
  getWindow: () => orb.window(),
  presence,
  onDragEnd: () => {
    const [x, y] = orb.window().getPosition()
    placement.recordPosition({ x, y })
  },
  onQuit: () => stopPlugin(),
})

// Applying an imported skin:
api.importSkin({ source, skinsRoot: api.skinsDirectory(configDir) })
settings.save({ orbSkin: 'firefly--lingxiaotian' })
await orb.load()
```

## HTTP interface

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness, capability discovery and runtime status; includes `protocolVersion`, `capabilities`, `gatewayInstanceId`, `voiceConfigured`, `inputSuspension`, `voiceClients`, `backend` |
| `POST /api/input/suspend` | Take the microphone: `{ owner, reason?, ttlMs? }`; default TTL 15 s, cap 300 s |
| `POST /api/input/resume` | Release it: `{ owner }` |
| `GET /api/input` | Current suspension status |

Microphone suspension semantics: do not wait for the acknowledgement (a key
press that starts recording is latency sensitive — send and start recording);
idempotent per owner, a repeated suspend refreshes the deadline; multiple
owners are reference counted; every hold expires, so a crashed holder can
never silence the Gateway for good.

Endpoints not listed here (`/api/tasks`, `/api/timeline`, `/api/backend/ui`,
`/api/permissions/:id`, `WS /api/realtime` payloads beyond the events below)
are used by our own front ends and carry no stability promise.

## Realtime events

Event names ship as constants in `shared/realtime-events.mjs`; a client that
spells them by hand is on its own.

| Direction | Event | Meaning |
| --- | --- | --- |
| server → client | `input.suspend` | Stop capturing outright (stronger than user-level mute: no capture, no wake word); carries `owner`, `reason`, `expiresAt` |
| server → client | `input.resume` | Capture may resume |
| client → server | `input.suspend.ack` | Confirms the suspension took effect on this client |

## Instance lease

A running Gateway writes `gateway.lock` into its config directory:
`{ schema: "qwaudio.gateway-lock/v1", instanceId, pid, owner, state, origin,
startedAt, heartbeatAt }`. Locate an instance by reading the lease, probing
`origin`, and checking that `/api/health` echoes the same
`gatewayInstanceId` — a port reused by another process then reads as "not
running" instead of leaking a stranger's status. A clean shutdown releases
the lease. Locked by `test/consumer-install.test.mjs` and
`test/gateway-instance-lock.test.mjs`.

## Setup gate

Starting `server/src/index.mjs` without the required realtime credential is
refused before the lease is touched: the process exits non-zero and the error
names every missing key (`DASHSCOPE_API_KEY`, or the Speech-to-Speech service
address when that provider is selected). `QWEN_AUDIO_ALLOW_UNCONFIGURED=1`
opts out for harnesses that never open a voice connection. Locked by
`test/gateway-setup.test.mjs` and `test/consumer-install.test.mjs`.

## Runtime baseline

Shipped code runs on the oldest Node admitted by the `engines` range. CI runs
the suite on that version, and `test/runtime-baseline.test.mjs` fails the
build if shipped code uses an API newer than the baseline.
