// routes/expenses.js - money spent running the shop: rent, transport, wages, airtime ... (owner only).
//   GET    /api/expenses                    list for a period, with totals by category
//   POST   /api/expenses                    record an expense (needs clientUuid)
//   POST   /api/expenses/:id/void           cancel a wrong expense (kept in the list, marked cancelled)
//   GET    /api/expenses/categories         categories
//   POST   /api/expenses/categories         add a category
//   PATCH  /api/expenses/categories/:id     rename
//   DELETE /api/expenses/categories/:id     remove (its past expenses stay, without a category)
//
// Expenses are subtracted from gross profit to give net profit (see reports).
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { cleanText, parseId } = require("../utils/validators");
const { cleanDate, escapeLike } = require("../utils/productInput");
const { parseExpense } = require("../utils/expenseInput");
const { todayInShop, resolveRange, SHOP_TZ } = require("../utils/time");
const { logAudit } = require("../utils/audit");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("owner"));

// ---------------------------------------------------------------------
// Categories (before "/:id" so the word is not read as an id)
// ---------------------------------------------------------------------
async function assertCategoryFree(shopId, name, exceptId) {
    const { rowCount } = await pool.query(
        `SELECT 1 FROM expense_categories WHERE shop_id = $1 AND LOWER(name) = LOWER($2) AND ($3::bigint IS NULL OR id <> $3)`,
        [shopId, name, exceptId || null]
    );
    if (rowCount > 0) throw new HttpError(409, `You already have a category called "${name}".`);
}

router.get(
    "/categories",
    asyncHandler(async (req, res) => {
        const { rows } = await pool.query(
            `SELECT c.id, c.name, COUNT(e.id) FILTER (WHERE e.voided_at IS NULL) AS uses
             FROM expense_categories c LEFT JOIN expenses e ON e.category_id = c.id
             WHERE c.shop_id = $1 GROUP BY c.id ORDER BY LOWER(c.name)`,
            [req.user.shopId]
        );
        res.json({ success: true, data: { categories: rows.map((r) => ({ id: r.id, name: r.name, uses: r.uses })) } });
    })
);

router.post(
    "/categories",
    asyncHandler(async (req, res) => {
        const name = cleanText(req.body.name, "the category name", { max: 100 });
        await assertCategoryFree(req.user.shopId, name);
        const { rows } = await pool.query(
            "INSERT INTO expense_categories (shop_id, name) VALUES ($1, $2) RETURNING id, name", [req.user.shopId, name]
        );
        res.status(201).json({ success: true, message: "Category added.", data: { category: { id: rows[0].id, name: rows[0].name, uses: 0 } } });
    })
);

router.patch(
    "/categories/:id",
    asyncHandler(async (req, res) => {
        const id = parseId(req.params.id);
        const name = cleanText(req.body.name, "the category name", { max: 100 });
        await assertCategoryFree(req.user.shopId, name, id);
        const { rows } = await pool.query(
            "UPDATE expense_categories SET name = $1 WHERE id = $2 AND shop_id = $3 RETURNING id, name", [name, id, req.user.shopId]
        );
        if (rows.length === 0) throw new HttpError(404, "That category could not be found.");
        res.json({ success: true, message: "Saved.", data: { category: rows[0] } });
    })
);

router.delete(
    "/categories/:id",
    asyncHandler(async (req, res) => {
        const id = parseId(req.params.id);
        const result = await pool.query("DELETE FROM expense_categories WHERE id = $1 AND shop_id = $2", [id, req.user.shopId]);
        if (result.rowCount === 0) throw new HttpError(404, "That category could not be found.");
        res.json({ success: true, message: "Category removed." });
    })
);

