import { strict as assert } from "node:assert";
import { test } from "node:test";
import { searchHeader } from "./searchsummary.js";

// Verified against the broken version first: a header of `""`, which is exactly what shipped (no header
// at all, just the ten results), fails ALL SIX.

test("a partial answer says so, and says how many there really are", () => {
    const line = searchHeader(25, 201, "invoices");
    assert.match(line, /Showing 25 of about 201/);
    assert.match(line, /invoices/);
    // The way out has to be in the sentence, or a caller who learns it was cut has nowhere to go.
    assert.match(line, /maxResults/);
});

test("a complete answer does NOT pretend there is more", () => {
    const line = searchHeader(3, 3, "from:bank");
    assert.match(line, /^3 matching/);
    assert.doesNotMatch(line, /about/);
    assert.doesNotMatch(line, /maxResults/);
});

test("nothing found is nothing found, not a failure", () => {
    const line = searchHeader(0, 0, "zzqqxx");
    assert.match(line, /No mail matches/);
    // Nothing about permissions or errors: an empty mailbox is an answer, and hedging invites a reader
    // to treat it as a problem it is not.
    assert.doesNotMatch(line, /error|permission|denied/i);
});

test("an estimate under what we are holding never reads as a bug", () => {
    // Gmail's estimate is approximate and has come back below the page actually returned.
    const line = searchHeader(25, 12, "invoices");
    assert.match(line, /^25 matching/);
    assert.doesNotMatch(line, /of about/);
});

test("the query is quoted, so an empty or odd one is still legible", () => {
    assert.match(searchHeader(5, 90, ""), /matching ""/);
    assert.match(searchHeader(5, 90, 'has:"a b"'), /matching "has/);
});

test("one result reads as one result", () => {
    assert.match(searchHeader(1, 1, "invoices"), /^1 matching/);
});
