// utils/subscriptions.js - the rules for a business's subscription.
// Step 2: start the free trial for a new business.
// Step 3: "may this business work right now?" (accessFor) and the plan's features.
// Step 4: plans, checkout (a pending payment), applying a successful payment, cancel / resume, user limits.
// Step 5 connects the payment provider to applySuccessfulPayment().
const crypto = require("crypto");
const HttpError = require("./httpError");
const { logAudit } = require("./audit");

// Length of the free trial and the plan it runs on. Change TRIAL_DAYS in .env to try another length.
const TRIAL_DAYS = Math.max(1, Number(process.env.TRIAL_DAYS) || 14);
const TRIAL_PLAN_CODE = "business";

/**
 * Give a business its free trial. Call it INSIDE the transaction that creates the business,
 * so a shop can never exist without a subscription row. Calling it again for the same shop
 * changes nothing (the trial can only be started once).
 */
async function startTrial(db, shopId, userId) {
    const plan = await db.query("SELECT id FROM subscription_plans WHERE code = $1", [TRIAL_PLAN_CODE]);
    if (plan.rowCount === 0) {
        // The subscription tables/plans were never set up: stop loudly instead of creating a shop with no trial.
        throw new Error("Subscription plans are missing. Run subscriptions.sql on the database first.");
    }

    const created = await db.query(
        `INSERT INTO subscriptions (shop_id, plan_id, status, trial_started_at, trial_ends_at)
         VALUES ($1, $2, 'trialing', NOW(), NOW() + make_interval(days => $3::int))
         ON CONFLICT (shop_id) DO NOTHING
         RETURNING id, status, trial_started_at, trial_ends_at`,
        [shopId, plan.rows[0].id, TRIAL_DAYS]
    );
    if (created.rowCount === 0) return null; // this shop already had a subscription

    await logAudit(db, {
        shopId, userId, action: "subscription.trial_started", entityType: "subscription",
        entityId: created.rows[0].id, details: { days: TRIAL_DAYS, plan: TRIAL_PLAN_CODE }
    });
    return created.rows[0];
}

/** The small summary the browser needs right after registering. */
function trialSummary(row) {
    if (!row) return null;
    const ends = new Date(row.trial_ends_at);
    return {
        status: row.status,
        trialEndsAt: ends.toISOString(),
        daysLeft: Math.max(0, Math.ceil((ends.getTime() - Date.now()) / 86400000))
    };
}


// ---------------------------------------------------------------------
// Step 3: may this business work right now?
// Decided from status + dates (not from a daily job), so nothing breaks if a job runs late.
// ---------------------------------------------------------------------
const DAY = 86400000;

/**
 * row = the subscription joined with its plan:
 *   { sub_status, trial_ends_at, current_period_end, plan_code, plan_name, features, max_users }
 * or null when the business has no subscription row yet (then it is allowed: see note in auth middleware).
 */
function accessFor(row, now) {
    now = now || new Date();
    if (!row || !row.sub_status) {
        return { state: "none", allowed: true, endsAt: null, daysLeft: null, planCode: null, planName: null, features: null, maxUsers: null };
    }
    const features = Array.isArray(row.features) ? row.features : [];
    const base = { planCode: row.plan_code, planName: row.plan_name, features, maxUsers: row.max_users };
    const left = (end) => Math.max(0, Math.ceil((new Date(end).getTime() - now.getTime()) / DAY));
    const open = (state, end) => Object.assign({ state, allowed: true, endsAt: new Date(end).toISOString(), daysLeft: left(end) }, base);
    const shut = (state, end) => Object.assign({ state, allowed: false, endsAt: end ? new Date(end).toISOString() : null, daysLeft: 0 }, base);
    const still = (end) => end && new Date(end).getTime() > now.getTime();

    switch (row.sub_status) {
        case "suspended": return shut("suspended", row.current_period_end);
        case "trialing":  return still(row.trial_ends_at) ? open("trial", row.trial_ends_at) : shut("trial_ended", row.trial_ends_at);
        case "active":    return still(row.current_period_end) ? open("active", row.current_period_end) : shut("past_due", row.current_period_end);
        case "cancelled": return still(row.current_period_end) ? open("cancelling", row.current_period_end) : shut("cancelled", row.current_period_end);
        case "expired":   return shut("trial_ended", row.trial_ends_at);
        case "past_due":  return shut("past_due", row.current_period_end);
        default:          return shut("past_due", row.current_period_end);
    }
}

