/**
 *      Lgtv2 - Simple Node.js module to remote control LG WebOS smart TVs
 *
 *      MIT (c) Sebastian Raff <hq@ccu.io> (https://github.com/hobbyquaker)
 *      this is a fork of https://github.com/msloth/lgtv.js, heavily modified and rewritten to suite my needs.
 *
 */

import fs from 'node:fs';
import os from 'node:os';
import dgram from 'node:dgram';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import WebSocket from 'ws';

const pairingTemplate = createRequire(import.meta.url)('./pairing.json');

const DEFAULT_KEEPALIVE = {
    keepalive: true,
    keepaliveInterval: 10000,
    keepaliveGracePeriod: 5000,
};

const PORT_SECURE = 3001;
const PORT_INSECURE = 3000;

/**
 * SHA-256 fingerprints of the certificates LG webOS TVs present on port 3001, used by
 * `verifyCert: 'lg'` (a chain matching any of them is accepted):
 *  - leaf "LGE TV SSG" (serial 0x2001) - one static certificate and key on every TV
 *    (seen on 2018-2023 models, EU/US/JP, firmware up to late 2025),
 *  - its issuer "LGE SSG Intermediate CA" (serial 0x1007, issued by "LG webOS TV Root CA").
 * Both valid 2018-03-12 .. 2034-08-15.
 */
const LG_ISSUER_FINGERPRINTS = [
    // LGE SSG Intermediate CA
    'E2:BD:64:64:D3:F5:1C:1B:95:B7:69:7D:9D:67:73:C3:3D:94:12:EB:A0:29:9C:56:8C:34:93:7D:3F:E6:8A:A0',
    // LGE TV SSG (leaf)
    '11:C5:B1:C5:90:77:50:AB:B9:DA:2A:66:65:CC:CE:2B:B2:88:A5:83:F4:5A:33:39:E7:1F:87:BF:2F:80:85:52',
];

const POWER_STATES = {
    Active: 'on',
    'Active Standby': 'standby',
    Suspend: 'off',
    'Screen Off': 'screen_off',
    'Screen Saver': 'screen_saver',
    'Power Off': 'off',
};

function normalizeFingerprint(fp) {
    return String(fp)
        .replace(/^sha256\//i, '')
        .replace(/[^0-9a-f]/gi, '')
        .toUpperCase()
        .replace(/(..)(?=.)/g, '$1:');
}

/** all certificates the peer presented: leaf first, then issuers */
function peerChain(tlsSocket) {
    const chain = [];
    let cert = tlsSocket.getPeerCertificate(true);
    const seen = new Set();
    while (cert && cert.fingerprint256 && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256);
        chain.push(cert);
        cert = cert.issuerCertificate;
    }
    return chain;
}

function magicPacket(mac) {
    const hex = String(mac).replace(/[^0-9a-f]/gi, '');
    if (hex.length !== 12) {
        throw new Error('invalid MAC address ' + mac);
    }
    const macBuf = Buffer.from(hex, 'hex');
    const buf = Buffer.alloc(6 + 16 * 6, 0xff);
    for (let i = 0; i < 16; i++) {
        macBuf.copy(buf, 6 + i * 6);
    }
    return buf;
}

/**
 * Send a Wake-on-LAN magic packet. Usable without an instance: LGTV.wake(mac).
 * options: address (default '255.255.255.255'), port (default 9), count (default 3), interval ms (default 100)
 */
