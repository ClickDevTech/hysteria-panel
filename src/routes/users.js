/**
 * API для управления пользователями Hysteria
 */

const express = require('express');
const router = express.Router();
const HyUser = require('../models/hyUserModel');
const HyNode = require('../models/hyNodeModel');
const ServerGroup = require('../models/serverGroupModel');
const cryptoService = require('../services/cryptoService');
const cache = require('../services/cacheService');
const logger = require('../utils/logger');
const { getNodesByGroups } = require('../utils/helpers');

/**
 * Инвалидация кэша пользователя
 */
async function invalidateUserCache(userId, subscriptionToken) {
    await cache.invalidateUser(userId);
    if (subscriptionToken) {
        await cache.invalidateSubscription(subscriptionToken);
    }
    // Очищаем устройства пользователя
    await cache.clearDeviceIPs(userId);
    // Инвалидируем счётчики дашборда
    await cache.invalidateDashboardCounts();
}

/**
 * GET /users - Список всех пользователей
 */
router.get('/', async (req, res) => {
    try {
        const { enabled, group, page = 1, limit = 50, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
        
        const filter = {};
        if (enabled !== undefined) filter.enabled = enabled === 'true';
        if (group) filter.groups = group;
        
        // Определяем поле для сортировки
        let sortField = {};
        const order = sortOrder === 'asc' ? 1 : -1;
        
        switch (sortBy) {
            case 'traffic':
                // Для сортировки по трафику нужно использовать aggregation
                // так как трафик - это сумма tx + rx
                const pipeline = [
                    { $match: filter },
                    {
                        $addFields: {
                            totalTraffic: { $add: ['$traffic.tx', '$traffic.rx'] }
                        }
                    },
                    { $sort: { totalTraffic: order } },
                    { $skip: (page - 1) * limit },
                    { $limit: parseInt(limit) }
                ];
                
                const usersAggregated = await HyUser.aggregate(pipeline);
                
                // Populate вручную после aggregation
                const users = await HyUser.populate(usersAggregated, [
                    { path: 'nodes', select: 'name ip' },
                    { path: 'groups', select: 'name color' }
                ]);
                
                const total = await HyUser.countDocuments(filter);
                
                return res.json({
                    users,
                    pagination: {
                        page: parseInt(page),
                        limit: parseInt(limit),
                        total,
                        pages: Math.ceil(total / limit),
                    }
                });
            
            case 'userId':
                sortField = { userId: order };
                break;
            
            case 'username':
                sortField = { username: order };
                break;
            
            case 'enabled':
                sortField = { enabled: order };
                break;
            
            case 'createdAt':
            default:
                sortField = { createdAt: order };
                break;
        }
        
        const users = await HyUser.find(filter)
            .sort(sortField)
            .skip((page - 1) * limit)
            .limit(parseInt(limit))
            .populate('nodes', 'name ip')
            .populate('groups', 'name color');
        
        const total = await HyUser.countDocuments(filter);
        
        res.json({
            users,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit),
            }
        });
    } catch (error) {
        logger.error(`[Users API] List error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /users/:userId - Получить пользователя
 */
router.get('/:userId', async (req, res) => {
    try {
        const user = await HyUser.findOne({ userId: req.params.userId })
            .populate('nodes', 'name ip domain port portRange')
            .populate('groups', 'name color');
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        res.json(user);
    } catch (error) {
        logger.error(`[Users API] Get user error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /users - Создать пользователя
 * Body: { userId, username?, groups?, enabled?, trafficLimit?, expireAt? }
 */
router.post('/', async (req, res) => {
    try {
        const { userId, username, groups, enabled, trafficLimit, expireAt } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'userId обязателен' });
        }
        
        // Проверяем существование
        const existing = await HyUser.findOne({ userId });
        if (existing) {
            return res.status(409).json({ error: 'Пользователь уже существует', user: existing });
        }
        
        // Генерируем пароль
        const password = cryptoService.generatePassword(userId);
        
        // Группы (массив ObjectId)
        const userGroups = groups || [];
        
        const user = new HyUser({
            userId,
            username: username || '',
            password,
            groups: userGroups,
            enabled: enabled !== undefined ? enabled : false,
            trafficLimit: trafficLimit || 0,
            expireAt: expireAt || null,
            nodes: [], // Ноды автоматически по группам
        });
        
        await user.save();
        
        logger.info(`[Users API] Created user ${userId}, groups: ${userGroups.length}`);
        
        res.status(201).json(user);
    } catch (error) {
        logger.error(`[Users API] Create user error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /users/:userId - Обновить пользователя
 */
router.put('/:userId', async (req, res) => {
    try {
        const { enabled, groups, trafficLimit, username, expireAt } = req.body;
        
        const user = await HyUser.findOne({ userId: req.params.userId });
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        const updates = {};
        
        if (enabled !== undefined) {
            updates.enabled = enabled;
        }
        
        if (username !== undefined) {
            updates.username = username;
        }
        
        if (trafficLimit !== undefined) {
            updates.trafficLimit = trafficLimit;
        }
        
        if (expireAt !== undefined) {
            updates.expireAt = expireAt;
        }
        
        if (groups !== undefined) {
            updates.groups = groups;
        }
        
        const updatedUser = await HyUser.findOneAndUpdate(
            { userId: req.params.userId },
            { $set: updates },
            { new: true }
        )
        .populate('nodes', 'name ip')
        .populate('groups', 'name color');
        
        // Инвалидируем кэш
        await invalidateUserCache(req.params.userId, user.subscriptionToken);
        
        logger.info(`[Users API] Updated user ${req.params.userId}`);
        
        res.json(updatedUser);
    } catch (error) {
        logger.error(`[Users API] Update error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /users/:userId - Удалить пользователя
 */
router.delete('/:userId', async (req, res) => {
    try {
        const user = await HyUser.findOneAndDelete({ userId: req.params.userId });
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Инвалидируем кэш
        await invalidateUserCache(req.params.userId, user.subscriptionToken);
        
        logger.info(`[Users API] Deleted user ${req.params.userId}`);
        
        res.json({ success: true, message: 'Пользователь удалён' });
    } catch (error) {
        logger.error(`[Users API] Delete error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /users/:userId/enable - Включить пользователя
 */
router.post('/:userId/enable', async (req, res) => {
    try {
        const user = await HyUser.findOneAndUpdate(
            { userId: req.params.userId },
            { $set: { enabled: true } },
            { new: true }
        );
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Инвалидируем кэш
        await invalidateUserCache(req.params.userId, user.subscriptionToken);
        
        logger.info(`[Users API] Enabled user ${req.params.userId}`);
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /users/:userId/disable - Отключить пользователя
 */
router.post('/:userId/disable', async (req, res) => {
    try {
        const user = await HyUser.findOneAndUpdate(
            { userId: req.params.userId },
            { $set: { enabled: false } },
            { new: true }
        );
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Инвалидируем кэш
        await invalidateUserCache(req.params.userId, user.subscriptionToken);
        
        logger.info(`[Users API] Disabled user ${req.params.userId}`);
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /users/:userId/groups - Добавить пользователя в группы
 * Body: { groups: ['groupId1', 'groupId2'] }
 */
router.post('/:userId/groups', async (req, res) => {
    try {
        const { groups } = req.body;
        
        if (!Array.isArray(groups)) {
            return res.status(400).json({ error: 'groups должен быть массивом' });
        }
        
        const user = await HyUser.findOneAndUpdate(
            { userId: req.params.userId },
            { $addToSet: { groups: { $each: groups } } },
            { new: true }
        ).populate('groups', 'name color');
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Инвалидируем кэш
        await invalidateUserCache(req.params.userId, user.subscriptionToken);
        
        logger.info(`[Users API] Added groups to user ${req.params.userId}`);
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /users/:userId/groups/:groupId - Удалить пользователя из группы
 */
router.delete('/:userId/groups/:groupId', async (req, res) => {
    try {
        const user = await HyUser.findOneAndUpdate(
            { userId: req.params.userId },
            { $pull: { groups: req.params.groupId } },
            { new: true }
        ).populate('groups', 'name color');
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Инвалидируем кэш
        await invalidateUserCache(req.params.userId, user.subscriptionToken);
        
        logger.info(`[Users API] Removed group ${req.params.groupId} from user ${req.params.userId}`);
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /users/sync-from-main - Синхронизация с основной БД
 * Body: { users: [{ userId, username, enabled, groups }] }
 */
router.post('/sync-from-main', async (req, res) => {
    try {
        const { users } = req.body;
        
        if (!Array.isArray(users)) {
            return res.status(400).json({ error: 'users должен быть массивом' });
        }
        
        let created = 0, updated = 0, errors = 0;
        
        for (const userData of users) {
            try {
                const { userId, username, enabled, groups } = userData;
                
                if (!userId) continue;
                
                const existing = await HyUser.findOne({ userId });
                
                if (existing) {
                    // Обновляем
                    const updates = {};
                    if (enabled !== undefined && enabled !== existing.enabled) {
                        updates.enabled = enabled;
                    }
                    if (username) updates.username = username;
                    if (groups !== undefined) {
                        updates.groups = groups;
                    }
                    
                    if (Object.keys(updates).length > 0) {
                        await HyUser.updateOne({ userId }, { $set: updates });
                        updated++;
                    }
                } else {
                    // Создаём нового
                    const password = cryptoService.generatePassword(userId);
                    
                    await HyUser.create({
                        userId,
                        username: username || '',
                        password,
                        groups: groups || [],
                        enabled: enabled || false,
                        nodes: [],
                    });
                    created++;
                }
            } catch (err) {
                logger.error(`[Sync] Error for userId ${userData.userId}: ${err.message}`);
                errors++;
            }
        }
        
        logger.info(`[Sync] Sync: created ${created}, updated ${updated}, errors ${errors}`);
        
        res.json({ created, updated, errors });
    } catch (error) {
        logger.error(`[Sync] Sync error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
