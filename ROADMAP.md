# Roadmap — lgtv2

This document covers the state of the `lgtv2` library and the concrete next
steps towards a 1.7 fix release and a 2.0 modernization.

`lgtv2` is the WebOS SSAP client used by
[lgtv2mqtt](https://github.com/hobbyquaker/lgtv2mqtt),
[node-red-contrib-lgtv](https://github.com/hobbyquaker/node-red-contrib-lgtv),
[homebridge-webos-tv](https://github.com/merdok/homebridge-webos-tv),
[ioBroker.lgtv](https://github.com/SebastianSchultz/ioBroker.lgtv) and ~17
other npm dependents. Per decision **T-1** in the
[lgtv2mqtt ROADMAP](https://github.com/hobbyquaker/lgtv2mqtt/blob/master/ROADMAP.md)
it stays a **standalone, owned library** and is modernized in lockstep with
lgtv2mqtt rather than absorbed into it. The fleet-wide plan (`xyz2mqtt` spec,
core lib, decisions D-1 … D-12) lives in the
[lgsb2mqtt ROADMAP](https://github.com/hobbyquaker/lgsb2mqtt/blob/master/ROADMAP.md)
and is not repeated here. Decisions specific to this repo are numbered L-n,
open questions continue the fleet numbering (OQ-24+).

**Order of work: 1.7.0 fix release (wss/TLS, error surfacing, keyfile fixes,
PR #42) → 1.8.0 hygiene/helpers → 2.0 (ESM, promises, `ws`, typings).**

lgtv2mqtt 1.3.0 depends on lgtv2 1.7 ("lgtv2 1.7: `ssl` option, IPv6 fix,
merge PR #42, release; then depend on it"), so **1.7.0 is the first
deliverable**.

---

## 0. Local, unpublished patches (`lgtv2-patches/`)

The untracked folder `lgtv2-patches/` is a copy of the npm-installed
`lgtv2@1.6.3` (from `/usr/local/lib/node_modules/lgtv2mqtt`, note the `_from`
fields in its `package.json`) with hand edits that have been running against a
real TV. What is in it and how it feeds into this roadmap:

| file               | change vs. 1.6.3                                                                                                      | use                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `index.js`         | default `url` → `wss://lgwebostv:3001`; default `wsconfig` gains `tlsOptions: {rejectUnauthorized: false}`; two debug `console.log`s | **Field-verified fix** for #48/#49 → becomes the `secure`/`rejectUnauthorized` options in 1.7.0 (L-2). Drop the `console.log`s. |
| `lg-ca-certs.pem`  | bundle of 16 public root CAs (DigiCert, Comodo/USERTrust, QuoVadis, IdenTrust), not referenced by the code              | Experiment at *verifying* the TV certificate instead of disabling verification. **Cannot work, regardless of completeness**: the TV's chain is LG's private PKI (see OQ-30), which no public root signs. Not needed. |
| `pairing.json`, `README.md`, `LICENSE` | identical to 1.6.3 (only CRLF)                                                                          | nothing to take over.                                                                                             |
| `package.json`     | the installed-package variant (`_from`, `_resolved`, …), version 1.6.3                                                  | confirms what 1.6.3 on npm contains (see *npm is ahead of git* below).                                            |

**→ Everything useful from this folder is recorded in this document (the
`index.js` diff is the two lines quoted above; the certificate findings are in
OQ-30). The folder can be deleted at any time — at the latest when the 1.7.0
item "`secure`/`rejectUnauthorized` options" is done.** It is deliberately
not committed.

---

## 1. Analysis: current state (1.6.3, June 2022)

~320 lines of callback-style ES5 (`var`, `util.inherits`), one file, no
tests beyond the manual `test.js`. Last commit Sep 2020, last npm publish
2022-06 (1.6.3; the 1.6.2/1.6.3 bumps are not in git — npm is ahead of the
repo, see *Packaging*). 25 open issues, 1 open PR. The protocol itself still
works; what broke is the transport default plus a handful of robustness gaps.

### Broken on current TVs

- **Default `ws://lgwebostv:3000`** (index.js:43). Since the 2023 firmware
  wave TVs only listen on `wss://host:3001` with a self-signed certificate
  (#48, #49, #24). It *does* work today via
  `{url: 'wss://host:3001', wsconfig: {tlsOptions: {rejectUnauthorized: false}}}`
  (verified by `lgtv2-patches/`), but nothing in the README says so and there
  is no first-class option.
- **Passing `wsconfig` replaces the whole default object** (index.js:46), so
  anyone who adds `tlsOptions` for wss silently loses the keepalive settings
  (`keepalive`, `keepaliveInterval: 10000`, `dropConnectionOnKeepaliveTimeout`)
  added in #31 to detect a TV going to standby. Must shallow-merge.
- **Specialized sockets ignore TLS options** (index.js:261):
  `getSocket()` creates a bare `new WebSocketClient()`. On wss TVs
  `getPointerInputSocket` returns a `wss://…:3001/resources/…` path, so
  button/pointer input fails with a certificate error even when the main
  connection works. Must reuse the main `wsconfig`.
- **Connect can hang forever** (#50): `websocket` has no handshake timeout
  (WebSocket-Node #275). If the TV's LAN port is half-awake the `http(s)`
  request never fails and neither `connect` nor `connectFailed` fires, so the
  reconnect loop never restarts. Needs a request/socket timeout around
  `client.connect()` (or a transport that supports `handshakeTimeout`, see
  *Dependencies*).

### Bugs / robustness

- **TV error responses are swallowed** (index.js:131-150). A response with
  `type: 'error'` (e.g. `404 no such service or method`,
  `401 insufficient permissions`, pairing `403 cancelled`) has an empty or
  missing `payload`; the callback is invoked as `cb(null, {})`. Consumers see
  "success" with no data — the root cause of #47 (launch app id), #25/#41
  (contentId), #28 and most "nothing happens" reports. Map `type === 'error'`
  to `cb(new Error(parsedMessage.error))` and `payload.returnValue === false`
  to an `Error` carrying `errorCode`/`errorText`.
- **Pairing rejection is reported as `prompt`** (index.js:177): any register
  response without `client-key` emits `prompt`, including the user pressing
  *No* on the TV. Emit `error` for `type === 'error'` and keep `prompt` for
  `pairingType: 'PROMPT'` responses only. Related: #21 (prompt on every
  connect on WebOS 4.70 — the empty-key problem below) and #38.
- **Key file can be written empty / saved in a race** (#38, #21):
  `mkdirp(ppath('lgtv2'))` (index.js:48) is mkdirp 1.x, which returns a
  *promise* that is never awaited; `fs.writeFile` of the key may run before the
  directory exists on first pairing. Use `fs.mkdirSync(dir, {recursive: true})`
  and write only when `res['client-key']` is a non-empty string.
- **Key file name derivation** (index.js:49):
  `url.replace(/[a-z]+:\/\/([0-9a-zA-Z-_.]+):\d+/, '$1')` — fails for IPv6
  (`[fe80::1]`), for URLs without an explicit port and for uppercase schemes;
  on a non-match `replace` returns the *whole URL*, producing a file name with
  `://`. Use `new URL(config.url).hostname`.
- **`keyFile` option still creates `~/.lgtv2`** (PR #42, merdok): the
  directory is created even when the caller supplies their own path; crashes
  when `$HOME` is read-only. Also, the README documents `keyFile` as a *prefix*
  that gets the hostname appended, but the code uses it verbatim when given —
  PR #42 restores the prefix behaviour; decide which is intended (L-5).
- **`persist-path` throws without `HOME`/`APPDATA`** (#27, systemd services
  without `User=`): `TypeError: Arguments to path.join must be strings`. Fall
  back to `os.homedir()` / `os.tmpdir()` and emit a warning instead of
  throwing at construction time.
- **Pending requests are dropped silently on close** (index.js:105): callbacks
  are deleted, so a `request()` issued just before the TV went away only
  reports after the 15 s `timeout`. Call them with
  `new Error('connection closed')` immediately.
- **`changed` array hack is firmware-specific** (index.js:132-148): on the
  first subscription response `muted`/`volume` are pushed into `changed`.
  Newer firmware answers `audio/getVolume` with
  `volumeStatus: {volume, muteStatus, soundOutput, …}` and no `changed` at
  all, so the README example (`res.changed.indexOf(…)`) throws
  (lgtv2mqtt #18). Either normalize both shapes in the lib or drop the hack
  and document `audio/getStatus` as the subscription to use (#46 lists the
  full `audio` service table).
- **No `unsubscribe()`**: `subscribe` callbacks live until the connection
  closes; `send()` does not return the request id, so callers cannot cancel.
  Return the cid and add `unsubscribe(cid)` (SSAP type `unsubscribe`).
- **Request timeouts are not cleared** on response (index.js:226) — harmless
  but keeps the event loop alive for 15 s after `disconnect()`; `clearTimeout`
  and `timer.unref()`.
- **`connect(host)` re-registers but ignores its argument** if already
  connected (index.js:290); `this.connection` (boolean) vs. the internal
  `connection` object is confusing — expose a read-only `connected` getter.
- **Power state / Wake-on-LAN** (#15, lgtv2mqtt #6): not a lib concern per se,
  but every consumer reimplements WoL and `getPowerState` parsing
  (see node-red-contrib-lgtv #7). A small optional helper
  (`lgtv.wake(mac)`, documented `tvpower/power/getPowerState` subscription)
  serves all dependents at once (T-5 in lgtv2mqtt).
- **PIN pairing** (#44): `pairing.json` is `pairingType: 'PROMPT'` only.
  Some models/setups require `PIN`; the register flow would need a second
  step (`setPin`). Investigate (OQ-27).

### Dependencies

| dep            | pinned  | latest | notes                                                                                                                                                                                                                                                            |
| -------------- | ------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| websocket      | ^1.0.32 | 1.0.35 | WebSocket-Node; last release 2024-05, effectively in maintenance. Optional native addons (`bufferutil`, `utf-8-validate`) need a toolchain — the source of the "bin deps" install pain on Windows/ARM. No handshake timeout (#50). TLS only via `tlsOptions`.       |
| persist-path   | ^1.0.2  | 1.0.2  | Our own, 2022. Throws without `HOME`/`APPDATA` (#27). Trivial to inline.                                                                                                                                                                                          |
| mkdirp         | ^1.0.4  | 3.0.1  | Superseded by `fs.mkdirSync(p, {recursive: true})` since node 10.12. Drop.                                                                                                                                                                                       |
| xo, camo-purge | latest  | —      | Drop per D-4 (eslint + prettier); `camo-purge` is obsolete.                                                                                                                                                                                                      |
| engines        | (none)  | —      | → `>=20` per fleet spec.                                                                                                                                                                                                                                         |

Transport alternative: **`ws`** (8.x, actively maintained, pure JS, no native
addons, `handshakeTimeout`, `rejectUnauthorized` passed straight through as an
`https.request` option, ping/pong keepalive via `ws.ping()`). It is the
de-facto standard. Switching is internal (the lib already hides the socket),
but keepalive semantics differ slightly → 2.0 (L-7).

### Packaging / hygiene

- **git == npm** (verified 2026-08-20 against the tarballs): HEAD is
  byte-identical to `lgtv2@1.6.3`; 1.6.1/1.6.2/1.6.3 were all published in
  Aug/Sep 2020 (the 2022 date on npm is `time.modified`, metadata only). No
  release tags existed → `v1.6.1`, `v1.6.2`, `v1.6.3` added on the matching
  "bump version" commits.
- **Working tree line endings**: the current checkout has CRLF in every file
  while the index has LF (`git ls-files --eol`: `i/lf w/crlf`), so
  `git status` shows every file as modified. Add `.gitattributes`
  (`* text=auto eol=lf`), renormalize, and always work from WSL (CLAUDE.md).
- Travis CI and david-dm badges are dead; `.travis.yml` targets node 6.
- No CHANGELOG, no tests, no GitHub Actions, no `files` whitelist
  (`pairing.json` **must** stay in the package), no TypeScript declarations
  (`index.d.ts` — several dependents are TS).
- README: examples use `ws://:3000` and the crashing
  `res.changed.indexOf(...)` pattern; the "LG Connect Apps" link is dead; the
  command list is a bare list of endpoints without payloads — the most
  requested doc item (#33, #22, #28, #32). Merge the endpoint table from the
  lgtv2mqtt ROADMAP (section 2) with payload examples and the full button
  name list for `getPointerInputSocket`.
- `test.js` is a manual smoke test; move to `examples/subscribe.js` and add
  real tests (L-9).

### Issue triage (open as of 2026-08)

| issue                               | topic                               | plan                                                                              |
| ----------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| #48 #49 #24                         | wss:3001 / port 3000 closed         | 1.7.0: `secure` option + README; 2.0: secure default (L-2).                        |
| #50                                 | connect hangs forever               | 1.7.0: handshake timeout workaround; 2.0: `ws` `handshakeTimeout` (L-7).          |
| #38 #21                             | key file empty / prompt every time  | 1.7.0: mkdir race + write-only-non-empty key + reject ≠ prompt.                   |
| PR #42                              | no mkdir when `keyFile` given       | 1.7.0: merge (adapted, L-5).                                                      |
| #27                                 | `persist-path` without `$HOME`      | 1.7.0: inline path logic with fallback.                                           |
| #47 #25 #41                         | launch / contentId "does nothing"   | 1.7.0: surface TV errors; README launch examples with `params`/`contentId`.       |
| #46                                 | eARC soundbar volume `-1`           | docs: use `audio/volumeUp` / `volumeDown` and `audio/getStatus`; nothing to fix in the lib. |
| #15                                 | `turnOff` wakes TV when LAN awake   | docs: check `getPowerState` first; helper in 1.8 (power/WoL).                     |
| #44                                 | PIN pairing                         | OQ-27.                                                                            |
| #40 #20                             | picture settings / energy saving    | out of scope for the lib (luna hack, see lgtv2mqtt OQ-23); document as recipe.    |
| #22 #33 #28 #32 #26 #30 #29 #34 #36 | questions / docs                    | close with README section links once the command reference exists.                |

---

## 2. Target API (2.0)

Same surface, promise-based, transport hidden:

```js
import LGTV from 'lgtv2';

const tv = new LGTV({
    host: '192.168.1.20',                   // or url: 'wss://192.168.1.20:3001'
    secure: true,                           // default true → wss:3001; false → ws:3000
    rejectUnauthorized: false,              // default false (TVs use a self-signed cert)
    keyFile: '/data/lgtv2/key-livingroom',  // or clientKey / saveKey as before
    timeout: 15000, reconnect: 5000, handshakeTimeout: 5000,
});

tv.on('prompt', () => …);        // accept on TV
tv.on('connect', () => …);       // paired + connected
tv.on('error' | 'close' | 'connecting' | 'message', …);

const { volume } = await tv.request('ssap://audio/getVolume');
const sub = await tv.subscribe('ssap://audio/getStatus', (err, status) => …);
await tv.unsubscribe(sub);
const sock = await tv.getSocket('ssap://com.webos.service.networkinput/getPointerInputSocket');
sock.send('button', { name: 'HOME' });
await tv.wake('AA:BB:CC:DD:EE:FF');      // optional WoL helper
await tv.disconnect();
```

Callbacks remain accepted as a trailing argument in 1.x and 2.0 (the four big
dependents are callback-based); promises are returned when no callback is
passed.

---

## 3. Decisions (repo-specific)

| ID  | Decision                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L-1 | `lgtv2` stays a standalone npm library (T-1). Breaking changes only in 2.0; 1.7/1.8 are drop-in for all dependents.                                                                                                                              |
| L-2 | 1.7.0 adds `host`/`secure`/`port` + `rejectUnauthorized` (default `false`). With only `host` given the lib tries `wss://host:3001` first, then `ws://host:3000`, and keeps the working port for reconnects (OQ-25 → fallback). `secure`/`port`/`url` pin one endpoint. |
| L-3 | User `wsconfig` is shallow-merged over the defaults, never replaces them; the same config is used for specialized sockets.                                                                                                                        |
| L-4 | SSAP `type: 'error'` and `returnValue: false` responses are delivered as `Error` (with `errorCode`/`errorText`) to the callback/promise; pairing rejection emits `error`, not `prompt`. Shipped in 1.7.0 as a bug fix.                              |
| L-5 | Drop `mkdirp` and `persist-path`; inline the key path logic (`~/.lgtv2/keyfile-<hostname>`, `APPDATA` on Windows, `os.homedir()`/`os.tmpdir()` fallback). `keyFile` is used **verbatim** (current behaviour, README corrected; PR #42 adapted).     |
| L-6 | Promise support is additive: every method returns a promise when no callback is given (1.7.0); callbacks keep working in 2.0.                                                                                                                     |
| L-7 | 2.0 replaces `websocket` with `ws` (handshake timeout, no native addons, maintained). 1.7 keeps `websocket` and works around #50 with a request timeout.                                                                                           |
| L-8 | Plain JavaScript (D-4) plus generated `index.d.ts`; 2.0 is ESM with `exports` — CJS consumers use `require(esm)` (node ≥ 20.19 / 22.12), hence `engines >= 20.19` for 2.0. 1.x stays CJS.                                                           |
| L-9 | Tests run against an in-process mock SSAP server (`node:test` + `ws`), covering register/prompt/reject, request/subscribe/unsubscribe, error mapping, both `getVolume` payload shapes, reconnect and close handling. No TV needed in CI.           |

---

## 4. Open questions

- **OQ-24 — `changed` array compatibility**: keep synthesizing `changed` on
  the first `getVolume` response (1.x behaviour some consumers rely on) or
  drop it in 2.0 and document `audio/getStatus`? Leaning: keep in 1.x and
  normalize `volumeStatus` into the same shape; remove in 2.0 with a
  CHANGELOG note.
- **OQ-25 — ws/wss auto-fallback** (shared with lgtv2mqtt OQ-20) — **decided:
  fallback in the lib** (1.7.0). `wss:3001` first, `ws:3000` second, the
  working port is kept for reconnects so old TVs pay the extra attempt only
  once; a single combined `ECONNFAILED` error is emitted when both fail.
  `secure`/`port`/`url` pin one endpoint. lgtv2mqtt therefore needs no
  `--insecure` flag (T-3 can be simplified to "pass `host` through").
- **OQ-26 — Key file location in Docker** (= fleet OQ-21) — **done in 1.8.0**:
  `LGTV2_KEY_DIR` overrides the key/cert directory. Whether the fleet spec
  mandates `/data` on top of that remains a spec question.
- **OQ-27 — PIN pairing** (#44): which models require it and what the
  `setPin` exchange looks like; no reliable reference implementation found
  (aiowebostv does not support it either). Needs a tester with such a TV.
- **OQ-28 — Power helper scope** — **done in 1.8.0**: both. `wake()` (instance
  with `mac` option, and static `LGTV.wake`) and `getPowerState()` /
  `subscribePowerState()` mapping to `on | standby | screen_off | off | unknown`
  (`LGTV.POWER_STATES`). Real-TV mapping check still pending.
- **OQ-29 — Typings** — **done in 1.8.0**: hand-written `index.d.ts` after
  all (the overload-heavy callback/promise API is awkward to express in JSDoc);
  drift is caught by `types-test/types.ts` compiled in CI.
- **OQ-30 — Certificate verification instead of `rejectUnauthorized: false`**.
  Measured on `lgtv-wohnzimmer:3001` (2026-08-20): the TV serves a 2-cert
  chain from **LG's private PKI**, not a public CA:
  - leaf `CN=LGE TV SSG` (O=LG Electronics Inc., OU=HE Lab.), valid
    2018-03-12 → 2034-08-15, no SAN for the TV's host/IP;
  - intermediate `CN=LGE SSG Intermediate CA`, issued by `CN=…webOS TV Root CA`
    (`security-part@lge.com`), same validity; the root itself is **not** sent.
  - sha256 fingerprint of the intermediate:
    `E2:BD:64:64:D3:F5:1C:1B:95:B7:69:7D:9D:67:73:C3:3D:94:12:EB:A0:29:9C:56:8C:34:93:7D:3F:E6:8A:A0`.

  So `lg-ca-certs.pem` is not "incomplete" — public roots can never verify
  this chain; `rejectUnauthorized: false` was necessary, not lazy. What *does*
  work (tested, `Verification: OK`): trusting the LG intermediate as a
  partial-chain anchor (`openssl s_client -CAfile <intermediate> -partial_chain`).
  In Node that is `tls` `ca: [intermediate]` plus a custom
  `checkServerIdentity` that ignores the hostname mismatch (the cert has no
  SAN) — or simpler, a `checkServerIdentity` that compares the peer's
  fingerprint. Options for the lib:
  1. ship the LG intermediate as `lg-webos-intermediate.pem` and verify against
     it by default (`rejectUnauthorized: true` + hostname check disabled) —
     strongest, but unknown whether *all* models/firmwares use the same
     intermediate (likely: it is LG-wide, 2018–2034);
  2. *trust-on-first-use*: store the leaf/intermediate fingerprint next to the
     client key, refuse a changed one;
  3. keep `rejectUnauthorized: false` (status quo).

  **Done in 1.8.0**: 1 and 2 as opt-ins (`verifyCert: 'lg' | 'tofu' |
  fingerprint(s)`), default stays 3. Implementation detail: the chain is
  inspected after the TLS handshake via `getPeerCertificate(true)` (Node skips
  `checkServerIdentity` when chain verification already failed), so `'lg'`
  pins the intermediate's SHA-256 fingerprint instead of shipping a PEM.
  **Research (2026-08-21, 17 sources, 25 claims adversarially verified)**:
  - The **leaf itself is fleet-wide static**: `CN=LGE TV SSG`, serial `0x2001`,
    same RSA-2048 key (SKI `59:BF:D3:B7…`), same validity, observed on a 2018
    EU TV (ours, webOS 6.0), a 2022 US OLED65G2PUA (firmware built Nov 2025)
    and a 2023 JP OLED55G3PJA (Shodan, Aug 2026). So the private key is shared
    by every TV — the cert proves "an LG TV", never "my TV".
  - Leaf SHA-256 `11:C5:B1:C5:90:77:50:AB:B9:DA:2A:66:65:CC:CE:2B:B2:88:A5:83:F4:5A:33:39:E7:1F:87:BF:2F:80:85:52`
    (measured here; serial/key match the Shodan records). Root
    `CN=LG webOS TV Root CA` (serial `0x1007` on the intermediate's AKI) is
    never sent and not published; LG's developer TLS page lists no LG-owned CA.
  - No rotation seen 2018→2026, none announced; expiry 2034-08-15.
  - No other client verifies: aiowebostv/Home Assistant (`ssl=False`),
    bscpylgtv (`CERT_NONE`), PyWebOSTV, homebridge-webos-tv, Homey LG WebOS
    Plus, node-red-contrib-lgtv #56 — all disable verification; none pins or
    publishes fingerprints.
  - Caveat: LGTVCompanion v4.0.1 (May 2023) rewrote its client "to resolve
    SSL handshake issues on webOS23 devices" and a 2026 report shows fw
    43.00.92 rejecting pairing with "blacklisted certificate detected" (an
    app-level pairing cert, not the server chain) — LG does change
    TLS-adjacent behaviour, so pinning needs an escape hatch.

  **Decision**: `verifyCert: 'lg'` accepts **leaf or intermediate** (both
  shipped in `LG_ISSUER_FINGERPRINTS`), stays **opt-in** in 1.x. Revisit a
  default of `'lg'` for 2.0 only with a documented fallback (`error` carries
  `chain` fingerprints so users can pass their own) and an issue template
  collecting fingerprints from other models.
- **OQ-31 — Learn the MAC for `wake()` automatically**: once paired, the
  wired/Wi-Fi MACs are available from
  `com.webos.service.connectionmanager/getinfo` (and `device_id` of
  `getCurrentSWInformation`). Cache them next to the client key so `wake()`
  works without a `mac` option? Leaning: yes in 1.9 (`macFile`, opt-out), since
  every dependent needs it; pick the interface matching the current
  connection's remote address.

---

## 5. Immediate next steps

### 1.7.0 — fix release (CJS, drop-in)

- [x] git == npm verified; tags `v1.6.1`–`v1.6.3` added (nothing to reconstruct).
- [x] `.gitattributes` + renormalize line endings.
- [x] `host`/`secure`/`port` + `rejectUnauthorized` options with automatic
      `wss:3001 → ws:3000` fallback (L-2, OQ-25); `url` still accepted.
      README: pairing instructions, LG-private-CA note. Fixes #48 #49 #24.
      Verified against `lgtv-wohnzimmer` (TLS handshake + pairing prompt OK).
- [x] Shallow-merge `wsconfig`; TLS options passed to specialized sockets (L-3).
- [x] `handshakeTimeout` option (timer + `client.abort()` → `connectFailed`,
      error code `ETIMEDOUT`) for #50.
- [x] Surface SSAP errors (`code: 'ESSAP'`, `errorCode`, `errorText`) and
      pairing rejection as `error` (L-4). Fixes #47 #25 #41.
- [x] Key file: `fs.mkdirSync` recursive at save time, write only non-empty
      keys, `URL` hostname parsing (IPv6), `$HOME` fallback, `mkdirp` and
      `persist-path` removed (L-5). Fixes #38 #21 #27; PR #42 superseded.
- [x] Fail pending *requests* on close (subscriptions are dropped silently as
      before — calling them with an error would crash consumers that don't
      check `err`); clear/unref timers; `unsubscribe()`; `connected` getter;
      `disconnect()` cancels the initial connect timer (previously a
      `disconnect()` right after construction still connected).
- [x] Promise return when no callback for `request`, `getSocket`, `disconnect` (L-6).
- [x] Normalize `volumeStatus` payloads into `volume`/`muted`/`changed`, with
      `changed` computed from the previous state per subscription (OQ-24).
- [x] `examples/subscribe.js`; mock-TV tests (`test/mock-tv.js`, 14 tests,
      L-9); GitHub Actions (lint + test on node 20/22/24).
- [x] `engines >= 20`, `files` whitelist, eslint + prettier, xo/camo-purge
      dropped, Travis/david-dm removed, CHANGELOG.md.
- [x] README command table checked against OLED65C17LB (webOS 6.0, fw 03.53.45,
      2026-08-21): `audio/getStatus`+`getVolume` (`volumeStatus` shape, no
      `subscribed` flag → normalization fix), `getSoundOutput`, `getPowerState`,
      `getSystemInfo`, `getCurrentSWInformation`, `getForegroundAppInfo`,
      `listLaunchPoints` (38 kB), `getExternalInputList`, `connectionmanager/getinfo`
      (MACs), `getServiceList`, pointer socket over wss — all OK.
      `media/getForegroundAppInfo` → 404, `getCurrentChannel`/`getChannelProgramInfo`
      → 500 outside live TV, `system.launcher/getAppState` → 403, and
      **`tv/getChannelList` makes the TV close the websocket** (tuner-less/ARC
      setup). All noted in the README table.
- [x] `v1.7.0` tagged locally (not pushed, not published yet).
- [ ] `git push --tags`, `npm publish`; bump lgtv2mqtt 1.3.0 and
      node-red-contrib-lgtv to `lgtv2@^1.7.0`.
- [x] `lgtv2-patches/` deleted (section 0 kept for the record).

### 1.8.0 — hygiene / helpers

- [x] `wake(mac)` (instance + static, `mac` option) and
      `getPowerState()`/`subscribePowerState()` mapped to
      `on|standby|screen_off|off|unknown` (OQ-28, T-5).
- [x] `index.d.ts`, hand-written, checked by `tsc` against `types-test/types.ts`
      in CI (OQ-29).
- [x] `verifyCert: 'lg' | 'tofu' | fingerprint(s)` opt-in (OQ-30). `'lg'` pins
      the LG intermediate by SHA-256 fingerprint (no PEM needed); `'tofu'`
      stores the leaf fingerprint in `certFile`. Tested with an
      openssl-generated CA→leaf chain.
- [x] README command reference with payloads and the button name list
      (landed in 1.7.0); closing the doc issues (#33 #22 #28 #32 #26 #30 #34
      #36 #46 #15) with pointers is a GitHub action for release day.
- [x] `LGTV2_KEY_DIR` env var (OQ-26).
- [x] Verified on the real TV (2026-08-21): `verifyCert: 'lg'` passes;
      `getPowerState()` → `on`, power-down sequence seen as `Screen Saver`
      (+`processing` hints) → `Active Standby` → websocket closed after ~4 s,
      port 3001 closed after ~10 s; `wake()` to the wired MAC brought the TV
      back within ~2 s (TV `device_id` in `getCurrentSWInformation` equals the
      wired MAC; `connectionmanager/getinfo` lists wired/wifi/p2p MACs — a
      future `wake()` could learn the MAC automatically, OQ-31).
- [x] `v1.8.0` tagged locally (push/publish on request).

### 2.0.0 — modernization

- [ ] ESM + `exports`, `engines >= 20.19` (L-8); `ws` transport (L-7).
- [ ] Secure default `wss://<host>:3001` (L-2); `host`/`port`/`secure` config.
- [ ] Remove the `changed` synthesis (OQ-24); `connected` getter.
- [ ] PIN pairing if OQ-27 is resolved.
- [ ] Migration notes in CHANGELOG; coordinated releases of lgtv2mqtt 2.0 and
      node-red-contrib-lgtv.
