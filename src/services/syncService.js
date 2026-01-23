/**
 * Hysteria nodes sync service
 * 
 * With HTTP auth, user sync is NOT needed - auth happens in realtime via HTTP.
 * 
 * This service handles:
 * - Node config updates
 * - Traffic stats collection
 * - Node health checks
 */

const HyUser = require('../models/hyUserModel');
const HyNode = require('../models/hyNodeModel');
const Settings = require('../models/settingsModel');
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
     * Get HTTP auth URL
     */
    getAuthUrl() {
        return `${config.BASE_URL}/api/auth`;
    }

    /**
     * Update config on a specific node
     */
    async updateNodeConfig(node) {
        logger.info(`[Sync] Updating config for node ${node.name} (${node.ip})`);
        
        await HyNode.updateOne(
            { _id: node._id },
            { $set: { status: 'syncing' } }
        );
        
        const ssh = new NodeSSH(node);
        
        try {
            await ssh.connect();
            
            // Use custom config or generate automatically
            let configContent;
            const customConfig = (node.customConfig || '').trim();
            if (node.useCustomConfig && customConfig && customConfig.length > 50) {
                // Basic validation: must contain listen and auth/tls/acme
                if (!customConfig.includes('listen:')) {
                    throw new Error('Custom config invalid: missing listen:');
                }
                if (!customConfig.includes('acme:') && !customConfig.includes('tls:')) {
                    throw new Error('Custom config invalid: missing acme: or tls:');
                }
                configContent = customConfig;
                logger.info(`[Sync] Using custom config for ${node.name}`);
            } else {
                if (node.useCustomConfig) {
                    logger.warn(`[Sync] Custom config for ${node.name} is empty or too short, using auto-generation`);
                }
                const authUrl = this.getAuthUrl();
                const settings = await Settings.get();
                const authInsecure = settings?.nodeAuth?.insecure ?? true;
                configContent = configGenerator.generateNodeConfig(node, authUrl, { authInsecure });
            }
            
            // Update config on node
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
                
                logger.info(`[Sync] Node ${node.name}: config updated`);
                return true;
            } else {
                throw new Error('Failed to update config');
            }
        } catch (error) {
            logger.error(`[Sync] Node ${node.name} error: ${error.message}`);
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
     * Update configs on all active nodes (parallel, up to 5 concurrent)
     */
    async syncAllNodes() {
        if (this.isSyncing) {
            logger.warn('[Sync] Sync already in progress');
            return;
        }
        
        this.isSyncing = true;
        logger.info('[Sync] Starting sync for all nodes');
        
        try {
            const nodes = await HyNode.find({ active: true });
            
            // Parallel sync with concurrency limit
            const CONCURRENCY = 5;
            for (let i = 0; i < nodes.length; i += CONCURRENCY) {
                const batch = nodes.slice(i, i + CONCURRENCY);
                await Promise.allSettled(
                    batch.map(node => this.updateNodeConfig(node))
                );
            }
            
            this.lastSyncTime = new Date();
            logger.info('[Sync] Sync completed');
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Collect traffic stats from node and update users
     * Uses bulkWrite for optimization (99% fewer MongoDB queries)
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
            
            // Sum node traffic
            let nodeTx = 0;
            let nodeRx = 0;
            
            // Prepare bulk operations for all users
            const bulkOps = [];
            const now = new Date();
            
            for (const [userId, traffic] of Object.entries(stats)) {
                nodeTx += traffic.tx || 0;
                nodeRx += traffic.rx || 0;
                
                bulkOps.push({
                    updateOne: {
                        filter: { userId },
                        update: {
                            $inc: {
                                'traffic.tx': traffic.tx || 0,
                                'traffic.rx': traffic.rx || 0,
                            },
                            $set: { 'traffic.lastUpdate': now }
                        }
                    }
                });
            }
            
            // Execute bulk update (1 query instead of N)
            if (bulkOps.length > 0) {
                const result = await HyUser.bulkWrite(bulkOps, { ordered: false });
                logger.debug(`[Stats] ${node.name}: Bulk updated ${result.modifiedCount}/${bulkOps.length} users`);
            }
            
            // Update node traffic
            await HyNode.updateOne(
                { _id: node._id },
                {
                    $inc: {
                        'traffic.tx': nodeTx,
                        'traffic.rx': nodeRx,
                    },
                    $set: { 'traffic.lastUpdate': now }
                }
            );
            
            logger.info(`[Stats] ${node.name}: ${Object.keys(stats).length} users, traffic: ↑${(nodeTx / 1024 / 1024).toFixed(1)}MB ↓${(nodeRx / 1024 / 1024).toFixed(1)}MB`);
        } catch (error) {
            logger.error(`[Stats] ${node.name} error: ${error.message}`);
        }
    }

    /**
     * Get online users from node
     */
    async getOnlineUsers(node) {
        try {
            // If Stats API not configured - skip, don't change status
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
                logger.info(`[Stats] ${node.name}: ${online} online`);
            }
            return online;
        } catch (error) {
            // Log error but DON'T change status to error
            // Error status should only be set for real node problems
            logger.warn(`[Stats] ${node.name}: Stats unavailable - ${error.message}`);
            
            // Update only lastError, don't touch status
            await HyNode.updateOne(
                { _id: node._id },
                { $set: { lastError: `Stats: ${error.message}` } }
            );
            return 0;
        }
    }

    /**
     * Kick user from all nodes
     */
    async kickUser(userId) {
        const user = await HyUser.findOne({ userId }).populate('nodes', 'name ip statsPort statsSecret');
        
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
                
                logger.info(`[Kick] ${userId} kicked from ${node.name}`);
            } catch (error) {
                logger.error(`[Kick] Kick error on ${node.name}: ${error.message}`);
            }
        }
    }

    /**
     * Collect stats from all nodes (parallel with concurrency limit)
     */
    async collectAllStats() {
        const nodes = await HyNode.find({ active: true });
        
        // Parallel processing with concurrency limit
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
        
        // Update last stats collection time
        this.lastSyncTime = new Date();
        
        // Invalidate traffic stats cache (data updated)
        await cache.invalidateTrafficStats();
    }

    /**
     * Health check all nodes (parallel)
     */
    async healthCheck() {
        const nodes = await HyNode.find({ active: true });
        
        // Parallel check with concurrency limit
        const CONCURRENCY = 5;
        for (let i = 0; i < nodes.length; i += CONCURRENCY) {
            const batch = nodes.slice(i, i + CONCURRENCY);
            await Promise.allSettled(
                batch.map(node => this.getOnlineUsers(node))
            );
        }
    }

    /**
     * Setup port hopping on node
     */
    async setupPortHopping(node) {
        const ssh = new NodeSSH(node);
        
        try {
            await ssh.connect();
            await ssh.setupPortHopping(node.portRange);
            return true;
        } catch (error) {
            logger.error(`[PortHop] Error on ${node.name}: ${error.message}`);
            return false;
        } finally {
            ssh.disconnect();
        }
    }
}

module.exports = new SyncService();
