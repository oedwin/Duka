// routes/sales.js - the till, sales history, receipts, voids and returns.
//   GET    /api/sales/catalog        products for the till (search, barcode, ids)     everyone
//   POST   /api/sales                complete a sale, or hold one for later           everyone
//   GET    /api/sales                history with filters and totals                  owner: all, cashier: own
//   GET    /api/sales/held           sales put on hold                                owner: all, cashier: own
//   DELETE /api/sales/held/:id       throw away a held sale                           owner / the cashier who held it
//   GET    /api/sales/:id            one sale with items, payments, returns, receipt header
//   POST   /api/sales/:id/void       cancel a sale (restores stock and debt)          owner
//   POST   /api/sales/:id/returns    take items back and refund                       owner
//
// SAFETY RULES
//  * A sale is ONE database transaction: stock, receipt number, payments and debt all
//    save together, or none of them do.
//  * Every sale carries a unique id made by the browser (clientUuid). Sending the same
//    sale twice (double tap, retry, bad network) returns the first sale, never a second.
//  * Stock rows are locked while a sale is written, so two tills cannot both sell the last item.
//  * Voids and returns never delete anything: they add records and keep a reason.
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { cleanText, wholeNumber, parseId, cleanUuid } = require("../utils/validators");
const { escapeLike, cleanDate } = require("../utils/productInput");
const { parseSaleInput, buildLines, applyDiscount, findBelowCost } = require("../utils/saleInput");
const { lowStockDefault, loadUnitsAndPrices } = require("../utils/productData");
const { friendlyStock } = require("../utils/units");
const { ugx } = require("../utils/money");
const { formatPhone } = require("../utils/phone");
const { derivedUuid } = require("../utils/ids");
const { SHOP_TZ } = require("../utils/time");
const { logAudit } = require("../utils/audit");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

const SALE_CONSTRAINT = "sales_shop_id_client_uuid_key";

// ---------------------------------------------------------------------
// Reading one sale (used by the receipt, history and every action's answer)
// ---------------------------------------------------------------------
async function loadSale(db, shopId, id) {
    const saleResult = await db.query(
        `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.balance AS customer_balance,
                u.full_name AS served_by_name, vu.full_name AS voided_by_name
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN users u ON u.id = s.served_by
         LEFT JOIN users vu ON vu.id = s.voided_by
         WHERE s.id = $1 AND s.shop_id = $2`,
        [id, shopId]
    );
    const row = saleResult.rows[0];
    if (!row) return null;

    const items = (await db.query(
        `SELECT si.id, si.product_id, si.unit_id, si.product_name, si.unit_name, si.quantity,
                si.factor_to_base, si.unit_price, si.line_total, si.cost_total,
                COALESCE((SELECT SUM(r.quantity) FROM sale_returns r WHERE r.sale_item_id = si.id), 0) AS returned_qty
         FROM sale_items si WHERE si.sale_id = $1 ORDER BY si.id`,
        [id]
    )).rows;

    const payments = (await db.query(
        `SELECT id, method, mobile_provider, reference, amount, paid_at, voided_at
         FROM payments WHERE sale_id = $1 ORDER BY id`,
        [id]
    )).rows;

    const returns = (await db.query(
        `SELECT r.id, r.sale_item_id, r.quantity, r.refund_amount, r.refund_method, r.reason,
                r.created_at, u.full_name AS by_name
         FROM sale_returns r LEFT JOIN users u ON u.id = r.created_by
         WHERE r.sale_id = $1 ORDER BY r.id`,
        [id]
    )).rows;

    const shop = (await db.query(
        `SELECT name, address, phone, tin, logo, receipt_footer, receipt_paper FROM shops WHERE id = $1`,
        [shopId]
    )).rows[0];

    // Money given back for returned items, and what that part of the goods had cost us.
    const refundedTotal = returns.reduce((sum, r) => sum + r.refund_amount, 0);
    const returnedCost = items.reduce(
        (sum, i) => sum + (i.returned_qty > 0 ? Math.round((i.cost_total * i.returned_qty) / i.quantity) : 0), 0
    );

    return {
        id: row.id,
        receiptNumber: row.receipt_number,
        status: row.status,
        saleType: row.sale_type,
        createdAt: row.created_at,
        notes: row.notes,
        customer: row.customer_id
            ? {
                id: row.customer_id, name: row.customer_name, phone: row.customer_phone,
                phoneDisplay: formatPhone(row.customer_phone), balance: row.customer_balance
            }
            : null,
        servedBy: row.served_by_name,
        servedById: row.served_by,
        subtotal: row.subtotal,
        discountAmount: row.discount_amount,
        totalAmount: row.total_amount,
        amountPaid: row.amount_paid,
        balanceDue: row.balance_due,
        refundedTotal,
        netTotal: row.total_amount - refundedTotal,
        cogs: row.cogs,
        returnedCost,
        items: items.map((i) => ({
            id: i.id, productId: i.product_id, unitId: i.unit_id, productName: i.product_name,
            unitName: i.unit_name, quantity: i.quantity, factorToBase: i.factor_to_base,
            unitPrice: i.unit_price, lineTotal: i.line_total, returnedQty: i.returned_qty
        })),
        payments: payments.map((p) => ({
            id: p.id, method: p.method, provider: p.mobile_provider, reference: p.reference,
            amount: p.amount, paidAt: p.paid_at, voided: p.voided_at !== null
        })),
        returns: returns.map((r) => ({
            id: r.id, saleItemId: r.sale_item_id, quantity: r.quantity, refundAmount: r.refund_amount,
            refundMethod: r.refund_method, reason: r.reason, createdAt: r.created_at, by: r.by_name
        })),
        voidedAt: row.voided_at,
        voidReason: row.void_reason,
        voidedBy: row.voided_by_name,
        shop: {
            name: shop.name, address: shop.address, phone: shop.phone, tin: shop.tin,
            logo: shop.logo, footer: shop.receipt_footer, paper: shop.receipt_paper
        }
    };
}

