// routes/customers.js - customers, what they owe, and taking their repayments.
//   GET   /api/customers?search=                everyone   find customers (the till uses this)
//   POST  /api/customers                        everyone   quick add (owner may add a limit and old debt)
//   GET   /api/customers/overview               owner      debtors list: owed, how old, overdue
//   GET   /api/customers/:id                    owner      profile with the debt ledger
//   PATCH /api/customers/:id                    owner      change details, credit limit, switch off
//   POST  /api/customers/:id/payments           owner      receive a payment (part or all of the debt)
//   GET   /api/customers/:id/payments/:pid      owner      one payment, for its receipt
//   POST  /api/customers/:id/payments/:pid/void owner      cancel a wrong payment
//
// customers.balance (what they owe us) is changed ONLY together with a customer_ledger line,
// in the same transaction. Repayments count against the OLDEST debt first, so the age of a debt
// is worked out from the ledger (see DEBT_SINCE_CTE) and no per-sale bookkeeping can drift.
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { formatPhone } = require("../utils/phone");
const { cleanText, parseId, has } = require("../utils/validators");
const { escapeLike, cleanDate } = require("../utils/productInput");
const { cleanPhoneOptional, cleanCreditLimit, parseDebtPayment, parseNewCustomer } = require("../utils/customerInput");
const { ugx } = require("../utils/money");
const { SHOP_TZ } = require("../utils/time");
const { logAudit } = require("../utils/audit");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

const COLUMNS = "id, name, phone, location, customer_type, credit_limit, balance, notes, is_active";
const PAYMENT_CONSTRAINT = "payments_shop_id_client_uuid_key";
const TODAY = `(NOW() AT TIME ZONE '${SHOP_TZ}')::date`;

function toCustomer(row) {
    return {
        id: row.id, name: row.name, phone: row.phone, phoneDisplay: formatPhone(row.phone),
        location: row.location, customerType: row.customer_type, creditLimit: row.credit_limit,
        balance: row.balance, // what they owe us
        notes: row.notes, isActive: row.is_active
    };
}

async function overdueDaysFor(db, shopId) {
    const { rows } = await db.query("SELECT value FROM settings WHERE shop_id = $1 AND key = 'overdue_days'", [shopId]);
    const n = rows[0] ? parseInt(rows[0].value, 10) : 30;
    return Number.isFinite(n) && n > 0 ? n : 30;
}

/*
 * How old is a customer's debt?
 * Payments (and credit notes) pay off the OLDEST debt first. So, going from the newest credit
 * entry backwards, we add up entries until they cover what is owed now. The oldest entry we needed
 * is where the unpaid debt starts. Sales that were voided are left out.
 */
const DEBT_SINCE_CTE = `
    items AS (
        SELECT cl.customer_id, cl.created_at, cl.amount,
               SUM(cl.amount) OVER (PARTITION BY cl.customer_id ORDER BY cl.created_at DESC, cl.id DESC) AS running
        FROM customer_ledger cl
        JOIN customers c0 ON c0.id = cl.customer_id AND c0.balance > 0
        LEFT JOIN sales s ON s.id = cl.sale_id
        WHERE cl.shop_id = $1 AND cl.amount > 0
          AND cl.entry_type IN ('credit_sale', 'opening_balance', 'adjustment')
          AND (cl.sale_id IS NULL OR s.status = 'completed')
    ),
    since AS (
        SELECT i.customer_id, MIN(i.created_at) AS debt_since
        FROM items i JOIN customers c ON c.id = i.customer_id
        WHERE i.running - i.amount < c.balance
        GROUP BY i.customer_id
    ),
    paid AS (
        SELECT customer_id, MAX(paid_at) AS last_payment
        FROM payments WHERE shop_id = $1 AND kind = 'debt_payment' AND voided_at IS NULL
        GROUP BY customer_id
    ),
    base AS (
        SELECT c.id, c.name, c.phone, c.location, c.customer_type, c.credit_limit, c.balance, c.notes, c.is_active,
               s.debt_since, p.last_payment,
               CASE WHEN c.balance > 0 AND s.debt_since IS NOT NULL
                    THEN (${TODAY} - (s.debt_since AT TIME ZONE '${SHOP_TZ}')::date) END AS days_owed
        FROM customers c
        LEFT JOIN since s ON s.customer_id = c.id
        LEFT JOIN paid p ON p.customer_id = c.id
        WHERE c.shop_id = $1 AND c.is_active
    )`;

