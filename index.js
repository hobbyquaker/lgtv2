/**
 *      Lgtv2 - Simple Node.js module to remote control LG WebOS smart TVs
 *
 *      MIT (c) Sebastian Raff <hq@ccu.io> (https://github.com/hobbyquaker)
 *      this is a fork of https://github.com/msloth/lgtv.js, heavily modified and rewritten to suite my needs.
 *
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const WebSocketClient = require('websocket').client;

const pairingTemplate = require('./pairing.json');

const DEFAULT_WSCONFIG = {
    keepalive: true,
    keepaliveInterval: 10000,
    dropConnectionOnKeepaliveTimeout: true,
    keepaliveGracePeriod: 5000,
};

const PORT_SECURE = 3001;
const PORT_INSECURE = 3000;

/**
 * Directory for the client key files. Same locations persist-path used
 * (Windows: %APPDATA%/lgtv2, macOS: ~/Library/Preferences/lgtv2, else ~/.lgtv2),
 * but does not throw when HOME/APPDATA are missing (systemd units without User=).
 */
function defaultKeyDir() {
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

    const userWsconfig = Object.assign({}, config.wsconfig);
    const tlsOptions = Object.assign({rejectUnauthorized: config.rejectUnauthorized}, userWsconfig.tlsOptions);
    delete userWsconfig.tlsOptions;
    const wsconfig = Object.assign({}, DEFAULT_WSCONFIG, userWsconfig);
    // the websocket module mutates the config object it is given, hand out copies
    const mainWsconfig = () => Object.assign({}, wsconfig, {tlsOptions: Object.assign({}, tlsOptions)});
    const socketWsconfig = () => ({tlsOptions: Object.assign({}, tlsOptions)});
    this.wsconfig = config.wsconfig = mainWsconfig();

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

    const client = new WebSocketClient(mainWsconfig());
    let connection = {};
    let isPaired = false;
    let autoReconnect = config.reconnect;
    let stopped = false;
    let handshakeTimer = null;
    let handshakeTimedOut = false;
    let reconnectTimer = null;

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

    function clearHandshakeTimer() {
        if (handshakeTimer) {
            clearTimeout(handshakeTimer);
            handshakeTimer = null;
        }
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

    client.on('connectFailed', (error) => {
        clearHandshakeTimer();
        if (handshakeTimedOut) {
            handshakeTimedOut = false;
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
    });

    client.on('connect', (conn) => {
        clearHandshakeTimer();
        lastError = undefined;
        cycleTried = 0;
        cycleErrors = [];
        connection = conn;

        connection.on('error', (error) => {
            that.emit('error', error);
        });

        connection.on('close', (e) => {
            connection = {};
            failPendingRequests('connection closed');
            that.emit('close', e);
            that.connection = false;
            scheduleReconnect();
        });

        connection.on('message', (message) => {
            that.emit('message', message);
            let parsedMessage;
            if (message.type === 'utf8') {
                if (message.utf8Data) {
                    try {
                        parsedMessage = JSON.parse(message.utf8Data);
                    } catch {
                        that.emit('error', new Error('JSON parse error ' + message.utf8Data));
                    }
                }
                if (parsedMessage && callbacks[parsedMessage.id]) {
                    const cid = parsedMessage.id;
                    const entry = callbacks[cid];
                    const err = responseToError(parsedMessage);
                    let payload = parsedMessage.payload;
                    if (entry.type === 'subscribe' && payload && payload.subscribed) {
                        volumeState[cid] = volumeState[cid] || {};
                        payload = normalizeVolumePayload(payload, volumeState[cid]);
                    }
                    entry.cb(err, payload);
                }
            } else {
                that.emit('error', new Error('received non utf8 message ' + message.toString()));
            }
        });

        isPaired = false;

        that.connection = false;

        that.register();
    });

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
        if (connection.connected) {
            connection.send(JSON.stringify({id: cid, type: 'unsubscribe'}));
        }
        return true;
    };

    this.send = function (type, uri, /* optional */ payload, /* optional */ cb) {
        if (typeof payload === 'function') {
            cb = payload;
            payload = {};
        }

        if (!connection.connected) {
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
            const special = new WebSocketClient(socketWsconfig());
            special
                .on('connect', (conn) => {
                    conn.on('error', (error) => {
                        that.emit('error', error);
                    }).on('close', () => {
                        delete specializedSockets[url];
                    });

                    specializedSockets[url] = new SpecializedSocket(conn);
                    done = true;
                    cb(null, specializedSockets[url]);
                })
                .on('connectFailed', (error) => {
                    if (!done) {
                        done = true;
                        cb(error);
                    } else {
                        that.emit('error', error);
                    }
                });

            special.connect(data.socketPath);
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

        if (connection.connected && !isPaired) {
            that.register();
        } else if (!connection.connected) {
            that.emit('connecting', host);
            connection = {};
            handshakeTimedOut = false;
            clearHandshakeTimer();
            if (config.handshakeTimeout) {
                handshakeTimer = setTimeout(() => {
                    handshakeTimer = null;
                    handshakeTimedOut = true;
                    client.abort();
                }, config.handshakeTimeout);
                handshakeTimer.unref();
            }
            client.connect(host);
        }
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
        clearHandshakeTimer();
        client.abort();

        Object.keys(specializedSockets).forEach((k) => {
            specializedSockets[k].close();
        });

        const promise = new Promise((resolve) => {
            if (connection && connection.connected) {
                connection.once('close', () => resolve());
                connection.close();
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

    Object.defineProperty(this, 'connected', {
        enumerable: true,
        get() {
            return Boolean(connection.connected && isPaired);
        },
    });

    let initialTimer = setTimeout(() => {
        initialTimer = null;
        that.connect(config.url);
    }, 0);
};

Object.setPrototypeOf(LGTV.prototype, EventEmitter.prototype);

module.exports = LGTV;
