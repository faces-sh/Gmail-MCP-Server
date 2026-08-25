/**
 * WHAT A SEARCH SAYS ABOUT ITSELF.
 *
 * `search_emails` used to answer with ten messages and nothing else, whatever the mailbox held, so a
 * caller could not tell ten-because-that-is-all from ten-because-we-stopped. Watched live: "Search my
 * email for anything about invoices and tell me how many you found" came back with "I found 10 emails
 * matching invoices". The real number was about 201.
 *
 * That is not a size problem, it is an honesty problem, and it is the same one a contacts listing had
 * (252 shown of 1,645) and a notes listing before it. A result that is quietly partial is worse than a
 * big one, because the caller acts on it.
 *
 * Its own module so a test can hold it: this sentence is the entire fix, and Gmail's own
 * `resultSizeEstimate` was already on the response being thrown away, so it costs nothing to say.
 */
export function searchHeader(shown: number, estimate: number, query: string): string {
    const q = JSON.stringify(query);
    if (shown === 0) return `No mail matches ${q}.`;
    // Never claim fewer than we are holding: the estimate is approximate and can come back under the
    // page we actually got, and "showing 25 of about 20" reads as a bug in us.
    const total = Math.max(estimate, shown);
    if (total <= shown) return `${shown} matching ${q}.`;
    // "of about", because the estimate IS an estimate. Saying "of 201" would claim a precision Gmail
    // does not give us, and being caught inventing a number costs more than the vagueness saves.
    return `Showing ${shown} of about ${total} matching ${q}. `
         + `Ask for more with maxResults, or narrow the query.`;
}