/** What each role may see: cashiers never get cost or profit; they only see their own sales. */
function forUser(sale, user) {
    if (user.role === "owner") {
        sale.profit = sale.status === "completed"
            ? sale.netTotal - (sale.cogs - sale.returnedCost)
            : null;
        return sale;
    }
    delete sale.cogs;
    delete sale.returnedCost;
    return sale;
}

function assertCanSee(sale, user) {
    if (!sale || (user.role !== "owner" && sale.servedById !== user.id)) {
        throw new HttpError(404, "That sale could not be found.");
    }
}

// ---------------------------------------------------------------------
// The till's product list
// ---------------------------------------------------------------------
router.get(
    "/catalog",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const params = [shopId];
        const where = ["p.shop_id = $1", "p.is_active"];
        const add = (value) => { params.push(value); return `$${params.length}`; };

        if (req.query.barcode) {
            where.push(`p.barcode = ${add(String(req.query.barcode).trim().slice(0, 60))}`);
        } else if (req.query.ids) {
            const ids = String(req.query.ids).split(",").slice(0, 100).map((v) => parseId(v));
            where.push(`p.id = ANY(${add(ids)}::bigint[])`);
        } else {
            const search = String(req.query.search || "").trim().slice(0, 80);
            if (search) {
                const like = add(`%${escapeLike(search)}%`);
                where.push(`(p.name ILIKE ${like} OR p.barcode ILIKE ${like} OR p.sku ILIKE ${like})`);
            }
        }
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
        const customerId = req.query.customerId ? parseId(req.query.customerId) : null;

        const { rows } = await pool.query(
            `SELECT p.id, p.name, p.barcode, p.stock_base, p.reorder_level
             FROM products p WHERE ${where.join(" AND ")}
             ORDER BY LOWER(p.name) LIMIT ${limit}`,
            params
        );
        const { units, prices } = await loadUnitsAndPrices(pool, rows.map((r) => r.id));

        // No cost prices here, ever. Customer-specific prices only for the chosen customer.
        res.json({
            success: true,
            data: {
                products: rows.map((r) => ({
                    id: r.id,
                    name: r.name,
                    barcode: r.barcode,
                    stockBase: r.stock_base,
                    units: units.get(r.id) || [],
                    prices: (prices.get(r.id) || []).filter((p) => p.customerId === null || p.customerId === customerId)
                }))
            }
        });
    })
);

