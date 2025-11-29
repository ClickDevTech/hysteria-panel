/**
 * Сервис синхронизации нод Hysteria
 * 
 * С HTTP авторизацией синхронизация пользователей НЕ НУЖНА!
 * Авторизация происходит в реалтайме через HTTP запросы к бэкенду.
 * 
 * Этот сервис нужен для:
 * - Обновления конфигов нод (если изменились настройки)
 * - Сбора статистики трафика
 * - Health check нод
 */

const HyUser = require('../models/hyUserModel');
const HyNode = require('../models/hyNodeModel');
const NodeSSH = require('./nodeSSH');
const configGenerator = require('./configGenerator');
const cache = require('./cacheService');
const logger = require('../utils/logger');
const axios = require('axios');
const config = require('../../config');

class SyncService {
    constructor() {
        this.isSyncing = false;
        this.lastSyncTime = null;
    }

    /**
     * Получает URL для HTTP авторизации
     */
    getAuthUrl() {
        return `${config.BASE_URL}/api/auth`;
    }

    /**
     * Обновляет конфиг на конкретной ноде
     */
    async updateNodeConfig(node) {
        logger.info(`[Sync] Обновление конфига ноды ${node.name} (${node.ip})`);
        
        await HyNode.updateOne(
            { _id: node._id },
            { $set: { status: 'syncing' } }
        );
        
        const ssh = new NodeSSH(node);
        
        try {
            await ssh.connect();
            
            // Используем кастомный конфиг или генерируем автоматически
            let configContent;
            const customConfig = (node.customConfig || '').trim();
            if (node.useCustomConfig && customConfig && customConfig.length > 50) {
                // Базовая валидация: должен содержать listen и auth/tls/acme
                if (!customConfig.includes('listen:')) {
                    throw new Error('Кастомный конфиг невалиден: отсутствует listen:');
                }
                if (!customConfig.includes('acme:') && !customConfig.includes('tls:')) {
                    throw new Error('Кастомный конфиг невалиден: отсутствует acme: или tls:');
                }
                configContent = customConfig;
                logger.info(`[Sync] Используется кастомный конфиг для ${node.name}`);
            } else {
                if (node.useCustomConfig) {
                    logger.warn(`[Sync] Кастомный конфиг для ${node.name} пуст или слишком короткий, используется автогенерация`);
                }
            const authUrl = this.getAuthUrl();
                configContent = configGenerator.generateNodeConfig(node, authUrl);
            }
            
            // Обновляем конфиг на ноде
            const success = await ssh.updateConfig(configContent);
            
            if (success) {
                const isRunning = await ssh.checkHysteriaStatus();
                
                await HyNode.updateOne(
                    { _id: node._id },
                    {
                        $set: {
                            status: isRunning ? 'online' : 'error',
                            lastSync: new Date(),
                            lastError: isRunning ? '' : 'Service not running after sync',
                        }
                    }
                );
                
                logger.info(`[Sync] ✅ Нода ${node.name}: конфиг обновлён`);
                return true;
            } else {
                throw new Error('Не удалось обновить конфиг');
            }
        } catch (error) {
            logger.error(`[Sync] ❌ Ошибка ноды ${node.name}: ${error.message}`);
            await HyNode.updateOne(
                { _id: node._id },
                { $set: { status: 'error', lastError: error.message } }
            );
            return false;
        } finally {
            ssh.disconnect();
        }
    }

