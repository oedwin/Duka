// middleware/auth.js - who is calling the API, and may their business work right now?
//   requireAuth           -> logged in AND the business subscription allows work; sets req.user, req.subscription
//   requireAuthAnyStatus  -> logged in only. Use it for the few things an expired business must still do:
//                            "who am I", change password, see/renew the subscription, pay.
//   requireRole(...)      -> must also have one of the given roles
//   requireFeature(key)   -> the business's plan must include this feature (e.g. "purchasing")
// Subscription rules are only enforced when SUBSCRIPTION_ENFORCE=true in .env.
require("dotenv").config();

const jwt = require("jsonwebtoken");
const pool = require("../db");
const HttpError = require("../utils/httpError");
const asyncHandler = require("../utils/asyncHandler");
const { accessFor, blockedMessage, enforcing } = require("../utils/subscriptions");

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

const USER_SQL = `SELECT u.id, u.shop_id, u.full_name, u.phone, u.role, u.is_active,
                         s.is_active AS shop_active`;
const SUB_SQL = `, sub.status AS sub_status, sub.trial_ends_at, sub.current_period_end,
                   pl.code AS plan_code, pl.name AS plan_name, pl.features, pl.max_users`;

/** Read the token, find the user (and the subscription in the same query), set req.user and req.subscription. */
async function loadUser(req) {
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
    let rows;
    try {
        ({ rows } = await pool.query(
            `${USER_SQL}${SUB_SQL}
             FROM users u
             JOIN shops s ON s.id = u.shop_id
             LEFT JOIN subscriptions sub ON sub.shop_id = u.shop_id
             LEFT JOIN subscription_plans pl ON pl.id = sub.plan_id
             WHERE u.id = $1`,
            [payload.sub]
        ));
    } catch (error) {
        if (error.code !== "42P01") throw error; // 42P01 = the subscription tables are not created yet
        ({ rows } = await pool.query(
            `${USER_SQL} FROM users u JOIN shops s ON s.id = u.shop_id WHERE u.id = $1`,
            [payload.sub]
        ));
    }
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
    req.subscription = accessFor(user.sub_status ? user : null);
}

const requireAuthAnyStatus = asyncHandler(async (req, res, next) => {
    if (!req.user) await loadUser(req);
    next();
});

const requireAuth = asyncHandler(async (req, res, next) => {
    if (!req.user) await loadUser(req);
    if (enforcing() && !req.subscription.allowed) {
        throw new HttpError(402, blockedMessage(req.subscription, req.user.role), {
            code: "SUBSCRIPTION_REQUIRED",
            details: { state: req.subscription.state }
        });
    }
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

/** Put AFTER requireAuth. A business with no subscription row yet is not blocked. */
function requireFeature(feature) {
    return (req, res, next) => {
        const sub = req.subscription;
        if (!enforcing() || !sub || !Array.isArray(sub.features) || sub.features.includes(feature)) return next();
        next(new HttpError(403, "Your plan does not include this. Upgrade your plan to use it.", {
            code: "PLAN_UPGRADE", details: { feature, plan: sub.planCode }
        }));
    };
}

module.exports = { signToken, requireAuth, requireAuthAnyStatus, requireRole, requireFeature };
