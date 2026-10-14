// Keep the client key yourself instead of in lgtv2's key file: here in a JSON file of your own,
// next to other settings. The same pattern works for an environment variable or a database.
// Usage: node examples/own-key-store.js <tv-host> [settings.json]

import fs from 'node:fs';
import LGTV from '../index.js';

const host = process.argv[2] || 'lgwebostv';
const file = process.argv[3] || 'settings.json';

const read = () => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
};

const lgtv = new LGTV({
    host,
    reconnect: false,
    // the stored key, if there is one; without it the TV shows the pairing prompt
    clientKey: read()[host],
    // called with a new key after the prompt was accepted; store it wherever you like
    saveKey: (key, cb) => {
        const settings = read();
        settings[host] = key;
        fs.writeFile(file, JSON.stringify(settings, null, 2), cb);
    },
});

lgtv.on('prompt', () => console.error('please accept the connection request on the TV'));
lgtv.on('error', (err) => {
    console.error('error:', err.message);
    process.exitCode = 1;
    lgtv.disconnect();
});

lgtv.on('connect', async () => {
    // clientKey is valid here, also right after a first pairing
    console.log('connected with key', lgtv.clientKey.slice(0, 4) + '…');
    const info = await lgtv.request('ssap://com.webos.service.update/getCurrentSWInformation');
    console.log('webOS', info.product_name, info.major_ver + '.' + info.minor_ver);
    await lgtv.disconnect();
});
