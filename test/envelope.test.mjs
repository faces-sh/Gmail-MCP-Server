// The failure envelope, checked against the server that ships (docs/MCP_FAILURE_ENVELOPE.md).
//
// Every HTTP case here runs the REAL server process, with the REAL googleapis client, against a local
// fake Google that answers the way Google answers. Nothing is stubbed inside the server, so a change to
// the client library that breaks the status or the body breaks these tests rather than passing quietly.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'dist', 'index.js');
const HOOK = path.join(HERE, 'fake-google-hook.mjs');

// A refresh token and a client secret that must never appear in anything the server emits.
const FAKE_REFRESH_TOKEN = '1//0gFAKEREFRESHTOKENvalue0123456789abcdef';
const FAKE_ACCESS_TOKEN = 'ya29.FAKEACCESSTOKENvalue0123456789abcdef';
const FAKE_CLIENT_SECRET = 'GOCSPX-fakeclientsecret0123456789';

// Google's real wording, byte for byte, because the point of the envelope is that this survives.
const BODY_401 = JSON.stringify({
    error: {
        code: 401,
        message: 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.',
        errors: [{ message: 'Invalid Credentials', domain: 'global', reason: 'authError', location: 'Authorization', locationType: 'header' }],
        status: 'UNAUTHENTICATED',
    },
});
const BODY_403 = JSON.stringify({
    error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }],
        status: 'PERMISSION_DENIED',
    },
});
const BODY_INVALID_GRANT = JSON.stringify({
    error: 'invalid_grant',
    error_description: 'Token has been expired or revoked.',
});

/** A stand-in for Google. `plan` decides what the next request gets. */
let fake;
let fakeUrl;
let plan = { status: 200, body: '{}' };
const seen = [];

before(async () => {
    fake = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push({ url: req.url, headers: req.headers, body });
            const answer = typeof plan === 'function' ? plan(req, body) : plan;
            res.writeHead(answer.status, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(answer.body);
        });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    fakeUrl = `http://127.0.0.1:${fake.address().port}`;
});

after(() => fake.close());

/** Config files for a server that believes it is signed in. */
function credentialsDir({ expired = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-test-'));
    fs.writeFileSync(path.join(dir, 'gcp-oauth.keys.json'), JSON.stringify({
        installed: { client_id: '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com', client_secret: FAKE_CLIENT_SECRET },
    }));
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
        access_token: FAKE_ACCESS_TOKEN,
        refresh_token: FAKE_REFRESH_TOKEN,
        scope: 'https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
        expiry_date: expired ? Date.now() - 60_000 : Date.now() + 3_600_000,
    }));
    return dir;
}

