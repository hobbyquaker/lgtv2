'use strict';

/**
 * Minimal in-process mock of a WebOS TV's SSAP websocket endpoint.
 * Just enough protocol to exercise lgtv2 without a real TV.
 */

const {WebSocketServer} = require('ws');

const CLIENT_KEY = 'mock-client-key-0123456789abcdef';

function createMockTv(options = {}) {
    const opts = Object.assign(
        {
            acceptKeys: [CLIENT_KEY],
            // 'accept' | 'prompt-then-accept' | 'reject' | 'silent'
            pairing: 'prompt-then-accept',
            volumeShape: 'old', // 'old' (volume/muted/changed) | 'new' (volumeStatus)
        },
        options,
    );

    const wss = new WebSocketServer({host: '127.0.0.1', port: opts.port || 0});
    const sockets = new Set();
    const received = [];
    const subscriptions = new Map(); // socket -> Set(cid)
    let volume = 7;
    let muted = false;

    function send(ws, obj) {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    function volumePayload(subscribed) {
        if (opts.volumeShape === 'new') {
            return {
                returnValue: true,
                subscribed,
                volumeStatus: {volume, muteStatus: muted, soundOutput: 'tv_speaker'},
            };
        }
        return {returnValue: true, subscribed, volume, muted, changed: []};
    }

    wss.on('connection', (ws) => {
        sockets.add(ws);
        subscriptions.set(ws, new Set());
        ws.on('close', () => {
            sockets.delete(ws);
            subscriptions.delete(ws);
        });
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            received.push(msg);
            const {id, type, uri, payload} = msg;

            if (type === 'register') {
                const key = payload && payload['client-key'];
                if (opts.pairing === 'silent') {
                    return;
                }
                if (key && opts.acceptKeys.includes(key)) {
                    send(ws, {id, type: 'registered', payload: {'client-key': key}});
                    return;
                }
                if (opts.pairing === 'reject') {
                    send(ws, {id, type: 'error', error: '403 cancelled'});
                    return;
                }
                if (opts.pairing === 'accept') {
                    send(ws, {id, type: 'registered', payload: {'client-key': CLIENT_KEY}});
                    return;
                }
                // prompt-then-accept
                send(ws, {id, type: 'response', payload: {pairingType: 'PROMPT', returnValue: true}});
                setTimeout(() => send(ws, {id, type: 'registered', payload: {'client-key': CLIENT_KEY}}), 20);
                return;
            }

            if (type === 'unsubscribe') {
                subscriptions.get(ws).delete(id);
                return;
            }

            if (type !== 'request' && type !== 'subscribe') {
                return;
            }

            switch (uri) {
                case 'ssap://audio/getVolume':
                    if (type === 'subscribe') {
                        subscriptions.get(ws).add(id);
                    }
                    send(ws, {id, type: 'response', payload: volumePayload(type === 'subscribe')});
                    break;
                case 'ssap://audio/setVolume':
                    volume = payload.volume;
                    send(ws, {id, type: 'response', payload: {returnValue: true}});
                    for (const [sock, cids] of subscriptions) {
                        for (const cid of cids) {
                            send(sock, {id: cid, type: 'response', payload: volumePayload(true)});
                        }
                    }
                    break;
                case 'ssap://system/turnOff':
                    send(ws, {id, type: 'response', payload: {returnValue: true}});
                    break;
                case 'ssap://test/returnValueFalse':
                    send(ws, {
                        id,
                        type: 'response',
                        payload: {returnValue: false, errorCode: -101, errorText: 'Invalid app id'},
                    });
                    break;
                case 'ssap://test/never':
                    break;
                default:
                    send(ws, {id, type: 'error', error: '404 no such service or method', payload: {}});
            }
        });
    });

    return new Promise((resolve) => {
        wss.on('listening', () => {
            const {port} = wss.address();
            resolve({
                port,
                url: 'ws://127.0.0.1:' + port,
                received,
                get connections() {
                    return sockets.size;
                },
                dropAll() {
                    for (const ws of sockets) {
                        ws.terminate();
                    }
                },
                close() {
                    return new Promise((res) => {
                        for (const ws of sockets) {
                            ws.terminate();
                        }
                        wss.close(() => res());
                    });
                },
            });
        });
    });
}

module.exports = {createMockTv, CLIENT_KEY};
