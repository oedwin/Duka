// middleware/errorHandler.js - one place that turns every error into the same JSON shape:
//   { "success": false, "message": "plain words the shopkeeper can act on" }
const HttpError = require("../utils/httpError");

// Unknown /api address
function notFound(req, res) {
    res.status(404).json({ success: false, message: "That address does not exist." });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
    // Errors we threw on purpose, with a friendly message
    if (error instanceof HttpError) {
        return res.status(error.status).json({ success: false, message: error.message, ...(error.extra || {}) });
    }

    // Broken or oversized request bodies
    if (error.type === "entity.parse.failed") {
        return res.status(400).json({ success: false, message: "That request could not be read." });
    }
    if (error.type === "entity.too.large") {
        return res.status(413).json({ success: false, message: "That file is too big." });
    }

    // Database rules (see database.sql)
    if (error.code === "23514") {
        // e.g. "Not enough stock for Sugar"
        return res.status(409).json({ success: false, message: error.message });
    }
    if (error.code === "23505") {
        return res.status(409).json({ success: false, message: "That record already exists." });
    }
    if (error.code === "23503") {
        return res.status(409).json({ success: false, message: "That record is still in use elsewhere." });
    }

    // Anything else is our bug: log the details, show a calm message.
    console.error("Server error:", error);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
}

module.exports = { notFound, errorHandler };
