// Type-level test for index.d.ts - compiled with `tsc --noEmit`, never executed.
import LGTV = require('../index');

const tv = new LGTV({host: '192.168.1.20', verifyCert: 'lg', mac: 'aa:bb:cc:dd:ee:ff', reconnect: 5000});

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
    await tv.wake('aa:bb:cc:dd:ee:ff', {address: '192.168.1.255'});
    await tv.disconnect();
});

tv.on('error', (err: Error) => console.log(err.message));
tv.on('certificate', (info) => console.log(info.fingerprint, info.stored));
tv.on('connecting', (url: string) => console.log(url));

const urls: string[] = tv.urls;
const connected: boolean = tv.connected;
console.log(urls, connected, tv.keyFile, tv.certFile);

LGTV.wake('aa:bb:cc:dd:ee:ff').then(() => {});
const fps: string[] = LGTV.LG_ISSUER_FINGERPRINTS;
console.log(fps);

// @ts-expect-error - secure must be a boolean
new LGTV({secure: 'yes'});
