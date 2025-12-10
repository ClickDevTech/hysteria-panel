/**
 * Middleware для проверки авторизации админа (сессия)
 */

const logger = require('../utils/logger');

function requireAuth(req, res, next) {
    if (!req.session || !req.session.authenticated) {
        logger.warn(`[Auth] Unauthorized request: ${req.method} ${req.path} (IP: ${req.ip})`);
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    next();
}

module.exports = requireAuth;


