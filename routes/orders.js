// routes/orders.js - purchase orders: the list of what you plan to buy from a supplier.
//   GET   /api/orders/suppliers       suppliers to choose from                       everyone
//   GET   /api/orders/low-stock       products that are low or out of stock          everyone
//   GET   /api/orders/catalog         search products to add to an order             everyone
//   GET   /api/orders                 list (filter by status, search)                everyone
//   GET   /api/orders/:id             one order with its lines                       everyone
//   POST  /api/orders                 create an order                                everyone
//   PUT   /api/orders/:id             change an order (while it is a draft or sent)  everyone
//   POST  /api/orders/:id/status      draft / sent / received / cancelled            everyone
//
// An order never changes stock or money: it is only a plan. When the goods arrive you record a
// normal purchase. Cashiers can make and change orders, but they never see cost prices: the server
// keeps the estimated costs and only sends them to owners.
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { wholeNumber, parseId, cleanUuid } = require("../utils/validators");
const { escapeLike, cleanDate } = require("../utils/productInput");
const { lowStockDefault, loadUnitsAndPrices } = require("../utils/productData");
const { todayInShop } = require("../utils/time");
const { formatPhone } = require("../utils/phone");
const { logAudit } = require("../utils/audit");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

const STATUSES = ["draft", "sent", "received", "cancelled"];
const OPEN = ["draft", "sent"];
// Which status may follow which. Only an owner may reopen an order that was already received.
const NEXT = {
    draft: ["sent", "received", "cancelled"],
    sent: ["draft", "received", "cancelled"],
    received: ["sent"],
    cancelled: ["draft"]
};

const isOwner = (req) => req.user.role === "owner";
const cleanNote = (value) => String(value === undefined || value === null ? "" : value).trim().slice(0, 500);

// ---------------------------------------------------------------------
// Products as the order screens need them
// ---------------------------------------------------------------------
/* Low stock = the same rule the Home screen uses. The suggested quantity brings the stock up to
   twice the low-stock level, counted in the biggest unit (cartons, sacks ...), at least 1. */
function toProduct(row, units, owner, lowDefault) {
    const list = (units || []).slice().sort((a, b) => a.factor - b.factor);
    const threshold = row.reorder_level > 0 ? row.reorder_level : lowDefault;
    const isOut = row.stock_base <= 0;
    const isLow = isOut || row.stock_base <= threshold;
    const biggest = list[list.length - 1] || null;
    const needBase = Math.max(Math.max(threshold * 2, 1) - row.stock_base, 1);
    const product = {
        id: row.id, name: row.name, barcode: row.barcode, stockBase: row.stock_base, units: list,
        isLow, isOut,
        suggestedUnitId: biggest ? biggest.id : null,
        suggestedQty: biggest ? Math.max(1, Math.ceil(needBase / biggest.factor)) : 1
    };
    if (owner) product.costPrice = row.cost_price;
    return product;
}

const LOW_SQL = `p.stock_base <= 0 OR p.stock_base <= CASE WHEN p.reorder_level > 0 THEN p.reorder_level ELSE $2 END`;

router.get(
    "/suppliers",
    asyncHandler(async (req, res) => {
        const { rows } = await pool.query(
            "SELECT id, name, phone FROM suppliers WHERE shop_id = $1 AND is_active ORDER BY LOWER(name)",
            [req.user.shopId]
        );
        res.json({
            success: true,
            data: { suppliers: rows.map((r) => ({ id: r.id, name: r.name, phoneDisplay: r.phone ? formatPhone(r.phone) : "" })) }
        });
    })
);

