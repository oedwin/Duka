// middleware/rateLimit.js - slows down password guessing.
// On Vercel the counters live in each server instance's memory, which is
// good enough to stop casual guessing. (A stricter database-backed limiter
// can be added later if needed.)
const rateLimit = require("express-rate-limit");

function limiter({ windowMs, limit, message, skipSuccessfulRequests = false }) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests,
        handler: (req, res) => res.status(429).json({ success: false, message })
    });
}

// 10 wrong logins per 15 minutes per device/network
const loginLimiter = limiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    message: "Too many login attempts. Please wait 15 minutes and try again."
});

// 10 new shops per hour per device/network
const registerLimiter = limiter({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    message: "Too many attempts. Please try again in an hour."
});

module.exports = { loginLimiter, registerLimiter };
