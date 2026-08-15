import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createRequire} from 'node:module';

import LGTV from '../index.js';
import {createMockTv, CLIENT_KEY} from './mock-tv.js';

function tmpKeyFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtv2-test-'));
    return path.join(dir, 'sub', 'keyfile');
}

function once(emitter, event, ms = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), ms);
        emitter.once(event, (...args) => {
            clearTimeout(timer);
            resolve(args);
        });
    });
}

function connectedTv(tv, extra = {}) {
    const lgtv = new LGTV(Object.assign({url: tv.url, keyFile: tmpKeyFile(), reconnect: false}, extra));
    lgtv.on('error', () => {});
    return once(lgtv, 'connect').then(() => lgtv);
}

test('require() still returns the constructor (CommonJS consumers)', () => {
    const require = createRequire(import.meta.url);
    const Required = require('../index.js');
    assert.equal(Required, LGTV);
    const lgtv = Required({host: 'tv.lan', reconnect: false, clientKey: 'x'}); // without new, as in 1.x
    assert.ok(lgtv instanceof LGTV);
    lgtv.disconnect();
});

test('pairs via prompt, saves the key (creating the directory) and emits connect', async () => {
    const tv = await createMockTv();
    const keyFile = tmpKeyFile();
    const lgtv = new LGTV({url: tv.url, keyFile, reconnect: false});
    lgtv.on('error', () => {});
    const events = [];
    lgtv.on('prompt', () => events.push('prompt'));
    lgtv.on('connect', () => events.push('connect'));
    await once(lgtv, 'connect');
    assert.deepEqual(events, ['prompt', 'connect']);
    assert.equal(lgtv.connected, true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.readFileSync(keyFile, 'utf8'), CLIENT_KEY);
    await lgtv.disconnect();
    await tv.close();
});

test('reuses a stored key without prompting', async () => {
    const tv = await createMockTv({pairing: 'reject'}); // would reject any prompt
    const keyFile = tmpKeyFile();
    fs.mkdirSync(path.dirname(keyFile), {recursive: true});
    fs.writeFileSync(keyFile, CLIENT_KEY);
    const lgtv = new LGTV({url: tv.url, keyFile, reconnect: false});
    let prompted = false;
    lgtv.on('prompt', () => {
        prompted = true;
    });
    lgtv.on('error', () => {});
    await once(lgtv, 'connect');
    assert.equal(prompted, false);
    const registerMsg = tv.received.find((m) => m.type === 'register');
    assert.equal(registerMsg.payload['client-key'], CLIENT_KEY);
    await lgtv.disconnect();
    await tv.close();
});

test('pairing rejection emits error, not prompt', async () => {
    const tv = await createMockTv({pairing: 'reject'});
    const lgtv = new LGTV({url: tv.url, keyFile: tmpKeyFile(), reconnect: false});
    let prompted = false;
    lgtv.on('prompt', () => {
        prompted = true;
    });
    const [err] = await once(lgtv, 'error');
    assert.match(err.message, /403 cancelled/);
    assert.equal(prompted, false);
    await lgtv.disconnect();
    await tv.close();
});

test('request: callback and promise forms; message event carries the raw frame', async () => {
    const tv = await createMockTv();
    const lgtv = await connectedTv(tv);
    const frames = [];
    lgtv.on('message', (raw) => frames.push(raw));
    const viaPromise = await lgtv.request('ssap://audio/getVolume');
    assert.equal(viaPromise.volume, 7);
    assert.equal(typeof frames[0], 'string');
    assert.equal(JSON.parse(frames[0]).type, 'response');
    const viaCb = await new Promise((resolve, reject) =>
        lgtv.request('ssap://audio/getVolume', (err, res) => (err ? reject(err) : resolve(res))),
    );
    assert.equal(viaCb.volume, 7);
    await lgtv.request('ssap://audio/setVolume', {volume: 12});
    assert.equal((await lgtv.request('ssap://audio/getVolume')).volume, 12);
    await lgtv.disconnect();
    await tv.close();
});

test('SSAP error responses and returnValue:false surface as errors', async () => {
    const tv = await createMockTv();
    const lgtv = await connectedTv(tv);
    await assert.rejects(lgtv.request('ssap://does/notExist'), /404 no such service or method/);
    await assert.rejects(lgtv.request('ssap://test/returnValueFalse'), (err) => {
        assert.equal(err.errorCode, -101);
        assert.equal(err.errorText, 'Invalid app id');
        assert.equal(err.code, 'ESSAP');
        return true;
    });
    await lgtv.disconnect();
    await tv.close();
});