// ---------------------------------------------------------------------
// Finding customers (the till)
// ---------------------------------------------------------------------
router.get(
    "/",
    asyncHandler(async (req, res) => {
        const params = [req.user.shopId];
        let where = "shop_id = $1 AND is_active";

        const search = String(req.query.search || "").trim().slice(0, 80);
        if (search) {
            params.push(`%${escapeLike(search)}%`);
            // phone is stored as digits only, so also compare digits typed by the user
            const digits = search.replace(/[^0-9]/g, "");
            if (digits.length >= 3) {
                params.push(`%${digits.replace(/^0/, "")}%`);
                where += ` AND (name ILIKE $2 OR phone LIKE $3)`;
            } else {
                where += ` AND name ILIKE $2`;
            }
        }
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

        const { rows } = await pool.query(
            `SELECT ${COLUMNS} FROM customers WHERE ${where} ORDER BY LOWER(name) LIMIT ${limit}`, params
        );
        res.json({ success: true, data: { customers: rows.map(toCustomer) } });
    })
);

// ---------------------------------------------------------------------
// Add a customer
// ---------------------------------------------------------------------
router.post(
    "/",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const input = parseNewCustomer(req.body, req.user.role === "owner");

        const customer = await pool.withTransaction(async (client) => {
            const created = await client.query(
                `INSERT INTO customers (shop_id, name, phone, location, customer_type, credit_limit, notes, balance)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
                [shopId, input.name, input.phone, input.location, input.customerType, input.creditLimit,
                 input.notes, input.openingBalance]
            );
            if (input.openingBalance > 0) {
                // Debt from before Duka goes in the ledger too, dated from when it started, so its age is right.
                await client.query(
                    `INSERT INTO customer_ledger (shop_id, customer_id, entry_type, amount, balance_after, note,
                                                  created_by, created_at)
                     VALUES ($1, $2, 'opening_balance', $3, $3, 'Balance brought forward', $4,
                             (COALESCE($5::date, ${TODAY})::timestamp + interval '12 hours') AT TIME ZONE '${SHOP_TZ}')`,
                    [shopId, created.rows[0].id, input.openingBalance, req.user.id, input.owedSince]
                );
            }
            await logAudit(client, {
                shopId, userId: req.user.id, action: "customer.create", entityType: "customer",
                entityId: created.rows[0].id, details: { opening: input.openingBalance }, ip: req.ip
            });
            return created.rows[0];
        });
        res.status(201).json({ success: true, message: "Customer added.", data: { customer: toCustomer(customer) } });
    })
);

// ---------------------------------------------------------------------
// Debtors list
// ---------------------------------------------------------------------
router.get(
    "/overview",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const overdueDays = await overdueDaysFor(pool, shopId);
        const params = [shopId, overdueDays];
        const add = (value) => { params.push(value); return `$${params.length}`; };
        // "$2::int > 0" is always true; it makes sure the overdue-days value is used in every query below.
        const where = ["$2::int > 0"];

        const filter = req.query.filter || "all";
        if (filter === "owing") where.push("balance > 0");
        else if (filter === "overdue") where.push("balance > 0 AND days_owed > $2");
        else if (filter !== "all") throw new HttpError(400, "Unknown filter.");

        const search = String(req.query.search || "").trim().slice(0, 80);
        if (search) {
            const like = add(`%${escapeLike(search)}%`);
            const digits = search.replace(/[^0-9]/g, "");
            if (digits.length >= 3) {
                const phoneLike = add(`%${digits.replace(/^0/, "")}%`);
                where.push(`(name ILIKE ${like} OR phone LIKE ${phoneLike})`);
            } else {
                where.push(`name ILIKE ${like}`);
            }
        }

        const SORTS = {
            balance: "balance DESC, LOWER(name)",
            oldest: "days_owed DESC NULLS LAST, balance DESC, LOWER(name)",
            name: "LOWER(name)"
        };
        const sort = SORTS[req.query.sort || "balance"];
        if (!sort) throw new HttpError(400, "Unknown sort.");

        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const whereSql = "WHERE " + where.join(" AND ");

        const totals = (await pool.query(
            `WITH ${DEBT_SINCE_CTE}
             SELECT COUNT(*) FILTER (WHERE balance > 0) AS owing,
                    COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0)::bigint AS total_owed,
                    COUNT(*) FILTER (WHERE balance > 0 AND days_owed > $2) AS overdue,
                    COALESCE(SUM(balance) FILTER (WHERE balance > 0 AND days_owed > $2), 0)::bigint AS overdue_amount
             FROM base`,
            [shopId, overdueDays]
        )).rows[0];

        const count = (await pool.query(
            `WITH ${DEBT_SINCE_CTE} SELECT COUNT(*) AS n FROM base ${whereSql}`, params
        )).rows[0].n;

        const limitParam = add(limit);
        const offsetParam = add((page - 1) * limit);
        const { rows } = await pool.query(
            `WITH ${DEBT_SINCE_CTE}
             SELECT * FROM base ${whereSql} ORDER BY ${sort} LIMIT ${limitParam} OFFSET ${offsetParam}`,
            params
        );

        res.json({
            success: true,
            data: {
                customers: rows.map((r) => ({
                    ...toCustomer(r),
                    debtSince: r.debt_since, daysOwed: r.days_owed, lastPaymentAt: r.last_payment,
                    overdue: r.balance > 0 && r.days_owed !== null && r.days_owed > overdueDays
                })),
                totals: {
                    owing: totals.owing, totalOwed: totals.total_owed,
                    overdue: totals.overdue, overdueAmount: totals.overdue_amount
                },
                overdueDays, page, limit, total: count, hasMore: page * limit < count
            }
        });
    })
);

// ---------------------------------------------------------------------
// Profile and ledger
// ---------------------------------------------------------------------
router.get(
    "/:id",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const customer = (await pool.query(`SELECT ${COLUMNS} FROM customers WHERE id = $1 AND shop_id = $2`, [id, shopId])).rows[0];
        if (!customer) throw new HttpError(404, "That customer could not be found.");

        const overdueDays = await overdueDaysFor(pool, shopId);
        const age = (await pool.query(
            `WITH ${DEBT_SINCE_CTE} SELECT debt_since, days_owed, last_payment FROM base WHERE id = $2`, [shopId, id]
        )).rows[0] || {};

        const ledger = (await pool.query(
            `SELECT cl.id, cl.entry_type, cl.amount, cl.balance_after, cl.note, cl.created_at, cl.sale_id, cl.payment_id,
                    s.receipt_number AS sale_receipt, s.status AS sale_status,
                    p.receipt_number AS payment_receipt, p.method AS payment_method, p.voided_at AS payment_voided,
                    u.full_name AS by_name
             FROM customer_ledger cl
             LEFT JOIN sales s ON s.id = cl.sale_id
             LEFT JOIN payments p ON p.id = cl.payment_id
             LEFT JOIN users u ON u.id = cl.created_by
             WHERE cl.customer_id = $1 AND cl.shop_id = $2
             ORDER BY cl.created_at DESC, cl.id DESC LIMIT 200`,
            [id, shopId]
        )).rows;

        const stats = (await pool.query(
            `SELECT COUNT(*) AS sales, COALESCE(SUM(total_amount), 0)::bigint AS total
             FROM sales WHERE customer_id = $1 AND shop_id = $2 AND status = 'completed'`,
            [id, shopId]
        )).rows[0];

        res.json({
            success: true,
            data: {
                customer: toCustomer(customer),
                stats: { sales: stats.sales, totalSold: stats.total },
                debt: {
                    since: age.debt_since || null, daysOwed: age.days_owed === undefined ? null : age.days_owed,
                    lastPaymentAt: age.last_payment || null, overdueDays,
                    overdue: customer.balance > 0 && age.days_owed !== null && age.days_owed !== undefined && age.days_owed > overdueDays
                },
                ledger: ledger.map((l) => ({
                    id: l.id, type: l.entry_type, amount: l.amount, balanceAfter: l.balance_after, note: l.note,
                    createdAt: l.created_at, by: l.by_name,
                    saleId: l.sale_id, saleReceipt: l.sale_receipt, saleVoided: l.sale_status === "voided",
                    paymentId: l.payment_id, paymentReceipt: l.payment_receipt, paymentMethod: l.payment_method,
                    paymentVoided: l.payment_voided !== null && l.payment_voided !== undefined
                }))
            }
        });
    })
);

// ---------------------------------------------------------------------
// Change details
// ---------------------------------------------------------------------
router.patch(
    "/:id",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const body = req.body || {};
        const existing = (await pool.query("SELECT id, name, balance FROM customers WHERE id = $1 AND shop_id = $2", [id, shopId])).rows[0];
        if (!existing) throw new HttpError(404, "That customer could not be found.");

        const changes = {};
        if (has(body, "name")) changes.name = cleanText(body.name, "the customer's name");
        if (has(body, "phone")) changes.phone = cleanPhoneOptional(body.phone);
        if (has(body, "location")) changes.location = cleanText(body.location, "the location", { required: false, max: 150 });
        if (has(body, "notes")) changes.notes = cleanText(body.notes, "the notes", { required: false, max: 500 });
        if (has(body, "customerType")) {
            if (!["retail", "wholesale"].includes(body.customerType)) throw new HttpError(400, "Choose retail or wholesale.");
            changes.customer_type = body.customerType;
        }
        if (has(body, "creditLimit")) changes.credit_limit = cleanCreditLimit(body.creditLimit);
        if (has(body, "isActive")) {
            if (typeof body.isActive !== "boolean") throw new HttpError(400, "Choose on or off.");
            if (!body.isActive && existing.balance !== 0) {
                throw new HttpError(409, `${existing.name} still owes ${ugx(existing.balance)}. Collect or settle it before switching them off.`);
            }
            changes.is_active = body.isActive;
        }

        const columns = Object.keys(changes);
        if (columns.length === 0) throw new HttpError(400, "There is nothing to save.");
        const assignments = columns.map((c, i) => `${c} = $${i + 1}`);
        const values = columns.map((c) => changes[c]);
        values.push(id, shopId);
        const { rows } = await pool.query(
            `UPDATE customers SET ${assignments.join(", ")} WHERE id = $${values.length - 1} AND shop_id = $${values.length}
             RETURNING ${COLUMNS}`,
            values
        );
        await logAudit(pool, {
            shopId, userId: req.user.id, action: "customer.update", entityType: "customer", entityId: id,
            details: { changed: columns }, ip: req.ip
        });
        res.json({ success: true, message: "Saved.", data: { customer: toCustomer(rows[0]) } });
    })
);

// ---------------------------------------------------------------------
// Receive a repayment
// ---------------------------------------------------------------------
async function findPayment(db, shopId, clientUuid) {
    return (await db.query(
        "SELECT id FROM payments WHERE shop_id = $1 AND client_uuid = $2", [shopId, clientUuid]
    )).rows[0] || null;
}

router.post(
    "/:id/payments",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const input = parseDebtPayment(req.body);

        let paymentId;
        let duplicate = false;
        try {
            const result = await pool.withTransaction(async (client) => {
                const customer = (await client.query(
                    "SELECT id, name, balance FROM customers WHERE id = $1 AND shop_id = $2 FOR UPDATE", [id, shopId]
                )).rows[0];
                if (!customer) throw new HttpError(404, "That customer could not be found.");

                // Seen this exact payment already? (checked after the lock, so two taps cannot both pass)
                const seen = await findPayment(client, shopId, input.clientUuid);
                if (seen) return { id: seen.id, duplicate: true };

                if (customer.balance <= 0) throw new HttpError(400, `${customer.name} does not owe anything.`);
                if (input.amount > customer.balance) {
                    throw new HttpError(400, `${customer.name} only owes ${ugx(customer.balance)}.`);
                }

                const counter = await client.query(
                    `INSERT INTO receipt_counters (shop_id, counter_type, last_number) VALUES ($1, 'payment', 1)
                     ON CONFLICT (shop_id, counter_type)
                     DO UPDATE SET last_number = receipt_counters.last_number + 1 RETURNING last_number`,
                    [shopId]
                );
                const receiptNumber = "P" + String(counter.rows[0].last_number).padStart(6, "0");

                const payment = await client.query(
                    `INSERT INTO payments (shop_id, client_uuid, kind, customer_id, amount, method, mobile_provider,
                                           reference, receipt_number, note, received_by)
                     VALUES ($1, $2, 'debt_payment', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
                    [shopId, input.clientUuid, id, input.amount, input.method, input.provider, input.reference,
                     receiptNumber, input.note, req.user.id]
                );

                const newBalance = customer.balance - input.amount;
                await client.query("UPDATE customers SET balance = $1 WHERE id = $2", [newBalance, id]);
                await client.query(
                    `INSERT INTO customer_ledger (shop_id, customer_id, entry_type, amount, balance_after, payment_id,
                                                  note, created_by)
                     VALUES ($1, $2, 'payment', $3, $4, $5, $6, $7)`,
                    [shopId, id, -input.amount, newBalance, payment.rows[0].id, `Payment ${receiptNumber}`, req.user.id]
                );
                await logAudit(client, {
                    shopId, userId: req.user.id, action: "customer.payment", entityType: "customer", entityId: id,
                    details: { receipt: receiptNumber, amount: input.amount, method: input.method }, ip: req.ip
                });
                return { id: payment.rows[0].id, duplicate: false };
            });
            paymentId = result.id;
            duplicate = result.duplicate;
        } catch (error) {
            // Two taps at the same instant: the database stopped the second one. Return the first.
            if (error.code === "23505" && error.constraint === PAYMENT_CONSTRAINT) {
                const again = await findPayment(pool, shopId, input.clientUuid);
                if (!again) throw error;
                paymentId = again.id;
                duplicate = true;
            } else {
                throw error;
            }
        }

        res.status(duplicate ? 200 : 201).json({
            success: true,
            message: duplicate ? "This payment was already saved." : "Payment received.",
            data: { paymentId, duplicate }
        });
    })
);

