// The uniform failure envelope every Maestro MCP server returns (docs/MCP_FAILURE_ENVELOPE.md).
//
// One shape, every failure:
//
//   [<code>] <one plain sentence: what did not happen>
//   HTTP <status> <reason phrase>
//   <the provider's response body, verbatim>
//
// Line 1 is for a person and for the model. Lines 2 and 3 are the evidence, and they are the whole point:
// an expired credential and a permission the account never had are both "403", and only Google's body
// separates them. So nothing here summarises, translates, or advises. It reports.
const MAX_BODY = 4000;
/** Reason phrases for the statuses Google actually returns, used only when the wire gave us none. */
const REASON_PHRASE = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    412: 'Precondition Failed',
    413: 'Payload Too Large',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
};
const REDACTED = '<redacted>';
/** Header names whose VALUE is a credential wherever it appears. */
const SECRET_HEADERS = 'authorization|proxy-authorization|cookie|set-cookie|x-goog-api-key|x-circuit-secret';
/** Field names whose VALUE is a credential wherever it appears, in JSON or in a form body or a query. */
const SECRET_FIELDS = 'access_token|refresh_token|id_token|client_secret|client_id|private_key|private_key_id|api_key|apikey|assertion';
/**
 * Strip credentials out of anything we echo. Rule 8, and this is the server most able to leak one:
 * a token-refresh failure carries the refresh token and the client secret in the request it made, and
 * a corrupt `credentials.json` can put the token itself into a JSON parse error.
 *
 * Deliberately blunt. Over-redacting a Google error body costs nothing, because Google's error bodies
 * carry `error` and `error_description` and never a token; under-redacting puts a live credential in a
 * transcript.
 */
