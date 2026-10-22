// routes/products.js - products, units and prices.
//   GET   /api/products             list (search, category, filter, pages)   everyone
//   GET   /api/products/:id         one product with units, prices, photo     everyone
//   POST  /api/products             add                                       owner
//   PATCH /api/products/:id         change any part (also remove / put back)  owner
//   GET   /api/products/export      all products as rows for a CSV file       owner
//   POST  /api/products/import      add many products from CSV rows           owner
//
// Cost prices are NEVER sent to cashiers.
// Stock is not changed here after the product exists: use stock adjustments
// and purchases (Step 5) so every change leaves a record.
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { cleanText, wholeNumber, parseId, has } = require("../utils/validators");
const {
    MAX_MONEY, cleanDate, cleanPhoto, cleanUnits, cleanPrices, resolvePrices, escapeLike, num
} = require("../utils/productInput");
const { logAudit } = require("../utils/audit");
const { lowStockDefault, loadUnitsAndPrices } = require("../utils/productData");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// Everything except the photo (photos are heavy and only sent for one product).
const LIST_COLUMNS = `p.id, p.category_id, p.name, p.barcode, p.sku, p.cost_price, p.reorder_level,
    p.stock_base, p.expiry_date, p.is_active, (p.photo IS NOT NULL) AS has_photo,
    (p.expiry_date IS NOT NULL AND p.expiry_date < CURRENT_DATE) AS is_expired,
    (p.expiry_date IS NOT NULL AND p.expiry_date >= CURRENT_DATE AND p.expiry_date <= CURRENT_DATE + 30) AS expiring_soon,
    c.name AS category_name`;

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function shapeProduct(row, units, prices, { canSeeCost, lowDefault }) {
    const lowLevel = row.reorder_level > 0 ? row.reorder_level : lowDefault;
    const isOut = row.stock_base <= 0;
    const productUnits = units.get(row.id) || [];
    const productPrices = prices.get(row.id) || [];
    const baseUnit = productUnits.find((u) => u.factor === 1);
    const baseRetail = baseUnit
        ? productPrices.find((p) => p.unitId === baseUnit.id && p.level === "retail" && p.minQty === 1)
        : null;

    const product = {
        id: row.id,
        name: row.name,
        categoryId: row.category_id,
        categoryName: row.category_name,
        barcode: row.barcode,
        sku: row.sku,
        reorderLevel: row.reorder_level,
        lowStockLevel: lowLevel,
        stockBase: row.stock_base,
        isOut,
        isLow: !isOut && row.stock_base <= lowLevel,
        expiryDate: row.expiry_date,
        isExpired: row.is_expired,
        expiringSoon: row.expiring_soon,
        isActive: row.is_active,
        hasPhoto: row.has_photo,
        units: productUnits,
        retailPrice: baseRetail ? baseRetail.price : null
    };
    if (canSeeCost) product.costPrice = row.cost_price; // attendants never get this field
    return product;
}

async function checkCategory(db, shopId, value) {
    if (value === undefined || value === null || value === "") return null;
    const id = parseId(value);
    const { rowCount } = await db.query("SELECT 1 FROM categories WHERE id = $1 AND shop_id = $2", [id, shopId]);
    if (rowCount === 0) throw new HttpError(400, "That category does not exist.");
    return id;
}

async function assertNameFree(db, shopId, name, exceptId) {
    const { rowCount } = await db.query(
        `SELECT 1 FROM products
         WHERE shop_id = $1 AND LOWER(name) = LOWER($2) AND ($3::bigint IS NULL OR id <> $3)`,
        [shopId, name, exceptId || null]
    );
    if (rowCount > 0) throw new HttpError(409, `You already have a product called "${name}".`);
}

async function assertBarcodeFree(db, shopId, barcode, exceptId) {
    if (!barcode) return;
    const { rowCount } = await db.query(
        `SELECT 1 FROM products
         WHERE shop_id = $1 AND barcode = $2 AND ($3::bigint IS NULL OR id <> $3)`,
        [shopId, barcode, exceptId || null]
    );
    if (rowCount > 0) throw new HttpError(409, "Another product already uses this barcode.");
}