test('request times out and not-connected is reported', async () => {
    const tv = await createMockTv();
    const lgtv = await connectedTv(tv, {timeout: 100});
    await assert.rejects(lgtv.request('ssap://test/never'), /timeout/);
    await lgtv.disconnect();
    await assert.rejects(lgtv.request('ssap://audio/getVolume'), /not connected/);
    await tv.close();
});

test('pending requests fail immediately when the connection drops', async () => {
    const tv = await createMockTv();
    const lgtv = await connectedTv(tv, {timeout: 5000});
    const pending = lgtv.request('ssap://test/never');
    const started = Date.now();
    tv.dropAll();
    await assert.rejects(pending, /connection closed/);
    assert.ok(Date.now() - started < 2000, 'failed fast, not via the 5s timeout');
    await lgtv.disconnect();
    await tv.close();
});

for (const shape of ['old', 'new']) {
    test(`subscribe getVolume with ${shape} payload shape yields volume/muted/changed; unsubscribe stops updates`, async () => {
        const tv = await createMockTv({volumeShape: shape});
        const lgtv = await connectedTv(tv);
        const updates = [];
        const cid = lgtv.subscribe('ssap://audio/getVolume', (err, res) => {
            assert.equal(err, null);
            updates.push(res);
        });
        assert.equal(typeof cid, 'string');
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(updates.length, 1);
        assert.equal(updates[0].volume, 7);
        assert.equal(updates[0].muted, false);
        assert.ok(updates[0].changed.includes('volume'));
        assert.ok(updates[0].changed.includes('muted'));

        await lgtv.request('ssap://audio/setVolume', {volume: 9});
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(updates.length, 2);
        assert.equal(updates[1].volume, 9);
        assert.deepEqual(updates[1].changed, ['volume']);

        assert.equal(lgtv.unsubscribe(cid), true);
        assert.equal(lgtv.unsubscribe(cid), false);
        await lgtv.request('ssap://audio/setVolume', {volume: 3});
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(updates.length, 2, 'no update after unsubscribe');
        assert.ok(tv.received.some((m) => m.type === 'unsubscribe' && m.id === cid));
        await lgtv.disconnect();
        await tv.close();
    });
}

test('reconnects after the TV drops the connection', async () => {
    const tv = await createMockTv();
    const lgtv = new LGTV({url: tv.url, keyFile: tmpKeyFile(), reconnect: 50});
    lgtv.on('error', () => {});
    await once(lgtv, 'connect');
    const closed = once(lgtv, 'close');
    tv.dropAll();
    const [info] = await closed;
    assert.equal(typeof info.code, 'number');
    assert.equal(lgtv.connected, false);
    await once(lgtv, 'connect');
    assert.equal(lgtv.connected, true);
    await lgtv.disconnect();
    assert.equal(lgtv.connected, false);
    await tv.close();
});

test('keepalive: a TV that stops answering pings is dropped and reconnected', async () => {
    const tv = await createMockTv();
    const lgtv = new LGTV({
        url: tv.url,
        keyFile: tmpKeyFile(),
        reconnect: 50,
        keepaliveInterval: 60,
        keepaliveGracePeriod: 60,
    });
    lgtv.on('error', () => {});
    await once(lgtv, 'connect');
    // the "TV" goes silent without closing: ws would answer pings automatically, so stop it reading
    const closed = once(lgtv, 'close', 5000);
    const started = Date.now();
    tv.pauseAll();
    await closed;
    assert.ok(Date.now() - started < 2000, 'dropped by the keepalive, not by a timeout');
    tv.dropAll(); // release the paused server side so the reconnect gets a fresh socket
    await once(lgtv, 'connect');
    await lgtv.disconnect();
    await tv.close();
});

test('connection refused on ws:// hints at wss', async () => {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const {port} = srv.address();
    await new Promise((r) => srv.close(r));
    const lgtv = new LGTV({url: 'ws://127.0.0.1:' + port, keyFile: tmpKeyFile(), reconnect: false});
    const [err] = await once(lgtv, 'error');
    assert.match(err.message, /ECONNREFUSED/);
    assert.match(err.message, /secure: true/);
    await lgtv.disconnect();
});

test('handshake timeout when the server never answers the upgrade', async () => {
    // a TCP server that accepts and then stays silent
    const sockets = [];
    const srv = net.createServer((s) => sockets.push(s));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const {port} = srv.address();
    const lgtv = new LGTV({
        url: 'ws://127.0.0.1:' + port,
        keyFile: tmpKeyFile(),
        reconnect: false,
        handshakeTimeout: 150,
    });
    const [err] = await once(lgtv, 'error');
    assert.equal(err.code, 'ETIMEDOUT');
    assert.match(err.message, /handshake timeout/);
    await lgtv.disconnect();
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => srv.close(r));
});

