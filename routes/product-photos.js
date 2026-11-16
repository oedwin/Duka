// routes/product-photos.js - product pictures for the product list and the till.
//   GET /api/product-photos?ids=1,2,3    pictures of up to 12 products at once    everyone
// Pictures are kept out of the normal product lists because they are large; screens ask for just
// the ones they show. Answer: { photos: { "1": "data:image/jpeg;base64,...", ... } } (products without a picture are left out).
const express = require("express");
const pool = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { parseId } = require("../utils/validators");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

router.get(
    "/",
    asyncHandler(async (req, res) => {
        const ids = String(req.query.ids || "").split(",").filter(Boolean).slice(0, 12).map((v) => parseId(v));
        const photos = {};
        if (ids.length) {
            const { rows } = await pool.query(
                `SELECT id, photo FROM products
                 WHERE shop_id = $1 AND id = ANY($2::bigint[]) AND photo IS NOT NULL AND photo <> ''`,
                [req.user.shopId, ids]
            );
            rows.forEach((r) => { photos[r.id] = r.photo; });
        }
        res.set("Cache-Control", "private, max-age=300");
        res.json({ success: true, data: { photos } });
    })
);

module.exports = router;
