/**
 * API подписок Hysteria 2
 * 
 * Единый роут /api/files/:token:
 * - Браузер → HTML страница
 * - Приложение → подписка в нужном формате
 */

const express = require('express');
const router = express.Router();
const HyUser = require('../models/hyUserModel');
const HyNode = require('../models/hyNodeModel');
const ServerGroup = require('../models/serverGroupModel');
const Settings = require('../models/settingsModel');
const logger = require('../utils/logger');
const { getNodesByGroups } = require('../utils/helpers');

// ==================== HELPERS ====================

function detectFormat(userAgent) {
    const ua = (userAgent || '').toLowerCase();
    // Shadowrocket лучше работает с base64 URI list
    if (/shadowrocket/.test(ua)) return 'shadowrocket';
    if (/clash|stash|surge|loon/.test(ua)) return 'clash';
    if (/hiddify|sing-?box|sfi|sfa|sfm|sft|karing|hiddifynext/.test(ua)) return 'singbox';
    return 'uri';
}

function isBrowser(req) {
    const accept = req.headers.accept || '';
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    return accept.includes('text/html') && /mozilla|chrome|safari|edge|opera/.test(ua);
}

async function getUserByToken(token) {
    let user = await HyUser.findOne({ subscriptionToken: token })
        .populate('nodes')
        .populate('groups', 'name subscriptionPrefix');
    if (!user) {
        user = await HyUser.findOne({ userId: token })
            .populate('nodes')
            .populate('groups', 'name subscriptionPrefix');
    }
    return user;
}

/**
 * Получить prefix для названия подписки из групп пользователя
 */
function getSubscriptionPrefix(user) {
    if (!user.groups || user.groups.length === 0) return '';
    
    // Берём prefix из первой группы где он задан
    for (const group of user.groups) {
        if (group.subscriptionPrefix) {
            return group.subscriptionPrefix;
        }
    }
    return '';
}

async function getActiveNodes(user) {
    let nodes = [];
    
    // Если у пользователя привязаны конкретные ноды
    if (user.nodes && user.nodes.length > 0) {
        nodes = user.nodes.filter(n => n && n.active);
        logger.debug(`[Sub] User ${user.userId}: ${nodes.length} linked active nodes`);
    }
    
    // Если нод нет - берём по группам пользователя
    if (nodes.length === 0) {
        nodes = await getNodesByGroups(user.groups);
        logger.debug(`[Sub] User ${user.userId}: ${nodes.length} nodes by groups`);
    }
    
    // Получаем настройки из БД
    const settings = await Settings.get();
    const lb = settings.loadBalancing || {};
    
    // Фильтрация перегруженных нод (если включено)
    if (lb.hideOverloaded) {
        const beforeFilter = nodes.length;
        nodes = nodes.filter(n => {
            if (!n.maxOnlineUsers || n.maxOnlineUsers === 0) return true;
            return n.onlineUsers < n.maxOnlineUsers;
        });
        if (nodes.length < beforeFilter) {
            logger.debug(`[Sub] Filtered out ${beforeFilter - nodes.length} overloaded nodes`);
        }
    }
    
    // Логируем статусы нод
    if (nodes.length > 0) {
        const statuses = nodes.map(n => `${n.name}:${n.status}(${n.onlineUsers}/${n.maxOnlineUsers || '∞'})`).join(', ');
        logger.info(`[Sub] Nodes for ${user.userId}: ${statuses}`);
    } else {
        logger.warn(`[Sub] NO NODES for user ${user.userId}! Check: active=true, groups match`);
    }
    
    // Сортировка: балансировка по нагрузке или по rankingCoefficient
    if (lb.enabled) {
        // Сортируем по % загрузки (наименее загруженные первыми)
        nodes.sort((a, b) => {
            const loadA = a.maxOnlineUsers ? a.onlineUsers / a.maxOnlineUsers : 0;
            const loadB = b.maxOnlineUsers ? b.onlineUsers / b.maxOnlineUsers : 0;
            // При равной загрузке — по rankingCoefficient
            if (Math.abs(loadA - loadB) < 0.1) {
                return (a.rankingCoefficient || 1) - (b.rankingCoefficient || 1);
            }
            return loadA - loadB;
        });
        logger.debug(`[Sub] Load balancing applied`);
    } else {
    nodes.sort((a, b) => (a.rankingCoefficient || 1) - (b.rankingCoefficient || 1));
    }
    
    return nodes;
}