export function redact(text) {
    let out = text;
    // "Authorization: Bearer ya29..." / "set-cookie: SID=..." (header block or log line, value to EOL)
    out = out.replace(new RegExp(`(^|\\n)([ \\t]*(?:${SECRET_HEADERS})[ \\t]*:)[^\\n]*`, 'gi'), `$1$2 ${REDACTED}`);
    // {"authorization":"Bearer ya29..."} / 'cookie': '...'
    out = out.replace(new RegExp(`(["'](?:${SECRET_HEADERS})["'][ \\t]*:[ \\t]*)(["']).*?\\2`, 'gi'), `$1$2${REDACTED}$2`);
    // {"refresh_token":"1//0g..."} , including the escaped-quote form inside a stringified error
    out = out.replace(new RegExp(`(\\\\?["'](?:${SECRET_FIELDS})\\\\?["'][ \\t]*:[ \\t]*)(\\\\?["']).*?\\2`, 'gi'), `$1$2${REDACTED}$2`);
    // refresh_token=1//0g... in a form body or a query string
    out = out.replace(new RegExp(`\\b(${SECRET_FIELDS}|token|code)=[^&\\s"'\\\\]+`, 'gi'), `$1=${REDACTED}`);
    // A bearer token anywhere, however it got there.
    out = out.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`);
    // Google credential shapes, as a last line of defence: access tokens, refresh tokens, client
    // secrets and client ids are recognisable on sight and must never survive on their own.
    out = out.replace(/\bya29\.[A-Za-z0-9\-._~+/]+=*/g, REDACTED);
    out = out.replace(/\b1\/\/[A-Za-z0-9\-._~+/]{20,}=*/g, REDACTED);
    out = out.replace(/\bGOCSPX-[A-Za-z0-9\-._~]+/g, REDACTED);
    out = out.replace(/\b\d{6,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com\b/gi, REDACTED);
    return out;
}
/** Redact, then cap at 4000 characters. Redaction runs first so a truncated secret cannot survive. */
function evidence(raw) {
    const clean = redact(raw);
    if (!clean.trim())
        return undefined;
    return clean.length > MAX_BODY ? `${clean.slice(0, MAX_BODY)} ...[truncated]` : clean;
}
/** One line, no trailing whitespace, ending in a full stop. */
function sentenceOf(raw) {
    const one = redact(raw).replace(/\s+/g, ' ').trim();
    return /[.!?]$/.test(one) ? one : `${one}.`;
}
/**
 * A failure carrying everything the envelope needs. Thrown by the layer that knows WHAT did not happen,
 * rendered by the layer that answers the tool call, and passed through untouched in between so no
 * wrapper can flatten a status and a body back into a bare string.
 */
export class ToolFailure extends Error {
    constructor(code, sentence, statusLine, body) {
        super(`[${code}] ${sentenceOf(sentence)}`);
        /** Survives a duplicated module copy, where `instanceof` would not. */
        this.isToolFailure = true;
        this.name = 'ToolFailure';
        this.code = code;
        this.sentence = sentenceOf(sentence);
        this.statusLine = statusLine;
        this.body = body;
    }
    /** The envelope, exactly as the contract writes it. */
    get text() {
        const lines = [`[${this.code}] ${this.sentence}`];
        if (this.statusLine)
            lines.push(this.statusLine);
        if (this.body)
            lines.push(this.body);
        return lines.join('\n');
    }
    /** Code and status only, for listing many failures at once without repeating every body. */
    get brief() {
        return this.statusLine ? `[${this.code}] ${this.statusLine}` : `[${this.code}]`;
    }
    /** The MCP result. `isError` is the contract; the `[code]` prefix is the backstop when it is lost. */
    toResult() {
        return { content: [{ type: 'text', text: this.text }], isError: true };
    }
}
function isToolFailure(error) {
    return error instanceof ToolFailure || (!!error && error.isToolFailure === true);
}
/** An HTTP status, from wherever this client happened to put it. */
function statusOf(error) {
    for (const candidate of [error?.response?.status, error?.status, error?.code]) {
        const n = typeof candidate === 'string' ? Number(candidate) : candidate;
        if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599)
            return n;
    }
    return undefined;
}
/**
 * The provider's body, verbatim.
 *
 * The HTTP client parses a JSON response before we ever see it, so for a JSON body this is that value
 * re-serialised: every field the provider sent, nothing added, nothing decided. A body it could not
 * parse arrives as a string and is passed through byte for byte.
 */
function bodyOf(error) {
    const data = error?.response?.data;
    if (data === undefined || data === null)
        return undefined;
    if (typeof data === 'string')
        return evidence(data);
    if (Buffer.isBuffer(data))
        return evidence(data.toString('utf8'));
    try {
        return evidence(JSON.stringify(data));
    }
    catch {
        return evidence(String(data));
    }
}
/** Every error code this client can attach, including the one behind a wrapped network failure. */
function errnoOf(error) {
    for (const candidate of [error?.code, error?.error?.code, error?.cause?.code]) {
        if (typeof candidate === 'string' && candidate)
            return candidate;
    }
    return undefined;
}
const NETWORK_ERRNOS = new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
    'ENETDOWN', 'ECONNABORTED', 'EPROTO', 'ERR_NETWORK', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);
const TIMEOUT_ERRNOS = new Set([
    'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ETIME', 'ABORT_ERR', 'ERR_CANCELED', 'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);
/** google-auth-library's own words for "there is nothing here to authenticate with". */
const NO_CREDENTIAL_MESSAGES = new Set([
    'No access, refresh token, API key or refresh handler callback is set.',
    'No refresh token is set.',
    'No refresh token or refresh handler callback is set.',
]);
/**
 * Turn anything that was thrown into the envelope, keeping the status and the body wherever they exist.
 *
 * `sentence` says what did not happen, in the caller's words. A `ToolFailure` from further down already
 * has a more specific one, so it comes back untouched.
 */
export function toolFailure(error, sentence) {
    if (isToolFailure(error))
        return error;
    const err = error;
    const status = statusOf(err);
    if (status !== undefined) {
        const reason = String(err?.response?.statusText ?? '').trim() || REASON_PHRASE[status] || '';
        const statusLine = `HTTP ${status}${reason ? ` ${reason}` : ''}`;
        return new ToolFailure(`http_${status}`, sentence, statusLine, bodyOf(err));
    }
    const message = typeof err?.message === 'string' ? err.message : String(err ?? '');
    const detail = evidence(message);
    if (err?.name === 'ZodError' || Array.isArray(err?.issues)) {
        return new ToolFailure('bad_request', sentence, undefined, detail);
    }
    const errno = errnoOf(err);
    if (errno && TIMEOUT_ERRNOS.has(errno))
        return new ToolFailure('timeout', sentence, undefined, detail);
    if (errno && NETWORK_ERRNOS.has(errno))
        return new ToolFailure('network', sentence, undefined, detail);
    if (errno === 'ENOENT')
        return new ToolFailure('not_found', sentence, undefined, detail);
    if (errno === 'EACCES' || errno === 'EPERM')
        return new ToolFailure('not_allowed', sentence, undefined, detail);
    if (NO_CREDENTIAL_MESSAGES.has(message.trim())) {
        return new ToolFailure('no_credentials', sentence, undefined, detail);
    }
    return new ToolFailure('failed', sentence, undefined, detail);
}
/** The envelope as an MCP result, for a handler that answers rather than throws. */
export function failureResult(error, sentence) {
    return toolFailure(error, sentence).toResult();
}
