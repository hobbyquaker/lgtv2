// Subscribe to volume/mute and foreground app changes, print them to the console.
// Usage: node examples/subscribe.js <tv-host>

import LGTV from '../index.js';

const lgtv = new LGTV({
    host: process.argv[2] || 'lgwebostv',
    // wss://host:3001 is tried first, ws://host:3000 (pre-2018 TVs) second - nothing to configure
});

lgtv.on('error', (err) => console.log('error', err.message));
lgtv.on('connecting', (url) => console.log('connecting', url));
lgtv.on('prompt', () => console.log('please accept the connection request on the TV'));
lgtv.on('close', () => console.log('close'));

lgtv.on('connect', async () => {
    console.log('connected');

    lgtv.subscribe('ssap://audio/getVolume', (err, res) => {
        if (err) {
            return console.log('volume error', err.message);
        }
        if (res.changed.includes('volume')) console.log('volume changed', res.volume);
        if (res.changed.includes('muted')) console.log('mute changed', res.muted);
    });

    lgtv.subscribe('ssap://com.webos.applicationManager/getForegroundAppInfo', (err, res) => {
        if (err) {
            return console.log('app error', err.message);
        }
        console.log('app', res.appId);
    });

    try {
        const info = await lgtv.request('ssap://system/getSystemInfo');
        console.log('system', info.modelName);
        console.log('power', (await lgtv.getPowerState()).state);
    } catch (err) {
        console.log('request failed', err.message);
    }
});

process.on('SIGINT', () => {
    lgtv.disconnect().then(() => process.exit(0));
});