// ---------------------------------------------------------------------
// Writing a sale
// ---------------------------------------------------------------------
async function findByClientUuid(db, shopId, clientUuid) {
    const { rows } = await db.query("SELECT id FROM sales WHERE shop_id = $1 AND client_uuid = $2", [shopId, clientUuid]);
    return rows[0] || null;
}

async function writeSale(client, user, input, ip) {
    const shopId = user.shopId;
    const completed = input.status === "completed";

    const shop = (await client.query("SELECT allow_negative_stock FROM shops WHERE id = $1", [shopId])).rows[0];

    // Lock order is always: customer, then products (by id), so two sales can never deadlock.
    let customer = null;
    if (input.customerId) {
        customer = (await client.query(
            `SELECT id, name, balance, credit_limit FROM customers
             WHERE id = $1 AND shop_id = $2 AND is_active FOR UPDATE`,
            [input.customerId, shopId]
        )).rows[0];
        if (!customer) throw new HttpError(400, "That customer could not be found.");
    }

    const productIds = [...new Set(input.items.map((i) => i.productId))].sort((a, b) => a - b);
    const productRows = (await client.query(
        `SELECT id, name, cost_price, stock_base FROM products
         WHERE id = ANY($1::bigint[]) AND shop_id = $2 AND is_active
         ORDER BY id FOR UPDATE`,
        [productIds, shopId]
    )).rows;
    const products = new Map(productRows.map((p) => [p.id, p]));

    const unitRows = (await client.query(
        "SELECT id, product_id, name, factor_to_base FROM product_units WHERE product_id = ANY($1::bigint[])",
        [productIds]
    )).rows;
    const unitsById = new Map(unitRows.map((u) => [u.id, u]));
    const unitsByProduct = new Map();
    for (const u of unitRows) {
        if (!unitsByProduct.has(u.product_id)) unitsByProduct.set(u.product_id, []);
        unitsByProduct.get(u.product_id).push({ name: u.name, factor: u.factor_to_base });
    }

    const { lines, subtotal, cogs, needBase } = buildLines(input.items, products, unitsById);
    const discount = applyDiscount(subtotal, input.discount);
    const total = subtotal - discount;

    let paid = 0;
    let balanceDue = total;
    let receiptNumber = null;

    if (completed) {
        // 1. Enough stock? (unless this shop allows selling below zero)
        if (!shop.allow_negative_stock) {
            for (const [productId, need] of needBase) {
                const product = products.get(productId);
                if (product.stock_base < need) {
                    throw new HttpError(409,
                        `Not enough stock for "${product.name}": only ${friendlyStock(Math.max(product.stock_base, 0), unitsByProduct.get(productId))} left.`,
                        { code: "NO_STOCK" });
                }
            }
        }

        // 2. Selling below cost needs a confirmation from the till.
        if (!input.allowBelowCost) {
            const below = findBelowCost(lines, total, cogs);
            if (below.length > 0) {
                throw new HttpError(409, `This sale is below cost: ${below.join(", ")}.`, { code: "BELOW_COST", details: below });
            }
        }

        // 3. Payments, and whatever is left becomes the customer's debt.
        paid = input.payments.reduce((sum, p) => sum + p.amount, 0);
        if (paid > total) {
            throw new HttpError(400, `The payments (${ugx(paid)}) are more than the total (${ugx(total)}).`);
        }
        balanceDue = total - paid;

        if (balanceDue > 0) {
            if (!customer) {
                throw new HttpError(400, "Choose a customer to sell on credit, or take the full payment.", { code: "NEEDS_CUSTOMER" });
            }
            const newBalance = customer.balance + balanceDue;
            const overLimit = customer.credit_limit !== null && newBalance > customer.credit_limit;
            if (overLimit && !(input.allowOverCreditLimit && user.role === "owner")) {
                throw new HttpError(409,
                    `This sale would take ${customer.name} to ${ugx(newBalance)}, above their credit limit of ${ugx(customer.credit_limit)}.`,
                    { code: "CREDIT_LIMIT", details: { canOverride: user.role === "owner" } });
            }
        }

        // 4. Next receipt number (the row lock makes numbers sequential with no gaps).
        const counter = await client.query(
            `INSERT INTO receipt_counters (shop_id, counter_type, last_number) VALUES ($1, 'sale', 1)
             ON CONFLICT (shop_id, counter_type)
             DO UPDATE SET last_number = receipt_counters.last_number + 1
             RETURNING last_number`,
            [shopId]
        );
        receiptNumber = String(counter.rows[0].last_number).padStart(6, "0");
    }

    // Resuming a held sale replaces it (same transaction, so it can never be counted twice).
    if (input.resumeHeldId) {
        const removed = await client.query(
            `DELETE FROM sales WHERE id = $1 AND shop_id = $2 AND status = 'held'
             AND ($3 = 'owner' OR served_by = $4) RETURNING id`,
            [input.resumeHeldId, shopId, user.role, user.id]
        );
        if (removed.rowCount === 0) throw new HttpError(409, "That held sale was already used or removed.");
    }

    const saleRow = await client.query(
        `INSERT INTO sales (shop_id, client_uuid, receipt_number, customer_id, sale_type, status,
                            subtotal, discount_amount, total_amount, amount_paid, balance_due, cogs,
                            served_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [shopId, input.clientUuid, receiptNumber, input.customerId, input.saleType, input.status,
         subtotal, discount, total, paid, balanceDue, completed ? cogs : 0, user.id, input.notes]
    );
    const saleId = saleRow.rows[0].id;

    // Lines keep a copy of the product and unit names, so old receipts never change.
    for (const line of lines) {
        await client.query(
            `INSERT INTO sale_items (sale_id, product_id, unit_id, product_name, unit_name, quantity,
                                     factor_to_base, quantity_base, unit_price, line_total, cost_total)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [saleId, line.productId, line.unitId, line.product.name, line.unit.name, line.quantity,
             line.unit.factor_to_base, line.quantityBase, line.unitPrice, line.lineTotal, line.costTotal]
        );
    }

    if (completed) {
        // Stock out, with a history line per product.
        for (const [productId, need] of needBase) {
            const updated = await client.query(
                "UPDATE products SET stock_base = stock_base - $1 WHERE id = $2 AND shop_id = $3 RETURNING stock_base",
                [need, productId, shopId]
            );
            await client.query(
                `INSERT INTO stock_movements (shop_id, product_id, movement_type, quantity_change,
                                              stock_after, ref_type, ref_id, note, created_by)
                 VALUES ($1, $2, 'sale', $3, $4, 'sale', $5, $6, $7)`,
                [shopId, productId, -need, updated.rows[0].stock_base, saleId, `Sale ${receiptNumber}`, user.id]
            );
        }

        for (const p of input.payments) {
            await client.query(
                `INSERT INTO payments (shop_id, client_uuid, kind, sale_id, customer_id, amount, method,
                                       mobile_provider, reference, received_by)
                 VALUES ($1, gen_random_uuid(), 'sale_payment', $2, $3, $4, $5, $6, $7, $8)`,
                [shopId, saleId, input.customerId, p.amount, p.method, p.provider, p.reference, user.id]
            );
        }

        if (balanceDue > 0) {
            const newBalance = customer.balance + balanceDue;
            await client.query("UPDATE customers SET balance = $1 WHERE id = $2", [newBalance, customer.id]);
            await client.query(
                `INSERT INTO customer_ledger (shop_id, customer_id, entry_type, amount, balance_after,
                                              sale_id, note, created_by)
                 VALUES ($1, $2, 'credit_sale', $3, $4, $5, $6, $7)`,
                [shopId, customer.id, balanceDue, newBalance, saleId, `Sale ${receiptNumber}`, user.id]
            );
        }
    }

    await logAudit(client, {
        shopId, userId: user.id, action: completed ? "sale.create" : "sale.hold",
        entityType: "sale", entityId: saleId,
        details: { receipt: receiptNumber, total, paid, balanceDue, lines: lines.length }, ip
    });
    return saleId;
}

