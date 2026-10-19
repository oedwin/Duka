// routes/categories.js - product categories.
//   GET    /api/categories        everyone logged in
//   POST   /api/categories        owner: add
//   PATCH  /api/categories/:id    owner: rename
//   DELETE /api/categories/:id    owner: remove (its products simply become "no category")
const express = require("express");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { cleanText, parseId } = require("../utils/validators");
const { logAudit } = require("../utils/audit");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

async function assertNameFree(shopId, name, exceptId) {
    const { rowCount } = await pool.query(
        `SELECT 1 FROM categories
         WHERE shop_id = $1 AND LOWER(name) = LOWER($2) AND ($3::bigint IS NULL OR id <> $3)`,
        [shopId, name, exceptId || null]
    );
    if (rowCount > 0) throw new HttpError(409, `You already have a category called "${name}".`);
}

router.get(
    "/",
    asyncHandler(async (req, res) => {
        const { rows } = await pool.query(
            `SELECT c.id, c.name, COUNT(p.id) FILTER (WHERE p.is_active) AS product_count
             FROM categories c
             LEFT JOIN products p ON p.category_id = c.id
             WHERE c.shop_id = $1
             GROUP BY c.id
             ORDER BY LOWER(c.name)`,
            [req.user.shopId]
        );
        res.json({
            success: true,
            data: { categories: rows.map((r) => ({ id: r.id, name: r.name, productCount: r.product_count })) }
        });
    })
);

router.post(
    "/",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const name = cleanText(req.body.name, "the category name", { max: 100 });
        await assertNameFree(req.user.shopId, name);

        const { rows } = await pool.query(
            "INSERT INTO categories (shop_id, name) VALUES ($1, $2) RETURNING id, name",
            [req.user.shopId, name]
        );
        await logAudit(pool, {
            shopId: req.user.shopId, userId: req.user.id, action: "category.create",
            entityType: "category", entityId: rows[0].id, ip: req.ip
        });
        res.status(201).json({
            success: true, message: "Category added.",
            data: { category: { id: rows[0].id, name: rows[0].name, productCount: 0 } }
        });
    })
);

router.patch(
    "/:id",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const id = parseId(req.params.id);
        const name = cleanText(req.body.name, "the category name", { max: 100 });
        await assertNameFree(req.user.shopId, name, id);

        const { rows } = await pool.query(
            "UPDATE categories SET name = $1 WHERE id = $2 AND shop_id = $3 RETURNING id, name",
            [name, id, req.user.shopId]
        );
        if (rows.length === 0) throw new HttpError(404, "That category could not be found.");
        await logAudit(pool, {
            shopId: req.user.shopId, userId: req.user.id, action: "category.rename",
            entityType: "category", entityId: id, ip: req.ip
        });
        res.json({ success: true, message: "Saved.", data: { category: rows[0] } });
    })
);

router.delete(
    "/:id",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const id = parseId(req.params.id);
        const result = await pool.query("DELETE FROM categories WHERE id = $1 AND shop_id = $2", [id, req.user.shopId]);
        if (result.rowCount === 0) throw new HttpError(404, "That category could not be found.");
        await logAudit(pool, {
            shopId: req.user.shopId, userId: req.user.id, action: "category.delete",
            entityType: "category", entityId: id, ip: req.ip
        });
        res.json({ success: true, message: "Category removed." });
    })
);

module.exports = router;