function validateUser(user) {
    if (!user) return { valid: false, error: 'Not found' };
    if (!user.enabled) return { valid: false, error: 'Inactive' };
    if (user.expireAt && new Date(user.expireAt) < new Date()) return { valid: false, error: 'Expired' };
    if (user.trafficLimit > 0) {
        const used = (user.traffic?.tx || 0) + (user.traffic?.rx || 0);
        if (used >= user.trafficLimit) return { valid: false, error: 'Traffic exceeded' };
    }
    return { valid: true };
}

function getNodeConfigs(node) {
    const configs = [];
    const host = node.domain || node.ip;
    
    if (node.portConfigs && node.portConfigs.length > 0) {
        node.portConfigs.filter(c => c.enabled).forEach(cfg => {
            configs.push({
                name: cfg.name || `Port ${cfg.port}`,
                host,
                port: cfg.port,
                portRange: cfg.portRange || '',
                domain: node.domain,
            });
        });
    } else {
        configs.push({ name: 'TLS', host, port: 443, portRange: '', domain: node.domain });
        configs.push({ name: 'HTTP', host, port: 80, portRange: '', domain: node.domain });
        if (node.portRange) {
            configs.push({ name: 'Hopping', host, port: node.port || 443, portRange: node.portRange, domain: node.domain });
        }
    }
    
    return configs;
}

// ==================== URI GENERATION ====================

function generateURI(user, node, config) {
    // Auth содержит userId для идентификации на сервере
    const auth = `${user.userId}:${user.password}`;
    const params = [];
    
    if (config.domain) params.push(`sni=${config.domain}`);
    params.push('alpn=h3');
    params.push(`insecure=${config.domain ? '0' : '1'}`);
    if (config.portRange) params.push(`mport=${config.portRange}`);
    
    const name = `${node.flag || ''} ${node.name} ${config.name}`.trim();
    const uri = `hysteria2://${auth}@${config.host}:${config.port}?${params.join('&')}#${encodeURIComponent(name)}`;
    return uri;
}

// ==================== FORMAT GENERATORS ====================

function generateURIList(user, nodes) {
    const uris = [];
    nodes.forEach(node => {
        getNodeConfigs(node).forEach(cfg => {
            uris.push(generateURI(user, node, cfg));
        });
    });
    return uris.join('\n');
}

function generateClashYAML(user, nodes) {
    const auth = `${user.userId}:${user.password}`;
    const proxies = [];
    const proxyNames = [];
    
    nodes.forEach(node => {
        getNodeConfigs(node).forEach(cfg => {
            const name = `${node.flag || ''} ${node.name} ${cfg.name}`.trim();
            proxyNames.push(name);
            
            let proxy = `  - name: "${name}"
    type: hysteria2
    server: ${cfg.host}
    port: ${cfg.port}
    password: "${auth}"
    sni: ${cfg.domain || cfg.host}
    skip-cert-verify: ${!cfg.domain}
    alpn:
      - h3`;
            
            if (cfg.portRange) proxy += `\n    ports: ${cfg.portRange}`;
            
            proxies.push(proxy);
        });
    });
    
    return `proxies:\n${proxies.join('\n')}\n\nproxy-groups:\n  - name: "Proxy"\n    type: select\n    proxies:\n${proxyNames.map(n => `      - "${n}"`).join('\n')}\n`;
}

