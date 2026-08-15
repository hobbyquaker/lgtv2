# Changelog

## 1.8.0 (unreleased)

### Added

- `wake([mac], [options])` / `LGTV.wake(mac, [options])`: Wake-on-LAN magic packets
  (`address`, `port`, `count`, `interval` options); `mac` option on the constructor.
- `getPowerState()` / `subscribePowerState()`: `tvpower/power/getPowerState` mapped to
  `on | standby | screen_off | off | unknown` plus the raw payload.
- `verifyCert` option for `wss` connections: `'lg'` pins LG's "LGE SSG Intermediate CA"
  by SHA-256 fingerprint, `'tofu'` pins the first seen certificate in `certFile`
  (`<keyFile>.cert`), or pass your own fingerprint(s). Failures emit `error` with
  `code: 'ECERT'` and never register with the TV. New `certificate` event.
- `LGTV2_KEY_DIR` environment variable overrides the key/cert directory.
- TypeScript declarations (`index.d.ts`), checked in CI.
- `LGTV.LG_ISSUER_FINGERPRINTS`, `LGTV.POWER_STATES`.

## 1.7.0 (2026-08-15)

Drop-in release for everyone on 1.6.x; the callback API is unchanged.

### Added

- `host` / `port` / `secure` options as an alternative to `url`. With only `host`
  given, `wss://<host>:3001` (required by 2023+ firmware) is tried first and
  `ws://<host>:3000` (pre-2018 TVs) second; the working port is remembered for
  reconnects. `secure`, `port` or `url` pin a single endpoint. The `url` option
  works exactly as before (#48, #49, #24).
- `rejectUnauthorized` option (default `false` — TVs use a certificate from LG's
  private PKI that no public CA can verify).
- `handshakeTimeout` option (default 10 s): aborts a connection attempt whose
  websocket handshake never completes and retries, instead of hanging forever
  when the TV's LAN port is half asleep (#50).
- `request()` and `getSocket()` return a promise when no callback is passed;
  `disconnect()` returns a promise that resolves once the socket is closed.
- `unsubscribe(id)`; `subscribe()`/`send()` return the request id.
- `connected` getter, `keyFile` and `wsconfig` properties.
- SSAP error responses (`type: 'error'`, e.g. `404 no such service or method`)
  and `returnValue: false` payloads are delivered as an `Error` (with
  `code: 'ESSAP'`, `errorCode`, `errorText`) instead of a silent empty result
  (#47, #25, #41).
- Tests against an in-process mock TV (`npm test`), GitHub Actions CI.

### Fixed

- A user-supplied `wsconfig` is merged over the defaults instead of replacing
  them, so adding `tlsOptions` no longer disables the keepalive.
- Specialized sockets (`getSocket`, pointer/button input) use the same TLS
  options as the main connection and therefore work on `wss` TVs.
- Pairing rejection on the TV (`403 cancelled`) emits `error`; `prompt` is only
  emitted for the actual pairing prompt. Keys are saved only when non-empty,
  the key directory is created synchronously before writing (#38, #21).
- Key file name derivation uses `new URL()` (IPv6 literals, URLs without a port).
- The key directory is no longer created when a custom `keyFile` is given (#42);
  its parent directory is created on first save instead.
- No crash when neither `HOME` nor `APPDATA` is set (#27).
- Requests pending when the connection drops fail immediately with
  `connection closed` instead of after the request timeout.
- Request timeout timers are cleared on response and no longer keep the process alive.
- Volume subscriptions: newer firmware answers `audio/getVolume` with
  `volumeStatus: {volume, muteStatus}`; this is normalized to `volume`/`muted`
  and `changed` is computed from the previous state, so the documented
  `res.changed.indexOf('volume')` pattern works on all firmware versions.
- A hint is appended to `ECONNREFUSED` errors on `ws://` URLs pointing to `secure: true`.

### Changed

- Requires Node.js >= 20.
- Dependencies `mkdirp` and `persist-path` removed (inlined); `websocket` bumped to ^1.0.35.
- `xo` replaced by eslint + prettier.
- Manual `test.js` moved to `examples/subscribe.js`.

## 1.6.3 (2020-09-27)

- Emit `message` for every received websocket message (debugging aid, #35).

## 1.6.2 (2020-08-23)

- Extended pairing manifest permissions.

## 1.6.1 (2020-08-23)

- Enable websocket keepalive (#31).
