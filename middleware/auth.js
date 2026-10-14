// middleware/auth.js - who is calling the API?
//   requireAuth        -> must be logged in; sets req.user
//   requireRole(...)   -> must also have one of the given roles
require("dotenv").config();

const jwt = require("jsonwebtoken");
const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 16) {
    // Stop at startup with a clear message instead of failing later.
    throw new Error(
        "JWT_SECRET is missing or too short. Add a long random value to your .env file (see .env.example)."
    );
}

/** Make the login token that the browser keeps. It only contains the user id. */
function signToken(userId) {
    return jwt.sign({ sub: String(userId) }, SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || "12h"
    });
}

const requireAuth = asyncHandler(async (req, res, next) => {
    const [scheme, token] = (req.headers.authorization || "").split(" ");
    if (scheme !== "Bearer" || !token) {
        throw new HttpError(401, "Please log in.");
    }

    let payload;
    try {
        payload = jwt.verify(token, SECRET);
    } catch (error) {
        throw new HttpError(401, "Your session has ended. Please log in again.");
    }

    // Look the user up every time, so switching someone off works immediately.
    const { rows } = await pool.query(
        `SELECT u.id, u.shop_id, u.full_name, u.phone, u.role, u.is_active,
                s.is_active AS shop_active
         FROM users u
         JOIN shops s ON s.id = u.shop_id
         WHERE u.id = $1`,
        [payload.sub]
    );
    const user = rows[0];
    if (!user || !user.is_active || !user.shop_active) {
        throw new HttpError(401, "This account is switched off. Please contact the shop owner.");
    }

    req.user = {
        id: user.id,
        shopId: user.shop_id,
        fullName: user.full_name,
        phone: user.phone,
        role: user.role
    };
    next();
});

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return next(new HttpError(403, "You do not have permission to do this."));
        }
        next();
    };
}

module.exports = { signToken, requireAuth, requireRole };