router.post(
    "/",
    asyncHandler(async (req, res) => {
        const input = parseSaleInput(req.body);
        const shopId = req.user.shopId;

        // Seen this exact sale already? Return it. Never save it twice.
        let saleId;
        let duplicate = false;
        const existing = await findByClientUuid(pool, shopId, input.clientUuid);
        if (existing) {
            saleId = existing.id;
            duplicate = true;
        } else {
            try {
                saleId = await pool.withTransaction((client) => writeSale(client, req.user, input, req.ip));
            } catch (error) {
                // Two taps at the same instant: the database stopped the second one. Return the first.
                if (error.code === "23505" && error.constraint === SALE_CONSTRAINT) {
                    const again = await findByClientUuid(pool, shopId, input.clientUuid);
                    if (!again) throw error;
                    saleId = again.id;
                    duplicate = true;
                } else {
                    throw error;
                }
            }
        }

        const sale = forUser(await loadSale(pool, shopId, saleId), req.user);
        res.status(duplicate ? 200 : 201).json({
            success: true,
            message: input.status === "held" ? "Sale put on hold." : "Sale saved.",
            data: { sale, duplicate }
        });
    })
);

// ---------------------------------------------------------------------
// Held sales
// ---------------------------------------------------------------------
router.get(
    "/held",
    asyncHandler(async (req, res) => {
        const params = [req.user.shopId];
        let own = "";
        if (req.user.role !== "owner") { params.push(req.user.id); own = "AND s.served_by = $2"; }

        const { rows } = await pool.query(
            `SELECT s.id, s.created_at, s.total_amount, s.sale_type, c.name AS customer_name,
                    u.full_name AS served_by_name,
                    (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id) AS item_count
             FROM sales s
             LEFT JOIN customers c ON c.id = s.customer_id
             LEFT JOIN users u ON u.id = s.served_by
             WHERE s.shop_id = $1 AND s.status = 'held' ${own}
             ORDER BY s.created_at DESC`,
            params
        );
        res.json({
            success: true,
            data: {
                held: rows.map((r) => ({
                    id: r.id, createdAt: r.created_at, total: r.total_amount, saleType: r.sale_type,
                    customerName: r.customer_name, servedBy: r.served_by_name, itemCount: r.item_count
                }))
            }
        });
    })
);

