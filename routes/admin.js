// routes/admin.js - the Duka administrator's dashboard (see utils/admin.js for who that is).
//   GET  /api/admin/overview                 counts, income, payments waiting for a person
//   GET  /api/admin/shops?search=&state=&page=
//   GET  /api/admin/shops/:id                one shop: owner, users, subscription, payments
//   POST /api/admin/shops/:id/suspend        {reason}
//   POST /api/admin/shops/:id/reactivate
//   POST /api/admin/shops/:id/grant-days     {days, reason}   free days (goodwill, a mistake, a promotion)
//   POST /api/admin/payments/confirm         {merchantRef, reference}  a customer paid outside Pesapal
//   POST /api/admin/login                    phone + password -> admin token (separate from shop logins)
//   GET  /api/admin/me, POST /api/admin/change-password
// Every change is written to the audit log with the administrator's name.
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { cleanText, parseId } = require("../utils/validators");
const { logAudit } = require("../utils/audit");
const bcrypt = require("bcryptjs");
const { normalizePhone } = require("../utils/phone");
const { checkPassword } = require("../utils/validators");
const { loginLimiter } = require("../middleware/rateLimit");
const { signAdminToken, requireAdminAuth } = require("../utils/admin");
const S = require("../utils/subscriptions");

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10); // keeps login timing the same for unknown numbers

// ---------- log in (the only open door) ----------
router.post(
    "/login",
    loginLimiter,
    asyncHandler(async (req, res) => {
        const phone = normalizePhone(req.body.phone);
        const password = typeof req.body.password === "string" ? req.body.password : "";
        const row = phone
            ? (await pool.query("SELECT id, full_name, phone, password_hash, is_active FROM admin_accounts WHERE phone = $1", [phone])).rows[0]
            : null;
        const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
        if (!row || !ok || !row.is_active) throw new HttpError(401, "Wrong phone number or password.");
        await pool.query("UPDATE admin_accounts SET last_login_at = NOW() WHERE id = $1", [row.id]);
        await logAudit(pool, { shopId: null, userId: null, action: "admin.login", entityType: "admin", entityId: Number(row.id), details: { adminName: row.full_name }, ip: req.ip });
        res.json({ success: true, data: { token: signAdminToken(row.id), admin: { id: Number(row.id), fullName: row.full_name, phone: row.phone } } });
    })
);

// Everything below needs an admin login.
router.use(requireAdminAuth);

router.get("/me", (req, res) => res.json({ success: true, data: { admin: req.admin } }));