// ---------------------------------------------------------------------
// One payment, with everything its receipt needs
// ---------------------------------------------------------------------
router.get(
    "/:id/payments/:paymentId",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const paymentId = parseId(req.params.paymentId);

        const row = (await pool.query(
            `SELECT p.id, p.receipt_number, p.amount, p.method, p.mobile_provider, p.reference, p.note, p.paid_at,
                    p.voided_at, p.void_reason, c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
                    c.balance AS customer_balance, u.full_name AS by_name,
                    (SELECT balance_after FROM customer_ledger WHERE payment_id = p.id AND entry_type = 'payment'
                     ORDER BY id LIMIT 1) AS balance_after
             FROM payments p
             JOIN customers c ON c.id = p.customer_id
             LEFT JOIN users u ON u.id = p.received_by
             WHERE p.id = $1 AND p.customer_id = $2 AND p.shop_id = $3 AND p.kind = 'debt_payment'`,
            [paymentId, id, shopId]
        )).rows[0];
        if (!row) throw new HttpError(404, "That payment could not be found.");

        const shop = (await pool.query(
            "SELECT name, address, phone, tin, logo, receipt_footer, receipt_paper FROM shops WHERE id = $1", [shopId]
        )).rows[0];

        res.json({
            success: true,
            data: {
                payment: {
                    id: row.id, receiptNumber: row.receipt_number, amount: row.amount, method: row.method,
                    provider: row.mobile_provider, reference: row.reference, note: row.note, paidAt: row.paid_at,
                    receivedBy: row.by_name, voided: row.voided_at !== null, voidReason: row.void_reason,
                    balanceAfter: row.balance_after, balanceBefore: row.balance_after === null ? null : row.balance_after + row.amount,
                    customer: { id: row.customer_id, name: row.customer_name, phone: row.customer_phone, balance: row.customer_balance },
                    shop: {
                        name: shop.name, address: shop.address, phone: shop.phone, tin: shop.tin,
                        logo: shop.logo, footer: shop.receipt_footer, paper: shop.receipt_paper
                    }
                }
            }
        });
    })
);

