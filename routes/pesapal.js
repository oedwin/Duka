// routes/pesapal.js - the two addresses Pesapal itself calls. No login here (Pesapal and the customer's
// browser have no Duka session), so nothing is trusted from the request: every call only carries an order
// number, and payments.settlePayment() asks Pesapal directly what really happened.
//   GET|POST /api/pesapal/ipn        Pesapal: "this payment changed"  (we answer with the JSON it expects)
//   GET      /api/pesapal/callback   the customer, sent back after paying or cancelling -> Subscription page
const express = require("express");

const pool = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { settlePayment } = require("../utils/payments");

const router = express.Router();

const pick = (req, name) => String((req.query && req.query[name]) || (req.body && req.body[name]) || "").slice(0, 80);

router.all(
    "/ipn",
    asyncHandler(async (req, res) => {
        const orderTrackingId = pick(req, "OrderTrackingId");
        const reply = (status) => ({
            orderNotificationType: pick(req, "OrderNotificationType") || "IPNCHANGE",
            orderTrackingId,
            orderMerchantReference: pick(req, "OrderMerchantReference"),
            status
        });
        try {
            await settlePayment(pool, orderTrackingId);
            res.json(reply(200));
        } catch (error) {
            // 500 makes Pesapal send the notification again later.
            console.error("Pesapal notification failed:", error.message);
            res.status(500).json(reply(500));
        }
    })
);

router.get(
    "/callback",
    asyncHandler(async (req, res) => {
        let state = "pending";
        let ref = "";
        try {
            const out = await settlePayment(pool, pick(req, "OrderTrackingId"));
            state = out.state === "unknown" ? "pending" : out.state;
            ref = out.merchantRef || "";
        } catch (error) {
            console.error("Pesapal return check failed:", error.message);
        }
        res.redirect(`/subscription?paid=${encodeURIComponent(state)}&ref=${encodeURIComponent(ref)}`);
    })
);

module.exports = router;