router.delete(
    "/held/:id",
    asyncHandler(async (req, res) => {
        const id = parseId(req.params.id);
        const removed = await pool.query(
            `DELETE FROM sales WHERE id = $1 AND shop_id = $2 AND status = 'held'
             AND ($3 = 'owner' OR served_by = $4) RETURNING id`,
            [id, req.user.shopId, req.user.role, req.user.id]
        );
        if (removed.rowCount === 0) throw new HttpError(404, "That held sale could not be found.");
        await logAudit(pool, {
            shopId: req.user.shopId, userId: req.user.id, action: "sale.hold_discard",
            entityType: "sale", entityId: id, ip: req.ip
        });
        res.json({ success: true, message: "Held sale removed." });
    })
);

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------
router.get(
    "/",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const params = [shopId];
        const add = (value) => { params.push(value); return `$${params.length}`; };
        const where = ["s.shop_id = $1", "s.status <> 'held'"];

        // Dates are shop days in Kampala. Empty = today.
        const from = cleanDate(req.query.from, "the start date");
        const to = cleanDate(req.query.to, "the end date");
        const today = `(NOW() AT TIME ZONE '${SHOP_TZ}')::date`;
        const fromParam = add(from);
        const toParam = add(to);
        where.push(`s.created_at >= (COALESCE(${fromParam}::date, ${today}))::timestamp AT TIME ZONE '${SHOP_TZ}'`);
        where.push(`s.created_at < (COALESCE(${toParam}::date, ${today}) + 1)::timestamp AT TIME ZONE '${SHOP_TZ}'`);

        const status = req.query.status || "completed";
        if (status === "completed" || status === "voided") where.push(`s.status = ${add(status)}`);
        else if (status !== "all") throw new HttpError(400, "Unknown status.");

        if (req.user.role !== "owner") where.push(`s.served_by = ${add(req.user.id)}`);
        else if (req.query.cashierId) where.push(`s.served_by = ${add(parseId(req.query.cashierId))}`);

        if (req.query.customerId) where.push(`s.customer_id = ${add(parseId(req.query.customerId))}`);

        const method = req.query.method || "";
        if (method === "credit") where.push("s.balance_due > 0");
        else if (["cash", "mobile_money", "bank"].includes(method)) {
            where.push(`EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id AND p.voided_at IS NULL AND p.method = ${add(method)})`);
        } else if (method) throw new HttpError(400, "Unknown payment method.");

        const search = String(req.query.search || "").trim().slice(0, 60);
        if (search) {
            const like = add(`%${escapeLike(search)}%`);
            where.push(`(s.receipt_number ILIKE ${like} OR c.name ILIKE ${like})`);
        }

        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const whereSql = where.join(" AND ");
        const from_ = `FROM sales s
             LEFT JOIN customers c ON c.id = s.customer_id
             LEFT JOIN users u ON u.id = s.served_by
             LEFT JOIN (SELECT sale_id, SUM(refund_amount)::bigint AS refunded
                        FROM sale_returns WHERE shop_id = $1 GROUP BY sale_id) rf ON rf.sale_id = s.id`;

        const totals = (await pool.query(
            `SELECT COUNT(*) FILTER (WHERE s.status = 'completed') AS sales,
                    COALESCE(SUM(s.total_amount) FILTER (WHERE s.status = 'completed'), 0)::bigint AS total,
                    COALESCE(SUM(s.amount_paid) FILTER (WHERE s.status = 'completed'), 0)::bigint AS paid,
                    COALESCE(SUM(s.balance_due) FILTER (WHERE s.status = 'completed'), 0)::bigint AS credit,
                    COALESCE(SUM(rf.refunded) FILTER (WHERE s.status = 'completed'), 0)::bigint AS refunds,
                    COUNT(*) AS row_count
             ${from_} WHERE ${whereSql}`,
            params
        )).rows[0];

        const limitParam = add(limit);
        const offsetParam = add((page - 1) * limit);
        const { rows } = await pool.query(
            `SELECT s.id, s.receipt_number, s.status, s.sale_type, s.created_at, s.total_amount,
                    s.amount_paid, s.balance_due, COALESCE(rf.refunded, 0) AS refunded,
                    c.name AS customer_name, u.full_name AS served_by_name,
                    (SELECT string_agg(DISTINCT p.method, ',') FROM payments p
                      WHERE p.sale_id = s.id AND p.voided_at IS NULL) AS methods
             ${from_} WHERE ${whereSql}
             ORDER BY s.created_at DESC, s.id DESC
             LIMIT ${limitParam} OFFSET ${offsetParam}`,
            params
        );

        res.json({
            success: true,
            data: {
                sales: rows.map((r) => ({
                    id: r.id, receiptNumber: r.receipt_number, status: r.status, saleType: r.sale_type,
                    createdAt: r.created_at, totalAmount: r.total_amount, amountPaid: r.amount_paid,
                    balanceDue: r.balance_due, refunded: r.refunded,
                    customerName: r.customer_name, servedBy: r.served_by_name,
                    methods: r.methods ? r.methods.split(",") : []
                })),
                totals: {
                    sales: totals.sales, total: totals.total, paid: totals.paid, credit: totals.credit,
                    refunds: totals.refunds, net: totals.total - totals.refunds
                },
                page, limit, total: totals.row_count, hasMore: page * limit < totals.row_count
            }
        });
    })
);