function generateSingboxJSON(user, nodes) {
    const auth = `${user.userId}:${user.password}`;
    const outbounds = [];
    const tags = [];
    
    nodes.forEach(node => {
        getNodeConfigs(node).forEach(cfg => {
            const tag = `${node.flag || ''} ${node.name} ${cfg.name}`.trim();
            tags.push(tag);
            
            const outbound = {
                type: 'hysteria2',
                tag,
                server: cfg.host,
                server_port: cfg.port,
                password: auth,
                tls: {
                    enabled: true,
                    server_name: cfg.domain || cfg.host,
                    insecure: !cfg.domain,
                    alpn: ['h3']
                }
            };
            
            if (cfg.portRange) outbound.hop_ports = cfg.portRange;
            
            outbounds.push(outbound);
        });
    });
    
    outbounds.unshift({ type: 'selector', tag: 'proxy', outbounds: tags, default: tags[0] });
    outbounds.push({ type: 'direct', tag: 'direct' });
    outbounds.push({ type: 'block', tag: 'block' });
    
    return { outbounds };
}

// ==================== HTML PAGE ====================

function generateHTML(user, nodes, token, baseUrl) {
    // Собираем все конфиги
    const allConfigs = [];
    nodes.forEach(node => {
        getNodeConfigs(node).forEach(cfg => {
            allConfigs.push({
                location: node.name,
                flag: node.flag || '🌐',
                name: cfg.name,
                uri: generateURI(user, node, cfg),
            });
        });
    });
    
    const trafficUsed = ((user.traffic?.tx || 0) + (user.traffic?.rx || 0)) / (1024 * 1024 * 1024);
    const trafficLimit = user.trafficLimit ? user.trafficLimit / (1024 * 1024 * 1024) : 0;
    const expireDate = user.expireAt ? new Date(user.expireAt).toLocaleDateString('ru-RU') : 'Бессрочно';
    
    // Группируем по локациям
    const locations = {};
    allConfigs.forEach(cfg => {
        if (!locations[cfg.location]) {
            locations[cfg.location] = { flag: cfg.flag, configs: [] };
        }
        locations[cfg.location].configs.push({ name: cfg.name, uri: cfg.uri });
    });

    return `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Подключение</title>
    <style>
        :root { --bg: #0a0a0a; --card: #141414; --border: #252525; --text: #fff; --muted: #888; --accent: #3b82f6; --success: #22c55e; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 16px; }
        .container { max-width: 600px; margin: 0 auto; }
        .header { text-align: center; padding: 32px 16px; background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%); border-radius: 16px; margin-bottom: 16px; }
        .header h1 { font-size: 24px; margin-bottom: 4px; }
        .header p { color: var(--muted); font-size: 14px; }
        .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
        .stat { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 12px; text-align: center; }
        .stat-value { font-size: 18px; font-weight: 600; color: var(--accent); }
        .stat-label { font-size: 11px; color: var(--muted); margin-top: 2px; }
        .section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
        .section h2 { font-size: 14px; margin-bottom: 12px; color: var(--muted); }
        .location { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
        .location-header { display: flex; align-items: center; gap: 10px; padding: 12px; cursor: pointer; background: var(--bg); }
        .location-header:hover { background: #1a1a1a; }
        .location-flag { font-size: 24px; }
        .location-name { flex: 1; font-weight: 500; }
        .location-arrow { color: var(--muted); transition: transform 0.2s; }
        .location.open .location-arrow { transform: rotate(180deg); }
        .location-configs { display: none; border-top: 1px solid var(--border); }
        .location.open .location-configs { display: block; }
        .config { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--border); }
        .config:last-child { border-bottom: none; }
        .config-name { font-size: 13px; }
        .copy-btn { padding: 6px 12px; background: var(--accent); border: none; border-radius: 6px; color: #fff; font-size: 12px; cursor: pointer; }
        .copy-btn:active { transform: scale(0.95); }
        .copy-btn.success { background: var(--success); }
        .sub-box { display: flex; gap: 8px; }
        .sub-box input { flex: 1; padding: 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 12px; }
        .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(100px); background: var(--success); color: #fff; padding: 10px 20px; border-radius: 8px; font-size: 14px; transition: transform 0.3s; }
        .toast.show { transform: translateX(-50%) translateY(0); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Подключение</h1>
            <p>Ваша персональная конфигурация</p>
        </div>
        
        <div class="stats">
            <div class="stat">
                <div class="stat-value">${trafficUsed.toFixed(1)} ГБ</div>
                <div class="stat-label">Использовано${trafficLimit > 0 ? ` / ${trafficLimit.toFixed(0)} ГБ` : ''}</div>
            </div>
            <div class="stat">
                <div class="stat-value">${Object.keys(locations).length}</div>
                <div class="stat-label">Локаций</div>
            </div>
            <div class="stat">
                <div class="stat-value">${expireDate}</div>
                <div class="stat-label">Действует до</div>
            </div>
        </div>
        
        <div class="section">
            <h2>🔗 ССЫЛКА ДЛЯ ПРИЛОЖЕНИЙ</h2>
            <div class="sub-box">
                <input type="text" value="${baseUrl}" readonly id="subUrl">
                <button class="copy-btn" onclick="copyText('${baseUrl}', this)">Копировать</button>
            </div>
        </div>
        
        <div class="section">
            <h2>🌍 ЛОКАЦИИ</h2>
            ${Object.entries(locations).map(([name, loc]) => `
            <div class="location">
                <div class="location-header" onclick="this.parentElement.classList.toggle('open')">
                    <span class="location-flag">${loc.flag}</span>
                    <span class="location-name">${name}</span>
                    <span class="location-arrow">▼</span>
                </div>
                <div class="location-configs">
                    ${loc.configs.map((cfg, i) => `
                    <div class="config">
                        <span class="config-name">${cfg.name}</span>
                        <button class="copy-btn" onclick="copyUri(${Object.entries(locations).indexOf([name, loc])}_${i}, this)">Копировать</button>
                    </div>
                    `).join('')}
                </div>
            </div>
            `).join('')}
        </div>
    </div>
    
    <div class="toast" id="toast">✓ Скопировано</div>
    
    <script>
        // Все URI для копирования
        const uris = ${JSON.stringify(allConfigs.map(c => c.uri))};
        
        function copyText(text, btn) {
            doCopy(text, btn);
        }
        
        function copyUri(index, btn) {
            // Находим правильный индекс
            const allBtns = document.querySelectorAll('.location-configs .copy-btn');
            let idx = 0;
            for (let i = 0; i < allBtns.length; i++) {
                if (allBtns[i] === btn) {
                    idx = i;
                    break;
                }
            }
            doCopy(uris[idx], btn);
        }
        
        function doCopy(text, btn) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => success(btn)).catch(() => fallback(text, btn));
            } else {
                fallback(text, btn);
            }
        }
        
        function fallback(text, btn) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); success(btn); } catch(e) {}
            document.body.removeChild(ta);
        }
        
        function success(btn) {
            const orig = btn.textContent;
            btn.textContent = '✓';
            btn.classList.add('success');
            document.getElementById('toast').classList.add('show');
            setTimeout(() => {
                btn.textContent = orig;
                btn.classList.remove('success');
                document.getElementById('toast').classList.remove('show');
            }, 1500);
        }
    </script>
</body>
</html>`;
}