// a port that nothing listens on (connection refused)
async function closedPort() {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const {port} = srv.address();
    await new Promise((r) => srv.close(r));
    return port;
}

test('falls back from wss:3001 to ws:3000 automatically and keeps the working port', async () => {
    const tv = await createMockTv();
    const securePort = await closedPort();
    const ports = {secure: securePort, insecure: tv.port};
    const lgtv = new LGTV({host: '127.0.0.1', ports, keyFile: tmpKeyFile(), reconnect: 50, handshakeTimeout: 500});
    const wss = 'wss://127.0.0.1:' + securePort;
    const ws = 'ws://127.0.0.1:' + tv.port;
    assert.deepEqual(lgtv.urls, [wss, ws]);
    const errors = [];
    lgtv.on('error', (err) => errors.push(err));
    const attempts = [];
    lgtv.on('connecting', (url) => attempts.push(url));
    await once(lgtv, 'connect');
    assert.deepEqual(attempts, [wss, ws]);
    assert.equal(errors.length, 0, 'no error reported while the fallback succeeds');

    // after a drop it reconnects to the port that worked, not to wss first
    const closed = once(lgtv, 'close');
    tv.dropAll();
    await closed;
    await once(lgtv, 'connect');
    assert.deepEqual(attempts, [wss, ws, ws]);
    await lgtv.disconnect();
    await tv.close();
});

test('reports one combined error when all ports fail', async () => {
    const ports = {secure: await closedPort(), insecure: await closedPort()};
    const lgtv = new LGTV({host: '127.0.0.1', ports, keyFile: tmpKeyFile(), reconnect: false});
    const [err] = await once(lgtv, 'error');
    assert.equal(err.code, 'ECONNFAILED');
    assert.match(err.message, new RegExp('wss://127\\.0\\.0\\.1:' + ports.secure));
    assert.match(err.message, new RegExp('ws://127\\.0\\.0\\.1:' + ports.insecure));
    await lgtv.disconnect();
});

test('default ports are 3001 (wss) and 3000 (ws)', () => {
    const a = new LGTV({host: 'tv.lan', reconnect: false, clientKey: 'x'});
    assert.deepEqual(a.urls, ['wss://tv.lan:3001', 'ws://tv.lan:3000']);
    a.disconnect();
});

test('no fallback when url, secure or port are given explicitly', () => {
    const a = new LGTV({url: 'ws://127.0.0.1:9', reconnect: false, clientKey: 'x'});
    assert.deepEqual(a.urls, ['ws://127.0.0.1:9']);
    a.disconnect();
    const b = new LGTV({host: '127.0.0.1', secure: false, reconnect: false, clientKey: 'x'});
    assert.deepEqual(b.urls, ['ws://127.0.0.1:3000']);
    b.disconnect();
    const c = new LGTV({host: '127.0.0.1', port: 4711, reconnect: false, clientKey: 'x'});
    assert.deepEqual(c.urls, ['wss://127.0.0.1:4711']);
    c.disconnect();
});

test('option handling: url building, ws options, keepalive, tls defaults, key file name', () => {
    const a = new LGTV({host: '192.168.1.20', reconnect: false, clientKey: 'x', handshakeTimeout: 0});
    assert.equal(a.wsOptions.rejectUnauthorized, false);
    assert.equal(a.keepalive.keepalive, true);
    assert.equal(a.keepalive.keepaliveInterval, 10000);
    a.disconnect();

    // 1.x style wsconfig with tlsOptions is still understood
    const b = new LGTV({
        host: 'fe80::1',
        secure: false,
        reconnect: false,
        clientKey: 'x',
        wsconfig: {keepaliveInterval: 1234, tlsOptions: {rejectUnauthorized: true}},
    });
    assert.equal(b.keepalive.keepaliveInterval, 1234);
    assert.equal(b.keepalive.keepalive, true, 'defaults survive a partial config');
    assert.equal(b.wsOptions.rejectUnauthorized, true);
    b.disconnect();

    // 2.x style
    const b2 = new LGTV({host: 'tv', reconnect: false, clientKey: 'x', keepalive: false, wsOptions: {ca: 'x'}});
    assert.equal(b2.keepalive.keepalive, false);
    assert.equal(b2.wsOptions.ca, 'x');
    b2.disconnect();

    const c = new LGTV({url: 'wss://[fe80::1]:3001', reconnect: false, handshakeTimeout: 0});
    assert.match(path.basename(c.keyFile), /^keyfile-fe80__1$/);
    c.disconnect();

    const d = new LGTV({url: 'ws://my-tv.lan:3000', reconnect: false, handshakeTimeout: 0});
    assert.equal(path.basename(d.keyFile), 'keyfile-my-tv.lan');
    d.disconnect();
});
