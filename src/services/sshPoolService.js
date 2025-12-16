/**
 * SSH Connection Pool Service
 * 
 * Optimizations:
 * - Connection reuse (saves ~200-500ms on handshake)
 * - Lazy connection (created on first request)
 * - Auto-cleanup of idle connections (memory release)
 * - Keepalive to maintain connections through NAT
 * - Auto-reconnect on disconnect
 * - Graceful shutdown
 */

const { Client } = require('ssh2');
const logger = require('../utils/logger');
const cryptoService = require('./cryptoService');

class SSHPool {
    constructor(options = {}) {
        // Connection pool: nodeId -> { client, meta }
        this.connections = new Map();
        
        // Settings
        this.config = {
            maxIdleTime: options.maxIdleTime || 2 * 60 * 1000,      // 2 min idle → close
            keepAliveInterval: options.keepAliveInterval || 30000,  // keepalive every 30 sec
            connectTimeout: options.connectTimeout || 15000,        // connection timeout
            maxRetries: options.maxRetries || 2,                    // reconnect attempts
            cleanupInterval: options.cleanupInterval || 30000,      // idle check every 30 sec
        };
        
        // Cleanup timer
        this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupInterval);
        
        // Graceful shutdown
        const shutdown = () => this.closeAll();
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
        
