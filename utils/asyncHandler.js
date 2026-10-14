// utils/asyncHandler.js - lets routes use async/await without try/catch everywhere.
// Any error is passed to the central error handler (middleware/errorHandler.js).
module.exports = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
