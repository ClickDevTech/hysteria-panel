/**
 * Сервис кэширования (Redis)
 * 
 * Кэширует:
 * - Подписки пользователей
 * - Данные пользователей (для авторизации)
 * - Онлайн-сессии (для лимита устройств)
 * - Активные ноды
 * 
 * TTL настраивается через панель управления
 */

const Redis = require('ioredis');
const logger = require('../utils/logger');

// TTL по умолчанию (в секундах) - используются если настройки не загружены
const DEFAULT_TTL = {
    SUBSCRIPTION: 3600,      // 1 час
    USER: 900,               // 15 минут
    ONLINE_SESSIONS: 10,     // 10 секунд
    ACTIVE_NODES: 30,        // 30 секунд
    SETTINGS: 60,            // 1 минута (фиксированный)
    TRAFFIC_STATS: 300,      // 5 минут
    GROUPS: 300,             // 5 минут
    DASHBOARD_COUNTS: 60,    // 1 минута
};

// Префиксы ключей
const PREFIX = {
    SUB: 'sub:',             // sub:{token}:{format}
    USER: 'user:',           // user:{userId}
    DEVICES: 'devices:',     // devices:{userId} - Hash с IP устройств
    ONLINE: 'online',        // online (хранит все сессии) - legacy
    NODES: 'nodes:active',   // nodes:active
    SETTINGS: 'settings',    // settings
    TRAFFIC_STATS: 'traffic:stats', // Общая статистика трафика
    GROUPS: 'groups:active', // Активные группы
    DASHBOARD_COUNTS: 'dashboard:counts', // Счётчики для дашборда
};

class CacheService {
    constructor() {
        this.redis = null;
        this.connected = false;
        // Динамические TTL из настроек панели
        this.ttl = { ...DEFAULT_TTL };
    }
    
    /**
     * Обновить TTL из настроек панели
     * Вызывается при старте и при изменении настроек
     */
    updateTTL(settings) {
        if (!settings?.cache) return;
        
        const c = settings.cache;
        this.ttl = {
            SUBSCRIPTION: c.subscriptionTTL || DEFAULT_TTL.SUBSCRIPTION,
            USER: c.userTTL || DEFAULT_TTL.USER,
            ONLINE_SESSIONS: c.onlineSessionsTTL || DEFAULT_TTL.ONLINE_SESSIONS,
            ACTIVE_NODES: c.activeNodesTTL || DEFAULT_TTL.ACTIVE_NODES,
            SETTINGS: DEFAULT_TTL.SETTINGS, // Всегда фиксированный
            TRAFFIC_STATS: DEFAULT_TTL.TRAFFIC_STATS, // Всегда фиксированный
            GROUPS: DEFAULT_TTL.GROUPS, // Всегда фиксированный
            DASHBOARD_COUNTS: DEFAULT_TTL.DASHBOARD_COUNTS, // Всегда фиксированный
        };
        logger.info(`[Cache] TTL обновлены: sub=${this.ttl.SUBSCRIPTION}s, user=${this.ttl.USER}s`);
    }

    /**
     * Подключение к Redis
     */
    async connect() {
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
        
        try {
            this.redis = new Redis(redisUrl, {
                maxRetriesPerRequest: 3,
                retryDelayOnFailover: 100,
                lazyConnect: true,
            });

            this.redis.on('connect', () => {
                this.connected = true;
                logger.info('✅ Redis подключен');
            });

            this.redis.on('error', (err) => {
                logger.error(`[Redis] Ошибка: ${err.message}`);
                this.connected = false;
            });

            this.redis.on('close', () => {
                this.connected = false;
                logger.warn('[Redis] Соединение закрыто');
            });

            await this.redis.connect();
            
        } catch (err) {
            logger.error(`[Redis] Не удалось подключиться: ${err.message}`);
            this.connected = false;
        }
    }

    /**
     * Проверка подключения
     */
    isConnected() {
        return this.connected && this.redis;
    }

    // ==================== ПОДПИСКИ ====================

