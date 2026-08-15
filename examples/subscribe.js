'use strict';

// Subscribe to volume/mute and foreground app changes, print them to the console.
// Usage: node examples/subscribe.js <tv-host>

const LGTV = require('../index.js');

const lgtv = new LGTV({
    host: process.argv[2] || 'lgwebostv',
    // secure: true (wss://host:3001) is the default; pre-2018 TVs need {secure: false}
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
    } catch (err) {
        console.log('getSystemInfo failed', err.message);
    }
});

process.on('SIGINT', () => {
    lgtv.disconnect().then(() => process.exit(0));
});
