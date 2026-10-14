// routes/auth.js - register a shop, log in, who am I, change my password.
//   POST /api/auth/register          create a shop + its owner
//   POST /api/auth/login             phone + password -> token
//   GET  /api/auth/me                current user and shop name
//   POST /api/auth/change-password   change my own password
const express = require("express");
const bcrypt = require("bcryptjs");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { normalizePhone, formatPhone } = require("../utils/phone");
const { cleanText, checkPassword } = require("../utils/validators");
const { logAudit } = require("../utils/audit");
const { createShopDefaults } = require("../utils/shopDefaults");
const { signToken, requireAuth } = require("../middleware/auth");
const { loginLimiter, registerLimiter } = require("../middleware/rateLimit");

const router = express.Router();

// Used to keep login timing the same when the phone number is unknown.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

function publicUser(row, shopName) {
    return {
        id: row.id,
        fullName: row.full_name,
        phone: row.phone,
        phoneDisplay: formatPhone(row.phone),
        role: row.role,
        shopId: row.shop_id,
        shopName: shopName || null
    };
}

// ---------- Register a new shop ----------
router.post(
    "/register",
    registerLimiter,
    asyncHandler(async (req, res) => {
        const shopName = cleanText(req.body.shopName, "your shop name");
        const fullName = cleanText(req.body.fullName, "your name");
        const address = cleanText(req.body.address, "the address", { required: false, max: 300 });
        const phone = normalizePhone(req.body.phone);
        if (!phone) {
            throw new HttpError(400, "Enter a valid phone number, like 0772 123 456.");
        }
        const password = checkPassword(req.body.password);

        const passwordHash = await bcrypt.hash(password, 10);

        // One transaction: either the whole shop is created, or nothing is.
        const user = await pool.withTransaction(async (client) => {
            const exists = await client.query("SELECT 1 FROM users WHERE phone = $1", [phone]);
            if (exists.rowCount > 0) {
                throw new HttpError(409, "This phone number is already registered. Try logging in.");
            }

            const shop = await client.query(
                "INSERT INTO shops (name, address, phone) VALUES ($1, $2, $3) RETURNING id",
                [shopName, address, formatPhone(phone)]
            );
            const shopId = shop.rows[0].id;

            const created = await client.query(
                `INSERT INTO users (shop_id, full_name, phone, password_hash, role)
                 VALUES ($1, $2, $3, $4, 'owner')
                 RETURNING id, shop_id, full_name, phone, role`,
                [shopId, fullName, phone, passwordHash]
            );

            await createShopDefaults(client, shopId);
            await logAudit(client, {
                shopId,
                userId: created.rows[0].id,
                action: "shop.register",
                entityType: "shop",
                entityId: shopId,
                ip: req.ip
            });
            return created.rows[0];
        });

        res.status(201).json({
            success: true,
            message: "Your shop is ready.",
            data: { token: signToken(user.id), user: publicUser(user, shopName) }
        });
    })
);

// ---------- Log in ----------
router.post(
    "/login",
    loginLimiter,
    asyncHandler(async (req, res) => {
        const phone = normalizePhone(req.body.phone);
        const password = typeof req.body.password === "string" ? req.body.password : "";

        let user = null;
        if (phone) {
            const { rows } = await pool.query(
                `SELECT u.id, u.shop_id, u.full_name, u.phone, u.role, u.password_hash,
                        u.is_active, s.name AS shop_name, s.is_active AS shop_active
                 FROM users u
                 JOIN shops s ON s.id = u.shop_id
                 WHERE u.phone = $1`,
                [phone]
            );
            user = rows[0] || null;
        }

        // Always compare, so a wrong phone and a wrong password look the same.
        const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
        if (!user || !passwordOk) {
            throw new HttpError(401, "Wrong phone number or password.");
        }
        if (!user.is_active || !user.shop_active) {
            throw new HttpError(403, "This account is switched off. Please contact the shop owner.");
        }

        await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);
        await logAudit(pool, {
            shopId: user.shop_id,
            userId: user.id,
            action: "auth.login",
            entityType: "user",
            entityId: user.id,
            ip: req.ip
        });

        res.json({
            success: true,
            data: { token: signToken(user.id), user: publicUser(user, user.shop_name) }
        });
    })
);

// ---------- Who am I? ----------
router.get(
    "/me",
    requireAuth,
    asyncHandler(async (req, res) => {
        const { rows } = await pool.query("SELECT name FROM shops WHERE id = $1", [req.user.shopId]);
        const me = {
            id: req.user.id,
            fullName: req.user.fullName,
            phone: req.user.phone,
            phoneDisplay: formatPhone(req.user.phone),
            role: req.user.role,
            shopId: req.user.shopId,
            shopName: rows[0] ? rows[0].name : null
        };
        res.json({ success: true, data: { user: me } });
    })
);

// ---------- Change my own password ----------
router.post(
    "/change-password",
    requireAuth,
    asyncHandler(async (req, res) => {
        const current = typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
        const newPassword = checkPassword(req.body.newPassword, "new password");

        const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
        const matches = rows[0] && (await bcrypt.compare(current, rows[0].password_hash));
        if (!matches) {
            throw new HttpError(400, "Your current password is not correct.");
        }

        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, req.user.id]);
        await logAudit(pool, {
            shopId: req.user.shopId,
            userId: req.user.id,
            action: "auth.change_password",
            entityType: "user",
            entityId: req.user.id,
            ip: req.ip
        });

        res.json({ success: true, message: "Password changed." });
    })
);

module.exports = router;