// ==================== MAIN ROUTE ====================

/**
 * GET /files/:token - Единственный роут
 * - Браузер → HTML
 * - Приложение → подписка
 */
router.get('/files/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const userAgent = req.headers['user-agent'] || 'unknown';
        
        logger.info(`[Sub] Request: token=${token.substring(0,8)}..., UA=${userAgent.substring(0,50)}`);
        
        const user = await getUserByToken(token);
        
        if (!user) {
            logger.warn(`[Sub] User not found for token: ${token}`);
            return res.status(404).type('text/plain').send('# User not found');
        }
        
        const validation = validateUser(user);
        
        if (!validation.valid) {
            logger.warn(`[Sub] User ${user.userId} invalid: ${validation.error}`);
            return res.status(403).type('text/plain').send(`# ${validation.error}`);
        }
        
        const nodes = await getActiveNodes(user);
        if (nodes.length === 0) {
            logger.error(`[Sub] NO SERVERS for user ${user.userId}! Check nodes in panel.`);
            return res.status(503).type('text/plain').send('# No servers available');
        }
        
        logger.info(`[Sub] Serving ${nodes.length} nodes to user ${user.userId}`);
        
        // Получаем название подписки из групп пользователя (для заголовка)
        const subscriptionName = getSubscriptionPrefix(user);
        
        // Определяем формат
        const format = req.query.format;
        
        // Если указан format - отдаём подписку
        if (format) {
            return sendSubscription(res, user, nodes, format, userAgent, subscriptionName);
        }
        
        // Если браузер без format - HTML
        if (isBrowser(req)) {
            const baseUrl = `${req.protocol}://${req.get('host')}/api/files/${token}`;
            return res.type('text/html').send(generateHTML(user, nodes, token, baseUrl));
        }
        
        // Приложение без format - автоопределение
        const detectedFormat = detectFormat(userAgent);
        return sendSubscription(res, user, nodes, detectedFormat, userAgent, subscriptionName);
        
    } catch (error) {
        logger.error(`[Sub] Error: ${error.message}`);
        res.status(500).type('text/plain').send('# Error');
    }
});

