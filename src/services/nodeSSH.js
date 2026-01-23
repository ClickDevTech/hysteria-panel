/**
 * SSH service for Hysteria node management
 * 
 * Uses SSHPool for connection reuse.
 * Falls back to direct connection if pool unavailable.
 */

const { Client } = require('ssh2');
const sshPool = require('./sshPoolService');
const logger = require('../utils/logger');
const cryptoService = require('./cryptoService');

class NodeSSH {
    constructor(node) {
        this.node = node;
        this.usePool = true;  // Use pool by default
        this.directClient = null;  // For legacy mode
    }

    /**
     * Connect to node via SSH (via pool or direct)
     */
    async connect() {
        if (this.usePool) {
            // Pool manages connections - just verify we can connect
            try {
                await sshPool.getConnection(this.node);
                return;
            } catch (error) {
                logger.warn(`[SSH] Pool failed for ${this.node.name}, falling back to direct`);
                this.usePool = false;
            }
        }
        
        // Fallback: direct connection
        return this.connectDirect();
    }
    
    /**
     * Direct connection (legacy, for special cases)
     */
    async connectDirect() {
        return new Promise((resolve, reject) => {
            this.directClient = new Client();
            
            const config = {
                host: this.node.ip,
                port: this.node.ssh?.port || 22,
                username: this.node.ssh?.username || 'root',
                readyTimeout: 30000,
            };
            
            if (this.node.ssh?.privateKey) {
                config.privateKey = this.node.ssh.privateKey;
            } else if (this.node.ssh?.password) {
                config.password = cryptoService.decrypt(this.node.ssh.password);
            } else {
                reject(new Error('SSH: no key or password provided'));
                return;
            }
            
            this.directClient
                .on('ready', () => {
                    logger.info(`[SSH] Connected (direct) to ${this.node.name} (${this.node.ip})`);
                    resolve();
                })
                .on('error', (err) => {
                    logger.error(`[SSH] Connection error to ${this.node.name}: ${err.message}`);
                    reject(err);
                })
                .connect(config);
        });
    }

    /**
     * Close connection
     */
    disconnect() {
        if (this.directClient) {
            this.directClient.end();
            this.directClient = null;
        }
        // Pool connections are NOT closed - they are reused
    }

