// routes/subscription.js - a business looks after its own subscription.
//   GET  /api/subscription            status, plans with prices, how many users                  everyone
//   GET  /api/subscription/payments   payment history                                            owner
//   POST /api/subscription/checkout   choose a plan + period: saves a pending payment, opens Pesapal owner
//   POST /api/subscription/payments/check   re-check a pending payment with Pesapal              owner
//   POST /api/subscription/cancel     stop renewing (works until the paid date)                  owner
//   POST /api/subscription/resume     change of mind before the end date                         owner
//
// These routes use requireAuthAnyStatus on purpose: a business whose subscription has ended must
// still be able to log in, see its status and pay.
const express = require("express");

const pool = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { cleanText, cleanUuid } = require("../utils/validators");
const S = require("../utils/subscriptions");
const pay = require("../utils/payments");
const { requireAuthAnyStatus, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuthAnyStatus);

// Online payment is on when PAYMENTS_ENABLED=true and the Pesapal keys are set (utils/pesapal.js).
const paymentsEnabled = () => pay.onlinePaymentsReady();

router.get(
    "/",
    asyncHandler(async (req, res) => {
        const shopId = req.user.shopId;
        const [overview, plans, users] = await Promise.all([
            S.getOverview(pool, shopId), S.listPlans(pool), S.activeUserCount(pool, shopId)
        ]);
        res.json({
            success: true,
            data: {
                subscription: Object.assign(S.publicAccess(overview.access), overview.details),
                plans, users, paymentsEnabled: paymentsEnabled()
            }
        });
    })
);

router.get(
    "/payments",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const { payments, total } = await S.listPayments(pool, req.user.shopId, limit, (page - 1) * limit);
        res.json({ success: true, data: { payments, page, limit, total, hasMore: page * limit < total } });
    })
);

router.post(
    "/checkout",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const clientUuid = cleanUuid(req.body.clientUuid, "payment");
        const payment = await S.createCheckout(pool, req.user, {
            planCode: req.body.planCode, months: req.body.months, clientUuid
        });
        // paymentUrl = Pesapal's payment page (null while online payment is switched off: the order is just saved).
        const paymentUrl = await pay.startPayment(pool, req.user, payment);
        res.status(201).json({ success: true, data: { payment, paymentUrl, paymentsEnabled: paymentsEnabled() } });
    })
);

// "Check payment": ask Pesapal again about one of this shop's pending payments (the notification may be late).
router.post(
    "/payments/check",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const result = await pay.checkOwnPayment(pool, req.user, req.body && req.body.ref);
        res.json({ success: true, data: result });
    })
);

router.post(
    "/cancel",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        const reason = cleanText(req.body && req.body.reason, "the reason", { required: false, max: 300 });
        await S.cancelSubscription(pool, req.user, reason);
        res.json({ success: true, message: "Subscription cancelled. You can keep working until the end date." });
    })
);

router.post(
    "/resume",
    requireRole("owner"),
    asyncHandler(async (req, res) => {
        await S.resumeSubscription(pool, req.user);
        res.json({ success: true, message: "Welcome back. Your subscription continues." });
    })
);

module.exports = router;
