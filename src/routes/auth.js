/**
 * HTTP Auth эндпоинт для Hysteria 2 нод
 * Ноды отправляют сюда запросы при каждом подключении клиента
 */

const express = require('express');
const router = express.Router();
const HyUser = require('../models/hyUserModel');
const cryptoService = require('../services/cryptoService');
const cache = require('../services/cacheService');
const { getSettings } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Извлечь IP из addr (поддержка IPv4 и IPv6)
 * Примеры:
 *   "185.90.103.104:55239" → "185.90.103.104"
 *   "[2001:db8::1]:55239" → "2001:db8::1"
 *   "::ffff:192.168.1.1:55239" → "::ffff:192.168.1.1"
 */
function extractIP(addr) {
    if (!addr) return '';
    
    // IPv6 с квадратными скобками: [2001:db8::1]:55239
    if (addr.startsWith('[')) {
        const endBracket = addr.indexOf(']');
        if (endBracket > 0) {
            return addr.substring(1, endBracket);
        }
    }
    
    // Находим последнее двоеточие
    const lastColon = addr.lastIndexOf(':');
    if (lastColon > 0) {
        // Проверяем, является ли часть после : портом (только цифры)
        const afterColon = addr.substring(lastColon + 1);
        if (/^\d+$/.test(afterColon)) {
            return addr.substring(0, lastColon);
        }
    }
    
    return addr;
}

/**
 * Проверить лимит устройств по уникальным IP
 * 
 * @param {string} userId - ID пользователя
 * @param {string} clientIP - IP адрес клиента
 * @param {number} maxDevices - Максимум устройств
 * @returns {Object} { allowed: boolean, activeCount: number }
 */
async function checkDeviceLimit(userId, clientIP, maxDevices) {
    try {
        // Получаем настройки grace period
        const settings = await getSettings();
        const gracePeriodMinutes = settings?.deviceGracePeriod ?? 15;
        const gracePeriodMs = gracePeriodMinutes * 60 * 1000;
        
        // Получаем все IP этого пользователя из Redis
        // Если Redis недоступен - вернет {} (fallback: лимит не работает корректно)
        const deviceIPs = await cache.getDeviceIPs(userId);
        const now = Date.now();
        
        // Считаем активные IP (в пределах grace period)
        const activeIPs = new Set();
        for (const [ip, timestamp] of Object.entries(deviceIPs)) {
            if (now - parseInt(timestamp) < gracePeriodMs) {
                activeIPs.add(ip);
            }
        }
        
        // Добавляем текущий IP
        activeIPs.add(clientIP);
        
        const activeCount = activeIPs.size;
        
        // Проверяем лимит
        if (activeCount > maxDevices) {
            return { allowed: false, activeCount };
        }
        
        // Разрешено — обновляем timestamp для этого IP
        await cache.updateDeviceIP(userId, clientIP);
        
        // Периодически чистим старые IP (не при каждом запросе)
        if (Math.random() < 0.1) { // 10% запросов
            await cache.cleanupOldDeviceIPs(userId, gracePeriodMs);
        }
        
        return { allowed: true, activeCount };
    } catch (err) {
        logger.error(`[Auth] Ошибка проверки устройств: ${err.message}`);
        // В случае ошибки — разрешаем (fail open)
        return { allowed: true, activeCount: 0 };
    }
}

/**
 * Получить пользователя (с кэшированием)
 */
async function getUserWithCache(userId) {
    // Сначала проверяем Redis кэш
    const cached = await cache.getUser(userId);
    if (cached) {
        return cached;
    }
    
    // Если кэша нет — запрашиваем из MongoDB
    const user = await HyUser.findOne({ userId }).populate('groups').lean();
    
    if (user) {
        // Сохраняем в Redis (без пароля)
        await cache.setUser(userId, user);
    }
    
    return user;
}