function sendSubscription(res, user, nodes, format, userAgent, subscriptionName = '') {
    let content, contentType = 'text/plain';
    let needsBase64 = false;
    
    switch (format) {
        case 'shadowrocket':
            // Shadowrocket лучше работает с base64-encoded URI list
            content = generateURIList(user, nodes);
            needsBase64 = true;
            break;
        case 'clash':
        case 'yaml':
            content = generateClashYAML(user, nodes);
            contentType = 'text/yaml';
            break;
        case 'singbox':
        case 'json':
            content = JSON.stringify(generateSingboxJSON(user, nodes), null, 2);
            contentType = 'application/json';
            break;
        case 'uri':
        case 'raw':
        default:
            content = generateURIList(user, nodes);
            // Base64 для Quantumult
            if (/quantumult/i.test(userAgent)) {
                needsBase64 = true;
            }
            break;
    }
    
    if (needsBase64) {
        content = Buffer.from(content).toString('base64');
    }
    
    const headers = {
        'Content-Type': `${contentType}; charset=utf-8`,
        'Profile-Update-Interval': '12',
        'Subscription-Userinfo': [
            `upload=${user.traffic?.tx || 0}`,
            `download=${user.traffic?.rx || 0}`,
            `total=${user.trafficLimit || 0}`,
            `expire=${user.expireAt ? Math.floor(new Date(user.expireAt).getTime() / 1000) : 0}`,
        ].join('; '),
    };
    
    // Название подписки в заголовке (поддерживается Clash, Hiddify, и др.)
    if (subscriptionName) {
        headers['Profile-Title'] = Buffer.from(subscriptionName).toString('base64');
        
        // Очищаем имя файла от недопустимых символов для HTTP заголовков
        // В HTTP заголовках Content-Disposition нельзя использовать: кавычки, переносы строк, табы и др.
        // Оставляем только безопасные символы: буквы, цифры, пробелы, дефисы, подчеркивания
        const safeFilename = subscriptionName
            .replace(/["\r\n\t\\/:*?<>|]/g, '') // Удаляем недопустимые символы для имени файла
            .replace(/[^\x20-\x7E]/g, '') // Оставляем только безопасные ASCII символы (32-126)
            .trim()
            .substring(0, 100) || 'subscription'; // Ограничиваем длину
        
        // Используем RFC 5987 encoding для поддержки не-ASCII символов в современных браузерах
        const encodedFilename = encodeURIComponent(subscriptionName.substring(0, 100));
        headers['Content-Disposition'] = `attachment; filename="${safeFilename}.txt"; filename*=UTF-8''${encodedFilename}.txt`;
    }
    
    res.set(headers);
    res.send(content);
}

// ==================== INFO ====================

router.get('/info/:token', async (req, res) => {
    try {
        const user = await getUserByToken(req.params.token);
        if (!user) return res.status(404).json({ error: 'Not found' });
        
        const nodes = await getActiveNodes(user);
        
        res.json({
            enabled: user.enabled,
            groups: user.groups,
            traffic: { used: (user.traffic?.tx || 0) + (user.traffic?.rx || 0), limit: user.trafficLimit },
            expire: user.expireAt,
            servers: nodes.length,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