/** The plain message a blocked person sees. Only the owner can renew, so staff are told to ask the owner. */
function blockedMessage(access, role) {
    if (access.state === "suspended") return "This account has been suspended. Please contact Duka support.";
    if (role !== "owner") return "This shop's Duka subscription has ended. Please ask the shop owner to renew it.";
    if (access.state === "trial_ended") return "Your free trial has ended. Choose a plan to keep using Duka.";
    if (access.state === "cancelled") return "Your subscription has ended. Choose a plan to start again.";
    return "Your subscription has expired. Renew it to keep using Duka.";
}

/** What the browser is told about the subscription (no internal details). */
function publicAccess(access) {
    if (!access) return null;
    return {
        state: access.state, allowed: access.allowed, endsAt: access.endsAt, daysLeft: access.daysLeft,
        renewSoon: access.allowed && access.daysLeft !== null && access.daysLeft <= 7,
        planCode: access.planCode, planName: access.planName, maxUsers: access.maxUsers
    };
}

/** Subscription rules are only ENFORCED when SUBSCRIPTION_ENFORCE=true in .env (so you can deploy safely first). */
function enforcing() { return String(process.env.SUBSCRIPTION_ENFORCE || "").toLowerCase() === "true"; }

// ---------------------------------------------------------------------
// Step 4: plans, checkout, payments, cancel / resume
// ---------------------------------------------------------------------
const PERIODS = [1, 3, 12];
const RECOMMENDED_PLAN = "business";
// Which payment provider new payments are created for (PAYMENT_PROVIDER in .env). Pesapal is connected (utils/pesapal.js).
const PROVIDERS = ["flutterwave", "pesapal", "mtn_momo", "airtel_money"];
function defaultProvider() {
    const p = String(process.env.PAYMENT_PROVIDER || "pesapal").toLowerCase();
    return PROVIDERS.includes(p) ? p : "pesapal";
}

/** The plans a business may choose, each with its prices: { code, name, maxUsers, features, recommended, prices: {1: .., 3: .., 12: ..} } */
async function listPlans(db) {
    const { rows } = await db.query(
        `SELECT p.code, p.name, p.description, p.max_users, p.features, pr.months, pr.price
         FROM subscription_plans p
         JOIN subscription_plan_prices pr ON pr.plan_id = p.id AND pr.is_active
         WHERE p.is_active
         ORDER BY p.sort_order, pr.months`
    );
    const plans = new Map();
    for (const r of rows) {
        if (!plans.has(r.code)) {
            plans.set(r.code, {
                code: r.code, name: r.name, description: r.description, maxUsers: Number(r.max_users),
                features: Array.isArray(r.features) ? r.features : [], recommended: r.code === RECOMMENDED_PLAN, prices: {}
            });
        }
        plans.get(r.code).prices[r.months] = Number(r.price);
    }
    return [...plans.values()];
}

async function activeUserCount(db, shopId) {
    const { rows } = await db.query("SELECT COUNT(*) AS n FROM users WHERE shop_id = $1 AND is_active", [shopId]);
    return Number(rows[0].n);
}

/** The business's own subscription: what it may do now, plus the dates and plan details the screen shows. */
async function getOverview(db, shopId) {
    const { rows } = await db.query(
        `SELECT sub.status AS sub_status, sub.trial_ends_at, sub.current_period_start, sub.current_period_end,
                sub.billing_months, sub.cancelled_at, pl.code AS plan_code, pl.name AS plan_name,
                pl.features, pl.max_users
         FROM subscriptions sub JOIN subscription_plans pl ON pl.id = sub.plan_id
         WHERE sub.shop_id = $1`,
        [shopId]
    );
    const row = rows[0] || null;
    const access = accessFor(row);
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    return {
        access,
        details: row ? {
            billingMonths: row.billing_months, trialEndsAt: iso(row.trial_ends_at),
            currentPeriodStart: iso(row.current_period_start), currentPeriodEnd: iso(row.current_period_end),
            cancelled: row.sub_status === "cancelled", cancelledAt: iso(row.cancelled_at)
        } : null
    };
}

function paymentShape(r) {
    return {
        id: r.id, merchantRef: r.merchant_ref, status: r.status, planCode: r.plan_code || null, planName: r.plan_name || null,
        months: r.months, amount: Number(r.amount), provider: r.provider, method: r.method,
        providerRef: r.provider_ref, failureReason: r.failure_reason,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
        periodStart: r.period_start ? new Date(r.period_start).toISOString() : null,
        periodEnd: r.period_end ? new Date(r.period_end).toISOString() : null
    };
}

const PAYMENT_SELECT = `SELECT sp.*, pl.code AS plan_code, pl.name AS plan_name
                        FROM subscription_payments sp JOIN subscription_plans pl ON pl.id = sp.plan_id`;