async function writePrices(client, productId, resolved) {
    for (const p of resolved) {
        await client.query(
            `INSERT INTO product_prices (product_id, unit_id, level, price, min_qty)
             VALUES ($1, $2, $3, $4, $5)`,
            [productId, p.unitId, p.level, p.price, p.minQty]
        );
    }
}

// ---------------------------------------------------------------------
// Creating a product (used by "add product" and by CSV import)
// ---------------------------------------------------------------------
async function parseNewProduct(db, shopId, body) {
    const name = cleanText(body.name, "the product name", { max: 200 });
    const barcode = cleanText(body.barcode, "the barcode", { required: false, max: 60 });
    const sku = cleanText(body.sku, "the SKU", { required: false, max: 60 });
    const costPrice = wholeNumber(body.costPrice === undefined ? 0 : body.costPrice, "the cost price", { min: 0, max: MAX_MONEY });
    const reorderLevel = wholeNumber(body.reorderLevel === undefined ? 0 : body.reorderLevel, "the low stock level", { min: 0, max: 1000000 });
    const openingStock = wholeNumber(body.openingStock === undefined ? 0 : body.openingStock, "the opening stock", { min: 0, max: 100000000 });
    const expiryDate = cleanDate(body.expiryDate);
    const photo = cleanPhoto(body.photo);
    const units = cleanUnits(body.units);
    const prices = cleanPrices(body.prices);
    const categoryId = await checkCategory(db, shopId, body.categoryId);

    await assertNameFree(db, shopId, name);
    await assertBarcodeFree(db, shopId, barcode);

    return { name, barcode, sku, costPrice, reorderLevel, openingStock, expiryDate, photo, units, prices, categoryId };
}

