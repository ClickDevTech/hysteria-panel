/**
 * SSH сервис для управления нодами Hysteria
 */

const { Client } = require('ssh2');
const logger = require('../utils/logger');
const cryptoService = require('./cryptoService');

class NodeSSH {
    constructor(node) {
        this.node = node;
        this.client = null;
    }

    /**
     * Подключается к ноде по SSH
     */
    async connect() {
        return new Promise((resolve, reject) => {
            this.client = new Client();
            
            const config = {
                host: this.node.ip,
                port: this.node.ssh?.port || 22,
                username: this.node.ssh?.username || 'root',
                readyTimeout: 30000,
            };
            
            // Добавляем аутентификацию (расшифровываем пароль)
            if (this.node.ssh?.privateKey) {
                config.privateKey = this.node.ssh.privateKey;
            } else if (this.node.ssh?.password) {
                config.password = cryptoService.decrypt(this.node.ssh.password);
            } else {
                reject(new Error('SSH: не указан ни ключ, ни пароль'));
                return;
            }
            
            this.client
                .on('ready', () => {
                    logger.info(`[SSH] Подключено к ${this.node.name} (${this.node.ip})`);
                    resolve();
                })
                .on('error', (err) => {
                    logger.error(`[SSH] Ошибка подключения к ${this.node.name}: ${err.message}`);
                    reject(err);
                })
                .connect(config);
        });
    }

    /**
     * Закрывает соединение
     */
    disconnect() {
        if (this.client) {
            this.client.end();
            this.client = null;
        }
    }

