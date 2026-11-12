// utils/syncInput.js - checks a batch of offline operations sent by a phone (no database in here).
// Each operation is something done while offline: a sale, or a customer added at the till.
const HttpError = require("./httpError");
const { cleanText, cleanUuid } = require("./validators");

const TYPES = ["sale", "customer"];
const MAX_OPERATIONS = 25;
const FIVE_MINUTES = 5 * 60 * 1000;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

/**
 * `at` is when it really happened, from the phone's clock. Phone clocks can be wrong, so:
 * a time in the future becomes "now", and a missing, broken or very old time becomes "now" too.
 */
function cleanTime(value, now) {
    const t = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isNaN(t)) return { at: now, adjusted: true };
    if (t > now.getTime() + FIVE_MINUTES) return { at: now, adjusted: true };
    if (t < now.getTime() - MAX_AGE_MS) return { at: now, adjusted: true };
    return { at: new Date(t), adjusted: false };
}

function parseSyncBatch(body, now = new Date()) {
    body = body || {};
    if (!Array.isArray(body.operations) || body.operations.length === 0) {
        throw new HttpError(400, "There is nothing to send.");
    }
    if (body.operations.length > MAX_OPERATIONS) {
        throw new HttpError(400, `Send at most ${MAX_OPERATIONS} items at a time.`);
    }

    const seen = new Set();
    return body.operations.map((op) => {
        if (!op || typeof op !== "object") throw new HttpError(400, "One of the items is not filled in correctly.");
        if (!TYPES.includes(op.type)) throw new HttpError(400, "Unknown kind of item.");
        const clientUuid = cleanUuid(op.clientUuid, "item");
        if (seen.has(clientUuid)) throw new HttpError(400, "The same item is listed twice.");
        seen.add(clientUuid);
        if (!op.payload || typeof op.payload !== "object") throw new HttpError(400, "An item has no details.");

        const time = cleanTime(op.at, now);
        return {
            type: op.type,
            clientUuid,
            at: time.at,
            timeAdjusted: time.adjusted,
            tempReceiptRef: cleanText(op.tempReceiptRef, "the temporary receipt number", { required: false, max: 40 }),
            payload: op.payload
        };
    });
}

module.exports = { TYPES, MAX_OPERATIONS, cleanTime, parseSyncBatch };
