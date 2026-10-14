// utils/httpError.js - an error that carries an HTTP status and a plain-language message.
// Throw it anywhere in a route:  throw new HttpError(400, "Please enter the shop name.");
class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

module.exports = HttpError;