function wake(mac, options, cb) {
    if (typeof options === 'function') {
        cb = options;
        options = {};
    }
    if (Array.isArray(mac)) {
        // several candidate MACs (e.g. wired + wifi): wake all of them
        const macs = [
            ...new Set(
                mac.map((m) =>
                    String(m)
                        .replace(/[^0-9a-f]/gi, '')
                        .toLowerCase(),
                ),
            ),
        ];
        const all = macs.length
            ? Promise.all(macs.map((m) => wake(m, options))).then(() => undefined)
            : Promise.reject(new Error('no MAC address known - pass one or connect to the TV once'));
        if (typeof cb === 'function') {
            all.then(() => cb(null), cb);
            return undefined;
        }
        return all;
    }
    const opts = Object.assign({address: '255.255.255.255', port: 9, count: 3, interval: 100}, options);
    const promise = new Promise((resolve, reject) => {
        let packet;
        try {
            packet = magicPacket(mac);
        } catch (err) {
            reject(err);
            return;
        }
        const socket = dgram.createSocket(opts.address.includes(':') ? 'udp6' : 'udp4');
        let sent = 0;
        const finish = (err) => {
            socket.close();
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        };
        socket.once('error', finish);
        socket.bind(() => {
            try {
                socket.setBroadcast(true);
            } catch {
                // unicast address or platform without broadcast support
            }
            const sendOne = () => {
                socket.send(packet, 0, packet.length, opts.port, opts.address, (err) => {
                    if (err) {
                        finish(err);
                        return;
                    }
                    sent++;
                    if (sent >= opts.count) {
                        finish();
                    } else {
                        setTimeout(sendOne, opts.interval);
                    }
                });
            };
            sendOne();
        });
    });
    if (typeof cb === 'function') {
        promise.then(() => cb(null), cb);
        return undefined;
    }
    return promise;
}

/**
 * Directory for the client key files. Same locations persist-path used
 * (Windows: %APPDATA%/lgtv2, macOS: ~/Library/Preferences/lgtv2, else ~/.lgtv2),
 * but does not throw when HOME/APPDATA are missing (systemd units without User=).
 */
function defaultKeyDir() {
    if (process.env.LGTV2_KEY_DIR) {
        return process.env.LGTV2_KEY_DIR;
    }
    if (process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'lgtv2');
    }
    let home = process.env.HOME;
    if (!home) {
        try {
            home = os.homedir();
        } catch {
            home = undefined;
        }
    }
    if (!home) {
        return path.join(os.tmpdir(), 'lgtv2');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library/Preferences', 'lgtv2');
    }
    return path.join(home, '.lgtv2');
}

function hostnameFromUrl(url) {
    try {
        const hostname = new URL(url).hostname;
        // IPv6 literals come with brackets and colons, neither is nice in a file name
        return hostname.replace(/^\[|]$/g, '').replace(/[^\w.-]/g, '_');
    } catch {
        return String(url).replace(/[^\w.-]/g, '_');
    }
}

function buildUrl(config) {
    if (config.url) {
        return config.url;
    }
    const secure = config.secure !== false;
    const ports = Object.assign({secure: PORT_SECURE, insecure: PORT_INSECURE}, config.ports);
    const port = config.port || (secure ? ports.secure : ports.insecure);
    let host = config.host || 'lgwebostv';
    if (host.includes(':') && !host.startsWith('[')) {
        host = '[' + host + ']';
    }
    return (secure ? 'wss' : 'ws') + '://' + host + ':' + port;
}

/**
 * Maps an SSAP response to (err, payload). Error responses (`type: 'error'`)
 * and `returnValue: false` payloads become Errors carrying the TV's details.
 */
function responseToError(message) {
    const payload = message.payload || {};
    if (message.type === 'error') {
        const err = new Error(message.error || 'unknown error');
        err.code = 'ESSAP';
        err.payload = payload;
        return err;
    }
    if (payload.returnValue === false) {
        const err = new Error(payload.errorText || payload.errorCode || 'request failed');
        err.code = 'ESSAP';
        err.errorCode = payload.errorCode;
        err.errorText = payload.errorText;
        err.payload = payload;
        return err;
    }
    return null;
}

/**
 * Older firmware answers audio/getVolume with {volume, muted, changed: [...]}, newer
 * firmware with {volumeStatus: {volume, muteStatus, ...}} and no `changed` array.
 * Normalize to the old shape so subscribers can keep using `res.changed`.
 */
function normalizeVolumePayload(payload, state) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    const status = payload.volumeStatus;
    if (status && typeof status === 'object') {
        if (typeof payload.volume === 'undefined' && typeof status.volume !== 'undefined') {
            payload.volume = status.volume;
        }
        if (typeof payload.muted === 'undefined' && typeof status.muteStatus !== 'undefined') {
            payload.muted = status.muteStatus;
        }
        if (typeof payload.soundOutput === 'undefined' && typeof status.soundOutput !== 'undefined') {
            payload.soundOutput = status.soundOutput;
        }
    }
    const hasVolume = typeof payload.volume !== 'undefined';
    const hasMuted = typeof payload.muted !== 'undefined';
    if (!hasVolume && !hasMuted) {
        return payload;
    }
    if (!Array.isArray(payload.changed)) {
        payload.changed = [];
    }
    if (hasVolume && payload.volume !== state.volume && !payload.changed.includes('volume')) {
        payload.changed.push('volume');
    }
    if (hasMuted && payload.muted !== state.muted && !payload.changed.includes('muted')) {
        payload.changed.push('muted');
    }
    state.volume = payload.volume;
    state.muted = payload.muted;
    return payload;
}