router.get(
    "/low-stock",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const lowDefault = await lowStockDefault(pool, shopId);
        const { rows } = await pool.query(
            `SELECT p.id, p.name, p.barcode, p.stock_base, p.reorder_level, p.cost_price
             FROM products p WHERE p.shop_id = $1 AND p.is_active AND (${LOW_SQL})
             ORDER BY p.stock_base ASC, LOWER(p.name) LIMIT 200`,
            [shopId, lowDefault]
        );
        const { units } = await loadUnitsAndPrices(pool, rows.map((r) => r.id));
        res.json({
            success: true,
            data: { items: rows.map((r) => toProduct(r, units.get(r.id), isOwner(req), lowDefault)) }
        });
    })
);

router.get(
    "/catalog",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const params = [shopId];
        const where = ["p.shop_id = $1", "p.is_active"];
        const search = String(req.query.search || "").trim().slice(0, 80);
        const lowDefault = await lowStockDefault(pool, shopId);
        params.push(lowDefault);
        if (search) {
            params.push(`%${escapeLike(search)}%`);
            where.push(`(p.name ILIKE $3 OR p.barcode ILIKE $3 OR p.sku ILIKE $3)`);
        }
        const { rows } = await pool.query(
            `SELECT p.id, p.name, p.barcode, p.stock_base, p.reorder_level, p.cost_price
             FROM products p WHERE ${where.join(" AND ")}
             ORDER BY (CASE WHEN ${LOW_SQL} THEN 0 ELSE 1 END), LOWER(p.name) LIMIT 30`,
            params
        );
        const { units } = await loadUnitsAndPrices(pool, rows.map((r) => r.id));
        res.json({
            success: true,
            data: { products: rows.map((r) => toProduct(r, units.get(r.id), isOwner(req), lowDefault)) }
        });
    })
);

// ---------------------------------------------------------------------
// Reading orders
// ---------------------------------------------------------------------
async function loadOrder(db, req, id) {
    const shopId = req.user.shopId;
    const owner = isOwner(req);
    const head = (await db.query(
        `SELECT o.id, o.order_number, o.status, o.supplier_id, o.note, o.created_at, o.updated_at,
                to_char(o.order_date, 'YYYY-MM-DD') AS order_date,
                to_char(o.expected_date, 'YYYY-MM-DD') AS expected_date,
                s.name AS supplier_name, s.phone AS supplier_phone,
                cu.full_name AS created_by_name, uu.full_name AS updated_by_name
         FROM purchase_orders o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN users cu ON cu.id = o.created_by
         LEFT JOIN users uu ON uu.id = o.updated_by
         WHERE o.id = $1 AND o.shop_id = $2`,
        [id, shopId]
    )).rows[0];
    if (!head) return null;

    const items = (await db.query(
        `SELECT i.id, i.product_id, i.unit_id, i.product_name, i.unit_name, i.quantity, i.unit_cost, i.auto_added,
                p.name AS cur_name, p.barcode, p.stock_base, p.reorder_level, p.cost_price
         FROM purchase_order_items i LEFT JOIN products p ON p.id = i.product_id AND p.shop_id = $2
         WHERE i.order_id = $1 ORDER BY i.id`,
        [id, shopId]
    )).rows;
    const lowDefault = await lowStockDefault(db, shopId);
    const { units } = await loadUnitsAndPrices(db, items.map((i) => i.product_id));

    const shop = (await db.query("SELECT name, address, phone FROM shops WHERE id = $1", [shopId])).rows[0] || {};
    let total = 0;
    const lines = items.map((i) => {
        const lineTotal = i.unit_cost === null ? 0 : Number(i.quantity) * Number(i.unit_cost);
        total += lineTotal;
        const line = {
            id: i.id, productId: i.product_id, unitId: i.unit_id, productName: i.product_name, unitName: i.unit_name,
            quantity: i.quantity, autoAdded: i.auto_added,
            product: i.cur_name === null ? null : toProduct(
                { id: i.product_id, name: i.cur_name, barcode: i.barcode, stock_base: i.stock_base, reorder_level: i.reorder_level, cost_price: i.cost_price },
                units.get(i.product_id), owner, lowDefault)
        };
        if (owner) { line.unitCost = i.unit_cost; line.lineTotal = lineTotal; }
        return line;
    });

    const order = {
        id: head.id, orderNumber: head.order_number, status: head.status, note: head.note,
        orderDate: head.order_date, expectedDate: head.expected_date,
        createdAt: head.created_at, updatedAt: head.updated_at,
        createdBy: head.created_by_name, updatedBy: head.updated_by_name,
        supplier: head.supplier_id ? { id: head.supplier_id, name: head.supplier_name, phone: head.supplier_phone || "", phoneDisplay: head.supplier_phone ? formatPhone(head.supplier_phone) : "" } : null,
        items: lines,
        shop: { name: shop.name, address: shop.address, phone: shop.phone }
    };
    if (owner) order.total = total;
    return order;
}