async function insertProduct(client, user, data) {
    const created = await client.query(
        `INSERT INTO products (shop_id, category_id, name, barcode, sku, cost_price,
                               reorder_level, stock_base, expiry_date, photo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [user.shopId, data.categoryId, data.name, data.barcode, data.sku, data.costPrice,
         data.reorderLevel, data.openingStock, data.expiryDate, data.photo]
    );
    const productId = created.rows[0].id;

    const unitIds = new Map();
    for (const unit of data.units) {
        const row = await client.query(
            "INSERT INTO product_units (product_id, name, factor_to_base) VALUES ($1, $2, $3) RETURNING id",
            [productId, unit.name, unit.factor]
        );
        unitIds.set(unit.key, row.rows[0].id);
    }
    const base = data.units.find((u) => u.factor === 1);
    await writePrices(client, productId, resolvePrices(data.prices, unitIds, unitIds.get(base.key)));

    if (data.openingStock > 0) {
        await client.query(
            `INSERT INTO stock_movements (shop_id, product_id, movement_type, quantity_change,
                                          stock_after, ref_type, ref_id, note, created_by)
             VALUES ($1, $2, 'opening', $3, $3, 'product', $2, 'Opening stock', $4)`,
            [user.shopId, productId, data.openingStock, user.id]
        );
    }
    await client.query(
        "INSERT INTO product_cost_history (product_id, cost_price) VALUES ($1, $2)",
        [productId, data.costPrice]
    );
    await logAudit(client, {
        shopId: user.shopId, userId: user.id, action: "product.create",
        entityType: "product", entityId: productId, details: { name: data.name }
    });
    return productId;
}

// ---------------------------------------------------------------------
// Changing units of an existing product
// ---------------------------------------------------------------------
async function syncUnits(client, productId, incoming) {
    const current = (await client.query(
        "SELECT id, name, factor_to_base FROM product_units WHERE product_id = $1", [productId]
    )).rows;
    const currentIds = new Set(current.map((u) => u.id));
    const currentBase = current.find((u) => u.factor_to_base === 1);
    const incomingBase = incoming.find((u) => u.factor === 1);

    // Stock is counted in the base unit, so that unit can be renamed but never swapped.
    if (currentBase && incomingBase.id !== currentBase.id) {
        throw new HttpError(400, "The smallest unit cannot be replaced. You can rename it instead.");
    }
    for (const unit of incoming) {
        if (unit.id !== undefined && !currentIds.has(unit.id)) {
            throw new HttpError(400, "A unit does not belong to this product.");
        }
    }

    // 1. Remove units that were taken off (only if never used in a sale or purchase)
    const keep = new Set(incoming.filter((u) => u.id !== undefined).map((u) => u.id));
    for (const unit of current) {
        if (keep.has(unit.id)) continue;
        const used = await client.query(
            `SELECT 1 FROM sale_items WHERE unit_id = $1
             UNION ALL SELECT 1 FROM purchase_items WHERE unit_id = $1 LIMIT 1`,
            [unit.id]
        );
        if (used.rowCount > 0) {
            throw new HttpError(409, `The unit "${unit.name}" was used in past sales or purchases, so it cannot be removed.`);
        }
        await client.query("DELETE FROM product_units WHERE id = $1", [unit.id]);
    }

    // 2. Rename/re-count existing units (two passes so names can be swapped safely)
    const existing = incoming.filter((u) => u.id !== undefined);
    for (const unit of existing) {
        await client.query("UPDATE product_units SET name = $1 WHERE id = $2", [`__tmp_${unit.id}`, unit.id]);
    }
    for (const unit of existing) {
        await client.query(
            "UPDATE product_units SET name = $1, factor_to_base = $2 WHERE id = $3 AND product_id = $4",
            [unit.name, unit.factor, unit.id, productId]
        );
    }

    // 3. Add new units
    for (const unit of incoming.filter((u) => u.id === undefined)) {
        await client.query(
            "INSERT INTO product_units (product_id, name, factor_to_base) VALUES ($1, $2, $3)",
            [productId, unit.name, unit.factor]
        );
    }
}

async function unitMap(client, productId) {
    const rows = (await client.query(
        "SELECT id, name, factor_to_base FROM product_units WHERE product_id = $1", [productId]
    )).rows;
    const base = rows.find((u) => u.factor_to_base === 1);
    return { ids: new Map(rows.map((u) => [u.name.toLowerCase(), u.id])), baseId: base ? base.id : null };
}

// ---------------------------------------------------------------------
// CSV import / export columns (one product per row)
// ---------------------------------------------------------------------
const CSV_COLUMNS = [
    "name", "category", "barcode", "base_unit", "cost_price", "retail_price",
    "wholesale_price", "wholesale_min_qty", "stock", "reorder_level", "expiry_date",
    "unit2_name", "unit2_factor", "unit2_wholesale_price",
    "unit3_name", "unit3_factor", "unit3_wholesale_price"
];

const CSV_EXAMPLES = [
    { name: "Sugar", category: "Groceries", barcode: "", base_unit: "Kg", cost_price: 4200, retail_price: 5000,
      wholesale_price: 4700, wholesale_min_qty: 10, stock: 150, reorder_level: 20, expiry_date: "",
      unit2_name: "Sack (50kg)", unit2_factor: 50, unit2_wholesale_price: 225000, unit3_name: "", unit3_factor: "", unit3_wholesale_price: "" },
    { name: "Laundry Soap", category: "Household", barcode: "", base_unit: "Piece", cost_price: 1200, retail_price: 1500,
      wholesale_price: "", wholesale_min_qty: "", stock: 240, reorder_level: 30, expiry_date: "",
      unit2_name: "Pack (10)", unit2_factor: 10, unit2_wholesale_price: 13500, unit3_name: "Carton (12 packs)", unit3_factor: 120, unit3_wholesale_price: 155000 }
];

async function ensureCategory(client, shopId, name) {
    const found = await client.query(
        "SELECT id FROM categories WHERE shop_id = $1 AND LOWER(name) = LOWER($2) ORDER BY id LIMIT 1",
        [shopId, name]
    );
    if (found.rows[0]) return found.rows[0].id;
    const created = await client.query(
        "INSERT INTO categories (shop_id, name) VALUES ($1, $2) RETURNING id", [shopId, name]
    );
    return created.rows[0].id;
}

/** One CSV row -> the same shape the "add product" screen sends. */
async function rowToBody(client, shopId, row) {
    const baseName = String(row.base_unit || "").trim() || "Piece";
    const units = [{ name: baseName, factor: 1 }];
    const prices = [];

    const retail = num(row.retail_price);
    if (retail !== undefined) prices.push({ unit: baseName, level: "retail", price: retail });
    const wholesale = num(row.wholesale_price);
    if (wholesale !== undefined) {
        prices.push({ unit: baseName, level: "wholesale", price: wholesale, minQty: num(row.wholesale_min_qty) || 1 });
    }
    for (const n of [2, 3]) {
        const unitName = String(row[`unit${n}_name`] || "").trim();
        if (!unitName) continue;
        units.push({ name: unitName, factor: num(row[`unit${n}_factor`]) });
        const unitWholesale = num(row[`unit${n}_wholesale_price`]);
        if (unitWholesale !== undefined) prices.push({ unit: unitName, level: "wholesale", price: unitWholesale, minQty: 1 });
    }

    const categoryName = String(row.category || "").trim();
    return {
        name: row.name,
        barcode: row.barcode,
        categoryId: categoryName ? await ensureCategory(client, shopId, categoryName) : null,
        costPrice: num(row.cost_price),
        reorderLevel: num(row.reorder_level),
        openingStock: num(row.stock),
        expiryDate: row.expiry_date,
        units,
        prices
    };
}

// ---------------------------------------------------------------------
// Export / import (defined before "/:id" so these words are not read as ids)
// ---------------------------------------------------------------------
router.get(
    "/export",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        if (req.query.template) {
            return res.json({ success: true, data: { columns: CSV_COLUMNS, rows: CSV_EXAMPLES } });
        }

        const { rows } = await pool.query(
            `SELECT p.id, p.name, c.name AS category, p.barcode, p.cost_price, p.reorder_level,
                    p.stock_base, p.expiry_date
             FROM products p LEFT JOIN categories c ON c.id = p.category_id
             WHERE p.shop_id = $1 AND p.is_active
             ORDER BY LOWER(p.name)`,
            [req.user.shopId]
        );
        const { units, prices } = await loadUnitsAndPrices(pool, rows.map((r) => r.id));

        let cutOff = 0; // products with more than 3 units (the file has room for 3)
        const lowestPrice = (list, unitId, level) =>
            list.filter((p) => p.unitId === unitId && p.level === level && !p.customerId)
                .sort((a, b) => a.minQty - b.minQty)[0];

        const out = rows.map((row) => {
            const u = units.get(row.id) || [];
            const pr = prices.get(row.id) || [];
            if (u.length > 3) cutOff++;
            const base = u[0];
            const baseRetail = base ? lowestPrice(pr, base.id, "retail") : null;
            const baseWholesale = base ? lowestPrice(pr, base.id, "wholesale") : null;
            const record = {
                name: row.name, category: row.category || "", barcode: row.barcode || "",
                base_unit: base ? base.name : "", cost_price: row.cost_price,
                retail_price: baseRetail ? baseRetail.price : "",
                wholesale_price: baseWholesale ? baseWholesale.price : "",
                wholesale_min_qty: baseWholesale ? baseWholesale.minQty : "",
                stock: row.stock_base, reorder_level: row.reorder_level, expiry_date: row.expiry_date || ""
            };
            [1, 2].forEach((i) => {
                const unit = u[i];
                const n = i + 1;
                const w = unit ? lowestPrice(pr, unit.id, "wholesale") : null;
                record[`unit${n}_name`] = unit ? unit.name : "";
                record[`unit${n}_factor`] = unit ? unit.factor : "";
                record[`unit${n}_wholesale_price`] = w ? w.price : "";
            });
            return record;
        });

        res.json({ success: true, data: { columns: CSV_COLUMNS, rows: out, cutOff } });
    })
);

router.post(
    "/import",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const rows = req.body && req.body.rows;
        if (!Array.isArray(rows) || rows.length === 0) throw new HttpError(400, "There are no rows to import.");
        if (rows.length > 300) throw new HttpError(400, "Send at most 300 rows at a time.");

        const result = { created: 0, skipped: 0, errors: [] };
        for (const raw of rows) {
            const row = raw && typeof raw === "object" ? raw : {};
            try {
                // Each row is its own transaction: one bad row never spoils the others.
                await pool.withTransaction(async (client) => {
                    const body = await rowToBody(client, req.user.shopId, row);
                    const data = await parseNewProduct(client, req.user.shopId, body);
                    await insertProduct(client, req.user, data);
                });
                result.created++;
            } catch (error) {
                const known = error instanceof HttpError || error.code === "23505" || error.code === "23514";
                if (!known) throw error;
                result.skipped++;
                result.errors.push({
                    line: row.line || null,
                    name: String(row.name || "").slice(0, 80),
                    message: error instanceof HttpError ? error.message : "This product already exists."
                });
            }
        }

        await logAudit(pool, {
            shopId: req.user.shopId, userId: req.user.id, action: "product.import",
            details: { created: result.created, skipped: result.skipped }, ip: req.ip
        });
        res.json({ success: true, data: result });
    })
);

// ---------------------------------------------------------------------
// List and detail
// ---------------------------------------------------------------------
router.get(
    "/",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const canSeeCost = req.user.role === "owner";
        const lowDefault = await lowStockDefault(pool, shopId);

        const params = [shopId];
        const where = ["p.shop_id = $1"];
        const add = (value) => { params.push(value); return `$${params.length}`; };

        const status = req.query.status || "active";
        if (status === "active") where.push("p.is_active");
        else if (status === "inactive") where.push("NOT p.is_active");
        else if (status !== "all") throw new HttpError(400, "Unknown status.");

        const search = String(req.query.search || "").trim().slice(0, 80);
        if (search) {
            const like = add(`%${escapeLike(search)}%`);
            where.push(`(p.name ILIKE ${like} OR p.barcode ILIKE ${like} OR p.sku ILIKE ${like})`);
        }
        if (req.query.categoryId) where.push(`p.category_id = ${add(parseId(req.query.categoryId))}`);

        const filter = req.query.filter || "";
        if (filter === "low") {
            where.push(`p.stock_base > 0 AND p.stock_base <=
                CASE WHEN p.reorder_level > 0 THEN p.reorder_level ELSE ${add(lowDefault)} END`);
        } else if (filter === "out") {
            where.push("p.stock_base <= 0");
        } else if (filter === "expiring") {
            where.push("p.expiry_date IS NOT NULL AND p.expiry_date <= CURRENT_DATE + 30");
        } else if (filter) {
            throw new HttpError(400, "Unknown filter.");
        }

        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const whereSql = where.join(" AND ");

        const total = (await pool.query(`SELECT COUNT(*) AS n FROM products p WHERE ${whereSql}`, params)).rows[0].n;
        const limitParam = add(limit);
        const offsetParam = add((page - 1) * limit);
        const { rows } = await pool.query(
            `SELECT ${LIST_COLUMNS}
             FROM products p LEFT JOIN categories c ON c.id = p.category_id
             WHERE ${whereSql}
             ORDER BY LOWER(p.name), p.id
             LIMIT ${limitParam} OFFSET ${offsetParam}`,
            params
        );

        const { units, prices } = await loadUnitsAndPrices(pool, rows.map((r) => r.id));
        res.json({
            success: true,
            data: {
                products: rows.map((r) => shapeProduct(r, units, prices, { canSeeCost, lowDefault })),
                page, limit, total, hasMore: page * limit < total
            }
        });
    })
);

router.get(
    "/:id",
    asyncHandler(async (req, res) => {
        const id = parseId(req.params.id);
        const canSeeCost = req.user.role === "owner";
        const lowDefault = await lowStockDefault(pool, req.user.shopId);

        const { rows } = await pool.query(
            `SELECT ${LIST_COLUMNS}, p.photo
             FROM products p LEFT JOIN categories c ON c.id = p.category_id
             WHERE p.id = $1 AND p.shop_id = $2`,
            [id, req.user.shopId]
        );
        if (rows.length === 0) throw new HttpError(404, "That product could not be found.");

        const { units, prices } = await loadUnitsAndPrices(pool, [id]);
        const product = shapeProduct(rows[0], units, prices, { canSeeCost, lowDefault });
        product.photo = rows[0].photo;
        product.prices = prices.get(id) || [];

        if (canSeeCost) {
            const history = await pool.query(
                `SELECT cost_price, created_at FROM product_cost_history
                 WHERE product_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10`,
                [id]
            );
            product.costHistory = history.rows.map((h) => ({ costPrice: h.cost_price, at: h.created_at }));
        }
        res.json({ success: true, data: { product } });
    })
);

// ---------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------
router.post(
    "/",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const data = await parseNewProduct(pool, req.user.shopId, req.body || {});
        const id = await pool.withTransaction((client) => insertProduct(client, req.user, data));
        res.status(201).json({ success: true, message: "Product added.", data: { id } });
    })
);

// ---------------------------------------------------------------------
// Change (send only what changed). Not used for stock.
// ---------------------------------------------------------------------
router.patch(
    "/:id",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const body = req.body || {};

        const found = await pool.query("SELECT * FROM products WHERE id = $1 AND shop_id = $2", [id, shopId]);
        const existing = found.rows[0];
        if (!existing) throw new HttpError(404, "That product could not be found.");

        // Column names below are fixed by us, never taken from the request.
        const changes = {};
        if (has(body, "name")) {
            changes.name = cleanText(body.name, "the product name", { max: 200 });
            if (changes.name.toLowerCase() !== existing.name.toLowerCase()) {
                await assertNameFree(pool, shopId, changes.name, id);
            }
        }
        if (has(body, "categoryId")) changes.category_id = await checkCategory(pool, shopId, body.categoryId);
        if (has(body, "barcode")) {
            changes.barcode = cleanText(body.barcode, "the barcode", { required: false, max: 60 });
            await assertBarcodeFree(pool, shopId, changes.barcode, id);
        }
        if (has(body, "sku")) changes.sku = cleanText(body.sku, "the SKU", { required: false, max: 60 });
        if (has(body, "costPrice")) changes.cost_price = wholeNumber(body.costPrice, "the cost price", { min: 0, max: MAX_MONEY });
        if (has(body, "reorderLevel")) changes.reorder_level = wholeNumber(body.reorderLevel, "the low stock level", { min: 0, max: 1000000 });
        if (has(body, "expiryDate")) changes.expiry_date = cleanDate(body.expiryDate);
        if (has(body, "photo")) changes.photo = cleanPhoto(body.photo);
        if (has(body, "isActive")) {
            if (typeof body.isActive !== "boolean") throw new HttpError(400, "Choose on or off.");
            changes.is_active = body.isActive;
        }
        const units = has(body, "units") ? cleanUnits(body.units) : null;
        const prices = has(body, "prices") ? cleanPrices(body.prices) : null;

        const columns = Object.keys(changes);
        if (columns.length === 0 && !units && !prices) throw new HttpError(400, "There is nothing to save.");

        await pool.withTransaction(async (client) => {
            if (columns.length > 0) {
                const assignments = columns.map((column, index) => `${column} = $${index + 1}`);
                const values = columns.map((column) => changes[column]);
                values.push(id, shopId);
                await client.query(
                    `UPDATE products SET ${assignments.join(", ")}
                     WHERE id = $${values.length - 1} AND shop_id = $${values.length}`,
                    values
                );
            }

            if (has(changes, "cost_price") && changes.cost_price !== existing.cost_price) {
                await client.query(
                    "INSERT INTO product_cost_history (product_id, cost_price) VALUES ($1, $2)",
                    [id, changes.cost_price]
                );
            }

            if (units) await syncUnits(client, id, units);

            if (prices) {
                const { ids, baseId } = await unitMap(client, id);
                const resolved = resolvePrices(prices, ids, baseId);
                // Replace retail and wholesale prices; per-customer 'special' prices are left alone.
                await client.query(
                    `DELETE FROM product_prices
                     WHERE product_id = $1 AND level IN ('retail', 'wholesale') AND customer_id IS NULL`,
                    [id]
                );
                await writePrices(client, id, resolved);
            }

            await logAudit(client, {
                shopId, userId: req.user.id, action: "product.update", entityType: "product", entityId: id,
                details: {
                    changed: [...columns.filter((c) => c !== "photo"), units ? "units" : null, prices ? "prices" : null]
                        .filter(Boolean),
                    photoChanged: columns.includes("photo")
                },
                ip: req.ip
            });
        });

        res.json({ success: true, message: "Saved." });
    })
);

module.exports = router;