/** Socket for pointer/button/keyboard input (getPointerInputSocket etc.) */
class SpecializedSocket {
    constructor(ws) {
        this.ws = ws;
    }

    send(type, payload) {
        payload = payload || {};
        // The message should be key:value pairs, one per line,
        // with an extra blank line to terminate.
        const message =
            Object.keys(payload)
                .reduce((acc, k) => acc.concat([k + ':' + payload[k]]), ['type:' + type])
                .join('\n') + '\n\n';
        this.ws.send(message);
    }

    close() {
        this.ws.close();
    }
}

const LGTV = function (config) {
    if (!(this instanceof LGTV)) {
        return new LGTV(config);
    }
    EventEmitter.call(this);
    const that = this;

    config = Object.assign({}, config);

    // Without an explicit url/secure/port, try wss://host:3001 (2018+ firmware) first and
    // fall back to ws://host:3000 (older TVs) automatically; the working one is kept.
    const autoPort = !config.url && typeof config.secure === 'undefined' && !config.port;
    const candidates = autoPort
        ? [buildUrl(Object.assign({}, config, {secure: true})), buildUrl(Object.assign({}, config, {secure: false}))]
        : [buildUrl(config)];
    let candidateIndex = 0;
    let cycleTried = 0;
    let cycleErrors = [];
    config.url = candidates[0];
    config.secure = config.url.startsWith('wss://');
    this.urls = candidates.slice();

    config.timeout = config.timeout || 15000;
    config.reconnect = typeof config.reconnect === 'undefined' ? 5000 : config.reconnect;
    config.handshakeTimeout = typeof config.handshakeTimeout === 'undefined' ? 10000 : config.handshakeTimeout;
    if (typeof config.rejectUnauthorized === 'undefined') {
        config.rejectUnauthorized = false;
    }

    // websocket options: keepalive settings are ours, everything else goes to `ws`
    // (`wsconfig` and `wsconfig.tlsOptions` from 1.x are still accepted)
    const legacy = Object.assign({}, config.wsconfig);
    const legacyTls = Object.assign({}, legacy.tlsOptions);
    delete legacy.tlsOptions;
    delete legacy.dropConnectionOnKeepaliveTimeout;
    const keepalive = Object.assign({}, DEFAULT_KEEPALIVE);
    for (const key of Object.keys(DEFAULT_KEEPALIVE)) {
        if (typeof legacy[key] !== 'undefined') {
            keepalive[key] = legacy[key];
            delete legacy[key];
        }
        if (typeof config[key] !== 'undefined') {
            keepalive[key] = config[key];
        }
    }
    const wsOptions = Object.assign(
        {rejectUnauthorized: config.rejectUnauthorized},
        legacy,
        legacyTls,
        config.wsOptions,
    );
    const mainWsOptions = () =>
        Object.assign({}, wsOptions, config.handshakeTimeout ? {handshakeTimeout: config.handshakeTimeout} : {});
    const socketWsOptions = () => Object.assign({}, wsOptions);
    this.wsOptions = wsOptions;
    this.keepalive = keepalive;

    if (typeof config.clientKey === 'undefined') {
        if (!config.keyFile) {
            config.keyFile = path.join(defaultKeyDir(), 'keyfile-' + hostnameFromUrl(config.url));
        }
        try {
            that.clientKey = fs.readFileSync(config.keyFile).toString();
        } catch {
            // no key yet, pairing prompt will follow
        }
    } else {
        that.clientKey = config.clientKey;
    }
    this.keyFile = config.keyFile;
    if (!config.certFile) {
        config.certFile = config.keyFile
            ? config.keyFile + '.cert'
            : path.join(defaultKeyDir(), 'certfile-' + hostnameFromUrl(config.url));
    }
    this.certFile = config.certFile;

    // MAC addresses learned from the TV (com.webos.service.connectionmanager/getinfo) for wake()
    config.learnMac = config.learnMac !== false;
    if (!config.macFile) {
        config.macFile = config.keyFile
            ? config.keyFile + '.mac'
            : path.join(defaultKeyDir(), 'macfile-' + hostnameFromUrl(config.url));
    }
    this.macFile = config.macFile;
    let macs = {};
    try {
        macs = JSON.parse(fs.readFileSync(config.macFile, 'utf8')) || {};
    } catch {
        // nothing learned yet
    }
    const macCandidates = () => (config.mac ? [config.mac] : [macs.wired, macs.wifi].filter(Boolean));
    Object.defineProperty(this, 'macs', {
        enumerable: true,
        get() {
            return Object.assign({}, macs);
        },
    });
    Object.defineProperty(this, 'mac', {
        enumerable: true,
        get() {
            return macCandidates()[0];
        },
    });

    function learnMacs() {
        that.request('ssap://com.webos.service.connectionmanager/getinfo', (err, res) => {
            if (err || !res) {
                return;
            }
            const learned = {
                wired: res.wiredInfo && res.wiredInfo.macAddress,
                wifi: res.wifiInfo && res.wifiInfo.macAddress,
            };
            if (!learned.wired && !learned.wifi) {
                return;
            }
            const changed = learned.wired !== macs.wired || learned.wifi !== macs.wifi;
            macs = learned;
            if (changed) {
                try {
                    fs.mkdirSync(path.dirname(config.macFile), {recursive: true});
                    fs.writeFileSync(config.macFile, JSON.stringify(macs) + '\n');
                } catch (err) {
                    that.emit('error', err);
                }
            }
            that.emit('mac', Object.assign({}, macs));
        });
    }

    that.saveKey =
        config.saveKey ||
        function (key, cb) {
            that.clientKey = key;
            try {
                fs.mkdirSync(path.dirname(config.keyFile), {recursive: true});
            } catch (err) {
                cb(err);
                return;
            }
            fs.writeFile(config.keyFile, key, cb);
        };

    let ws = null; // current ws instance (connecting or open)
    let connection = null; // open + usable ws
    let isPaired = false;
    let autoReconnect = config.reconnect;
    let stopped = false;
    let reconnectTimer = null;
    let keepaliveTimer = null;
    let keepaliveGraceTimer = null;

    const specializedSockets = {};

    const callbacks = {};
    const timers = {};
    const volumeState = {};
    let cidCount = 0;
    const cidPrefix = ('0000000' + Math.floor(Math.random() * 0xffffffff).toString(16)).slice(-8);

    function getCid() {
        return cidPrefix + ('000' + (cidCount++).toString(16)).slice(-4);
    }

    let lastError;

    function emitError(error) {
        if (lastError !== error.toString()) {
            that.emit('error', error);
        }
        lastError = error.toString();
    }

    function scheduleReconnect() {
        if (!config.reconnect || reconnectTimer) {
            return;
        }
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (autoReconnect) {
                that.connect(config.url);
            }
        }, config.reconnect);
    }

    function stopKeepalive() {
        if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
        }
        if (keepaliveGraceTimer) {
            clearTimeout(keepaliveGraceTimer);
            keepaliveGraceTimer = null;
        }
    }

    function startKeepalive(socket) {
        stopKeepalive();
        if (!keepalive.keepalive) {
            return;
        }
        socket.on('pong', () => {
            if (keepaliveGraceTimer) {
                clearTimeout(keepaliveGraceTimer);
                keepaliveGraceTimer = null;
            }
        });
        keepaliveTimer = setInterval(() => {
            if (socket.readyState !== WebSocket.OPEN) {
                return;
            }
            socket.ping();
            if (!keepaliveGraceTimer) {
                keepaliveGraceTimer = setTimeout(() => {
                    keepaliveGraceTimer = null;
                    // no pong in time: the TV went away without closing (standby)
                    socket.terminate();
                }, keepalive.keepaliveGracePeriod);
                keepaliveGraceTimer.unref();
            }
        }, keepalive.keepaliveInterval);
        keepaliveTimer.unref();
    }

    function failPendingRequests(reason) {
        Object.keys(callbacks).forEach((cid) => {
            const entry = callbacks[cid];
            delete callbacks[cid];
            if (timers[cid]) {
                clearTimeout(timers[cid]);
                delete timers[cid];
            }
            if (entry.type === 'request') {
                entry.cb(new Error(reason));
            }
        });
    }

    /**
     * verifyCert: false (default) | 'lg' | 'tofu' | fingerprint | [fingerprints]
     * Returns an Error when the peer certificate chain is not acceptable.
     */
    function verifyPeer(tlsSocket) {
        if (!config.verifyCert || !config.secure || !tlsSocket || !tlsSocket.getPeerCertificate) {
            return null;
        }
        const chain = peerChain(tlsSocket);
        if (chain.length === 0) {
            return new Error('certificate verification failed: no peer certificate');
        }
        const fps = chain.map((c) => normalizeFingerprint(c.fingerprint256));
        const describe = () => chain.map((c) => (c.subject && c.subject.CN) + ' ' + c.fingerprint256).join(' <- ');

        let expected;
        if (config.verifyCert === 'lg') {
            expected = LG_ISSUER_FINGERPRINTS;
        } else if (config.verifyCert === 'tofu') {
            let stored;
            try {
                stored = fs.readFileSync(config.certFile, 'utf8').trim();
            } catch {
                stored = undefined;
            }
            if (!stored) {
                try {
                    fs.mkdirSync(path.dirname(config.certFile), {recursive: true});
                    fs.writeFileSync(config.certFile, fps[0] + '\n');
                } catch (err) {
                    return new Error('cannot store certificate fingerprint in ' + config.certFile + ': ' + err.message);
                }
                that.emit('certificate', {fingerprint: fps[0], stored: true});
                return null;
            }
            expected = [stored];
        } else {
            expected = [].concat(config.verifyCert);
        }
        expected = expected.map(normalizeFingerprint);
        if (fps.some((fp) => expected.includes(fp))) {
            return null;
        }
        const err = new Error(
            'certificate verification failed (' +
                (config.verifyCert === 'tofu'
                    ? 'fingerprint changed, delete ' + config.certFile + ' to re-trust'
                    : 'mode ' + config.verifyCert) +
                '): ' +
                describe(),
        );
        err.code = 'ECERT';
        err.chain = fps;
        return err;
    }

    /** a connection attempt failed before the socket was open (refused, timeout, TLS, cert) */
    function connectFailed(error) {
        if (error && /handshake has timed out/i.test(error.message)) {
            error = new Error('handshake timeout after ' + config.handshakeTimeout + 'ms (' + config.url + ')');
            error.code = 'ETIMEDOUT';
        } else if (error && error.code === 'ECONNREFUSED' && !config.secure && !autoPort) {
            error.message += ' - newer TVs only accept wss://<host>:3001, try {secure: true}';
        }
        if (candidates.length > 1) {
            cycleErrors.push(config.url + ': ' + error.message);
            cycleTried++;
            candidateIndex = (candidateIndex + 1) % candidates.length;
            config.url = candidates[candidateIndex];
            config.secure = config.url.startsWith('wss://');
            if (cycleTried < candidates.length) {
                // try the other port right away, without reporting an error yet
                setImmediate(() => {
                    if (!stopped) {
                        that.connect(config.url);
                    }
                });
                return;
            }
            error = new Error('connect failed on all ports (' + cycleErrors.join('; ') + ')');
            error.code = 'ECONNFAILED';
            cycleTried = 0;
            cycleErrors = [];
        }
        emitError(error);
        scheduleReconnect();
    }

    function handleMessage(data) {
        const text = typeof data === 'string' ? data : data.toString();
        that.emit('message', text);
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(text);
        } catch {
            that.emit('error', new Error('JSON parse error ' + text));
            return;
        }
        if (parsedMessage && callbacks[parsedMessage.id]) {
            const cid = parsedMessage.id;
            const entry = callbacks[cid];
            const err = responseToError(parsedMessage);
            let payload = parsedMessage.payload;
            // some firmware omits `subscribed` on the first response, normalize every subscription payload
            if (entry.type === 'subscribe' && payload && typeof payload === 'object') {
                volumeState[cid] = volumeState[cid] || {};
                payload = normalizeVolumePayload(payload, volumeState[cid]);
            }
            entry.cb(err, payload);
        }
    }

    function openConnection(socket) {
        connection = socket;
        lastError = undefined;
        cycleTried = 0;
        cycleErrors = [];
        isPaired = false;
        that.connection = false;
        startKeepalive(socket);
        socket.on('message', handleMessage);
        that.register();
    }

    this.register = function () {
        const pairing = Object.assign({}, pairingTemplate);
        if (that.clientKey) {
            pairing['client-key'] = that.clientKey;
        }

        that.send('register', undefined, pairing, (err, res) => {
            if (err) {
                // e.g. "403 cancelled" when the user declines on the TV
                that.emit('error', err);
                return;
            }
            if (res && typeof res['client-key'] === 'string' && res['client-key'] !== '') {
                isPaired = true;
                that.connection = true;
                that.emit('connect');
                if (config.learnMac) {
                    learnMacs();
                }
                if (res['client-key'] !== that.clientKey) {
                    that.saveKey(res['client-key'], (err) => {
                        if (err) {
                            that.emit('error', err);
                        }
                    });
                }
            } else {
                that.emit('prompt');
            }
        });
    };

    this.request = function (uri, payload, cb) {
        if (typeof payload === 'function') {
            cb = payload;
            payload = {};
        }
        if (typeof cb === 'function') {
            return this.send('request', uri, payload, cb);
        }
        return new Promise((resolve, reject) => {
            this.send('request', uri, payload, (err, res) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(res);
                }
            });
        });
    };

    this.subscribe = function (uri, payload, cb) {
        return this.send('subscribe', uri, payload, cb);
    };

    this.unsubscribe = function (cid) {
        if (!callbacks[cid]) {
            return false;
        }
        delete callbacks[cid];
        delete volumeState[cid];
        if (connection && connection.readyState === WebSocket.OPEN) {
            connection.send(JSON.stringify({id: cid, type: 'unsubscribe'}));
        }
        return true;
    };

    this.send = function (type, uri, /* optional */ payload, /* optional */ cb) {
        if (typeof payload === 'function') {
            cb = payload;
            payload = {};
        }

        if (!connection || connection.readyState !== WebSocket.OPEN) {
            if (typeof cb === 'function') {
                cb(new Error('not connected'));
            }
            return undefined;
        }

        const cid = getCid();

        const json = JSON.stringify({
            id: cid,
            type,
            uri,
            payload,
        });

        if (typeof cb === 'function') {
            switch (type) {
                case 'request':
                    callbacks[cid] = {
                        type,
                        cb(err, res) {
                            // Remove callback reference
                            delete callbacks[cid];
                            if (timers[cid]) {
                                clearTimeout(timers[cid]);
                                delete timers[cid];
                            }
                            cb(err, res);
                        },
                    };

                    // Set callback timeout
                    timers[cid] = setTimeout(() => {
                        delete timers[cid];
                        if (callbacks[cid]) {
                            delete callbacks[cid];
                            cb(new Error('timeout'));
                        }
                    }, config.timeout);
                    timers[cid].unref();
                    break;

                case 'subscribe':
                case 'register':
                    callbacks[cid] = {type, cb};
                    break;
                default:
                    throw new Error('unknown type');
            }
        }
        connection.send(json);
        return cid;
    };

    this.getSocket = function (url, cb) {
        if (typeof cb !== 'function') {
            return new Promise((resolve, reject) => {
                this.getSocket(url, (err, sock) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(sock);
                    }
                });
            });
        }

        if (specializedSockets[url]) {
            cb(null, specializedSockets[url]);
            return undefined;
        }

        that.request(url, (err, data) => {
            if (err) {
                cb(err);
                return;
            }
            if (!data || !data.socketPath) {
                cb(new Error('no socketPath in response'));
                return;
            }

            let done = false;
            const special = new WebSocket(data.socketPath, socketWsOptions());
            special.on('open', () => {
                specializedSockets[url] = new SpecializedSocket(special);
                done = true;
                cb(null, specializedSockets[url]);
            });
            special.on('error', (error) => {
                if (!done) {
                    done = true;
                    cb(error);
                } else {
                    that.emit('error', error);
                }
            });
            special.on('close', () => {
                delete specializedSockets[url];
            });
        });
        return undefined;
    };

    /**
     *      Connect to TV using a websocket url (eg "wss://192.168.0.100:3001")
     *
     */
    this.connect = function (host) {
        autoReconnect = config.reconnect;
        stopped = false;
        host = host || config.url;

        if (connection && connection.readyState === WebSocket.OPEN) {
            if (!isPaired) {
                that.register();
            }
            return;
        }
        if (ws && ws.readyState === WebSocket.CONNECTING) {
            return;
        }

        that.emit('connecting', host);
        let opened = false;
        let rejected = false;
        let lastSocketError = null;
        const socket = new WebSocket(host, mainWsOptions());
        ws = socket;

        socket.on('upgrade', (response) => {
            const certError = verifyPeer(response.socket);
            if (certError) {
                rejected = true;
                socket.terminate();
                emitError(certError);
                scheduleReconnect();
            }
        });
        socket.on('open', () => {
            if (rejected) {
                return;
            }
            opened = true;
            openConnection(socket);
        });
        socket.on('error', (error) => {
            if (!opened) {
                lastSocketError = error;
            } else {
                that.emit('error', error);
            }
        });
        socket.on('close', (code, reason) => {
            if (ws === socket) {
                ws = null;
            }
            if (rejected) {
                return;
            }
            if (!opened) {
                connectFailed(lastSocketError || new Error('connection closed during handshake (' + code + ')'));
                return;
            }
            stopKeepalive();
            connection = null;
            failPendingRequests('connection closed');
            that.emit('close', {code, reason: reason ? reason.toString() : ''});
            that.connection = false;
            scheduleReconnect();
        });
    };

    this.disconnect = function (cb) {
        autoReconnect = false;
        stopped = true;
        if (initialTimer) {
            clearTimeout(initialTimer);
            initialTimer = null;
        }
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        stopKeepalive();

        Object.keys(specializedSockets).forEach((k) => {
            specializedSockets[k].close();
        });

        const promise = new Promise((resolve) => {
            const socket = ws;
            if (socket && socket.readyState === WebSocket.CONNECTING) {
                socket.once('close', () => resolve());
                socket.terminate();
            } else if (socket && socket.readyState === WebSocket.OPEN) {
                socket.once('close', () => resolve());
                socket.close();
            } else {
                resolve();
            }
        });
        if (typeof cb === 'function') {
            promise.then(() => cb());
            return undefined;
        }
        return promise;
    };

    /**
     * Wake the TV via Wake-on-LAN. mac defaults to config.mac, else to the MACs learned from the TV.
     */
    this.wake = function (mac, options, cb) {
        if (typeof mac === 'function' || (mac && typeof mac === 'object' && !Array.isArray(mac))) {
            cb = options;
            options = mac;
            mac = undefined;
        }
        return wake(mac || macCandidates(), options, cb);
    };

    /**
     * Power state via com.webos.service.tvpower/power/getPowerState, mapped to
     * {state: 'on' | 'standby' | 'screen_off' | 'screen_saver' | 'off' | 'unknown', raw}.
     * Note: a TV in deep standby does not answer at all - use `connected` and wake().
     */
    this.getPowerState = function (cb) {
        const map = (res) => ({
            state: POWER_STATES[res && res.state] || 'unknown',
            raw: res,
        });
        if (typeof cb === 'function') {
            this.request('ssap://com.webos.service.tvpower/power/getPowerState', (err, res) => {
                cb(err, err ? undefined : map(res));
            });
            return undefined;
        }
        return this.request('ssap://com.webos.service.tvpower/power/getPowerState').then(map);
    };

    this.subscribePowerState = function (cb) {
        return this.subscribe('ssap://com.webos.service.tvpower/power/getPowerState', (err, res) => {
            cb(err, err ? undefined : {state: POWER_STATES[res && res.state] || 'unknown', raw: res});
        });
    };

    Object.defineProperty(this, 'connected', {
        enumerable: true,
        get() {
            return Boolean(connection && connection.readyState === WebSocket.OPEN && isPaired);
        },
    });

    let initialTimer = setTimeout(() => {
        initialTimer = null;
        that.connect(config.url);
    }, 0);
};

Object.setPrototypeOf(LGTV.prototype, EventEmitter.prototype);

LGTV.wake = wake;
LGTV.LG_ISSUER_FINGERPRINTS = LG_ISSUER_FINGERPRINTS.slice();
LGTV.POWER_STATES = Object.assign({}, POWER_STATES);

export default LGTV;
// `require('lgtv2')` keeps returning the constructor itself (node >= 20.19 / 22.12 require(esm))
export {LGTV, wake, LG_ISSUER_FINGERPRINTS, POWER_STATES, LGTV as 'module.exports'};
