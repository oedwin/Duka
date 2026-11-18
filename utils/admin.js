// utils/admin.js - the Duka administrator's own login (separate from shop users).
// Admin accounts live in the admin_accounts table (see admin_accounts.sql) and have no shop.
// Their login token is signed with a DIFFERENT secret from shop tokens, so a shop token can never open the
// admin dashboard and an admin token can never be used as a shop login.
require("dotenv").config();
const jwt = require("jsonwebtoken");

const pool = require("../db");
const HttpError = require("./httpError");
const asyncHandler = require("./asyncHandler");

const SECRET = (process.env.ADMIN_JWT_SECRET || (process.env.JWT_SECRET ? process.env.JWT_SECRET + "|duka-admin" : ""));

function signAdminToken(adminId) {
    if (!SECRET) throw new Error("JWT_SECRET is missing.");
    return jwt.sign({ sub: String(adminId), typ: "admin" }, SECRET, { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || "8h" });
}

/** Reads the admin token, finds the account (so switching one off works at once), sets req.admin. */
const requireAdminAuth = asyncHandler(async (req, res, next) => {
    const [scheme, token] = (req.headers.authorization || "").split(" ");
    if (scheme !== "Bearer" || !token) throw new HttpError(401, "Please log in.");
    let payload;
    try {
        payload = jwt.verify(token, SECRET);
    } catch (error) {
        throw new HttpError(401, "Your session has ended. Please log in again.");
    }
    if (payload.typ !== "admin") throw new HttpError(401, "Please log in.");
    const { rows } = await pool.query(
        "SELECT id, full_name, phone, is_active FROM admin_accounts WHERE id = $1", [payload.sub]);
    const admin = rows[0];
    if (!admin || !admin.is_active) throw new HttpError(401, "This account is switched off.");
    req.admin = { id: Number(admin.id), fullName: admin.full_name, phone: admin.phone };
    next();
});

module.exports = { signAdminToken, requireAdminAuth };