    /**
     * Обновляет конфиги на всех активных нодах (параллельно, до 5 одновременно)
     */
    async syncAllNodes() {
        if (this.isSyncing) {
            logger.warn('[Sync] Синхронизация уже запущена');
            return;
        }
        
        this.isSyncing = true;
        logger.info('[Sync] Запуск синхронизации всех нод');
        
        try {
            const nodes = await HyNode.find({ active: true });
            
            // Параллельная синхронизация с ограничением concurrency
            const CONCURRENCY = 5;
            for (let i = 0; i < nodes.length; i += CONCURRENCY) {
                const batch = nodes.slice(i, i + CONCURRENCY);
                await Promise.allSettled(
                    batch.map(node => this.updateNodeConfig(node))
                );
            }
            
            this.lastSyncTime = new Date();
            logger.info('[Sync] Синхронизация завершена');
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Получает статистику трафика с ноды и обновляет пользователей
     */
    async collectTrafficStats(node) {
        try {
            if (!node.statsPort || !node.statsSecret) {
                return;
            }
            
            const url = `http://${node.ip}:${node.statsPort}/traffic?clear=true`;
            
            const response = await axios.get(url, {
                headers: { Authorization: node.statsSecret },
                timeout: 10000,
            });
            
            const stats = response.data;
            
            // Суммируем трафик ноды
            let nodeTx = 0;
            let nodeRx = 0;
            
            // Обновляем трафик каждого пользователя
            for (const [userId, traffic] of Object.entries(stats)) {
                nodeTx += traffic.tx || 0;
                nodeRx += traffic.rx || 0;
                
                await HyUser.updateOne(
                    { userId },
                    {
                        $inc: {
                            'traffic.tx': traffic.tx || 0,
                            'traffic.rx': traffic.rx || 0,
                        },
                        $set: { 'traffic.lastUpdate': new Date() }
                    }
                );
            }
            
            // Обновляем трафик ноды
            await HyNode.updateOne(
                { _id: node._id },
                {
                    $inc: {
                        'traffic.tx': nodeTx,
                        'traffic.rx': nodeRx,
                    },
                    $set: { 'traffic.lastUpdate': new Date() }
                }
            );
            
            logger.info(`[Stats] ${node.name}: ${Object.keys(stats).length} пользователей, трафик: ↑${(nodeTx / 1024 / 1024).toFixed(1)}MB ↓${(nodeRx / 1024 / 1024).toFixed(1)}MB`);
        } catch (error) {
            logger.error(`[Stats] Ошибка ${node.name}: ${error.message}`);
        }
    }

    /**
     * Получает онлайн пользователей с ноды
     */
    async getOnlineUsers(node) {
        try {
            // Если Stats API не настроен - просто пропускаем, не меняем статус
            if (!node.statsPort || !node.statsSecret) {
                logger.debug(`[Stats] ${node.name}: Stats API not configured, skipping`);
                return 0;
            }
            
            const url = `http://${node.ip}:${node.statsPort}/online`;
            
            const response = await axios.get(url, {
                headers: { Authorization: node.statsSecret },
                timeout: 5000,
            });
            
            const online = Object.keys(response.data).length;
            
            await HyNode.updateOne(
                { _id: node._id },
                { $set: { onlineUsers: online, status: 'online' } }
            );
            
            if (online > 0) {
                logger.info(`[Stats] ${node.name}: ${online} онлайн`);
            }
            return online;
        } catch (error) {
            // Логируем ошибку, но НЕ меняем статус на error
            // Статус error должен ставиться только при реальных проблемах с нодой
            logger.warn(`[Stats] ${node.name}: Stats unavailable - ${error.message}`);
            
            // Обновляем только lastError, статус не трогаем
            await HyNode.updateOne(
                { _id: node._id },
                { $set: { lastError: `Stats: ${error.message}` } }
            );
            return 0;
        }
    }

    /**
     * Кикает пользователя со всех нод
     */
    async kickUser(userId) {
        const user = await HyUser.findOne({ userId }).populate('nodes');
        
        if (!user) {
            return;
        }
        
        for (const node of user.nodes) {
            try {
                if (!node.statsPort || !node.statsSecret) continue;
                
                const url = `http://${node.ip}:${node.statsPort}/kick`;
                
                await axios.post(url, [userId], {
                    headers: {
                        Authorization: node.statsSecret,
                        'Content-Type': 'application/json',
                    },
                    timeout: 5000,
                });
                
                logger.info(`[Kick] ${userId} кикнут с ${node.name}`);
            } catch (error) {
                logger.error(`[Kick] Ошибка кика с ${node.name}: ${error.message}`);
            }
        }
    }

    /**
     * Собирает статистику со всех нод (параллельно с ограничением concurrency)
     */
    async collectAllStats() {
        const nodes = await HyNode.find({ active: true });
        
        // Параллельная обработка с ограничением concurrency
        const CONCURRENCY = 5;
        for (let i = 0; i < nodes.length; i += CONCURRENCY) {
            const batch = nodes.slice(i, i + CONCURRENCY);
            await Promise.allSettled(
                batch.flatMap(node => [
                    this.collectTrafficStats(node),
                    this.getOnlineUsers(node)
                ])
            );
        }
        
        // Обновляем время последнего сбора статистики
        this.lastSyncTime = new Date();
        
        // Инвалидируем кэш статистики трафика (данные обновились)
        await cache.invalidateTrafficStats();
    }

    /**
     * Проверяет здоровье всех нод (параллельно)
     */
    async healthCheck() {
        const nodes = await HyNode.find({ active: true });
        
        // Параллельная проверка с ограничением concurrency
        const CONCURRENCY = 5;
        for (let i = 0; i < nodes.length; i += CONCURRENCY) {
            const batch = nodes.slice(i, i + CONCURRENCY);
            await Promise.allSettled(
                batch.map(node => this.getOnlineUsers(node))
            );
        }
    }

    /**
     * Настраивает port hopping на ноде
     */
    async setupPortHopping(node) {
        const ssh = new NodeSSH(node);
        
        try {
            await ssh.connect();
            await ssh.setupPortHopping(node.portRange);
            return true;
        } catch (error) {
            logger.error(`[PortHop] Ошибка на ${node.name}: ${error.message}`);
            return false;
        } finally {
            ssh.disconnect();
        }
    }
}

module.exports = new SyncService();