// ---------------------------------------------------------------------
// Cancel a wrong payment: the debt comes back, the payment stays marked as cancelled
// ---------------------------------------------------------------------
router.post(
    "/:id/payments/:paymentId/void",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const paymentId = parseId(req.params.paymentId);
        const reason = cleanText(req.body.reason, "the reason", { max: 300 });

        const balance = await pool.withTransaction(async (client) => {
            const customer = (await client.query(
                "SELECT id, balance FROM customers WHERE id = $1 AND shop_id = $2 FOR UPDATE", [id, shopId]
            )).rows[0];
            if (!customer) throw new HttpError(404, "That customer could not be found.");

            const payment = (await client.query(
                `SELECT * FROM payments WHERE id = $1 AND customer_id = $2 AND shop_id = $3 AND kind = 'debt_payment' FOR UPDATE`,
                [paymentId, id, shopId]
            )).rows[0];
            if (!payment) throw new HttpError(404, "That payment could not be found.");
            if (payment.voided_at) throw new HttpError(409, "This payment was already cancelled.");

            await client.query("UPDATE payments SET voided_at = NOW(), void_reason = $1 WHERE id = $2", [reason, paymentId]);
            const newBalance = customer.balance + payment.amount;
            await client.query("UPDATE customers SET balance = $1 WHERE id = $2", [newBalance, id]);
            await client.query(
                `INSERT INTO customer_ledger (shop_id, customer_id, entry_type, amount, balance_after, payment_id, note, created_by)
                 VALUES ($1, $2, 'void_reversal', $3, $4, $5, $6, $7)`,
                [shopId, id, payment.amount, newBalance, paymentId, `Payment ${payment.receipt_number} cancelled`, req.user.id]
            );
            await logAudit(client, {
                shopId, userId: req.user.id, action: "customer.payment_void", entityType: "customer", entityId: id,
                details: { receipt: payment.receipt_number, amount: payment.amount, reason }, ip: req.ip
            });
            return newBalance;
        });

        res.json({ success: true, message: "Payment cancelled. The money is owed again.", data: { balance } });
    })
);

module.exports = router;