/** One tool call against a freshly spawned server. Returns the MCP result and everything it printed. */
function callTool(name, args, { dir, redirect = true } = {}) {
    return new Promise((resolve, reject) => {
        const execArgv = redirect ? ['--import', HOOK] : [];
        const child = spawn(process.execPath, [...execArgv, SERVER], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                FAKE_GOOGLE_URL: fakeUrl,
                GMAIL_OAUTH_PATH: path.join(dir, 'gcp-oauth.keys.json'),
                GMAIL_CREDENTIALS_PATH: path.join(dir, 'credentials.json'),
                MAESTRO_CIRCUIT_URL: '',
                MAESTRO_CIRCUIT_SECRET: '',
                MAESTRO_SESSION_ID: '',
            },
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out; stderr: ${stderr}`)); }, 20_000);
        child.stderr.on('data', (d) => { stderr += d; });
        child.stdout.on('data', (d) => {
            stdout += d;
            let i;
            while ((i = stdout.indexOf('\n')) >= 0) {
                const line = stdout.slice(0, i).trim();
                stdout = stdout.slice(i + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.id === 2) {
                    clearTimeout(timer);
                    child.kill();
                    resolve({ response: msg, stderr });
                }
            }
        });
        child.on('error', reject);
        const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
        send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'envelope-test', version: '1.0.0' } } });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    });
}

function envelopeOf(response) {
    assert.ok(response.result, `expected a result, got ${JSON.stringify(response)}`);
    assert.equal(response.result.isError, true, 'rule 1: isError must be true');
    const text = response.result.content[0].text;
    const [first, ...rest] = text.split('\n');
    return { text, first, status: rest[0], body: rest.slice(1).join('\n') };
}

test('401: the status line is literal and Google\'s body arrives verbatim', async () => {
    plan = { status: 401, body: BODY_401 };
    const dir = credentialsDir();
    const { response } = await callTool('read_email', { messageId: '18f2a3b4c5d6e7f8' }, { dir });
    const env = envelopeOf(response);

    assert.equal(env.first, '[http_401] Could not read the email.');
    assert.equal(env.status, 'HTTP 401 Unauthorized');
    assert.equal(env.body, BODY_401);
});

test('403: the body separates a missing scope from a missing share, so it is not summarised', async () => {
    plan = { status: 403, body: BODY_403 };
    const dir = credentialsDir();
    const { response } = await callTool('send_email', {
        to: ['alex.roe@example.com'], subject: 'Hello', body: 'Hello there',
    }, { dir });
    const env = envelopeOf(response);

    assert.equal(env.first, '[http_403] Could not send the email.');
    assert.equal(env.status, 'HTTP 403 Forbidden');
    assert.equal(env.body, BODY_403);
    assert.match(env.body, /PERMISSION_DENIED/);
    assert.match(env.body, /insufficientPermissions/);
});

test('an expired credential arrives as invalid_grant, not as advice', async () => {
    plan = { status: 400, body: BODY_INVALID_GRANT };
    const dir = credentialsDir({ expired: true });
    const { response, stderr } = await callTool('search_emails', { query: 'is:unread' }, { dir });
    const env = envelopeOf(response);

    assert.equal(env.first, '[http_400] Could not search the mailbox.');
    assert.equal(env.status, 'HTTP 400 Bad Request');
    assert.equal(env.body, BODY_INVALID_GRANT);
    // Rule 7: the server says what happened and never what to do about it.
    assert.doesNotMatch(env.text, /reconnect|sign in again|try again|please/i);
    // Rule 8: the refresh token and the client secret were in the request that failed.
    assert.doesNotMatch(env.text, /0gFAKEREFRESHTOKEN|GOCSPX-|ya29\./);
    assert.doesNotMatch(stderr, /0gFAKEREFRESHTOKEN|GOCSPX-/);
});

test('no credentials: no status line is invented, and the missing file is named', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-test-'));
    fs.writeFileSync(path.join(dir, 'gcp-oauth.keys.json'), JSON.stringify({
        installed: { client_id: 'x.apps.googleusercontent.com', client_secret: FAKE_CLIENT_SECRET },
    }));
    const { response } = await callTool('list_email_labels', {}, { dir });
    const env = envelopeOf(response);

    assert.match(env.first, /^\[no_credentials\] Could not reach Gmail: there is no saved Gmail sign-in at /);
    assert.match(env.first, /credentials\.json\.$/);
    assert.doesNotMatch(env.text, /^HTTP /m, 'rule 4: no status line for a failure that was not HTTP');
});

test('a bad argument is a bad_request, not a stack trace', async () => {
    const dir = credentialsDir();
    const { response } = await callTool('send_email', { subject: 'no recipients' }, { dir });
    const env = envelopeOf(response);

    assert.match(env.first, /^\[bad_request\] Could not send the email\./);
    assert.match(env.text, /"path"/, 'the validator\'s own account of what was wrong is the evidence');
});

test('a 429 keeps its status and its body', async () => {
    const quota = JSON.stringify({ error: { code: 429, message: 'User-rate limit exceeded.', status: 'RESOURCE_EXHAUSTED' } });
    plan = { status: 429, body: quota };
    const dir = credentialsDir();
    const { response } = await callTool('list_email_labels', {}, { dir });
    const env = envelopeOf(response);

    assert.equal(env.first, '[http_429] Could not list the labels.');
    assert.equal(env.status, 'HTTP 429 Too Many Requests');
    assert.equal(env.body, quota);
});

test('a batch where every message failed is a failure, not a report of one', async () => {
    plan = { status: 403, body: BODY_403 };
    const dir = credentialsDir();
    const { response } = await callTool('batch_delete_emails', { messageIds: ['aaa', 'bbb'] }, { dir });
    const env = envelopeOf(response);

    assert.equal(env.first, '[http_403] Could not delete any of the 2 emails.');
    assert.equal(env.status, 'HTTP 403 Forbidden');
    assert.equal(env.body, BODY_403);
});

test('the label layer no longer flattens Google\'s answer into a sentence of its own', async () => {
    const conflict = JSON.stringify({
        error: { code: 409, message: 'Label name exists or conflicts', errors: [{ message: 'Label name exists or conflicts', domain: 'global', reason: 'duplicate' }], status: 'ALREADY_EXISTS' },
    });
    plan = { status: 409, body: conflict };
    const dir = credentialsDir();
    const { response } = await callTool('create_label', { name: 'Receipts' }, { dir });
    const env = envelopeOf(response);

    assert.equal(env.first, '[http_409] Could not create the label "Receipts".');
    assert.equal(env.status, 'HTTP 409 Conflict');
    assert.equal(env.body, conflict);
    // Rule 7: it used to answer "Please use a different name". That is the caller's call to make.
    assert.doesNotMatch(env.text, /please use a different name/i);
});

test('a tool that does not exist fails as a tool call', async () => {
    const dir = credentialsDir();
    const { response } = await callTool('teleport_email', {}, { dir });
    const env = envelopeOf(response);
    assert.match(env.first, /^\[unknown_tool\] Could not run "teleport_email"/);
});

test('a body over 4000 characters is truncated, and says so', async () => {
    plan = { status: 500, body: JSON.stringify({ error: { code: 500, message: 'x'.repeat(6000) } }) };
    const dir = credentialsDir();
    const { response } = await callTool('read_email', { messageId: 'abc' }, { dir });
    const env = envelopeOf(response);

    assert.equal(env.status, 'HTTP 500 Internal Server Error');
    assert.ok(env.body.endsWith(' ...[truncated]'), 'a capped body says it was capped');
    assert.equal(env.body.length, 4000 + ' ...[truncated]'.length);
});

test('redaction strips every credential shape out of an echoed body', async () => {
    const { redact } = await import('../dist/failureEnvelope.js');

    assert.equal(redact('Authorization: Bearer ya29.abcdef'), 'Authorization: <redacted>');
    assert.equal(redact('set-cookie: SID=zzz; Secure'), 'set-cookie: <redacted>');
    assert.equal(redact('{"refresh_token":"1//0gabcdefghijklmnopqrst"}'), '{"refresh_token":"<redacted>"}');
    assert.equal(redact('{"access_token":"ya29.abc","expires_in":3599}'), '{"access_token":"<redacted>","expires_in":3599}');
    assert.equal(
        redact('refresh_token=1//0gabc&client_id=12345678-abc.apps.googleusercontent.com&client_secret=GOCSPX-zzz&grant_type=refresh_token'),
        'refresh_token=<redacted>&client_id=<redacted>&client_secret=<redacted>&grant_type=refresh_token');
    assert.equal(redact('token ya29.SOMETHINGLONGHERE00'), 'token <redacted>');
    // What must survive: Google's account of what went wrong.
    assert.equal(redact(BODY_INVALID_GRANT), BODY_INVALID_GRANT);
    assert.equal(redact(BODY_403), BODY_403);
});

test('the circuit never parks a failure envelope behind a handle', async () => {
    const calls = [];
    const broker = http.createServer((req, res) => {
        calls.push(req.url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ slug: '@@h9@@' }));
    });
    await new Promise((r) => broker.listen(0, '127.0.0.1', r));
    process.env.MAESTRO_CIRCUIT_URL = `http://127.0.0.1:${broker.address().port}`;
    process.env.MAESTRO_CIRCUIT_SECRET = 'secret';
    process.env.MAESTRO_SESSION_ID = 'session';
    try {
        const { wrapResult } = await import('../dist/circuitBuffer.js');
        const failure = { content: [{ type: 'text', text: `[http_403] Could not send the email.\nHTTP 403 Forbidden\n${'x'.repeat(500)}` }], isError: true };
        assert.equal(await wrapResult(failure), failure, 'a failure result is returned untouched');
        assert.deepEqual(calls, [], 'and never reaches the buffer');

        const success = { content: [{ type: 'text', text: 'y'.repeat(500) }] };
        const wrapped = await wrapResult(success);
        assert.match(wrapped.content[0].text, /^\[circuit @@h9@@/);
    } finally {
        broker.close();
        delete process.env.MAESTRO_CIRCUIT_URL;
        delete process.env.MAESTRO_CIRCUIT_SECRET;
        delete process.env.MAESTRO_SESSION_ID;
    }
});

test('a circuit buffer that answers 500 fails loudly instead of expanding to nothing', async () => {
    const broker = http.createServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('circuit buffer exploded');
    });
    await new Promise((r) => broker.listen(0, '127.0.0.1', r));
    process.env.MAESTRO_CIRCUIT_URL = `http://127.0.0.1:${broker.address().port}`;
    process.env.MAESTRO_CIRCUIT_SECRET = 'secret';
    process.env.MAESTRO_SESSION_ID = 'session';
    try {
        const { resolveArgs } = await import('../dist/circuitBuffer.js');
        await assert.rejects(
            () => resolveArgs({ body: 'here it is: @@h3@@' }),
            (error) => {
                assert.equal(error.code, 'circuit_error');
                assert.equal(error.statusLine, 'HTTP 500');
                assert.equal(error.body, 'circuit buffer exploded');
                return true;
            });
    } finally {
        broker.close();
        delete process.env.MAESTRO_CIRCUIT_URL;
        delete process.env.MAESTRO_CIRCUIT_SECRET;
        delete process.env.MAESTRO_SESSION_ID;
    }
});

// Not an envelope test: a guard that rewriting the failure paths left the working paths alone. This one
// passes before the change as well as after, which is exactly what it is for.
test('a call that works still works, and is still not an error', async () => {
    plan = (req) => (req.url.includes('/labels')
        ? { status: 200, body: JSON.stringify({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Receipts', type: 'user' }] }) }
        : { status: 500, body: '{}' });
    const dir = credentialsDir();
    const { response } = await callTool('list_email_labels', {}, { dir });

    assert.equal(response.result.isError ?? false, false);
    assert.match(response.result.content[0].text, /Found 2 labels \(1 system, 1 user\)/);
    assert.match(response.result.content[0].text, /Name: Receipts/);
});