    /**
     * Выполняет команду на удалённом сервере
     */
    async exec(command) {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('SSH не подключен'));
                return;
            }
            
            this.client.exec(command, (err, stream) => {
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
     * Записывает файл на удалённый сервер
     */
    async writeFile(remotePath, content) {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('SSH не подключен'));
                return;
            }
            
            this.client.sftp((err, sftp) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                const writeStream = sftp.createWriteStream(remotePath);
                
                writeStream
                    .on('close', () => {
                        logger.info(`[SSH] Записан файл ${remotePath} на ${this.node.name}`);
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
     * Читает файл с удалённого сервера
     */
    async readFile(remotePath) {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('SSH не подключен'));
                return;
            }
            
            this.client.sftp((err, sftp) => {
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
     * Проверяет статус Hysteria сервиса
     */
    async checkHysteriaStatus() {
        try {
            // Ждём 2 секунды чтобы сервис успел подняться после reload
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const result = await this.exec('systemctl is-active hysteria-server 2>/dev/null || systemctl is-active hysteria 2>/dev/null || echo "unknown"');
            const status = result.stdout.trim();
            
            logger.debug(`[SSH] ${this.node.name} hysteria status: ${status}`);
            
            return status === 'active';
        } catch (error) {
            logger.warn(`[SSH] ${this.node.name} status check failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Перезапускает Hysteria
     */
    async restartHysteria() {
        try {
            // Пробуем оба возможных имени сервиса
            let result = await this.exec('systemctl restart hysteria-server 2>/dev/null || systemctl restart hysteria 2>/dev/null');
            
            if (result.code !== 0) {
                logger.error(`[SSH] Ошибка перезапуска Hysteria на ${this.node.name}: ${result.stderr}`);
                return false;
            }
            
            logger.info(`[SSH] Hysteria перезапущен на ${this.node.name}`);
            return true;
        } catch (error) {
            logger.error(`[SSH] Ошибка перезапуска: ${error.message}`);
            return false;
        }
    }

    /**
     * Reload конфигурации Hysteria (без перезапуска)
     */
    async reloadHysteria() {
        try {
            // Сначала пробуем restart (более надёжно чем reload)
            const result = await this.exec('systemctl restart hysteria-server 2>&1 || systemctl restart hysteria 2>&1');
            
            logger.debug(`[SSH] ${this.node.name} restart output: ${result.stdout} ${result.stderr}`);
            
            // Ждём 3 секунды чтобы сервис поднялся
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Проверяем что сервис действительно запустился
            const statusResult = await this.exec('systemctl is-active hysteria-server 2>/dev/null || systemctl is-active hysteria 2>/dev/null');
            const isActive = statusResult.stdout.trim() === 'active';
            
            if (isActive) {
                logger.info(`[SSH] Hysteria перезапущен и работает на ${this.node.name}`);
            return true;
            } else {
                // Попробуем получить логи для диагностики
                const logsResult = await this.exec('journalctl -u hysteria-server -n 10 --no-pager 2>/dev/null || journalctl -u hysteria -n 10 --no-pager 2>/dev/null');
                logger.error(`[SSH] Hysteria не запустился на ${this.node.name}. Логи: ${logsResult.stdout}`);
                return false;
            }
        } catch (error) {
            logger.error(`[SSH] Ошибка restart: ${error.message}`);
            return false;
        }
    }

    /**
     * Обновляет конфиг на ноде
     */
    async updateConfig(configContent) {
        try {
            const configPath = this.node.paths?.config || '/etc/hysteria/config.yaml';
            
            // Создаём бэкап
            await this.exec(`cp ${configPath} ${configPath}.bak 2>/dev/null || true`);
            
            // Записываем новый конфиг
            await this.writeFile(configPath, configContent);
            
            // Проверяем синтаксис конфига
            const checkResult = await this.exec(`/usr/local/bin/hysteria check -c ${configPath} 2>&1 || true`);
            
            // Если проверка не прошла - откатываем
            if (checkResult.stdout.includes('error') || checkResult.stderr.includes('error')) {
                logger.error(`[SSH] Ошибка в конфиге ${this.node.name}: ${checkResult.stdout}`);
                await this.exec(`mv ${configPath}.bak ${configPath}`);
                return false;
            }
            
            // Применяем конфиг
            return await this.reloadHysteria();
        } catch (error) {
            logger.error(`[SSH] Ошибка обновления конфига: ${error.message}`);
            return false;
        }
    }

    /**
     * Настраивает port hopping через iptables
     * Унифицированная версия (без привязки к интерфейсу)
     */
    async setupPortHopping(portRange) {
        try {
            const mainPort = this.node.port || 443;
            const [startPort, endPort] = portRange.split('-').map(Number);
            
            // Скрипт полной очистки и настройки
            const script = `
# Очищаем ВСЕ старые правила (разные варианты)
iptables -t nat -D PREROUTING -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
ip6tables -t nat -D PREROUTING -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true

# Очищаем legacy правила с привязкой к интерфейсу
for iface in eth0 eth1 ens3 ens5 enp0s3 eno1; do
    iptables -t nat -D PREROUTING -i $iface -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
    ip6tables -t nat -D PREROUTING -i $iface -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort} 2>/dev/null || true
done

# Добавляем новые правила (БЕЗ привязки к интерфейсу)
iptables -t nat -A PREROUTING -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort}
ip6tables -t nat -A PREROUTING -p udp --dport ${startPort}:${endPort} -j REDIRECT --to-port ${mainPort}

# Открываем порты в UFW
if command -v ufw &> /dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow ${startPort}:${endPort}/udp 2>/dev/null || true
fi

# Сохраняем правила
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
            
            logger.info(`[SSH] Port hopping настроен на ${this.node.name}: ${portRange} -> ${mainPort}`);
            return true;
        } catch (error) {
            logger.error(`[SSH] Ошибка настройки port hopping: ${error.message}`);
            return false;
        }
    }
    
    /**
     * Получает текущую скорость сети (байт/сек)
     */
    async getNetworkSpeed() {
        try {
            // Читаем /proc/net/dev дважды с интервалом 1 сек
            const getNetStats = async () => {
                const result = await this.exec(`cat /proc/net/dev | grep -E '(eth|ens|enp|eno)' | head -1`);
                const line = result.stdout.trim();
                
                if (!line) return null;
                
                // Формат /proc/net/dev:
                // eth0: 12345678 123 0 0 0 0 0 0 87654321 123 0 0 0 0 0 0
                //       RX bytes                    TX bytes
                
                // Убираем название интерфейса и двоеточие
                const data = line.replace(/^[^:]+:\s*/, '');
                const parts = data.trim().split(/\s+/);
                
                // RX: bytes (0), packets (1), errs (2)...
                // TX: bytes (8), packets (9), errs (10)...
                const rxBytes = parseInt(parts[0]) || 0;
                const txBytes = parseInt(parts[8]) || 0;
                
                return { rx: rxBytes, tx: txBytes, time: Date.now() };
            };
            
            const stats1 = await getNetStats();
            if (!stats1) {
                return { success: false, error: 'Network interface not found' };
            }
            
            // Ждем 1 секунду
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const stats2 = await getNetStats();
            if (!stats2) {
                return { success: false, error: 'Network interface not found' };
            }
            
            // Вычисляем скорость (байт/сек)
            const timeDiff = (stats2.time - stats1.time) / 1000; // секунды
            const rxSpeed = Math.round((stats2.rx - stats1.rx) / timeDiff);
            const txSpeed = Math.round((stats2.tx - stats1.tx) / timeDiff);
            
            return { 
                success: true, 
                rx: rxSpeed,  // байт/сек (download)
                tx: txSpeed,  // байт/сек (upload)
            };
        } catch (error) {
            logger.error(`[SSH] Ошибка получения скорости сети ${this.node.name}: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    
    /**
     * Получает системную статистику ноды
     */
    async getSystemStats() {
        try {
            // Одной командой получаем всё нужное
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
            logger.error(`[SSH] Ошибка получения статистики ${this.node.name}: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
}

module.exports = NodeSSH;