        logger.info('[SSHPool] Initialized');
    }
    
    /**
     * Get or create connection
     * @param {Object} node - node object with ssh credentials
     * @returns {Client} - SSH client
     */
    async getConnection(node) {
        const nodeId = node._id?.toString() || node.id;
        
        // Check existing connection
        const existing = this.connections.get(nodeId);
        
        if (existing && existing.client._sock?.writable) {
            // Connection alive - update lastUsed
            existing.lastUsed = Date.now();
            existing.useCount++;
            return existing.client;
        }
        
        // Dead connection - remove
        if (existing) {
            this.removeConnection(nodeId, 'dead');
        }
        
        // Create new
        return this.createConnection(node);
    }
    
    /**
     * Create new SSH connection
     */
    async createConnection(node, retryCount = 0) {
        const nodeId = node._id?.toString() || node.id;
        const nodeName = node.name || nodeId;
        
        return new Promise((resolve, reject) => {
            const client = new Client();
            
            // Connection timeout
            const timeout = setTimeout(() => {
                client.end();
                reject(new Error(`Connection timeout (${this.config.connectTimeout}ms)`));
            }, this.config.connectTimeout);
            
            // SSH configuration
            const sshConfig = {
                host: node.ip,
                port: node.ssh?.port || 22,
                username: node.ssh?.username || 'root',
                readyTimeout: this.config.connectTimeout,
                keepaliveInterval: this.config.keepAliveInterval,
                keepaliveCountMax: 3,
            };
            
            // Authentication
            if (node.ssh?.privateKey) {
                sshConfig.privateKey = node.ssh.privateKey;
            } else if (node.ssh?.password) {
                sshConfig.password = cryptoService.decrypt(node.ssh.password);
            } else {
                clearTimeout(timeout);
                reject(new Error('SSH: no key or password'));
                return;
            }
            
            client
                .on('ready', () => {
                    clearTimeout(timeout);
                    
                    // Save to pool
                    const meta = {
                        client,
                        nodeId,
                        nodeName,
                        host: node.ip,
                        createdAt: Date.now(),
                        lastUsed: Date.now(),
                        useCount: 1,
                    };
                    
                    this.connections.set(nodeId, meta);
                    
                    logger.info(`[SSHPool] ✓ Connected: ${nodeName} (${node.ip}) [pool: ${this.connections.size}]`);
                    resolve(client);
                })
                .on('error', async (err) => {
                    clearTimeout(timeout);
                    this.connections.delete(nodeId);
                    
                    // Retry logic с exponential backoff
                    if (retryCount < this.config.maxRetries) {
                        const delay = Math.pow(2, retryCount) * 500;
                        logger.warn(`[SSHPool] ${nodeName}: retry ${retryCount + 1}/${this.config.maxRetries} in ${delay}ms`);
                        
                        await new Promise(r => setTimeout(r, delay));
                        
                        try {
                            const newClient = await this.createConnection(node, retryCount + 1);
                            resolve(newClient);
                        } catch (retryErr) {
                            reject(retryErr);
                        }
                    } else {
                        logger.error(`[SSHPool] ✗ Failed: ${nodeName} - ${err.message}`);
                        reject(err);
                    }
                })
                .on('close', () => {
                    this.removeConnection(nodeId, 'closed');
                })
                .on('end', () => {
                    this.removeConnection(nodeId, 'ended');
                })
                .connect(sshConfig);
        });
    }
    
    /**
     * Remove connection from pool
     */
    removeConnection(nodeId, reason = 'unknown') {
        const conn = this.connections.get(nodeId);
        if (conn) {
            try {
                conn.client.end();
            } catch (e) {}
            this.connections.delete(nodeId);
            logger.debug(`[SSHPool] Removed: ${conn.nodeName} (${reason})`);
        }
    }
    
    /**
     * Execute command with auto-reconnect
     */
    async exec(node, command, options = {}) {
        const client = await this.getConnection(node);
        const nodeId = node._id?.toString() || node.id;
        
        return new Promise((resolve, reject) => {
            const execTimeout = options.timeout || 30000;
            
            const timer = setTimeout(() => {
                reject(new Error(`Exec timeout (${execTimeout}ms): ${command.substring(0, 50)}`));
            }, execTimeout);
            
            client.exec(command, (err, stream) => {
                if (err) {
                    clearTimeout(timer);
                    // Connection broken - remove from pool
                    this.removeConnection(nodeId, 'exec error');
                    reject(err);
                    return;
                }
                
                let stdout = '';
                let stderr = '';
                
                stream
                    .on('close', (code) => {
                        clearTimeout(timer);
                        resolve({ code, stdout, stderr });
                    })
                    .on('data', (data) => {
                        stdout += data.toString();
                    })
                    .stderr.on('data', (data) => {
                        stderr += data.toString();
                    });
            });
        });
    }
    
    /**
     * Write file via SFTP
     */
    async writeFile(node, remotePath, content) {
        const client = await this.getConnection(node);
        const nodeId = node._id?.toString() || node.id;
        
        return new Promise((resolve, reject) => {
            client.sftp((err, sftp) => {
                if (err) {
                    this.removeConnection(nodeId, 'sftp error');
                    reject(err);
                    return;
                }
                
                const writeStream = sftp.createWriteStream(remotePath);
                
                writeStream
                    .on('close', () => {
                        logger.debug(`[SSHPool] Written: ${remotePath}`);
                        resolve();
                    })
                    .on('error', (err) => {
                        reject(err);
                    });
                
                writeStream.write(content);
                writeStream.end();
            });
        });
    }
    
    /**
     * Read file via SFTP
     */
    async readFile(node, remotePath) {
        const client = await this.getConnection(node);
        const nodeId = node._id?.toString() || node.id;
        
        return new Promise((resolve, reject) => {
            client.sftp((err, sftp) => {
                if (err) {
                    this.removeConnection(nodeId, 'sftp error');
                    reject(err);
                    return;
                }
                
                let content = '';
                const readStream = sftp.createReadStream(remotePath);
                
                readStream
                    .on('data', (data) => {
                        content += data.toString();
                    })
                    .on('close', () => {
                        resolve(content);
                    })
                    .on('error', (err) => {
                        reject(err);
                    });
            });
        });
    }
    
    /**
     * Check if connection exists in pool and is alive
     */
    hasConnection(nodeId) {
        const conn = this.connections.get(nodeId?.toString());
        return conn && conn.client._sock?.writable;
    }
    
    /**
     * Close specific connection
     */
    async close(nodeId) {
        this.removeConnection(nodeId?.toString(), 'manual');
    }
    
    /**
     * Cleanup idle connections
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [nodeId, conn] of this.connections) {
            const idleTime = now - conn.lastUsed;
            
            if (idleTime > this.config.maxIdleTime) {
                this.removeConnection(nodeId, `idle ${Math.round(idleTime / 1000)}s`);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            logger.info(`[SSHPool] Cleanup: ${cleaned} idle connections removed [pool: ${this.connections.size}]`);
        }
    }
    
    /**
     * Close all connections
     */
    closeAll() {
        logger.info(`[SSHPool] Shutting down (${this.connections.size} connections)`);
        
        clearInterval(this.cleanupTimer);
        
        for (const [nodeId, conn] of this.connections) {
            try {
                conn.client.end();
            } catch (e) {}
        }
        
        this.connections.clear();
    }
    
    /**
     * Pool statistics
     */
    getStats() {
        const now = Date.now();
        const connections = [];
        
        for (const [nodeId, conn] of this.connections) {
            connections.push({
                nodeId,
                name: conn.nodeName,
                host: conn.host,
                alive: conn.client._sock?.writable || false,
                idleMs: now - conn.lastUsed,
                useCount: conn.useCount,
                uptimeMs: now - conn.createdAt,
            });
        }
        
        return {
            total: this.connections.size,
            config: this.config,
            connections,
        };
    }
}

// Singleton with optimal settings
module.exports = new SSHPool({
    maxIdleTime: 2 * 60 * 1000,       // 2 min idle
    keepAliveInterval: 30 * 1000,     // keepalive every 30 sec  
    connectTimeout: 15 * 1000,        // 15 sec timeout
    maxRetries: 2,                    // 2 retries
    cleanupInterval: 30 * 1000,       // cleanup every 30 sec
});