router.get(
    "/",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const params = [shopId];
        const add = (value) => { params.push(value); return `$${params.length}`; };
        const where = ["o.shop_id = $1"];

        const status = String(req.query.status || "open");
        if (status === "open") where.push(`o.status IN ('draft', 'sent')`);
        else if (STATUSES.includes(status)) where.push(`o.status = ${add(status)}`);
        else if (status !== "all") throw new HttpError(400, "Unknown status.");

        const search = String(req.query.search || "").trim().slice(0, 60);
        if (search) {
            const like = add(`%${escapeLike(search)}%`);
            where.push(`(o.order_number::text ILIKE ${like} OR s.name ILIKE ${like})`);
        }
        const whereSql = where.join(" AND ");
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
        const pageNo = Math.max(1, parseInt(req.query.page, 10) || 1);
        const from = `FROM purchase_orders o LEFT JOIN suppliers s ON s.id = o.supplier_id`;

        const count = Number((await pool.query(`SELECT COUNT(*) AS n ${from} WHERE ${whereSql}`, params)).rows[0].n);
        const limitParam = add(limit);
        const offsetParam = add((pageNo - 1) * limit);
        const { rows } = await pool.query(
            `SELECT o.id, o.order_number, o.status, to_char(o.order_date, 'YYYY-MM-DD') AS order_date,
                    to_char(o.expected_date, 'YYYY-MM-DD') AS expected_date, s.name AS supplier_name,
                    (SELECT COUNT(*) FROM purchase_order_items i WHERE i.order_id = o.id) AS item_count,
                    (SELECT COALESCE(SUM(i.quantity * i.unit_cost), 0) FROM purchase_order_items i WHERE i.order_id = o.id) AS total
             ${from} WHERE ${whereSql}
             ORDER BY o.order_number DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
            params
        );
        res.json({
            success: true,
            data: {
                orders: rows.map((r) => {
                    const o = {
                        id: r.id, orderNumber: r.order_number, status: r.status, orderDate: r.order_date,
                        expectedDate: r.expected_date, supplierName: r.supplier_name, itemCount: Number(r.item_count)
                    };
                    if (isOwner(req)) o.total = Number(r.total);
                    return o;
                }),
                page: pageNo, limit, total: count, hasMore: pageNo * limit < count
            }
        });
    })
);

router.get(
    "/:id",
    asyncHandler(async (req, res) => {
        const order = await loadOrder(pool, req, parseId(req.params.id));
        if (!order) throw new HttpError(404, "That order could not be found.");
        res.json({ success: true, data: { order } });
    })
);

// ---------------------------------------------------------------------
// Writing orders
// ---------------------------------------------------------------------
function parseOrder(body) {
    const status = body.status === "sent" ? "sent" : "draft";
    if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, "Add at least one product to the order.");
    if (body.items.length > 200) throw new HttpError(400, "An order can have at most 200 products.");

    const seen = new Set();
    const items = body.items.map((raw) => {
        const productId = parseId(raw && raw.productId);
        const unitId = parseId(raw && raw.unitId);
        const key = productId + ":" + unitId;
        if (seen.has(key)) throw new HttpError(400, "A product is listed twice in the same unit. Combine the quantities.");
        seen.add(key);
        const hasCost = raw.unitCost !== undefined && raw.unitCost !== null && raw.unitCost !== "";
        return {
            productId, unitId,
            quantity: wholeNumber(raw.quantity, "the quantity", { min: 1, max: 1000000 }),
            unitCost: hasCost ? wholeNumber(raw.unitCost, "the buying price", { min: 0, max: 1000000000 }) : null,
            autoAdded: raw.autoAdded === true
        };
    });
    return {
        status, items,
        supplierId: body.supplierId ? parseId(body.supplierId) : null,
        orderDate: cleanDate(body.orderDate, "the order date") || todayInShop(),
        expectedDate: cleanDate(body.expectedDate, "the expected delivery date") || null,
        note: cleanNote(body.note)
    };
}

/* Checks every product and unit belong to this shop, then writes the lines.
   Owners send the estimated cost; for everyone else the server keeps the cost the line already had,
   or else the product's current cost price. */
async function writeItems(client, req, orderId, items, oldCosts) {
    const shopId = req.user.shopId;
    const owner = isOwner(req);
    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = new Map((await client.query(
        "SELECT id, name, cost_price FROM products WHERE id = ANY($1::bigint[]) AND shop_id = $2",
        [productIds, shopId]
    )).rows.map((p) => [Number(p.id), p]));
    const units = new Map((await client.query(
        "SELECT id, product_id, name, factor_to_base FROM product_units WHERE product_id = ANY($1::bigint[])",
        [productIds]
    )).rows.map((u) => [Number(u.id), u]));

    for (const item of items) {
        const product = products.get(Number(item.productId));
        if (!product) throw new HttpError(400, "A product in this order could not be found.");
        const unit = units.get(Number(item.unitId));
        if (!unit || Number(unit.product_id) !== Number(item.productId)) {
            throw new HttpError(400, `The unit chosen for "${product.name}" is not valid.`);
        }
        const fallback = Number(product.cost_price || 0) * Number(unit.factor_to_base);
        const kept = oldCosts.get(item.productId + ":" + item.unitId);
        const cost = owner && item.unitCost !== null ? item.unitCost : (kept !== undefined ? kept : fallback);
        await client.query(
            `INSERT INTO purchase_order_items (order_id, product_id, unit_id, product_name, unit_name, quantity, unit_cost, auto_added)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [orderId, item.productId, item.unitId, product.name, unit.name, item.quantity, cost, item.autoAdded]
        );
    }
}