    /**
     * Execute command on remote server
     */
    async exec(command) {
        if (this.usePool) {
            return sshPool.exec(this.node, command);
        }
        
        // Legacy direct execution
        return new Promise((resolve, reject) => {
            if (!this.directClient) {
                reject(new Error('SSH not connected'));
                return;
            }
            
            this.directClient.exec(command, (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                let stdout = '';
                let stderr = '';
                
                stream
                    .on('close', (code) => {
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
     * Write file to remote server
     */
    async writeFile(remotePath, content) {
        if (this.usePool) {
            return sshPool.writeFile(this.node, remotePath, content);
        }
        
        // Legacy direct write
        return new Promise((resolve, reject) => {
            if (!this.directClient) {
                reject(new Error('SSH not connected'));
                return;
            }
            
            this.directClient.sftp((err, sftp) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                const writeStream = sftp.createWriteStream(remotePath);
                
                writeStream
                    .on('close', () => {
                        logger.info(`[SSH] Written file ${remotePath} to ${this.node.name}`);
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
     * Read file from remote server
     */
    async readFile(remotePath) {
        if (this.usePool) {
            return sshPool.readFile(this.node, remotePath);
        }
        
        // Legacy direct read
        return new Promise((resolve, reject) => {
            if (!this.directClient) {
                reject(new Error('SSH not connected'));
                return;
            }
            
            this.directClient.sftp((err, sftp) => {
                if (err) {
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
     * Check Hysteria service status
     * Performs multiple checks to ensure service is actually running
     */
    async checkHysteriaStatus() {
        try {
            // Wait for service to stabilize after restart
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Check 1: systemctl is-active
            const result = await this.exec('systemctl is-active hysteria-server 2>/dev/null || systemctl is-active hysteria 2>/dev/null || echo "unknown"');
            const status = result.stdout.trim();
            
            logger.debug(`[SSH] ${this.node.name} hysteria status: ${status}`);
            
            if (status !== 'active') {
                return false;
            }
            
            // Check 2: Verify service didn't crash immediately after start
            // Check journal for errors in last 10 seconds
            const journalCheck = await this.exec(`
                journalctl -u hysteria-server -u hysteria --since "10 seconds ago" --no-pager 2>/dev/null | grep -iE "(fatal|error|failed|panic)" | head -5
            `);
            
            if (journalCheck.stdout.trim()) {
                logger.warn(`[SSH] ${this.node.name} has errors in journal: ${journalCheck.stdout.trim()}`);
                return false;
            }
            
            // Check 3: Verify the process is actually listening on the expected port
            const port = this.node.port || 443;
            const portCheck = await this.exec(`ss -ulnp | grep -E ":${port}\\s" | head -1`);
            
            if (!portCheck.stdout.trim()) {
                logger.warn(`[SSH] ${this.node.name} is not listening on port ${port}`);
                return false;
            }
            
            logger.debug(`[SSH] ${this.node.name} all checks passed, service is healthy`);
            return true;
        } catch (error) {
            logger.warn(`[SSH] ${this.node.name} status check failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Restart Hysteria service
     */
    async restartHysteria() {
        try {
            let result = await this.exec('systemctl restart hysteria-server 2>/dev/null || systemctl restart hysteria 2>/dev/null');
            
            if (result.code !== 0) {
                logger.error(`[SSH] Hysteria restart error on ${this.node.name}: ${result.stderr}`);
                return false;
            }
            
            logger.info(`[SSH] Hysteria restarted on ${this.node.name}`);
            return true;
        } catch (error) {
            logger.error(`[SSH] Restart error: ${error.message}`);
            return false;
        }
    }

    /**
     * Reload Hysteria config
     */
    async reloadHysteria() {
        try {
            const result = await this.exec('systemctl restart hysteria-server 2>&1 || systemctl restart hysteria 2>&1');
            
            logger.debug(`[SSH] ${this.node.name} restart output: ${result.stdout} ${result.stderr}`);
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            const statusResult = await this.exec('systemctl is-active hysteria-server 2>/dev/null || systemctl is-active hysteria 2>/dev/null');
            const isActive = statusResult.stdout.trim() === 'active';
            
            if (isActive) {
                logger.info(`[SSH] Hysteria restarted and running on ${this.node.name}`);
            return true;
            } else {
                // Try to get logs for diagnostics
                const logsResult = await this.exec('journalctl -u hysteria-server -n 10 --no-pager 2>/dev/null || journalctl -u hysteria -n 10 --no-pager 2>/dev/null');
                logger.error(`[SSH] Hysteria failed to start on ${this.node.name}. Logs: ${logsResult.stdout}`);
                return false;
            }
        } catch (error) {
            logger.error(`[SSH] Restart error: ${error.message}`);
            return false;
        }
    }

    /**
     * Update config on node
     */
    async updateConfig(configContent) {
        try {
            const configPath = this.node.paths?.config || '/etc/hysteria/config.yaml';
            
            await this.exec(`cp ${configPath} ${configPath}.bak 2>/dev/null || true`);
            await this.writeFile(configPath, configContent);
            
            const checkResult = await this.exec(`/usr/local/bin/hysteria check -c ${configPath} 2>&1 || true`);
            
            // If check failed - rollback
            if (checkResult.stdout.includes('error') || checkResult.stderr.includes('error')) {
                logger.error(`[SSH] Config error on ${this.node.name}: ${checkResult.stdout}`);
                await this.exec(`mv ${configPath}.bak ${configPath}`);
                return false;
            }
            
            return await this.reloadHysteria();
        } catch (error) {
            logger.error(`[SSH] Config update error: ${error.message}`);
            return false;
        }
    }

    /**
     * Setup port hopping via iptables
     */
    async setupPortHopping(portRange) {
        try {
            const mainPort = this.node.port || 443;
            const [startPort, endPort] = portRange.split('-').map(Number);
            
            const script = `
# Clear old rules
iptables -t nat -D PREROUTING -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
ip6tables -t nat -D PREROUTING -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true

# Clear legacy interface-specific rules
for iface in eth0 eth1 ens3 ens5 enp0s3 eno1; do
    iptables -t nat -D PREROUTING -i $iface -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
    ip6tables -t nat -D PREROUTING -i $iface -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
done

# Add new rules (no interface binding)
iptables -t nat -A PREROUTING -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort}
ip6tables -t nat -A PREROUTING -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort}

# Open ports in UFW
if command -v ufw &> /dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow ${startPort}:${endPort}/udp 2>/dev/null || true
fi

# Save rules
if command -v netfilter-persistent &> /dev/null; then
    netfilter-persistent save 2>/dev/null
elif command -v iptables-save &> /dev/null; then
    mkdir -p /etc/iptables
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    ip6tables-save > /etc/iptables/rules.v6 2>/dev/null || true
fi

echo "Port hopping: ${startPort}-${endPort} -> ${mainPort}"
`;
            
            await this.exec(script);
            
            logger.info(`[SSH] Port hopping configured on ${this.node.name}: ${portRange} -> ${mainPort}`);
            return true;
        } catch (error) {
            logger.error(`[SSH] Port hopping setup error: ${error.message}`);
            return false;
        }
    }
    
    /**
     * Get current network speed (bytes/sec)
     */
    async getNetworkSpeed() {
        try {
            const getNetStats = async () => {
                const result = await this.exec(`cat /proc/net/dev | grep -E '(eth|ens|enp|eno)' | head -1`);
                const line = result.stdout.trim();
                
                if (!line) return null;
                
                const data = line.replace(/^[^:]+:\s*/, '');
                const parts = data.trim().split(/\s+/);
                
                const rxBytes = parseInt(parts[0]) || 0;
                const txBytes = parseInt(parts[8]) || 0;
                
                return { rx: rxBytes, tx: txBytes, time: Date.now() };
            };
            
            const stats1 = await getNetStats();
            if (!stats1) {
                return { success: false, error: 'Network interface not found' };
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const stats2 = await getNetStats();
            if (!stats2) {
                return { success: false, error: 'Network interface not found' };
            }
            
            const timeDiff = (stats2.time - stats1.time) / 1000;
            const rxSpeed = Math.round((stats2.rx - stats1.rx) / timeDiff);
            const txSpeed = Math.round((stats2.tx - stats1.tx) / timeDiff);
            
            return { 
                success: true, 
                rx: rxSpeed,
                tx: txSpeed,
            };
        } catch (error) {
            logger.error(`[SSH] Network speed error on ${this.node.name}: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    /**
     * Get system stats from node
     */
    async getSystemStats() {
        try {
            const result = await this.exec(`
echo "===CPU==="
cat /proc/loadavg
echo "===CORES==="
nproc
echo "===MEM==="
free -b | grep -E "^Mem:"
echo "===DISK==="
df -B1 / | tail -1
echo "===UPTIME==="
cat /proc/uptime | cut -d' ' -f1
            `);
            
            const output = result.stdout || '';
            const lines = output.split('\n');
            
            let cpu = { load1: 0, load5: 0, load15: 0, cores: 1 };
            let mem = { total: 0, used: 0, free: 0, percent: 0 };
            let disk = { total: 0, used: 0, free: 0, percent: 0 };
            let uptime = 0;
            
            let section = '';
            for (const line of lines) {
                if (line.includes('===CPU===')) { section = 'cpu'; continue; }
                if (line.includes('===CORES===')) { section = 'cores'; continue; }
                if (line.includes('===MEM===')) { section = 'mem'; continue; }
                if (line.includes('===DISK===')) { section = 'disk'; continue; }
                if (line.includes('===UPTIME===')) { section = 'uptime'; continue; }
                
                if (section === 'cpu' && line.trim()) {
                    const parts = line.trim().split(/\s+/);
                    cpu.load1 = parseFloat(parts[0]) || 0;
                    cpu.load5 = parseFloat(parts[1]) || 0;
                    cpu.load15 = parseFloat(parts[2]) || 0;
                }
                
                if (section === 'cores' && line.trim()) {
                    cpu.cores = parseInt(line.trim()) || 1;
                }
                
                if (section === 'mem' && line.trim()) {
                    // Mem: total used free shared buff/cache available
                    const parts = line.trim().split(/\s+/);
                    const total = parseInt(parts[1]) || 0;
                    const used = parseInt(parts[2]) || 0;
                    const free = parseInt(parts[3]) || 0;
                    mem = {
                        total,
                        used,
                        free,
                        percent: total > 0 ? Math.round((used / total) * 100) : 0,
                    };
                }
                
                if (section === 'disk' && line.trim()) {
                    // /dev/xxx 123456 78901 45678 50% /
                    const parts = line.trim().split(/\s+/);
                    const total = parseInt(parts[1]) || 0;
                    const used = parseInt(parts[2]) || 0;
                    const free = parseInt(parts[3]) || 0;
                    disk = {
                        total,
                        used,
                        free,
                        percent: total > 0 ? Math.round((used / total) * 100) : 0,
                    };
                }
                
                if (section === 'uptime' && line.trim()) {
                    uptime = Math.floor(parseFloat(line.trim()) || 0);
                }
            }
            
            return { success: true, cpu, mem, disk, uptime };
        } catch (error) {
            logger.error(`[SSH] System stats error on ${this.node.name}: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
}

module.exports = NodeSSH;