router.post(
    "/change-password",
    asyncHandler(async (req, res) => {
        const current = typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
        const next = checkPassword(req.body.newPassword, "new password");
        const row = (await pool.query("SELECT password_hash FROM admin_accounts WHERE id = $1", [req.admin.id])).rows[0];
        if (!row || !(await bcrypt.compare(current, row.password_hash))) throw new HttpError(400, "Your current password is not correct.");
        await pool.query("UPDATE admin_accounts SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(next, 12), req.admin.id]);
        await logAudit(pool, { shopId: null, userId: null, action: "admin.change_password", entityType: "admin", entityId: req.admin.id, ip: req.ip });
        res.json({ success: true, data: { ok: true } });
    })
);

const iso = (v) => (v ? new Date(v).toISOString() : null);
const PAGE = 20;

// The groups the dashboard filters by (built from the same rules the app uses to decide access).
const GROUPS = {
    trial: (a) => a.state === "trial",
    active: (a) => a.state === "active" || a.state === "cancelling",
    expiring: (a) => a.allowed && a.daysLeft !== null && a.daysLeft <= 7,
    expired: (a) => ["trial_ended", "past_due", "cancelled"].includes(a.state),
    suspended: (a) => a.state === "suspended"
};

async function loadShops(db) {
    const { rows } = await db.query(
        `SELECT s.id, s.name, s.phone AS shop_phone,
                sub.status AS sub_status, sub.trial_ends_at, sub.current_period_end, sub.billing_months,
                sub.created_at AS joined_at, sub.suspended_reason,
                pl.code AS plan_code, pl.name AS plan_name, pl.features, pl.max_users,
                o.full_name AS owner_name, o.phone AS owner_phone,
                (SELECT COUNT(*) FROM users u WHERE u.shop_id = s.id AND u.is_active) AS user_count
           FROM shops s
           LEFT JOIN subscriptions sub ON sub.shop_id = s.id
           LEFT JOIN subscription_plans pl ON pl.id = sub.plan_id
           LEFT JOIN LATERAL (SELECT full_name, phone FROM users
                               WHERE shop_id = s.id AND role = 'owner' ORDER BY id LIMIT 1) o ON TRUE
          ORDER BY s.id`
    );
    return rows.map((r) => {
        const access = S.accessFor(r.sub_status ? r : null);
        return {
            id: Number(r.id), name: r.name, ownerName: r.owner_name || null, ownerPhone: r.owner_phone || r.shop_phone || null,
            planName: r.plan_name || null, state: access.state, allowed: access.allowed,
            endsAt: access.endsAt, daysLeft: access.daysLeft, users: Number(r.user_count), maxUsers: r.max_users || null,
            joinedAt: iso(r.joined_at), _access: access
        };
    });
}
const publicShop = ({ _access, ...rest }) => rest;

router.get(
    "/overview",
    asyncHandler(async (req, res) => {
        const shops = await loadShops(pool);
        const counts = { total: shops.length };
        Object.keys(GROUPS).forEach((k) => { counts[k] = shops.filter((s) => GROUPS[k](s._access)).length; });

        const money = (await pool.query(
            `SELECT COALESCE(SUM(amount) FILTER (WHERE paid_at >= (date_trunc('month', NOW() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala')), 0) AS this_month,
                    COALESCE(SUM(amount) FILTER (WHERE paid_at >= NOW() - interval '30 days'), 0) AS last_30,
                    COALESCE(SUM(amount), 0) AS all_time
               FROM subscription_payments WHERE status = 'successful'`
        )).rows[0];

        // Orders that were saved but never confirmed: the customer may have paid outside Pesapal.
        const pending = (await pool.query(
            `SELECT p.merchant_ref, p.shop_id, s.name AS shop_name, pl.name AS plan_name, p.months, p.amount,
                    p.provider, p.provider_ref, p.failure_reason, p.created_at
               FROM subscription_payments p
               JOIN shops s ON s.id = p.shop_id
               JOIN subscription_plans pl ON pl.id = p.plan_id
              WHERE p.status = 'pending' AND p.created_at >= NOW() - interval '30 days'
              ORDER BY p.created_at DESC LIMIT 25`
        )).rows.map((r) => ({
            merchantRef: r.merchant_ref, shopId: r.shop_id, shopName: r.shop_name, planName: r.plan_name,
            months: r.months, amount: Number(r.amount), provider: r.provider, started: Boolean(r.provider_ref),
            note: r.failure_reason || null, createdAt: iso(r.created_at)
        }));

        res.json({
            success: true,
            data: {
                counts,
                income: { thisMonth: Number(money.this_month), last30: Number(money.last_30), allTime: Number(money.all_time) },
                pending
            }
        });
    })
);

router.get(
    "/shops",
    asyncHandler(async (req, res) => {
        const search = String(req.query.search || "").trim().toLowerCase().slice(0, 60);
        const group = Object.prototype.hasOwnProperty.call(GROUPS, req.query.state) ? req.query.state : "";
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);

        let shops = await loadShops(pool);
        if (group) shops = shops.filter((s) => GROUPS[group](s._access));
        if (search) {
            const digits = search.replace(/\D/g, "");
            shops = shops.filter((s) =>
                s.name.toLowerCase().includes(search) ||
                String(s.ownerName || "").toLowerCase().includes(search) ||
                (digits.length >= 4 && String(s.ownerPhone || "").includes(digits.replace(/^0/, ""))));
        }
        // Most urgent first: the soonest end date; shops without one go last.
        shops.sort((a, b) => (a.endsAt ? Date.parse(a.endsAt) : Infinity) - (b.endsAt ? Date.parse(b.endsAt) : Infinity) || a.id - b.id);

        const total = shops.length;
        const items = shops.slice((page - 1) * PAGE, page * PAGE).map(publicShop);
        res.json({ success: true, data: { shops: items, page, limit: PAGE, total, hasMore: page * PAGE < total } });
    })
);

router.get(
    "/shops/:id",
    asyncHandler(async (req, res) => {
        const id = parseId(req.params.id);
        const shop = (await loadShops(pool)).find((s) => s.id === id);
        if (!shop) throw new HttpError(404, "That shop could not be found.");

        const users = (await pool.query(
            "SELECT full_name, phone, role, is_active FROM users WHERE shop_id = $1 ORDER BY role DESC, id", [id]
        )).rows.map((u) => ({ fullName: u.full_name, phone: u.phone, role: u.role, active: u.is_active }));
        const details = (await S.getOverview(pool, id)).details;
        const { payments } = await S.listPayments(pool, id, 20, 0);
        const sub = (await pool.query("SELECT suspended_at, suspended_reason FROM subscriptions WHERE shop_id = $1", [id])).rows[0] || {};

        res.json({
            success: true,
            data: {
                shop: publicShop(shop), details, users, payments,
                suspendedAt: iso(sub.suspended_at), suspendedReason: sub.suspended_reason || null
            }
        });
    })
);

