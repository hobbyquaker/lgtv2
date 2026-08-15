# LGTV2

[![NPM version](https://badge.fury.io/js/lgtv2.svg)](http://badge.fury.io/js/lgtv2)
[![npm](https://img.shields.io/npm/dt/lgtv2.svg)]()
[![CI](https://github.com/hobbyquaker/lgtv2/actions/workflows/ci.yml/badge.svg)](https://github.com/hobbyquaker/lgtv2/actions/workflows/ci.yml)
[![License][mit-badge]][mit-url]

Simple Node.js module to remote control LG WebOS smart TVs.

> this is a fork of [LGTV.js](https://github.com/msloth/lgtv.js), heavily modified and rewritten to suite my needs.

## Projects using this Module

- [node-red-contrib-lgtv](https://github.com/hobbyquaker/node-red-contrib-lgtv) - [Node-RED](https://nodered.org/) Nodes to control LG webOS Smart TVs.
- [lgtv2mqtt](https://github.com/hobbyquaker/lgtv2mqtt) - Interface between LG WebOS Smart TVs and MQTT.
- [homebridge-webos-tv](https://github.com/merdok/homebridge-webos-tv) - [Homebridge](https://github.com/nfarina/homebridge) plugin for LG WebOS TVs.
- [ioBroker.lgtv](https://github.com/SebastianSchultz/ioBroker.lgtv) - LG WebOS SmartTV adapter for [ioBroker](http://iobroker.net/).

## Installation

`npm install lgtv2`

Requires Node.js >= 20.

## TV configuration

- The TV must be reachable on your network. Newer TVs (firmware from 2023 on) only accept
  **secure** websocket connections on port 3001 (`wss://<tv>:3001`); TVs from before 2018
  only offer `ws://<tv>:3000`. Since lgtv2 1.7 you don't have to care: with just `{host}`
  the module tries `wss://<tv>:3001` first, falls back to `ws://<tv>:3000` and remembers
  what worked. Set `secure`/`port` or a full `url` to pin it.
- On first connection the TV shows a connection request ("LG Connect Apps" / "Mobile TV On"
  on older models). Accept it; the resulting client key is stored in the key file (see
  `keyFile` below) and reused on subsequent connections.
- To turn the TV **on** over the network you need Wake-on-LAN and the TV setting
  _Settings → General → Mobile TV On / Turn on via Wi-Fi_ (2025+ models:
  _Support → IP control settings → Wake on LAN_). Then `lgtv.wake()` / `LGTV.wake(mac)` turns it on.

## Usage Examples

Subscribe to volume and mute changes and output to console:

```javascript
const LGTV = require('lgtv2');

const lgtv = new LGTV({host: '192.168.1.20'});

lgtv.on('error', (err) => console.log(err));
lgtv.on('prompt', () => console.log('please accept the connection request on the TV'));

lgtv.on('connect', () => {
    console.log('connected');

    lgtv.subscribe('ssap://audio/getVolume', (err, res) => {
        if (err) return console.log(err);
        if (res.changed.includes('volume')) console.log('volume changed', res.volume);
        if (res.changed.includes('muted')) console.log('mute changed', res.muted);
    });
});
```

Turn TV off (promise style):

```javascript
const LGTV = require('lgtv2');

const lgtv = new LGTV({host: '192.168.1.20'});
lgtv.on('error', (err) => console.log(err));

lgtv.on('connect', async () => {
    await lgtv.request('ssap://system/turnOff');
    await lgtv.disconnect();
});
```

Old-style TV (ws://, port 3000):

```javascript
const lgtv = new LGTV({host: '192.168.1.20', secure: false});
// or: new LGTV({url: 'ws://192.168.1.20:3000'})
```

More in [examples/](examples/).

## API

### options

- `host` - hostname or IP of the TV. Used to build the URL together with `secure` and `port`.
- `secure` - `true` → `wss://<host>:3001`, `false` → `ws://<host>:3000`. When omitted (and no `port`/`url` is given) both are tried automatically, `wss` first; the port that worked is used for reconnects, and only if both fail an `error` (`code: 'ECONNFAILED'`) is emitted.
- `port` - overrides the port chosen by `secure` (disables the automatic fallback).
- `ports` - `{secure: 3001, insecure: 3000}` - the ports used for `wss`/`ws` (e.g. behind port forwarding); keeps the automatic fallback.
- `url` - complete websocket URL (e.g. `'wss://192.168.1.20:3001'`). Takes precedence over `host`/`secure`/`port` and disables the automatic fallback.
- `urls` (property) - the list of URLs that will be tried.
- `rejectUnauthorized` - verify the TV's TLS certificate against public CAs. Default `false`: the TV uses a certificate issued by LG's private CA that is not verifiable against public roots.
- `verifyCert` - additional certificate check for `wss` connections, default `false`:
    - `'lg'` - the presented chain must contain LG's "LGE SSG Intermediate CA" (pinned by SHA-256 fingerprint, see `LGTV.LG_ISSUER_FINGERPRINTS`). Protects against a rogue device answering as your TV.
    - `'tofu'` - trust on first use: the first certificate seen is pinned in `certFile`; a different one later is rejected (`error` with `code: 'ECERT'`, delete the file to re-trust).
    - a SHA-256 fingerprint (`'AB:CD:…'` or `'sha256/abcd…'`) or an array of them - accepted if any certificate of the chain matches.
- `certFile` - where the `tofu` fingerprint is stored, default `<keyFile>.cert`.
- `mac` - MAC address of the TV for `wake()`.
- `timeout` - request timeout in milliseconds, default: 15000.
- `handshakeTimeout` - abort a connection attempt whose websocket handshake does not complete within this many milliseconds (then reconnect), default: 10000. `0` disables.
- `reconnect` - reconnect interval in milliseconds, default: 5000. `false`/`0` disables auto-reconnect.
- `keyFile` - path of the file the client key is stored in. Default: Linux `~/.lgtv2/keyfile-<host>`, macOS `~/Library/Preferences/lgtv2/keyfile-<host>`, Windows `%APPDATA%\lgtv2\keyfile-<host>`; the environment variable `LGTV2_KEY_DIR` overrides the directory (handy for Docker volumes). The directory is created when the key is first saved.
- `saveKey` - `function (key, callback)` to override how the key is stored.
- `clientKey` - supply the key directly (use together with a custom `saveKey`).
- `wsconfig` - options for the underlying [websocket](https://github.com/theturtle32/WebSocket-Node/blob/master/docs/WebSocketClient.md) client; merged over the defaults (`keepalive: true, keepaliveInterval: 10000, dropConnectionOnKeepaliveTimeout: true, keepaliveGracePeriod: 5000`). `wsconfig.tlsOptions` is merged over `{rejectUnauthorized}`.

### properties

- `connected` - `true` while connected _and_ paired.
- `keyFile` - resolved key file path.
- `clientKey` - the current client key.

### methods

#### request(uri [, payload] [, callback])

Send a request. With a callback: `callback(err, payload)`. Without a callback a promise is returned.
Error responses from the TV (`type: 'error'`, e.g. `404 no such service or method`, or
`returnValue: false`) are delivered as an `Error` with `code: 'ESSAP'` and, if available,
`errorCode` / `errorText`.

#### subscribe(uri [, payload], callback)

Subscribe to a topic. The callback is invoked for every update. Returns the subscription id.

For `ssap://audio/getVolume` the payload is normalized across firmware versions: `volume`,
`muted` and `changed` (array with `'volume'` and/or `'muted'`) are always present.

#### unsubscribe(id)

Stop a subscription. Returns `true` if the id was known.

#### getSocket(uri [, callback])

Get a specialized socket for mouse and button events. Returns a promise when no callback is given.

```javascript
const sock = await lgtv.getSocket('ssap://com.webos.service.networkinput/getPointerInputSocket');
sock.send('button', {name: 'HOME'});
sock.send('click');
sock.send('move', {dx: 10, dy: 0});
```

Button names include `LEFT RIGHT UP DOWN ENTER BACK EXIT HOME MENU INFO DASH ASTERISK CC
PLAY PAUSE STOP REWIND FASTFORWARD RED GREEN YELLOW BLUE VOLUMEUP VOLUMEDOWN MUTE
CHANNELUP CHANNELDOWN 0 … 9`.

#### getPowerState([callback]) / subscribePowerState(callback)

`com.webos.service.tvpower/power/getPowerState` mapped to `{state, raw}` with `state` one of
`'on'` (Active), `'standby'` (Active Standby), `'screen_off'` (Screen Off), `'off'` (Suspend / Power Off),
`'unknown'`. A TV in deep standby does not answer at all - then `connected` is `false` and only
`wake()` helps.

#### wake([mac] [, options] [, callback]) / LGTV.wake(mac [, options] [, callback])

Sends Wake-on-LAN magic packets (3 by default). `mac` defaults to the `mac` option. `options`:
`address` (default `'255.255.255.255'`, use your subnet's broadcast address if the TV does not
react), `port` (9), `count` (3), `interval` (100 ms). Returns a promise when no callback is given.

```javascript
await LGTV.wake('aa:bb:cc:dd:ee:ff', {address: '192.168.1.255'});
```

#### connect([url])

Usually not needed - the connection is established automatically on construction and
re-established after `close`.

#### disconnect([callback])

Closes the connection to the TV and stops auto-reconnection. Returns a promise when no callback is given.

### events

- `connecting` (url) - trying to connect to the TV
- `prompt` - the TV shows the pairing prompt; accept it on the TV
- `connect` - connection established and paired
- `close` - connection closed
- `error` (err) - websocket/pairing/TV errors. Subsequent equal connection errors are only emitted once (so your log isn't flooded with `EHOSTUNREACH` while the TV is off)
- `message` (raw) - every raw websocket message, for debugging
- `certificate` ({fingerprint, stored}) - `verifyCert: 'tofu'` pinned a certificate for the first time

### TypeScript

Type declarations ship with the package (`index.d.ts`); `import LGTV = require('lgtv2')` or
`import LGTV from 'lgtv2'` with `esModuleInterop`.

## Commands

A selection of SSAP endpoints; payloads are passed as the second argument of `request`.

| uri                                                      | payload / notes                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ssap://api/getServiceList`                              |                                                                                  |
| `ssap://audio/getStatus`                                 | subscribe: volume, mute, sound output                                            |
| `ssap://audio/getVolume`                                 | subscribe: `{volume, muted, changed}` (normalized)                               |
| `ssap://audio/setVolume`                                 | `{volume: 10}`                                                                   |
| `ssap://audio/volumeUp` / `volumeDown`                   | needed for ARC/eARC soundbars that report `volume: -1`                           |
| `ssap://audio/setMute`                                   | `{mute: true}`                                                                   |
| `ssap://com.webos.service.apiadapter/audio/getSoundOutput` / `changeSoundOutput` | `{output: 'external_arc'}` — `tv_speaker`, `external_arc`, `external_optical`, `bt_soundbar`, `headphone`, `lineout` |
| `ssap://com.webos.service.tvpower/power/getPowerState`   | subscribe: `{state: 'Active' \| 'Active Standby' \| 'Suspend' \| 'Screen Off'}` |
| `ssap://com.webos.service.tvpower/power/turnOffScreen` / `turnOnScreen` |                                                                   |
| `ssap://system/turnOff`                                  |                                                                                  |
| `ssap://system/getSystemInfo`                            | model name etc.                                                                  |
| `ssap://com.webos.service.update/getCurrentSWInformation` | firmware version                                                                |
| `ssap://com.webos.applicationManager/getForegroundAppInfo` | subscribe: `{appId}`                                                           |
| `ssap://com.webos.applicationManager/listLaunchPoints`   | installed apps (id → title)                                                      |
| `ssap://com.webos.applicationManager/launch`             | `{id: 'netflix'}`, `{id: 'youtube.leanback.v4', params: {contentTarget: 'https://www.youtube.com/watch?v=…'}}` |
| `ssap://system.launcher/launch`                          | `{id: 'netflix', contentId: '…'}`                                                |
| `ssap://system.launcher/open`                            | `{target: 'https://example.org'}` — opens the browser                            |
| `ssap://system.launcher/close` / `getAppState`           | `{id}`                                                                           |
| `ssap://com.webos.media/getForegroundAppInfo`            | subscribe: play/pause state (newer firmware)                                     |
| `ssap://media.controls/play` / `pause` / `stop` / `rewind` / `fastForward` |                                                                 |
| `ssap://media.viewer/close`                              |                                                                                  |
| `ssap://system.notifications/createToast`                | `{message: 'Hello World!'}` (optional `iconData` base64, `iconExtension`)        |
| `ssap://system.notifications/createAlert`                | `{message, buttons: [{label, onclick, params}]}`                                 |
| `ssap://com.webos.service.ime/insertText`                | `{text: 'abc', replace: 0}`                                                      |
| `ssap://com.webos.service.ime/sendEnterKey` / `deleteCharacters` | `{count: 1}`                                                             |
| `ssap://tv/getExternalInputList`                         | inputs with `id`, `label`, `connected`                                           |
| `ssap://tv/switchInput`                                  | `{inputId: 'HDMI_2'}`                                                            |
| `ssap://tv/getCurrentChannel`                            | subscribe                                                                        |
| `ssap://tv/getChannelList` / `getChannelProgramInfo`     |                                                                                  |
| `ssap://tv/openChannel`                                  | `{channelId}` or `{channelNumber: '5'}`                                          |
| `ssap://tv/channelUp` / `channelDown`                    |                                                                                  |
| `ssap://com.webos.service.tv.display/set3DOn` / `set3DOff` |                                                                                |
| `ssap://webapp/closeWebApp`                              |                                                                                  |

Endpoints not listed here (picture settings, energy saving, …) are not exposed through the
SSAP permission set of this pairing manifest.

## License

MIT (c) [Sebastian Raff](https://github.com/hobbyquaker)

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
