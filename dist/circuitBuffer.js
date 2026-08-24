// The TypeScript half of Maestro's circuit cache (docs/reqs/003_handle_bus.md). Mirrors the Python helper
// (Resources/dispatch/bin/circuit_buffer.py); both satisfy the same shared test vector
// (scripts/test_circuit_helper.py). Applied at the server's central tool-call handler:
//   resolveArgs(args) at the top (expand @@hN@@ slugs back into payloads, BEFORE validation),
//   wrapResult(result) on return (park a large result + PREPEND its slug so the next tool can wire it).
// No-op when the circuit env is absent (server run outside Maestro), so the server still works solo.
import { ToolFailure, toolFailure } from "./failureEnvelope.js";
const THRESHOLD = 200;
/** A circuit failure IS a tool failure, so it reaches the caller as the same envelope. */
export class CircuitError extends ToolFailure {
}
function cfg() {
    const url = (process.env.MAESTRO_CIRCUIT_URL || "").trim();
    const secret = (process.env.MAESTRO_CIRCUIT_SECRET || "").trim();
    const session = (process.env.MAESTRO_SESSION_ID || "").trim();
    return url && secret && session ? { url, secret, session } : null;
}
async function post(path, body, url, secret) {
    const r = await fetch(url.replace(/\/$/, "") + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Circuit-Secret": secret },
        body: JSON.stringify(body),
    });
    // Read the body whatever the status: on a failure it is the evidence the caller has to report.
    const text = await r.text();
    let json = null;
    if (r.status === 200) {
        try {
            json = JSON.parse(text);
        }
        catch {
            json = null;
        }
    }
    return { status: r.status, json, text };
}
async function fetchSlug(slug, c) {
    let status;
    let json;
    let text;
    try {
        ({ status, json, text } = await post("/get", { session: c.session, slug }, c.url, c.secret));
    }
    catch (error) {
        throw toolFailure(error, `Could not expand ${slug}: Maestro's circuit buffer did not answer`);
    }
    if (status === 404) {
        // Keeps the recovery the model already had ("re-fetch it"), which this server does know: the cache
        // it is talking about is its own, not a provider's.
        throw new CircuitError("expired_handle", `Circuit slug ${slug} is no longer cached, so it could not be expanded; re-fetch what it stood for`);
    }
    if (status !== 200) {
        throw new CircuitError("circuit_error", `Could not expand circuit slug ${slug}`, `HTTP ${status}`, text || undefined);
    }
    // Never fall back to an empty payload: a tool asked to act on @@hN@@ would then act on nothing at all,
    // which is a failure wearing a success (send an email whose body silently became "").
    const payload = json && json.payload;
    if (typeof payload !== "string") {
        throw new CircuitError("circuit_error", `Could not expand circuit slug ${slug}: the circuit buffer returned no payload`, undefined, text || undefined);
    }
    return payload;
}
export async function resolveArgs(args) {
    const c = cfg();
    if (!c)
        return args;
    const expand = async (v) => {
        if (typeof v === "string" && /@@h\d+@@/.test(v)) {
            const tokens = new Set((v.match(/@@h\d+@@/g) || []));
            let out = v;
            for (const t of tokens) {
                const payload = await fetchSlug(t, c);
                out = out.split(t).join(payload);
            }
            return out;
        }
        if (Array.isArray(v))
            return Promise.all(v.map(expand));
        if (v && typeof v === "object") {
            const o = {};
            for (const k of Object.keys(v))
                o[k] = await expand(v[k]);
            return o;
        }
        return v;
    };
    return expand(args);
}
export async function wrapResult(result) {
    const c = cfg();
    // A failure envelope is never parked or prefixed: `[<code>]` has to lead the text with nothing before
    // it, and a caller cannot read a status and a body out of a handle.
    if (!c || !result || result.isError === true || !Array.isArray(result.content))
        return result;
    const first = result.content[0];
    if (!first || first.type !== "text" || typeof first.text !== "string" || first.text.length < THRESHOLD) {
        return result;
    }
    let slug;
    try {
        const { json } = await post("/put", { session: c.session, payload: first.text }, c.url, c.secret);
        slug = json && json.slug;
    }
    catch {
        return result; // best-effort: a buffer hiccup never breaks the tool
    }
    if (!slug)
        return result;
    const tag = `[circuit ${slug} · to feed this whole result into another tool, pass ${slug} as its argument ` +
        `instead of retyping it; read_tool_result(${slug}) shows it in full later]`;
    return { ...result, content: [{ ...first, text: tag + "\n\n" + first.text }, ...result.content.slice(1)] };
}