/** Runs one change on a shop's subscription and records who did it. */
async function change(req, action, details, run) {
    const id = parseId(req.params.id);
    return pool.withTransaction(async (client) => {
        const sub = (await client.query("SELECT id, status FROM subscriptions WHERE shop_id = $1 FOR UPDATE", [id])).rows[0];
        if (!sub) throw new HttpError(404, "That shop has no subscription yet.");
        await run(client, sub, id);
        await logAudit(client, { shopId: id, userId: null, action, entityType: "subscription", entityId: sub.id, details: Object.assign({ adminId: req.admin.id, adminName: req.admin.fullName }, details), ip: req.ip });
    });
}

router.post(
    "/shops/:id/suspend",
    asyncHandler(async (req, res) => {
        const reason = cleanText(req.body.reason, "the reason", { required: true, max: 300 });
        await change(req, "admin.suspend", { reason }, async (client, sub, id) => {
            if (sub.status === "suspended") throw new HttpError(409, "This shop is already suspended.");
            await client.query(
                "UPDATE subscriptions SET status = 'suspended', suspended_at = NOW(), suspended_reason = $2 WHERE shop_id = $1", [id, reason]);
        });
        res.json({ success: true, data: { ok: true } });
    })
);

router.post(
    "/shops/:id/reactivate",
    asyncHandler(async (req, res) => {
        await change(req, "admin.reactivate", {}, async (client, sub, id) => {
            if (sub.status !== "suspended") throw new HttpError(409, "This shop is not suspended.");
            // Back to what its dates say: paid time left -> active (or cancelled if it had been cancelled),
            // free trial left -> trialing, otherwise expired (past_due if it had paid before).
            await client.query(
                `UPDATE subscriptions
                    SET status = CASE
                          WHEN current_period_end > NOW() THEN (CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled' ELSE 'active' END)
                          WHEN current_period_end IS NULL AND trial_ends_at > NOW() THEN 'trialing'
                          WHEN current_period_end IS NOT NULL THEN 'past_due'
                          ELSE 'expired' END,
                        suspended_at = NULL, suspended_reason = NULL
                  WHERE shop_id = $1`, [id]);
        });
        res.json({ success: true, data: { ok: true } });
    })
);

router.post(
    "/shops/:id/grant-days",
    asyncHandler(async (req, res) => {
        const days = Number(req.body.days);
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, "Days must be a whole number from 1 to 365.");
        const reason = cleanText(req.body.reason, "the reason", { required: true, max: 300 });
        await change(req, "admin.grant_days", { days, reason }, async (client, sub, id) => {
            await client.query(
                `UPDATE subscriptions SET
                    trial_ends_at = CASE WHEN status = 'trialing' THEN GREATEST(NOW(), trial_ends_at) + make_interval(days => $2) ELSE trial_ends_at END,
                    current_period_start = CASE WHEN status IN ('expired', 'past_due') THEN NOW() ELSE current_period_start END,
                    current_period_end = CASE WHEN status = 'trialing' THEN current_period_end
                                              ELSE GREATEST(NOW(), COALESCE(current_period_end, NOW())) + make_interval(days => $2) END,
                    status = CASE WHEN status IN ('expired', 'past_due') THEN 'active' ELSE status END
                  WHERE shop_id = $1`, [id, days]);
        });
        res.json({ success: true, data: { ok: true } });
    })
);

// A customer paid by another way (cash, a direct mobile money transfer) and quoted their DUKA-... reference.
router.post(
    "/payments/confirm",
    asyncHandler(async (req, res) => {
        const merchantRef = cleanText(req.body.merchantRef, "the order reference", { required: true, max: 60 });
        const reference = cleanText(req.body.reference, "the payment reference (for example the mobile money transaction id, or CASH-date)", { required: true, max: 80 });
        const result = await pool.withTransaction(async (client) => {
            const pay = (await client.query(
                "SELECT id, shop_id, status FROM subscription_payments WHERE merchant_ref = $1 FOR UPDATE", [merchantRef])).rows[0];
            if (!pay) throw new HttpError(404, "No order has that reference.");
            if (pay.status === "successful") throw new HttpError(409, "This order is already confirmed.");
            try {
                await client.query(
                    "UPDATE subscription_payments SET provider = 'manual', provider_ref = $2, method = 'manual', failure_reason = NULL WHERE id = $1",
                    [pay.id, reference]);
            } catch (error) {
                if (error.code === "23505") throw new HttpError(409, "That payment reference was already used for another order.");
                throw error;
            }
            const applied = await S.applySuccessfulPayment(client, {
                merchantRef, providerRef: reference, method: "manual", rawResponse: { confirmedByAdminId: req.admin.id }
            });
            await logAudit(client, {
                shopId: pay.shop_id, userId: null, action: "admin.confirm_payment",
                entityType: "subscription_payment", entityId: pay.id,
                details: { merchantRef, reference, adminId: req.admin.id, adminName: req.admin.fullName }, ip: req.ip
            });
            return applied;
        });
        res.json({ success: true, data: { periodEnd: result && result.periodEnd ? iso(result.periodEnd) : null } });
    })
);

module.exports = router;
