// utils/time.js - the shop's clock. Uganda is UTC+3 all year (no daylight saving).
// "Today" for a shopkeeper means today in Kampala, not in the server's time zone.
const HttpError = require("./httpError");

const SHOP_TZ = "Africa/Kampala";

/** Today in Kampala as "2026-10-22" */
function todayInShop(now = new Date()) {
    return now.toLocaleDateString("en-CA", { timeZone: SHOP_TZ });
}

/** "2026-10-22" plus or minus whole days */
function addDays(dateText, days) {
    const [y, m, d] = dateText.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function daysBetween(fromText, toText) {
    const a = Date.parse(fromText + "T00:00:00Z");
    const b = Date.parse(toText + "T00:00:00Z");
    return Math.round((b - a) / 86400000);
}

/**
 * from / to come from the screen (already checked as real dates). Missing = today.
 * Swapped dates are put right. A range may be at most `maxDays` days long.
 */
function resolveRange(fromText, toText, maxDays = 400, now = new Date()) {
    const today = todayInShop(now);
    let from = fromText || toText || today;
    let to = toText || fromText || today;
    if (from > to) [from, to] = [to, from];
    if (daysBetween(from, to) > maxDays) {
        throw new HttpError(400, `Please choose a period of at most ${maxDays} days.`);
    }
    return { from, to };
}

/**
 * SQL for "this column falls on a Kampala day between $from and $to (inclusive)".
 * fromParam / toParam are placeholders like "$2" holding "YYYY-MM-DD" text.
 * Written as a range so the date indexes can still be used.
 */
function dayRange(column, fromParam, toParam) {
    return `${column} >= ${fromParam}::date::timestamp AT TIME ZONE '${SHOP_TZ}'
            AND ${column} < (${toParam}::date + 1)::timestamp AT TIME ZONE '${SHOP_TZ}'`;
}

module.exports = { SHOP_TZ, todayInShop, addDays, daysBetween, resolveRange, dayRange };