/**
 * "Choose this plan for N months": checks everything and saves a PENDING payment with the price taken
 * from the database (never from the browser). Nothing is extended until the payment is verified (Step 5).
 * The same clientUuid, or an equal open order from the last hour, returns the same payment.
 */
async function createCheckout(db, user, input) {
    const months = Number(input.months);
    if (!PERIODS.includes(months)) throw new HttpError(400, "Choose 1, 3 or 12 months.");
    const planCode = String(input.planCode || "");

    const found = await db.query(
        `SELECT p.id, p.code, p.name, p.max_users, pr.price
         FROM subscription_plans p
         JOIN subscription_plan_prices pr ON pr.plan_id = p.id AND pr.months = $2 AND pr.is_active
         WHERE p.code = $1 AND p.is_active`,
        [planCode, months]
    );
    const plan = found.rows[0];
    if (!plan) throw new HttpError(400, "That plan is not available.");

    const users = await activeUserCount(db, user.shopId);
    if (users > Number(plan.max_users)) {
        throw new HttpError(409,
            `Your shop has ${users} active users but the ${plan.name} plan allows ${plan.max_users}. ` +
            "Switch off some staff accounts first, or choose a bigger plan.", { code: "PLAN_LIMIT" });
    }

    const again = await db.query(
        `${PAYMENT_SELECT} WHERE sp.shop_id = $1 AND (sp.client_uuid = $2
            OR (sp.status = 'pending' AND sp.plan_id = $3 AND sp.months = $4 AND sp.created_at > NOW() - INTERVAL '1 hour'))
         ORDER BY sp.id DESC LIMIT 1`,
        [user.shopId, input.clientUuid, plan.id, months]
    );
    if (again.rows[0]) return paymentShape(again.rows[0]);

    const sub = (await db.query("SELECT id FROM subscriptions WHERE shop_id = $1", [user.shopId])).rows[0];
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Kampala" }).replace(/-/g, "");
    const merchantRef = `DUKA-${user.shopId}-${day}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const created = await db.query(
        `INSERT INTO subscription_payments (shop_id, subscription_id, plan_id, client_uuid, merchant_ref, months,
                                            amount, provider, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [user.shopId, sub ? sub.id : null, plan.id, input.clientUuid, merchantRef, months, Number(plan.price),
         defaultProvider(), user.id]
    );
    await logAudit(db, {
        shopId: user.shopId, userId: user.id, action: "subscription.checkout", entityType: "subscription_payment",
        entityId: created.rows[0].id, details: { plan: plan.code, months, amount: Number(plan.price) }
    });
    const out = await db.query(`${PAYMENT_SELECT} WHERE sp.id = $1`, [created.rows[0].id]);
    return paymentShape(out.rows[0]);
}

/** The business's payment history, newest first. */
async function listPayments(db, shopId, limit, offset) {
    const { rows } = await db.query(
        `${PAYMENT_SELECT} WHERE sp.shop_id = $1 ORDER BY sp.created_at DESC, sp.id DESC LIMIT $2 OFFSET $3`,
        [shopId, limit, offset]
    );
    const total = (await db.query("SELECT COUNT(*) AS n FROM subscription_payments WHERE shop_id = $1", [shopId])).rows[0].n;
    return { payments: rows.map(paymentShape), total: Number(total) };
}

/**
 * A payment was VERIFIED as successful: buy the days. Call it inside a transaction (Step 5 does, after it
 * has checked the provider's notification). Safe to call twice: the second call changes nothing.
 *   New period starts now, or when the current paid time / trial ends, whichever is LATER, so no days are lost.
 *   The chosen plan applies at once. A business suspended by the administrator stays suspended.
 */
