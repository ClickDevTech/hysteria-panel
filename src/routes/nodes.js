/**
 * API для управления нодами Hysteria
 */

const express = require('express');
const router = express.Router();
const HyNode = require('../models/hyNodeModel');
const HyUser = require('../models/hyUserModel');
const ServerGroup = require('../models/serverGroupModel');
const cryptoService = require('../services/cryptoService');
const cache = require('../services/cacheService');
const logger = require('../utils/logger');

/**
 * Инвалидация кэша при изменении нод
 */
async function invalidateNodesCache() {
    await cache.invalidateNodes();
    await cache.invalidateAllSubscriptions();
    await cache.invalidateDashboardCounts();
}

/**
 * GET /nodes - Список всех нод
 */
router.get('/', async (req, res) => {
    try {
        const { active, group, status } = req.query;
        
        const filter = {};
        if (active !== undefined) filter.active = active === 'true';
        if (group) filter.groups = group;
        if (status) filter.status = status;
        
        const nodes = await HyNode.find(filter)
            .populate('groups', 'name color')
            .sort({ name: 1 });
        
        res.json(nodes);
    } catch (error) {
        logger.error(`[Nodes API] Ошибка получения списка: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id - Получить ноду
 */
router.get('/:id', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id).populate('groups', 'name color');
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Считаем пользователей на этой ноде
        const userCount = await HyUser.countDocuments({
            nodes: node._id,
            enabled: true
        });
        
        res.json({
            ...node.toObject(),
            userCount,
        });
    } catch (error) {
        logger.error(`[Nodes API] Ошибка получения ноды: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes - Создать ноду
 */
router.post('/', async (req, res) => {
    try {
        const {
            name, ip, domain, port, portRange, statsPort,
            groups, ssh, paths, settings, rankingCoefficient
        } = req.body;
        
        if (!name || !ip) {
            return res.status(400).json({ error: 'name и ip обязательны' });
        }
        
        // Проверяем уникальность IP
        const existing = await HyNode.findOne({ ip });
        if (existing) {
            return res.status(409).json({ error: 'Нода с таким IP уже существует' });
        }
        
        // Генерируем секрет для API статистики
        const statsSecret = cryptoService.generateNodeSecret();
        
        const node = new HyNode({
            name,
            ip,
            domain: domain || '',
            port: port || 443,
            portRange: portRange || '20000-50000',
            statsPort: statsPort || 9999,
            statsSecret,
            groups: groups || [],
            ssh: ssh || {},
            paths: paths || {},
            settings: settings || {},
            rankingCoefficient: rankingCoefficient || 1.0,
            active: true,
            status: 'offline',
        });
        
        await node.save();
        
        // Инвалидируем кэш
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Создана нода ${name} (${ip})`);
        
        res.status(201).json(node);
    } catch (error) {
        logger.error(`[Nodes API] Ошибка создания ноды: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /nodes/:id - Обновить ноду
 */
router.put('/:id', async (req, res) => {
    try {
        const allowedUpdates = [
            'name', 'domain', 'port', 'portRange', 'statsPort',
            'groups', 'ssh', 'paths', 'settings', 'active', 'rankingCoefficient'
        ];
        
        const updates = {};
        for (const key of allowedUpdates) {
            if (req.body[key] !== undefined) {
                updates[key] = req.body[key];
            }
        }
        
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true }
        ).populate('groups', 'name color');
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Инвалидируем кэш
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Обновлена нода ${node.name}`);
        
        res.json(node);
    } catch (error) {
        logger.error(`[Nodes API] Ошибка обновления: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /nodes/:id - Удалить ноду
 */
router.delete('/:id', async (req, res) => {
    try {
        const node = await HyNode.findByIdAndDelete(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Удаляем ноду из списка пользователей
        await HyUser.updateMany(
            { nodes: node._id },
            { $pull: { nodes: node._id } }
        );
        
        // Инвалидируем кэш
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Удалена нода ${node.name}`);
        
        res.json({ success: true, message: 'Нода удалена' });
    } catch (error) {
        logger.error(`[Nodes API] Ошибка удаления: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id/status - Получить статус ноды
 */
router.get('/:id/status', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id).select('name status lastError onlineUsers lastSync');
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        res.json({
            name: node.name,
            status: node.status,
            lastError: node.lastError,
            onlineUsers: node.onlineUsers,
            lastSync: node.lastSync,
        });
    } catch (error) {
        logger.error(`[Nodes API] Ошибка получения статуса: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/reset-status - Сброс статуса ноды на online
 */
router.post('/:id/reset-status', async (req, res) => {
    try {
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $set: { status: 'online', lastError: '' } },
            { new: true }
        );
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        logger.info(`[Nodes API] Статус ноды ${node.name} сброшен на online`);
        
        res.json({ success: true, message: 'Статус сброшен', node });
    } catch (error) {
        logger.error(`[Nodes API] Ошибка сброса статуса: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/sync - Принудительная синхронизация ноды
 */
router.post('/:id/sync', async (req, res) => {
    try {
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $set: { status: 'syncing' } },
            { new: true }
        );
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        logger.info(`[Nodes API] Запущена синхронизация ноды ${node.name}`);
        
        res.json({ success: true, message: 'Синхронизация запущена' });
    } catch (error) {
        logger.error(`[Nodes API] Ошибка запуска синхронизации: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id/users - Пользователи на ноде
 */
router.get('/:id/users', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        const users = await HyUser.find({
            nodes: node._id,
            enabled: true
        }).select('userId username traffic');
        
        res.json(users);
    } catch (error) {
        logger.error(`[Nodes API] Ошибка получения пользователей: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/groups - Добавить ноду в группы
 */
router.post('/:id/groups', async (req, res) => {
    try {
        const { groups } = req.body;
        
        if (!Array.isArray(groups)) {
            return res.status(400).json({ error: 'groups должен быть массивом' });
        }
        
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $addToSet: { groups: { $each: groups } } },
            { new: true }
        ).populate('groups', 'name color');
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Инвалидируем кэш
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Добавлены группы для ноды ${node.name}`);
        res.json(node);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /nodes/:id/groups/:groupId - Удалить ноду из группы
 */
router.delete('/:id/groups/:groupId', async (req, res) => {
    try {
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $pull: { groups: req.params.groupId } },
            { new: true }
        ).populate('groups', 'name color');
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Инвалидируем кэш
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Удалена группа ${req.params.groupId} у ноды ${node.name}`);
        res.json(node);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id/config - Получить текущий конфиг ноды
 */
router.get('/:id/config', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Генерируем конфиг с HTTP авторизацией
        const configGenerator = require('../services/configGenerator');
        const config = require('../../config');
        
        const baseUrl = process.env.BASE_URL || `http://localhost:${config.PORT}`;
        const authUrl = `${baseUrl}/api/auth`;
        
        const configContent = configGenerator.generateNodeConfig(node, authUrl);
        
        res.type('text/yaml').send(configContent);
    } catch (error) {
        logger.error(`[Nodes API] Ошибка генерации конфига: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/setup-port-hopping - Настройка port hopping на ноде
 */
router.post('/:id/setup-port-hopping', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        const syncService = require('../services/syncService');
        const success = await syncService.setupPortHopping(node);
        
        if (success) {
            res.json({ success: true, message: 'Port hopping настроен' });
        } else {
            res.status(500).json({ error: 'Не удалось настроить port hopping' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/update-config - Обновить конфиг на ноде через SSH
 */
router.post('/:id/update-config', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        const syncService = require('../services/syncService');
        const success = await syncService.updateNodeConfig(node);
        
        if (success) {
            res.json({ success: true, message: 'Конфиг обновлён' });
        } else {
            res.status(500).json({ error: 'Не удалось обновить конфиг' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
