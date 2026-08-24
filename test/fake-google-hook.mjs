// Preloaded into the server under test (`node --import`) so every HTTPS call it makes to Google lands on
// the local fake at FAKE_GOOGLE_URL instead. Patched at `https.request`, which is the one layer every
// client in the stack goes through: googleapis talks to gaxios, gaxios to node-fetch, node-fetch to this.
//
// Test-only. The server itself is untouched, which is the point: the envelope has to come out of the
// code that ships, through the real googleapis client, off a real socket.

import https from 'node:https';
import http from 'node:http';

const target = process.env.FAKE_GOOGLE_URL;
const realRequest = https.request;

if (target) {
    const fake = new URL(target);
    https.request = function request(options, ...rest) {
        const host = typeof options === 'string' || options instanceof URL
            ? new URL(String(options)).hostname
            : options?.hostname || options?.host;
        if (!/\.googleapis\.com$/.test(String(host || ''))) {
            return realRequest.call(this, options, ...rest);
        }
        const original = typeof options === 'string' || options instanceof URL ? { path: new URL(String(options)).pathname } : options;
        return http.request({
            ...original,
            protocol: 'http:',
            hostname: fake.hostname,
            host: undefined,
            port: fake.port,
            agent: undefined,
        }, ...rest);
    };
}