// ---------------------------------------------------------------------
// One sale
// ---------------------------------------------------------------------
router.get(
    "/:id",
    asyncHandler(async (req, res) => {
        const sale = await loadSale(pool, req.user.shopId, parseId(req.params.id));
        assertCanSee(sale, req.user);
        res.json({ success: true, data: { sale: forUser(sale, req.user) } });
    })
);

// ---------------------------------------------------------------------
// Void: cancel a whole sale. Nothing is deleted; stock and debt are put back.
// ---------------------------------------------------------------------
router.post(
    "/:id/void",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const reason = cleanText(req.body.reason, "the reason for voiding this sale", { max: 300 });

        await pool.withTransaction(async (client) => {
            const sale = (await client.query(
                "SELECT * FROM sales WHERE id = $1 AND shop_id = $2 FOR UPDATE", [id, shopId]
            )).rows[0];
            if (!sale) throw new HttpError(404, "That sale could not be found.");
            if (sale.status === "voided") throw new HttpError(409, "This sale was already voided.");
            if (sale.status === "held") throw new HttpError(400, "A held sale was never sold. Remove it from the held list instead.");

            const hasReturns = await client.query("SELECT 1 FROM sale_returns WHERE sale_id = $1 LIMIT 1", [id]);
            if (hasReturns.rowCount > 0) {
                throw new HttpError(409, "This sale already has returns, so it cannot be voided.");
            }

            // Same lock order as a new sale: customer first, then products.
            let customer = null;
            if (sale.customer_id) {
                customer = (await client.query(
                    "SELECT id, balance FROM customers WHERE id = $1 FOR UPDATE", [sale.customer_id]
                )).rows[0];
            }

            // Stock back in, product by product.
            const back = (await client.query(
                `SELECT product_id, SUM(quantity_base)::bigint AS qty FROM sale_items
                 WHERE sale_id = $1 GROUP BY product_id ORDER BY product_id`,
                [id]
            )).rows;
            for (const item of back) {
                const updated = await client.query(
                    "UPDATE products SET stock_base = stock_base + $1 WHERE id = $2 AND shop_id = $3 RETURNING stock_base",
                    [item.qty, item.product_id, shopId]
                );
                await client.query(
                    `INSERT INTO stock_movements (shop_id, product_id, movement_type, quantity_change,
                                                  stock_after, ref_type, ref_id, note, created_by)
                     VALUES ($1, $2, 'sale_void', $3, $4, 'sale', $5, $6, $7)`,
                    [shopId, item.product_id, item.qty, updated.rows[0].stock_base, id,
                     `Void of sale ${sale.receipt_number}`, req.user.id]
                );
            }

            // The debt this sale created is taken off the customer's book.
            if (customer && sale.balance_due > 0) {
                const newBalance = customer.balance - sale.balance_due;
                await client.query("UPDATE customers SET balance = $1 WHERE id = $2", [newBalance, customer.id]);
                await client.query(
                    `INSERT INTO customer_ledger (shop_id, customer_id, entry_type, amount, balance_after,
                                                  sale_id, note, created_by)
                     VALUES ($1, $2, 'void_reversal', $3, $4, $5, $6, $7)`,
                    [shopId, customer.id, -sale.balance_due, newBalance, id,
                     `Void of sale ${sale.receipt_number}`, req.user.id]
                );
            }

            // The money taken for this sale no longer counts in today's cash.
            await client.query("UPDATE payments SET voided_at = NOW() WHERE sale_id = $1 AND voided_at IS NULL", [id]);
            await client.query(
                "UPDATE sales SET status = 'voided', voided_at = NOW(), voided_by = $1, void_reason = $2 WHERE id = $3",
                [req.user.id, reason, id]
            );

            await logAudit(client, {
                shopId, userId: req.user.id, action: "sale.void", entityType: "sale", entityId: id,
                details: { receipt: sale.receipt_number, total: sale.total_amount, reason }, ip: req.ip
            });
        });

        res.json({
            success: true, message: "Sale voided. Stock has been put back.",
            data: { sale: forUser(await loadSale(pool, shopId, id), req.user) }
        });
    })
);

