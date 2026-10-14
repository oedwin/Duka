// routes/users.js - the owner manages staff accounts (owner only).
//   GET   /api/users                      list staff
//   POST  /api/users                      add a staff member
//   PATCH /api/users/:id                  change name / role, switch on or off
//   POST  /api/users/:id/reset-password   give someone a new password
const express = require("express");
const bcrypt = require("bcryptjs");

const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { normalizePhone, formatPhone } = require("../utils/phone");
const { cleanText, checkPassword, parseId, has } = require("../utils/validators");
const { logAudit } = require("../utils/audit");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("owner"));

const ROLES = ["owner", "cashier"];

function toStaff(row) {
    return {
        id: row.id,
        fullName: row.full_name,
        phone: row.phone,
        phoneDisplay: formatPhone(row.phone),
        role: row.role,
        isActive: row.is_active,
        lastLoginAt: row.last_login_at,
        createdAt: row.created_at
    };
}

const STAFF_COLUMNS = "id, full_name, phone, role, is_active, last_login_at, created_at";

// ---------- List ----------
router.get(
    "/",
    asyncHandler(async (req, res) => {
        const { rows } = await pool.query(
            `SELECT ${STAFF_COLUMNS} FROM users
             WHERE shop_id = $1
             ORDER BY is_active DESC, role, full_name`,
            [req.user.shopId]
        );
        res.json({ success: true, data: { staff: rows.map(toStaff) } });
    })
);

// ---------- Add ----------
router.post(
    "/",
    asyncHandler(async (req, res) => {
        const fullName = cleanText(req.body.fullName, "the staff member's name");
        const phone = normalizePhone(req.body.phone);
        if (!phone) throw new HttpError(400, "Enter a valid phone number, like 0772 123 456.");
        const password = checkPassword(req.body.password);
        const role = has(req.body, "role") ? req.body.role : "cashier";
        if (!ROLES.includes(role)) throw new HttpError(400, "Choose Owner or Cashier.");

        const taken = await pool.query("SELECT 1 FROM users WHERE phone = $1", [phone]);
        if (taken.rowCount > 0) {
            throw new HttpError(409, "Someone already uses this phone number.");
        }

        const hash = await bcrypt.hash(password, 10);
        const { rows } = await pool.query(
            `INSERT INTO users (shop_id, full_name, phone, password_hash, role)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING ${STAFF_COLUMNS}`,
            [req.user.shopId, fullName, phone, hash, role]
        );

        await logAudit(pool, {
            shopId: req.user.shopId,
            userId: req.user.id,
            action: "user.create",
            entityType: "user",
            entityId: rows[0].id,
            details: { role },
            ip: req.ip
        });

        res.status(201).json({ success: true, message: "Staff member added.", data: { user: toStaff(rows[0]) } });
    })
);

// ---------- Change ----------
router.patch(
    "/:id",
    asyncHandler(async (req, res) => {
        const id = parseId(req.params.id);

        const found = await pool.query(
            "SELECT id, role, is_active FROM users WHERE id = $1 AND shop_id = $2",
            [id, req.user.shopId]
        );
        const target = found.rows[0];
        if (!target) throw new HttpError(404, "That staff member could not be found.");

        const fullName = has(req.body, "fullName") ? cleanText(req.body.fullName, "the staff member's name") : null;

        let role = null;
        if (has(req.body, "role")) {
            if (!ROLES.includes(req.body.role)) throw new HttpError(400, "Choose Owner or Cashier.");
            role = req.body.role;
        }

        let isActive = null;
        if (has(req.body, "isActive")) {
            if (typeof req.body.isActive !== "boolean") throw new HttpError(400, "Choose on or off.");
            isActive = req.body.isActive;
        }

        // Safety rules so the shop can never lock itself out.
        const losesOwnerPower =
            target.role === "owner" &&
            target.is_active &&
            ((role !== null && role !== "owner") || isActive === false);

        if (losesOwnerPower) {
            if (id === req.user.id) {
                throw new HttpError(400, "You cannot switch off or demote your own account.");
            }
            const others = await pool.query(
                `SELECT COUNT(*) AS n FROM users
                 WHERE shop_id = $1 AND role = 'owner' AND is_active AND id <> $2`,
                [req.user.shopId, id]
            );
            if (others.rows[0].n === 0) {
                throw new HttpError(400, "The shop needs at least one active owner.");
            }
        }

        const { rows } = await pool.query(
            `UPDATE users
             SET full_name = COALESCE($1, full_name),
                 role      = COALESCE($2, role),
                 is_active = COALESCE($3, is_active)
             WHERE id = $4 AND shop_id = $5
             RETURNING ${STAFF_COLUMNS}`,
            [fullName, role, isActive, id, req.user.shopId]
        );

        await logAudit(pool, {
            shopId: req.user.shopId,
            userId: req.user.id,
            action: "user.update",
            entityType: "user",
            entityId: id,
            details: { fullName: fullName !== null, role, isActive },
            ip: req.ip
        });

        res.json({ success: true, message: "Saved.", data: { user: toStaff(rows[0]) } });
    })
);

// ---------- Reset a password ----------
router.post(
    "/:id/reset-password",
    asyncHandler(async (req, res) => {
        const id = parseId(req.params.id);
        const newPassword = checkPassword(req.body.newPassword, "new password");
        const hash = await bcrypt.hash(newPassword, 10);

        const result = await pool.query(
            "UPDATE users SET password_hash = $1 WHERE id = $2 AND shop_id = $3",
            [hash, id, req.user.shopId]
        );
        if (result.rowCount === 0) throw new HttpError(404, "That staff member could not be found.");

        await logAudit(pool, {
            shopId: req.user.shopId,
            userId: req.user.id,
            action: "user.reset_password",
            entityType: "user",
            entityId: id,
            ip: req.ip
        });

        res.json({ success: true, message: "New password saved. Tell them to log in with it." });
    })
);

module.exports = router;