router.post(
    "/",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const clientUuid = cleanUuid(req.body.clientUuid, "order");
        const input = parseOrder(req.body);

        // Seen this exact order already (double tap, retry)? Return it, never save it twice.
        const existing = (await pool.query(
            "SELECT id FROM purchase_orders WHERE shop_id = $1 AND client_uuid = $2", [shopId, clientUuid]
        )).rows[0];
        let id = existing ? existing.id : null;

        if (!id) {
            id = await pool.withTransaction(async (client) => {
                if (input.supplierId) {
                    const sup = await client.query("SELECT 1 FROM suppliers WHERE id = $1 AND shop_id = $2", [input.supplierId, shopId]);
                    if (sup.rowCount === 0) throw new HttpError(400, "That supplier could not be found.");
                }
                // One order is numbered at a time per shop, so the numbers never repeat or skip.
                await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [Number(shopId) * 100 + 71]);
                const next = (await client.query(
                    "SELECT COALESCE(MAX(order_number), 0) + 1 AS n FROM purchase_orders WHERE shop_id = $1", [shopId]
                )).rows[0].n;
                const created = await client.query(
                    `INSERT INTO purchase_orders (shop_id, client_uuid, order_number, supplier_id, status, order_date,
                                                  expected_date, note, created_by, updated_by)
                     VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $9) RETURNING id`,
                    [shopId, clientUuid, next, input.supplierId, input.status, input.orderDate,
                     input.expectedDate, input.note, req.user.id]
                );
                const newId = created.rows[0].id;
                await writeItems(client, req, newId, input.items, new Map());
                await logAudit(client, {
                    shopId, userId: req.user.id, action: "order.create", entityType: "purchase_order", entityId: newId,
                    details: { number: next, lines: input.items.length }, ip: req.ip
                });
                return newId;
            });
        }
        res.status(existing ? 200 : 201).json({
            success: true, message: "Order saved.",
            data: { order: await loadOrder(pool, req, id), duplicate: Boolean(existing) }
        });
    })
);