    /**
     * Получить подписку из кэша
     */
    async getSubscription(token, format) {
        if (!this.isConnected()) return null;
        
        try {
            const key = `${PREFIX.SUB}${token}:${format}`;
            const data = await this.redis.get(key);
            if (data) {
                logger.debug(`[Cache] HIT subscription: ${token}:${format}`);
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getSubscription: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить подписку в кэш
     */
    async setSubscription(token, format, data) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.SUB}${token}:${format}`;
            await this.redis.setex(key, this.ttl.SUBSCRIPTION, JSON.stringify(data));
            logger.debug(`[Cache] SET subscription: ${token}:${format}`);
        } catch (err) {
            logger.error(`[Cache] Ошибка setSubscription: ${err.message}`);
        }
    }

    /**
     * Инвалидировать подписку (все форматы)
     * Использует SCAN вместо KEYS для неблокирующей работы
     */
    async invalidateSubscription(token) {
        if (!this.isConnected()) return;
        
        try {
            const pattern = `${PREFIX.SUB}${token}:*`;
            const keysToDelete = await this._scanKeys(pattern);
            
            if (keysToDelete.length > 0) {
                await this.redis.unlink(...keysToDelete);
                logger.debug(`[Cache] INVALIDATE subscription: ${token} (${keysToDelete.length} keys)`);
            }
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateSubscription: ${err.message}`);
        }
    }

    /**
     * Инвалидировать все подписки (при изменении нод)
     * Использует SCAN вместо KEYS для неблокирующей работы
     */
    async invalidateAllSubscriptions() {
        if (!this.isConnected()) return;
        
        try {
            const pattern = `${PREFIX.SUB}*`;
            const keysToDelete = await this._scanKeys(pattern);
            
            if (keysToDelete.length > 0) {
                // Удаляем батчами по 100 ключей для избежания блокировки
                const BATCH_SIZE = 100;
                for (let i = 0; i < keysToDelete.length; i += BATCH_SIZE) {
                    const batch = keysToDelete.slice(i, i + BATCH_SIZE);
                    await this.redis.unlink(...batch);
                }
                logger.info(`[Cache] INVALIDATE all subscriptions (${keysToDelete.length} keys)`);
            }
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateAllSubscriptions: ${err.message}`);
        }
    }
    
    /**
     * Неблокирующий поиск ключей через SCAN
     * @param {string} pattern - паттерн для поиска
     * @returns {Promise<string[]>} - массив найденных ключей
     */
    async _scanKeys(pattern) {
        const keys = [];
        let cursor = '0';
        
        do {
            const [newCursor, foundKeys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = newCursor;
            keys.push(...foundKeys);
        } while (cursor !== '0');
        
        return keys;
    }

    // ==================== ПОЛЬЗОВАТЕЛИ ====================

    /**
     * Получить пользователя из кэша
     */
    async getUser(userId) {
        if (!this.isConnected()) return null;
        
        try {
            const key = `${PREFIX.USER}${userId}`;
            const data = await this.redis.get(key);
            if (data) {
                logger.debug(`[Cache] HIT user: ${userId}`);
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getUser: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить пользователя в кэш
     */
    async setUser(userId, userData) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.USER}${userId}`;
            // Не кэшируем пароль
            const safeData = { ...userData };
            if (safeData.password) delete safeData.password;
            
            await this.redis.setex(key, this.ttl.USER, JSON.stringify(safeData));
            logger.debug(`[Cache] SET user: ${userId}`);
        } catch (err) {
            logger.error(`[Cache] Ошибка setUser: ${err.message}`);
        }
    }

    /**
     * Инвалидировать пользователя
     */
    async invalidateUser(userId) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.USER}${userId}`;
            await this.redis.del(key);
            logger.debug(`[Cache] INVALIDATE user: ${userId}`);
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateUser: ${err.message}`);
        }
    }

    // ==================== УСТРОЙСТВА (IP) ====================

    /**
     * Получить все IP устройств пользователя с timestamps
     * @param {string} userId 
     * @returns {Object} { ip: timestamp, ... } или пустой объект
     */
    async getDeviceIPs(userId) {
        if (!this.isConnected()) return {};
        
        try {
            const key = `${PREFIX.DEVICES}${userId}`;
            const data = await this.redis.hgetall(key);
            return data || {};
        } catch (err) {
            logger.error(`[Cache] Ошибка getDeviceIPs: ${err.message}`);
            return {};
        }
    }

    /**
     * Обновить timestamp для IP устройства
     * @param {string} userId 
     * @param {string} ip 
     */
    async updateDeviceIP(userId, ip) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.DEVICES}${userId}`;
            await this.redis.hset(key, ip, Date.now().toString());
            // Устанавливаем TTL на весь ключ (автоочистка неактивных юзеров)
            await this.redis.expire(key, 86400); // 24 часа
        } catch (err) {
            logger.error(`[Cache] Ошибка updateDeviceIP: ${err.message}`);
        }
    }

    /**
     * Удалить устаревшие IP устройств
     * @param {string} userId 
     * @param {number} gracePeriodMs - период в миллисекундах
     */
    async cleanupOldDeviceIPs(userId, gracePeriodMs) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.DEVICES}${userId}`;
            const devices = await this.redis.hgetall(key);
            const now = Date.now();
            
            const toDelete = [];
            for (const [ip, timestamp] of Object.entries(devices)) {
                if (now - parseInt(timestamp) > gracePeriodMs) {
                    toDelete.push(ip);
                }
            }
            
            if (toDelete.length > 0) {
                await this.redis.hdel(key, ...toDelete);
                logger.debug(`[Cache] Cleaned ${toDelete.length} old IPs for ${userId}`);
            }
        } catch (err) {
            logger.error(`[Cache] Ошибка cleanupOldDeviceIPs: ${err.message}`);
        }
    }

    /**
     * Сбросить все устройства пользователя (при отключении/кике)
     * @param {string} userId 
     */
    async clearDeviceIPs(userId) {
        if (!this.isConnected()) return;
        
        try {
            const key = `${PREFIX.DEVICES}${userId}`;
            await this.redis.del(key);
            logger.debug(`[Cache] Cleared devices for ${userId}`);
        } catch (err) {
            logger.error(`[Cache] Ошибка clearDeviceIPs: ${err.message}`);
        }
    }

    // ==================== ОНЛАЙН-СЕССИИ (legacy, для совместимости) ====================

    /**
     * Получить онлайн-сессии (legacy)
     * @deprecated Используйте getDeviceIPs для подсчёта устройств
     */
    async getOnlineSessions() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.ONLINE);
            if (data) {
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getOnlineSessions: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить онлайн-сессии (legacy)
     * @deprecated Используйте updateDeviceIP для обновления устройств
     */
    async setOnlineSessions(data) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.ONLINE, this.ttl.ONLINE_SESSIONS, JSON.stringify(data));
        } catch (err) {
            logger.error(`[Cache] Ошибка setOnlineSessions: ${err.message}`);
        }
    }

    // ==================== АКТИВНЫЕ НОДЫ ====================

    /**
     * Получить активные ноды
     */
    async getActiveNodes() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.NODES);
            if (data) {
                logger.debug('[Cache] HIT active nodes');
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getActiveNodes: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить активные ноды
     */
    async setActiveNodes(nodes) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.NODES, this.ttl.ACTIVE_NODES, JSON.stringify(nodes));
            logger.debug('[Cache] SET active nodes');
        } catch (err) {
            logger.error(`[Cache] Ошибка setActiveNodes: ${err.message}`);
        }
    }

    /**
     * Инвалидировать ноды
     */
    async invalidateNodes() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.NODES);
            logger.debug('[Cache] INVALIDATE nodes');
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateNodes: ${err.message}`);
        }
    }

    // ==================== НАСТРОЙКИ ====================

    /**
     * Получить настройки
     */
    async getSettings() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.SETTINGS);
            if (data) {
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getSettings: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить настройки
     */
    async setSettings(settings) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.SETTINGS, this.ttl.SETTINGS, JSON.stringify(settings));
        } catch (err) {
            logger.error(`[Cache] Ошибка setSettings: ${err.message}`);
        }
    }

    /**
     * Инвалидировать настройки
     */
    async invalidateSettings() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.SETTINGS);
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateSettings: ${err.message}`);
        }
    }

    // ==================== СТАТИСТИКА ТРАФИКА ====================

    /**
     * Получить статистику трафика
     */
    async getTrafficStats() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.TRAFFIC_STATS);
            if (data) {
                logger.debug('[Cache] HIT traffic stats');
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getTrafficStats: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить статистику трафика
     */
    async setTrafficStats(stats) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.TRAFFIC_STATS, this.ttl.TRAFFIC_STATS, JSON.stringify(stats));
            logger.debug('[Cache] SET traffic stats');
        } catch (err) {
            logger.error(`[Cache] Ошибка setTrafficStats: ${err.message}`);
        }
    }

    /**
     * Инвалидировать статистику трафика
     */
    async invalidateTrafficStats() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.TRAFFIC_STATS);
            logger.debug('[Cache] INVALIDATE traffic stats');
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateTrafficStats: ${err.message}`);
        }
    }

    // ==================== ГРУППЫ ====================

    /**
     * Получить активные группы
     */
    async getGroups() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.GROUPS);
            if (data) {
                logger.debug('[Cache] HIT groups');
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getGroups: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить активные группы
     */
    async setGroups(groups) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.GROUPS, this.ttl.GROUPS, JSON.stringify(groups));
            logger.debug('[Cache] SET groups');
        } catch (err) {
            logger.error(`[Cache] Ошибка setGroups: ${err.message}`);
        }
    }

    /**
     * Инвалидировать группы
     */
    async invalidateGroups() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.GROUPS);
            logger.debug('[Cache] INVALIDATE groups');
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateGroups: ${err.message}`);
        }
    }

    // ==================== СЧЁТЧИКИ ДАШБОРДА ====================

    /**
     * Получить счётчики для дашборда
     */
    async getDashboardCounts() {
        if (!this.isConnected()) return null;
        
        try {
            const data = await this.redis.get(PREFIX.DASHBOARD_COUNTS);
            if (data) {
                logger.debug('[Cache] HIT dashboard counts');
                return JSON.parse(data);
            }
            return null;
        } catch (err) {
            logger.error(`[Cache] Ошибка getDashboardCounts: ${err.message}`);
            return null;
        }
    }

    /**
     * Сохранить счётчики для дашборда
     */
    async setDashboardCounts(counts) {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.setex(PREFIX.DASHBOARD_COUNTS, this.ttl.DASHBOARD_COUNTS, JSON.stringify(counts));
            logger.debug('[Cache] SET dashboard counts');
        } catch (err) {
            logger.error(`[Cache] Ошибка setDashboardCounts: ${err.message}`);
        }
    }

    /**
     * Инвалидировать счётчики дашборда
     */
    async invalidateDashboardCounts() {
        if (!this.isConnected()) return;
        
        try {
            await this.redis.del(PREFIX.DASHBOARD_COUNTS);
            logger.debug('[Cache] INVALIDATE dashboard counts');
        } catch (err) {
            logger.error(`[Cache] Ошибка invalidateDashboardCounts: ${err.message}`);
        }
    }

    // ==================== СТАТИСТИКА ====================

    /**
     * Получить статистику кэша
     */
    async getStats() {
        if (!this.isConnected()) {
            return { connected: false };
        }
        
        try {
            const info = await this.redis.info('memory');
            const dbSize = await this.redis.dbsize();
            
            // Парсим used_memory
            const usedMemoryMatch = info.match(/used_memory:(\d+)/);
            const usedMemory = usedMemoryMatch ? parseInt(usedMemoryMatch[1]) : 0;
            
            return {
                connected: true,
                keys: dbSize,
                usedMemoryMB: (usedMemory / 1024 / 1024).toFixed(2),
            };
        } catch (err) {
            return { connected: false, error: err.message };
        }
    }
}

// Синглтон
const cacheService = new CacheService();

module.exports = cacheService;

