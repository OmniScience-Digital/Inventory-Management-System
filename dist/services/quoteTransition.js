/**
 * Pure quote status lattice. No I/O, no ClickUp, no DynamoDB - this file only
 * answers one question: "given where the DB last saw this quote, and where Xero
 * says it is now, which steps must we replay, in which order?"
 *
 * Unit-test this file heavily - it's the whole correctness story of the poller.
 */
/**
 * Transition table. Keys are previous (DB) status, values are ordered step
 * lists keyed by new (Xero) status.
 *
 * Why replay instead of jumping straight to the end state: Xero can move a
 * quote through several statuses between two polls (e.g. DRAFT -> SENT ->
 * ACCEPTED before we ever see it). A snapshot diff only shows the endpoints,
 * so we replay every intermediate step so each ClickUp artifact (CRM-01,
 * CRM-02, CRM-33, CRM-32, job card) still gets created in the right order.
 *
 * Every entry below corresponds to a scenario confirmed with the team:
 *   '' -> SENT      : Does not exist -> Draft -> Sent
 *   '' -> ACCEPTED  : Does not exist -> Draft -> Sent -> Accepted
 *   DRAFT -> ACCEPTED : Draft -> Sent -> Accepted
 *   DRAFT -> DELETED  : Draft -> Sent -> Declined -> Deleted
 *   SENT -> DELETED   : Sent -> Declined -> Deleted
 *   DECLINED -> ACCEPTED : Declined -> Sent -> Accepted
 *
 * Known blind spot (cannot be fixed from snapshots): SENT -> DECLINED -> SENT
 * within one poll ends where it started, so the diff shows "no change". Xero's
 * Quotes endpoint exposes current state only - there is no status history API.
 * Mitigations: shorter poll interval + the content-change heuristic in
 * buildContentChangeSteps.
 */
const TRANSITION_TABLE = {
    // Brand-new quote (no DB row yet = "Does not exist"). Xero may already be
    // past DRAFT by the time we first see it - replay everything up to current.
    '': {
        DRAFT: ['Created'],
        SENT: ['Created', 'Sent'],
        ACCEPTED: ['Created', 'Sent', 'Accepted'],
        DECLINED: ['Created', 'Sent', 'Declined'],
        DELETED: ['Created', 'Sent', 'Declined', 'Deleted'],
    },
    DRAFT: {
        SENT: ['Sent'],
        // Draft -> Sent -> Accepted: replay the Sent step first so CRM-02 exists
        // before the Accepted step needs its id.
        ACCEPTED: ['Sent', 'Accepted'],
        DECLINED: ['Sent', 'Declined'],
        // Draft -> Sent -> Declined -> Deleted: replay the full chain, not just Deleted.
        DELETED: ['Sent', 'Declined', 'Deleted'],
    },
    SENT: {
        ACCEPTED: ['Accepted'],
        DECLINED: ['Declined'],
        // Sent -> Declined -> Deleted: replay Declined (cold storage) before Deleted.
        DELETED: ['Declined', 'Deleted'],
    },
    DECLINED: {
        SENT: ['Sent After Declined'],
        // Declined -> Sent -> Accepted: revive CRM-02 first, then accept.
        ACCEPTED: ['Sent After Declined', 'Accepted'],
        // Already in cold storage - straight to Deleted.
        DELETED: ['Deleted'],
    },
    ACCEPTED: {
        // Only reachable via the content-change fallback: Xero never flips
        // ACCEPTED back to SENT in the Status field. DB-only sync, no ClickUp work.
        SENT: ['Accepted Quote Sent'],
        DELETED: ['Deleted'],
    },
};
/**
 * Maps a (previous, next) status pair to the ordered list of steps to replay.
 * Returns [] for same-status (no transition) AND for unknown pairs - callers
 * must distinguish those two cases (see handleQuoteStatuses).
 */
export function buildSteps(prevStatus, nextStatus) {
    const from = (prevStatus || '').toUpperCase();
    const to = (nextStatus || '').toUpperCase();
    if (from === to)
        return [];
    return TRANSITION_TABLE[from]?.[to] ?? [];
}
/**
 * Content changed (line items / totals) but status is unchanged. Xero's Status
 * field never flips ACCEPTED/DECLINED back to SENT on a resend, so a resend of
 * an already-decided quote only shows up here.
 *
 * NOTE: this is a heuristic, not detection - a SENT -> DECLINED -> SENT
 * round-trip with untouched content is invisible to us (see blind spot above).
 */
export function buildContentChangeSteps(prevStatus) {
    switch ((prevStatus || '').toUpperCase()) {
        case 'ACCEPTED':
            return ['Accepted Quote Sent'];
        case 'DECLINED':
            return ['Sent After Declined'];
        case 'SENT':
            return ['Revision After Sent'];
        default:
            return ['Updated'];
    }
}