// ---------------------------------------------------------------------
// List (default: this month so far)
// ---------------------------------------------------------------------
router.get(
    "/",
    asyncHandler(async (req, res) => {
        const today = todayInShop();
        const { from, to } = resolveRange(
            cleanDate(req.query.from, "the start date") || today.slice(0, 8) + "01",
            cleanDate(req.query.to, "the end date") || today
        );

        const params = [req.user.shopId, from, to];
        const add = (value) => { params.push(value); return `$${params.length}`; };
        const where = ["e.shop_id = $1", "e.expense_date BETWEEN $2::date AND $3::date"];

        const status = req.query.status || "active";
        if (status === "active") where.push("e.voided_at IS NULL");
        else if (status === "voided") where.push("e.voided_at IS NOT NULL");
        else if (status !== "all") throw new HttpError(400, "Unknown status.");

        if (req.query.categoryId) where.push(`e.category_id = ${add(parseId(req.query.categoryId))}`);
        const search = String(req.query.search || "").trim().slice(0, 60);
        if (search) where.push(`e.description ILIKE ${add(`%${escapeLike(search)}%`)}`);

        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const whereSql = where.join(" AND ");

        const totals = (await pool.query(
            `SELECT COUNT(*) AS row_count,
                    COALESCE(SUM(e.amount) FILTER (WHERE e.voided_at IS NULL), 0)::bigint AS total
             FROM expenses e WHERE ${whereSql}`,
            params
        )).rows[0];

        const byCategory = (await pool.query(
            `SELECT COALESCE(c.name, 'No category') AS category, SUM(e.amount)::bigint AS total
             FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id
             WHERE ${whereSql} AND e.voided_at IS NULL
             GROUP BY COALESCE(c.name, 'No category') ORDER BY total DESC`,
            params
        )).rows;

        const limitParam = add(limit);
        const offsetParam = add((page - 1) * limit);
        const { rows } = await pool.query(
            `SELECT e.id, e.expense_date, e.amount, e.description, e.payment_method, e.voided_at, e.void_reason,
                    c.name AS category_name, u.full_name AS by_name
             FROM expenses e
             LEFT JOIN expense_categories c ON c.id = e.category_id
             LEFT JOIN users u ON u.id = e.created_by
             WHERE ${whereSql}
             ORDER BY e.expense_date DESC, e.id DESC
             LIMIT ${limitParam} OFFSET ${offsetParam}`,
            params
        );

        res.json({
            success: true,
            data: {
                range: { from, to },
                expenses: rows.map((r) => ({
                    id: r.id, date: r.expense_date, amount: r.amount, description: r.description,
                    method: r.payment_method, category: r.category_name, by: r.by_name,
                    voided: r.voided_at !== null, voidReason: r.void_reason
                })),
                total: totals.total, byCategory,
                count: totals.row_count, page, limit, hasMore: page * limit < totals.row_count
            }
        });
    })
);

// ---------------------------------------------------------------------
// Record an expense. One statement, so it is naturally all-or-nothing, and a repeat is ignored.
// ---------------------------------------------------------------------
router.post(
    "/",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const input = parseExpense(req.body);

        if (input.categoryId) {
            const ok = await pool.query("SELECT 1 FROM expense_categories WHERE id = $1 AND shop_id = $2", [input.categoryId, shopId]);
            if (ok.rowCount === 0) throw new HttpError(400, "That category does not exist.");
        }

        const created = await pool.query(
            `INSERT INTO expenses (shop_id, client_uuid, category_id, amount, description, payment_method, expense_date, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, (NOW() AT TIME ZONE '${SHOP_TZ}')::date), $8)
             ON CONFLICT (shop_id, client_uuid) DO NOTHING RETURNING id`,
            [shopId, input.clientUuid, input.categoryId, input.amount, input.description, input.paymentMethod,
             input.expenseDate, req.user.id]
        );

        const duplicate = created.rowCount === 0;
        if (!duplicate) {
            await logAudit(pool, {
                shopId, userId: req.user.id, action: "expense.create", entityType: "expense",
                entityId: created.rows[0].id, details: { amount: input.amount, method: input.paymentMethod }, ip: req.ip
            });
        }
        res.status(duplicate ? 200 : 201).json({
            success: true,
            message: duplicate ? "This expense was already saved." : "Expense saved.",
            data: { duplicate }
        });
    })
);

router.post(
    "/:id/void",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const id = parseId(req.params.id);
        const reason = cleanText(req.body.reason, "the reason", { max: 300 });
        const result = await pool.query(
            `UPDATE expenses SET voided_at = NOW(), void_reason = $1
             WHERE id = $2 AND shop_id = $3 AND voided_at IS NULL RETURNING amount`,
            [reason, id, shopId]
        );
        if (result.rowCount === 0) throw new HttpError(404, "That expense could not be found, or it was already cancelled.");
        await logAudit(pool, {
            shopId, userId: req.user.id, action: "expense.void", entityType: "expense", entityId: id,
            details: { amount: result.rows[0].amount, reason }, ip: req.ip
        });
        res.json({ success: true, message: "Expense cancelled." });
    })
);

module.exports = router;
