'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');

const LGTV = require('../index.js');
const {createMockTv} = require('./mock-tv.js');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lgtv2-helpers-'));
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

function fingerprint(certPem) {
    const der = new crypto.X509Certificate(certPem).raw;
    return crypto
        .createHash('sha256')
        .update(der)
        .digest('hex')
        .toUpperCase()
        .replace(/(..)(?=.)/g, '$1:');
}

/** CA + leaf signed by it, like the TV's "LGE SSG Intermediate CA" -> "LGE TV SSG" chain */
function makeChain() {
    const dir = tmpDir();
    const o = (args) => execFileSync('openssl', args, {cwd: dir, stdio: ['ignore', 'pipe', 'pipe']});
    o([
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'ca.key',
        '-out',
        'ca.pem',
        '-days',
        '2',
        '-subj',
        '/CN=Test Intermediate CA',
    ]);
    o(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=Test TV']);
    o([
        'x509',
        '-req',
        '-in',
        'leaf.csr',
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        'leaf.pem',
        '-days',
        '2',
    ]);
    const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
    return {
        key: read('leaf.key'),
        cert: read('leaf.pem') + read('ca.pem'), // server sends leaf + intermediate, like the TV
        leafFp: fingerprint(read('leaf.pem')),
        caFp: fingerprint(read('ca.pem')),
    };
}

function tlsTv(chain, extra = {}) {
    return createMockTv(Object.assign({tls: {key: chain.key, cert: chain.cert}}, extra));
}

test('wake(): sends 3 magic packets for the MAC to the given address/port (static and instance)', async () => {
    const received = [];
    const sock = dgram.createSocket('udp4');
    await new Promise((r) => sock.bind(0, '127.0.0.1', r));
    sock.on('message', (msg) => received.push(msg));
    const {port} = sock.address();

    await LGTV.wake('aa:bb:cc:dd:ee:ff', {address: '127.0.0.1', port, interval: 5});
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 3);
    const pkt = received[0];
    assert.equal(pkt.length, 102);
    assert.deepEqual([...pkt.subarray(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    for (let i = 0; i < 16; i++) {
        assert.equal(pkt.subarray(6 + i * 6, 12 + i * 6).toString('hex'), 'aabbccddeeff');
    }

    const lgtv = new LGTV({host: '127.0.0.1', mac: 'AA-BB-CC-DD-EE-FF', reconnect: false, clientKey: 'x'});
    lgtv.disconnect();
    await lgtv.wake({address: '127.0.0.1', port, count: 1});
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 4);
    await new Promise((resolve, reject) =>
        lgtv.wake('AABBCCDDEEFF', {address: '127.0.0.1', port, count: 1}, (err) => (err ? reject(err) : resolve())),
    );

    await assert.rejects(LGTV.wake('not-a-mac'), /invalid MAC/);
    sock.close();
});

test('getPowerState()/subscribePowerState() map the TV states', async () => {
    const tv = await createMockTv({powerState: 'Active Standby'});
    const lgtv = new LGTV({url: tv.url, keyFile: path.join(tmpDir(), 'key'), reconnect: false});
    lgtv.on('error', () => {});
    await once(lgtv, 'connect');

    assert.deepEqual((await lgtv.getPowerState()).state, 'standby');
    tv.setPowerState('Active');
    const viaCb = await new Promise((resolve, reject) =>
        lgtv.getPowerState((err, res) => (err ? reject(err) : resolve(res))),
    );
    assert.equal(viaCb.state, 'on');
    assert.equal(viaCb.raw.state, 'Active');
    tv.setPowerState('Screen Off');
    assert.equal((await lgtv.getPowerState()).state, 'screen_off');
    tv.setPowerState('Screen Saver');
    assert.equal((await lgtv.getPowerState()).state, 'screen_saver');
    tv.setPowerState('Something New');
    assert.equal((await lgtv.getPowerState()).state, 'unknown');

    const updates = [];
    lgtv.subscribePowerState((err, res) => updates.push(res.state));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(updates, ['unknown']);

    await lgtv.disconnect();
    await tv.close();
});

test('LGTV2_KEY_DIR overrides the key directory', () => {
    const dir = tmpDir();
    const prev = process.env.LGTV2_KEY_DIR;
    process.env.LGTV2_KEY_DIR = dir;
    try {
        const lgtv = new LGTV({host: 'tv.lan', reconnect: false});
        lgtv.disconnect();
        assert.equal(lgtv.keyFile, path.join(dir, 'keyfile-tv.lan'));
        assert.equal(lgtv.certFile, path.join(dir, 'keyfile-tv.lan.cert'));
    } finally {
        if (prev === undefined) delete process.env.LGTV2_KEY_DIR;
        else process.env.LGTV2_KEY_DIR = prev;
    }
});

test('verifyCert: off by default - self-signed chain connects', async () => {
    const chain = makeChain();
    const tv = await tlsTv(chain);
    const lgtv = new LGTV({url: tv.url, keyFile: path.join(tmpDir(), 'key'), reconnect: false});
    lgtv.on('error', () => {});
    await once(lgtv, 'connect');
    assert.equal(lgtv.connected, true);
    await lgtv.disconnect();
    await tv.close();
});

test('verifyCert: pinned fingerprint of the issuer (like "lg" mode) accepts; wrong pin rejects with ECERT', async () => {
    const chain = makeChain();
    const tv = await tlsTv(chain);

    const ok = new LGTV({url: tv.url, keyFile: path.join(tmpDir(), 'key'), reconnect: false, verifyCert: chain.caFp});
    ok.on('error', () => {});
    await once(ok, 'connect');
    await ok.disconnect();

    const okLeaf = new LGTV({
        url: tv.url,
        keyFile: path.join(tmpDir(), 'key'),
        reconnect: false,
        verifyCert: ['sha256/' + chain.leafFp.toLowerCase()],
    });
    okLeaf.on('error', () => {});
    await once(okLeaf, 'connect');
    await okLeaf.disconnect();

    const bad = new LGTV({url: tv.url, keyFile: path.join(tmpDir(), 'key'), reconnect: false, verifyCert: 'lg'});
    let connected = false;
    bad.on('connect', () => {
        connected = true;
    });
    const [err] = await once(bad, 'error');
    assert.equal(err.code, 'ECERT');
    assert.match(err.message, /mode lg/);
    assert.ok(err.chain.includes(chain.leafFp));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(connected, false, 'must not register on an unverified connection');
    assert.equal(
        tv.received.filter((m) => m.type === 'register').length,
        2,
        'only the two accepted clients registered',
    );
    await bad.disconnect();
    await tv.close();
});

test('verifyCert: tofu stores the fingerprint on first contact and rejects a changed certificate', async () => {
    const chain1 = makeChain();
    const tv1 = await tlsTv(chain1);
    const keyFile = path.join(tmpDir(), 'key');

    const first = new LGTV({url: tv1.url, keyFile, reconnect: false, verifyCert: 'tofu'});
    first.on('error', () => {});
    const certEvent = once(first, 'certificate');
    await once(first, 'connect');
    const [info] = await certEvent;
    assert.equal(info.stored, true);
    assert.equal(info.fingerprint, chain1.leafFp);
    assert.equal(fs.readFileSync(keyFile + '.cert', 'utf8').trim(), chain1.leafFp);
    await first.disconnect();

    const again = new LGTV({url: tv1.url, keyFile, reconnect: false, verifyCert: 'tofu'});
    again.on('error', () => {});
    await once(again, 'connect');
    await again.disconnect();
    await tv1.close();

    // same "TV" (same key file), different certificate
    const chain2 = makeChain();
    const tv2 = await tlsTv(chain2);
    const changed = new LGTV({url: tv2.url, keyFile, reconnect: false, verifyCert: 'tofu'});
    const [err] = await once(changed, 'error');
    assert.equal(err.code, 'ECERT');
    assert.match(err.message, /fingerprint changed/);
    await changed.disconnect();
    await tv2.close();
});

test('verifyCert is ignored on plain ws:// connections', async () => {
    const tv = await createMockTv();
    const lgtv = new LGTV({url: tv.url, keyFile: path.join(tmpDir(), 'key'), reconnect: false, verifyCert: 'lg'});
    lgtv.on('error', () => {});
    await once(lgtv, 'connect');
    await lgtv.disconnect();
    await tv.close();
});