// ---------------------------------------------------------------------
// Returns: customer brings some items back
// ---------------------------------------------------------------------
router.post(
    "/:id/returns",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const clientUuid = cleanUuid(req.body.clientUuid, "return");
        const reason = cleanText(req.body.reason, "the reason for the return", { max: 300 });
        const method = req.body.refundMethod;
        if (!["cash", "mobile_money", "bank", "credit_note"].includes(method)) {
            throw new HttpError(400, "Choose how the money goes back to the customer.");
        }
        if (!Array.isArray(req.body.items) || req.body.items.length === 0 || req.body.items.length > 100) {
            throw new HttpError(400, "Choose the items being returned.");
        }
        const wanted = new Map();
        for (const raw of req.body.items) {
            const itemId = parseId(raw && raw.saleItemId);
            if (wanted.has(itemId)) throw new HttpError(400, "An item is listed twice.");
            wanted.set(itemId, wholeNumber(raw.quantity, "the quantity returned", { min: 1, max: 100000 }));
        }

        let repeated = false;
        await pool.withTransaction(async (client) => {
            const sale = (await client.query(
                "SELECT * FROM sales WHERE id = $1 AND shop_id = $2 FOR UPDATE", [id, shopId]
            )).rows[0];
            if (!sale) throw new HttpError(404, "That sale could not be found.");
            if (sale.status !== "completed") throw new HttpError(409, "Only a completed sale can have returns.");

            // Same return sent twice? Nothing more to do.
            const uuids = [...wanted.keys()].map((itemId) => derivedUuid(clientUuid, itemId));
            const seen = await client.query(
                "SELECT 1 FROM sale_returns WHERE shop_id = $1 AND client_uuid = ANY($2::uuid[]) LIMIT 1",
                [shopId, uuids]
            );
            if (seen.rowCount > 0) { repeated = true; return; }

            const itemRows = (await client.query(
                `SELECT si.*, COALESCE((SELECT SUM(r.quantity) FROM sale_returns r WHERE r.sale_item_id = si.id), 0) AS returned
                 FROM sale_items si WHERE si.sale_id = $1 AND si.id = ANY($2::bigint[])`,
                [id, [...wanted.keys()]]
            )).rows;
            if (itemRows.length !== wanted.size) throw new HttpError(400, "An item does not belong to this sale.");

            // Money back = the item's share of what the customer really paid (after any discount).
            const plan = itemRows.map((item) => {
                const quantity = wanted.get(item.id);
                const left = item.quantity - item.returned;
                if (quantity > left) {
                    throw new HttpError(400, `You can return at most ${left} of "${item.product_name}" (${item.unit_name}).`);
                }
                const share = sale.subtotal > 0
                    ? Math.round((quantity * item.unit_price * sale.total_amount) / sale.subtotal) : 0;
                return { item, quantity, quantityBase: quantity * item.factor_to_base, refund: share };
            });
            const totalRefund = plan.reduce((sum, p) => sum + p.refund, 0);

            let customer = null;
            if (sale.customer_id) {
                customer = (await client.query(
                    "SELECT id, balance FROM customers WHERE id = $1 FOR UPDATE", [sale.customer_id]
                )).rows[0];
            }
            if (method === "credit_note" && !customer) {
                throw new HttpError(400, "A credit note needs a customer. Choose cash, mobile money or bank instead.");
            }

            // Stock back in (products in id order, to avoid lock clashes).
            const perProduct = new Map();
            for (const p of plan) perProduct.set(p.item.product_id, (perProduct.get(p.item.product_id) || 0) + p.quantityBase);
            for (const productId of [...perProduct.keys()].sort((a, b) => a - b)) {
                const qty = perProduct.get(productId);
                const updated = await client.query(
                    "UPDATE products SET stock_base = stock_base + $1 WHERE id = $2 AND shop_id = $3 RETURNING stock_base",
                    [qty, productId, shopId]
                );
                await client.query(
                    `INSERT INTO stock_movements (shop_id, product_id, movement_type, quantity_change,
                                                  stock_after, ref_type, ref_id, note, created_by)
                     VALUES ($1, $2, 'return', $3, $4, 'sale', $5, $6, $7)`,
                    [shopId, productId, qty, updated.rows[0].stock_base, id,
                     `Return on sale ${sale.receipt_number}`, req.user.id]
                );
            }

            for (const p of plan) {
                await client.query(
                    `INSERT INTO sale_returns (shop_id, client_uuid, sale_id, sale_item_id, quantity,
                                               quantity_base, refund_amount, refund_method, reason, created_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [shopId, derivedUuid(clientUuid, p.item.id), id, p.item.id, p.quantity,
                     p.quantityBase, p.refund, method, reason, req.user.id]
                );
            }

            // A credit note lowers what the customer owes (or leaves credit in their favour).
            if (method === "credit_note" && totalRefund > 0) {
                const newBalance = customer.balance - totalRefund;
                await client.query("UPDATE customers SET balance = $1 WHERE id = $2", [newBalance, customer.id]);
                await client.query(
                    `INSERT INTO customer_ledger (shop_id, customer_id, entry_type, amount, balance_after,
                                                  sale_id, note, created_by)
                     VALUES ($1, $2, 'refund', $3, $4, $5, $6, $7)`,
                    [shopId, customer.id, -totalRefund, newBalance, id,
                     `Return on sale ${sale.receipt_number}`, req.user.id]
                );
            }

            await logAudit(client, {
                shopId, userId: req.user.id, action: "sale.return", entityType: "sale", entityId: id,
                details: { receipt: sale.receipt_number, refund: totalRefund, method, reason }, ip: req.ip
            });
        });

        res.json({
            success: true,
            message: repeated ? "This return was already saved." : "Return saved. Stock has been put back.",
            data: { sale: forUser(await loadSale(pool, shopId, id), req.user), duplicate: repeated }
        });
    })
);

module.exports = router;
