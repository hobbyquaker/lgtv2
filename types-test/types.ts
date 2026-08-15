// Type-level test for index.d.ts - compiled with `tsc --noEmit`, never executed.
import LGTV, {wake, LG_ISSUER_FINGERPRINTS} from '../index.js';

const tv = new LGTV({
    host: '192.168.1.20',
    verifyCert: 'lg',
    mac: 'aa:bb:cc:dd:ee:ff',
    reconnect: 5000,
    keepaliveInterval: 5000,
    wsOptions: {ca: 'pem'},
});

tv.on('connect', async () => {
    const vol = await tv.request<{volume: number}>('ssap://audio/getVolume');
    const n: number = vol.volume;
    tv.request('ssap://audio/setVolume', {volume: n}, (err, res) => {
        if (err) console.log(err.message);
        console.log(res);
    });
    const id = tv.subscribe('ssap://audio/getStatus', (err, res) => console.log(err, res));
    if (id) tv.unsubscribe(id);

    const power = await tv.getPowerState();
    const s: LGTV.PowerState = power.state;
    console.log(s);

    const sock = await tv.getSocket('ssap://com.webos.service.networkinput/getPointerInputSocket');
    sock.send('button', {name: 'HOME'});
    sock.close();

    await tv.wake();
    await tv.wake(['aa:bb:cc:dd:ee:ff', '11:22:33:44:55:66'], {address: '192.168.1.255'});
    await tv.disconnect();
});

tv.on('error', (err: Error) => console.log(err.message));
tv.on('certificate', (info) => console.log(info.fingerprint, info.stored));
tv.on('mac', (macs) => console.log(macs.wired, macs.wifi));
tv.on('message', (raw: string) => console.log(raw.length));
tv.on('close', (info) => console.log(info.code, info.reason));
tv.on('connecting', (url: string) => console.log(url));

const urls: string[] = tv.urls;
const connected: boolean = tv.connected;
console.log(urls, connected, tv.keyFile, tv.certFile, tv.macFile, tv.mac, tv.macs.wired);

LGTV.wake('aa:bb:cc:dd:ee:ff').then(() => {});
wake('aa:bb:cc:dd:ee:ff').then(() => {});
const fps: string[] = LGTV.LG_ISSUER_FINGERPRINTS;
const fps2: string[] = LG_ISSUER_FINGERPRINTS;
console.log(fps, fps2);

// @ts-expect-error - secure must be a boolean
new LGTV({secure: 'yes'});
