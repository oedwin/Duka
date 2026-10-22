// utils/httpError.js - an error that carries an HTTP status and a plain-language message.
// Throw it anywhere in a route:  throw new HttpError(400, "Please enter the shop name.");
// `extra` is sent to the screen too, e.g. { code: "BELOW_COST", details: ["Sugar"] },
// so the screen can ask "Sell anyway?" instead of only showing a message.
class HttpError extends Error {
    constructor(status, message, extra) {
        super(message);
        this.status = status;
        this.extra = extra || null;
    }
}

module.exports = HttpError;
