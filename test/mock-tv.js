/**
 * Minimal in-process mock of a WebOS TV's SSAP websocket endpoint.
 * Just enough protocol to exercise lgtv2 without a real TV.
 */

import https from 'node:https';
import {WebSocketServer} from 'ws';

export const CLIENT_KEY = 'mock-client-key-0123456789abcdef';

export function createMockTv(options = {}) {
    const opts = Object.assign(
        {
            acceptKeys: [CLIENT_KEY],
            // 'accept' | 'prompt-then-accept' | 'reject' | 'silent'
            pairing: 'prompt-then-accept',
            volumeShape: 'old', // 'old' (volume/muted/changed) | 'new' (volumeStatus)
        },
        options,
    );

    // opts.tls = {key, cert} → serve wss:// via an https server
    let httpsServer = null;
    let wss;
    if (opts.tls) {
        httpsServer = https.createServer(opts.tls);
        wss = new WebSocketServer({server: httpsServer});
        httpsServer.listen(opts.port || 0, '127.0.0.1');
    } else {
        wss = new WebSocketServer({host: '127.0.0.1', port: opts.port || 0});
    }
    let powerState = opts.powerState || 'Active';
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
            // real webOS 6 payload: no `subscribed` field even on subscription responses
            return {
                returnValue: true,
                callerId: 'secondscreen.client',
                volumeStatus: {volume, muteStatus: muted, soundOutput: 'tv_speaker', maxVolume: 100},
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
                case 'ssap://com.webos.service.connectionmanager/getinfo':
                    send(ws, {
                        id,
                        type: 'response',
                        payload: {
                            returnValue: true,
                            subscribed: false,
                            wiredInfo: {macAddress: opts.wiredMac || '74:E6:B8:44:0A:7E'},
                            wifiInfo: {macAddress: opts.wifiMac || '20:28:BC:1B:5F:46'},
                            p2pInfo: {macAddress: '22:28:BC:1B:5F:46'},
                        },
                    });
                    break;
                case 'ssap://com.webos.service.tvpower/power/getPowerState':
                    send(ws, {
                        id,
                        type: 'response',
                        payload: {
                            returnValue: true,
                            subscribed: type === 'subscribe',
                            state: powerState,
                            processing: '',
                        },
                    });
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
        (httpsServer || wss).on('listening', () => {
            const {port} = (httpsServer || wss).address();
            resolve({
                port,
                url: (httpsServer ? 'wss' : 'ws') + '://127.0.0.1:' + port,
                received,
                setPowerState(state) {
                    powerState = state;
                },
                get connections() {
                    return sockets.size;
                },
                dropAll() {
                    for (const ws of sockets) {
                        ws.terminate();
                    }
                },
                /** stop reading from the TCP sockets: the "TV" goes silent without closing (no pongs) */
                pauseAll() {
                    for (const ws of sockets) {
                        ws._socket.pause();
                    }
                },
                close() {
                    return new Promise((res) => {
                        for (const ws of sockets) {
                            ws.terminate();
                        }
                        wss.close(() => (httpsServer ? httpsServer.close(() => res()) : res()));
                    });
                },
            });
        });
    });
}
