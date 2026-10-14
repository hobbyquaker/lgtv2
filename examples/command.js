// Send one command to the TV, print the answer, exit.
// Usage: node examples/command.js <tv-host> <ssap uri> [json payload]
//   node examples/command.js lgwebostv ssap://audio/getVolume
//   node examples/command.js lgwebostv ssap://audio/setVolume '{"volume": 10}'
//   node examples/command.js lgwebostv ssap://system.notifications/createToast '{"message": "Hello"}'
//
// The first run shows the pairing prompt on the TV; accept it. The key is stored in the key file
// (~/.lgtv2/keyfile-<host> on Linux, see the README), so every later run connects without asking.

import LGTV from '../index.js';

const [host, uri, json] = process.argv.slice(2);
if (!host || !uri) {
    console.error('usage: node examples/command.js <tv-host> <ssap uri> [json payload]');
    process.exit(2);
}
const payload = json ? JSON.parse(json) : undefined;

const lgtv = new LGTV({host, reconnect: false});

lgtv.on('prompt', () => console.error('please accept the connection request on the TV'));
lgtv.on('key', () => console.error('paired; the key is stored in', lgtv.keyFile));
lgtv.on('error', (err) => {
    console.error('error:', err.message);
    process.exitCode = 1;
    lgtv.disconnect();
});

lgtv.on('connect', async () => {
    try {
        const res = await lgtv.request(uri, payload);
        console.log(JSON.stringify(res, null, 2));
    } catch (err) {
        console.error('error:', err.message);
        process.exitCode = 1;
    }
    await lgtv.disconnect();
});