/**
 * POST /auth - Проверка авторизации пользователя
 * 
 * Hysteria отправляет:
 * {
 *   "addr": "IP:port клиента",
 *   "auth": "строка авторизации от клиента",
 *   "tx": bandwidth клиента
 * }
 * 
 * Мы ожидаем auth в формате: "userId:password" или просто "userId"
 * 
 * Ответ:
 * { "ok": true, "id": "userId" } — разрешить
 * { "ok": false } — запретить
 */
router.post('/', async (req, res) => {
    try {
        const { addr, auth, tx } = req.body;
        
        if (!auth) {
            logger.warn(`[Auth] Пустой auth от ${addr}`);
            return res.json({ ok: false });
        }
        
        // Парсим auth строку: может быть "userId:password" или "userId"
        let userId, password;
        
        if (auth.includes(':')) {
            [userId, password] = auth.split(':');
        } else {
            userId = auth;
            password = null;
        }
        
        // Ищем пользователя с группами (с кэшированием)
        const user = await getUserWithCache(userId);
        
        if (!user) {
            logger.warn(`[Auth] Пользователь не найден: ${userId} (${addr})`);
            return res.json({ ok: false });
        }
        
        // Проверяем что подписка активна
        if (!user.enabled) {
            logger.warn(`[Auth] Подписка неактивна: ${userId} (${addr})`);
            return res.json({ ok: false });
        }
        
        // Проверяем пароль если указан
        if (password) {
            const expectedPassword = cryptoService.generatePassword(userId);
            if (password !== expectedPassword && password !== user.password) {
                logger.warn(`[Auth] Неверный пароль: ${userId} (${addr})`);
                return res.json({ ok: false });
            }
        }
        
        // Проверяем лимит трафика
        if (user.trafficLimit > 0) {
            const usedTraffic = (user.traffic?.tx || 0) + (user.traffic?.rx || 0);
            if (usedTraffic >= user.trafficLimit) {
                logger.warn(`[Auth] Превышен лимит трафика: ${userId} (${addr})`);
                return res.json({ ok: false });
            }
        }
        
        // Проверяем дату истечения
        if (user.expireAt && new Date(user.expireAt) < new Date()) {
            logger.warn(`[Auth] Подписка истекла: ${userId} (${addr})`);
            return res.json({ ok: false });
        }
        
        // Проверяем лимит устройств
        let maxDevices = user.maxDevices;
        
        // Если у пользователя 0 - берём минимальный из групп
        if (maxDevices === 0 && user.groups?.length > 0) {
            const groupLimits = user.groups
                .filter(g => g.maxDevices > 0)
                .map(g => g.maxDevices);
            
            if (groupLimits.length > 0) {
                maxDevices = Math.min(...groupLimits);
            }
        }
        
        // -1 = безлимит, 0 = без ограничений (нет настроек)
        if (maxDevices > 0) {
            // Извлекаем IP из addr (поддержка IPv4 и IPv6)
            const clientIP = extractIP(addr);
            
            const { allowed, activeCount } = await checkDeviceLimit(userId, clientIP, maxDevices);
            
            if (!allowed) {
                logger.warn(`[Auth] Превышен лимит устройств (${activeCount}/${maxDevices} IP): ${userId} (${addr})`);
                return res.json({ ok: false });
            }
        }
        
        logger.debug(`[Auth] ✅ Авторизован: ${userId} (${addr})`);
        
        // Успешная авторизация
        // Bandwidth ограничивается на стороне КЛИЕНТА (в подписке)
        // или глобально на сервере (bandwidth в config.yaml)
        return res.json({ 
            ok: true, 
            id: userId,
        });
        
    } catch (error) {
        logger.error(`[Auth] Ошибка: ${error.message}`);
        // В случае ошибки — запрещаем (безопаснее)
        return res.json({ ok: false });
    }
});

// Эндпоинт /check/:userId удалён по соображениям безопасности
// Для отладки используйте логи или веб-панель

module.exports = router;