async function applySuccessfulPayment(client, info) {
    const found = await client.query("SELECT * FROM subscription_payments WHERE merchant_ref = $1 FOR UPDATE", [info.merchantRef]);
    const pay = found.rows[0];
    if (!pay) throw new HttpError(404, "That payment could not be found.");
    if (pay.status === "successful") return { already: true };
    if (pay.status === "refunded") throw new HttpError(409, "That payment was refunded.");

    // A business registered before subscriptions existed may have no row yet.
    await client.query(
        `INSERT INTO subscriptions (shop_id, plan_id, status) VALUES ($1, $2, 'expired') ON CONFLICT (shop_id) DO NOTHING`,
        [pay.shop_id, pay.plan_id]
    );
    const sub = (await client.query("SELECT id FROM subscriptions WHERE shop_id = $1 FOR UPDATE", [pay.shop_id])).rows[0];

    const updated = await client.query(
        `WITH cur AS (
             SELECT id, GREATEST(NOW(), COALESCE(CASE WHEN status = 'trialing' THEN trial_ends_at ELSE current_period_end END, NOW())) AS start_at
             FROM subscriptions WHERE id = $1)
         UPDATE subscriptions s
            SET plan_id = $2,
                status = CASE WHEN s.status = 'suspended' THEN 'suspended' ELSE 'active' END,
                billing_months = $3,
                current_period_start = cur.start_at,
                current_period_end = cur.start_at + make_interval(months => $3::int),
                cancelled_at = NULL, cancel_reason = NULL
           FROM cur WHERE s.id = cur.id
         RETURNING s.current_period_start, s.current_period_end`,
        [sub.id, pay.plan_id, pay.months]
    );
    const period = updated.rows[0];

    await client.query(
        `UPDATE subscription_payments
            SET status = 'successful', paid_at = COALESCE(paid_at, NOW()), subscription_id = $2,
                provider_ref = COALESCE($3, provider_ref), method = COALESCE($4, method), phone = COALESCE($5, phone),
                raw_response = COALESCE($6::jsonb, raw_response), failure_reason = NULL,
                period_start = $7, period_end = $8
          WHERE id = $1`,
        [pay.id, sub.id, info.providerRef || null, info.method || null, info.phone || null,
         info.rawResponse ? JSON.stringify(info.rawResponse) : null, period.current_period_start, period.current_period_end]
    );
    await logAudit(client, {
        shopId: pay.shop_id, userId: null, action: "subscription.payment_applied", entityType: "subscription_payment",
        entityId: pay.id, details: { months: pay.months, amount: Number(pay.amount) }
    });
    return { already: false, periodEnd: new Date(period.current_period_end).toISOString() };
}

/** Stop renewing: the business keeps working until the date it already paid for. */
async function cancelSubscription(db, user, reason) {
    const { rows } = await db.query(
        `SELECT id, status, trial_ends_at, current_period_end FROM subscriptions WHERE shop_id = $1`, [user.shopId]);
    const sub = rows[0];
    const access = accessFor(sub ? { sub_status: sub.status, trial_ends_at: sub.trial_ends_at, current_period_end: sub.current_period_end } : null);
    if (!sub || !access.allowed || !["trialing", "active"].includes(sub.status)) {
        throw new HttpError(409, "There is no running subscription to cancel.");
    }
    await db.query(
        `UPDATE subscriptions
            SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $2,
                current_period_end = CASE WHEN status = 'trialing' THEN trial_ends_at ELSE current_period_end END
          WHERE id = $1`,
        [sub.id, reason || null]
    );
    await logAudit(db, { shopId: user.shopId, userId: user.id, action: "subscription.cancel", entityType: "subscription", entityId: sub.id, details: { reason: reason || null } });
}

/** Change of mind before the end date: carry on as before. */
async function resumeSubscription(db, user) {
    const resumed = await db.query(
        `UPDATE subscriptions
            SET status = CASE WHEN billing_months IS NULL THEN 'trialing' ELSE 'active' END,
                cancelled_at = NULL, cancel_reason = NULL
          WHERE shop_id = $1 AND status = 'cancelled' AND current_period_end > NOW()
          RETURNING id`,
        [user.shopId]
    );
    if (resumed.rowCount === 0) throw new HttpError(409, "This subscription has already ended. Choose a plan to start again.");
    await logAudit(db, { shopId: user.shopId, userId: user.id, action: "subscription.resume", entityType: "subscription", entityId: resumed.rows[0].id });
}

/** For adding / switching on staff: refuse when the plan's user limit is reached (only when subscriptions are enforced). */
async function assertRoomForUser(db, shopId) {
    if (!enforcing()) return;
    const { rows } = await db.query(
        `SELECT pl.max_users, pl.name FROM subscriptions sub JOIN subscription_plans pl ON pl.id = sub.plan_id WHERE sub.shop_id = $1`, [shopId]);
    if (!rows[0]) return;
    const users = await activeUserCount(db, shopId);
    if (users >= Number(rows[0].max_users)) {
        throw new HttpError(403,
            `Your ${rows[0].name} plan allows ${rows[0].max_users} users and you already have ${users}. Upgrade your plan to add more.`,
            { code: "PLAN_LIMIT" });
    }
}

module.exports = {
    TRIAL_DAYS, TRIAL_PLAN_CODE, startTrial, trialSummary, accessFor, blockedMessage, publicAccess, enforcing,
    PERIODS, listPlans, getOverview, createCheckout, listPayments, applySuccessfulPayment,
    cancelSubscription, resumeSubscription, assertRoomForUser, activeUserCount
};