router.put(
    "/:id",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const input = parseOrder(req.body);

        await pool.withTransaction(async (client) => {
            const found = (await client.query(
                "SELECT id, status FROM purchase_orders WHERE id = $1 AND shop_id = $2 FOR UPDATE", [id, shopId]
            )).rows[0];
            if (!found) throw new HttpError(404, "That order could not be found.");
            if (!OPEN.includes(found.status)) {
                throw new HttpError(409, "This order is already " + found.status + ". Reopen it before changing it.");
            }
            if (input.supplierId) {
                const sup = await client.query("SELECT 1 FROM suppliers WHERE id = $1 AND shop_id = $2", [input.supplierId, shopId]);
                if (sup.rowCount === 0) throw new HttpError(400, "That supplier could not be found.");
            }
            const oldCosts = new Map((await client.query(
                "SELECT product_id, unit_id, unit_cost FROM purchase_order_items WHERE order_id = $1", [id]
            )).rows.map((r) => [r.product_id + ":" + r.unit_id, r.unit_cost === null ? undefined : Number(r.unit_cost)]));

            await client.query(
                `UPDATE purchase_orders SET supplier_id = $1, status = $2, order_date = $3::date, expected_date = $4::date,
                        note = $5, updated_by = $6, updated_at = NOW()
                 WHERE id = $7 AND shop_id = $8`,
                [input.supplierId, input.status, input.orderDate, input.expectedDate, input.note, req.user.id, id, shopId]
            );
            await client.query("DELETE FROM purchase_order_items WHERE order_id = $1", [id]);
            await writeItems(client, req, id, input.items, oldCosts);
            await logAudit(client, {
                shopId, userId: req.user.id, action: "order.update", entityType: "purchase_order", entityId: id,
                details: { lines: input.items.length }, ip: req.ip
            });
        });
        res.json({ success: true, message: "Order saved.", data: { order: await loadOrder(pool, req, id) } });
    })
);

router.post(
    "/:id/status",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const next = String(req.body.status || "");
        if (!STATUSES.includes(next)) throw new HttpError(400, "Unknown status.");

        await pool.withTransaction(async (client) => {
            const found = (await client.query(
                "SELECT id, status FROM purchase_orders WHERE id = $1 AND shop_id = $2 FOR UPDATE", [id, shopId]
            )).rows[0];
            if (!found) throw new HttpError(404, "That order could not be found.");
            if (!NEXT[found.status].includes(next)) {
                throw new HttpError(409, "This order is " + found.status + " and cannot be changed to " + next + ".");
            }
            if (found.status === "received" && !isOwner(req)) {
                throw new HttpError(403, "Only the owner can reopen an order that was received.");
            }
            await client.query(
                "UPDATE purchase_orders SET status = $1, updated_by = $2, updated_at = NOW() WHERE id = $3 AND shop_id = $4",
                [next, req.user.id, id, shopId]
            );
            await logAudit(client, {
                shopId, userId: req.user.id, action: "order.status", entityType: "purchase_order", entityId: id,
                details: { from: found.status, to: next }, ip: req.ip
            });
        });
        res.json({ success: true, message: "Order updated.", data: { order: await loadOrder(pool, req, id) } });
    })
);

module.exports = router;
