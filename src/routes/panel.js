/**
 * Роуты для веб-панели управления
 * SSR с EJS шаблонами
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const router = express.Router();

// Multer для загрузки backup файлов
const backupUpload = multer({ 
    dest: '/tmp/backup-uploads/',
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.tar.gz') || file.originalname.endsWith('.tgz')) {
            cb(null, true);
        } else {
            cb(new Error('Только .tar.gz файлы разрешены'));
        }
    }
});
const HyUser = require('../models/hyUserModel');
const HyNode = require('../models/hyNodeModel');
const ServerGroup = require('../models/serverGroupModel');
const Settings = require('../models/settingsModel');
const Admin = require('../models/adminModel');
const syncService = require('../services/syncService');
const cryptoService = require('../services/cryptoService');
const cache = require('../services/cacheService');
const nodeSetup = require('../services/nodeSetup');
const NodeSSH = require('../services/nodeSSH');
const { getActiveGroups, invalidateGroupsCache, invalidateSettingsCache } = require('../utils/helpers');
const config = require('../../config');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const ejs = require('ejs');
const os = require('os');
const rpsCounter = require('../middleware/rpsCounter');
const statsService = require('../services/statsService');

// Кэш скомпилированных шаблонов (для production)
const templateCache = new Map();

// Rate limiter для защиты от brute-force
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 5, // максимум 5 попыток
    message: 'Слишком много попыток входа. Попробуйте через 15 минут.',
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn(`[Panel] Rate limit exceeded for IP: ${req.ip}`);
        res.status(429).render('login', { 
            error: 'Слишком много попыток входа. Попробуйте через 15 минут.' 
        });
    },
});

// Парсинг IP whitelist
function parseIpWhitelist() {
    const whitelist = config.PANEL_IP_WHITELIST || '';
    if (!whitelist.trim()) return null; // Пустой = разрешено всем
    return whitelist.split(',').map(ip => ip.trim()).filter(Boolean);
}

// Проверка IP в whitelist (поддержка CIDR)
function isIpAllowed(clientIp, whitelist) {
    if (!whitelist || whitelist.length === 0) return true;
    
    // Нормализуем IPv6-mapped IPv4
    const normalizedIp = clientIp.replace(/^::ffff:/, '');
    
    for (const entry of whitelist) {
        if (entry.includes('/')) {
            // CIDR нотация
            if (isIpInCidr(normalizedIp, entry)) return true;
        } else {
            // Точное совпадение
            if (normalizedIp === entry) return true;
        }
    }
    return false;
}

// Проверка IP в CIDR диапазоне
function isIpInCidr(ip, cidr) {
    const [range, bits] = cidr.split('/');
    const mask = parseInt(bits);
    
    const ipNum = ipToNum(ip);
    const rangeNum = ipToNum(range);
    
    if (ipNum === null || rangeNum === null) return false;
    
    const maskBits = ~((1 << (32 - mask)) - 1);
    return (ipNum & maskBits) === (rangeNum & maskBits);
}

function ipToNum(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    return parts.reduce((acc, part) => (acc << 8) + parseInt(part), 0) >>> 0;
}

// Middleware: проверка IP whitelist
const checkIpWhitelist = (req, res, next) => {
    const whitelist = parseIpWhitelist();
    if (!whitelist) return next(); // Нет whitelist - пропускаем всех
    
    // Получаем реальный IP (X-Forwarded-For от Caddy или прямой)
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp = forwardedFor 
        ? forwardedFor.split(',')[0].trim()
        : (req.ip || req.connection.remoteAddress || '');
    
    if (!isIpAllowed(clientIp, whitelist)) {
        logger.warn(`[Panel] Access denied for IP: ${clientIp}`);
        return res.status(403).send('Доступ запрещён. Ваш IP не в whitelist.');
    }
    next();
};

// Применяем IP whitelist ко всем роутам панели
router.use(checkIpWhitelist);

// Middleware: проверка авторизации
const requireAuth = (req, res, next) => {
    if (!req.session || !req.session.authenticated) {
        return res.redirect('/panel/login');
    }
    next();
};

// Хелпер для рендера с layout (с кэшированием шаблонов)
const render = (res, template, data = {}) => {
    const isProduction = process.env.NODE_ENV === 'production';
    
    // Получаем или компилируем шаблон
    let compiledTemplate = templateCache.get(template);
    
    if (!compiledTemplate || !isProduction) {
        const templatePath = path.join(__dirname, '../../views', template + '.ejs');
        const templateContent = fs.readFileSync(templatePath, 'utf8');
        compiledTemplate = ejs.compile(templateContent, { filename: templatePath });
        if (isProduction) {
            templateCache.set(template, compiledTemplate);
        }
    }
    
    // Получаем i18n переменные из res.locals (установлены middleware)
    const i18nVars = {
        t: res.locals.t,
        lang: res.locals.lang,
        supportedLangs: res.locals.supportedLangs,
        locales: res.locals.locales,
    };
    
    // Рендерим контент из кэшированного шаблона
    const content = compiledTemplate({ 
        ...data, 
        ...i18nVars,
        baseUrl: config.BASE_URL, 
        config 
    });
    
    // Рендерим layout с контентом
    res.render('layout', {
        ...data,
        ...i18nVars,
        content,
        baseUrl: config.BASE_URL,
        config,
    });
};

// ==================== AUTH ====================

// GET /panel/login - Логин или первичная регистрация
router.get('/login', async (req, res) => {
    if (req.session && req.session.authenticated) {
        return res.redirect('/panel');
    }
    
    // Проверяем есть ли админ в БД
    const hasAdmin = await Admin.hasAdmin();
    
    if (!hasAdmin) {
        // Первый запуск - показываем форму регистрации
        return res.render('setup', { error: null });
    }
    
    res.render('login', { error: null });
});

// POST /panel/setup - Первичная регистрация админа
router.post('/setup', async (req, res) => {
    try {
        // Проверяем что админа ещё нет
        const hasAdmin = await Admin.hasAdmin();
        if (hasAdmin) {
            return res.redirect('/panel/login');
        }
        
        const { username, password, passwordConfirm } = req.body;
        
        // Валидация
        if (!username || username.length < 3) {
            return res.render('setup', { error: 'Логин должен быть минимум 3 символа' });
        }
        if (!password || password.length < 6) {
            return res.render('setup', { error: 'Пароль должен быть минимум 6 символов' });
        }
        if (password !== passwordConfirm) {
            return res.render('setup', { error: 'Пароли не совпадают' });
        }
        
        // Создаём админа
        await Admin.createAdmin(username, password);
        
        logger.info(`[Panel] Administrator created: ${username}`);
        
        // Авторизуем сразу
        req.session.authenticated = true;
        req.session.adminUsername = username.toLowerCase();
        
        res.redirect('/panel');
    } catch (error) {
        logger.error('[Panel] Admin creation error:', error.message);
        res.render('setup', { error: 'Ошибка: ' + error.message });
    }
});

// POST /panel/login (с rate limiting)
router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    
    // Проверяем есть ли админ в БД
    const hasAdmin = await Admin.hasAdmin();
    if (!hasAdmin) {
        return res.redirect('/panel/login');
    }
    
    // Проверяем логин/пароль
    const admin = await Admin.verifyPassword(username, password);
    
    if (admin) {
        req.session.authenticated = true;
        req.session.adminUsername = admin.username;
        logger.info(`[Panel] Successful login: ${admin.username} from IP: ${req.ip}`);
        return res.redirect('/panel');
    }
    
    logger.warn(`[Panel] Failed login attempt: ${username} from IP: ${req.ip}`);
    res.render('login', { error: 'Неверный логин или пароль' });
});

// GET /panel/logout
router.get('/logout', (req, res) => {
    const username = req.session?.adminUsername;
    req.session.destroy();
    if (username) {
        logger.info(`[Panel] Logout: ${username}`);
    }
    res.redirect('/panel/login');
});

// ==================== DASHBOARD ====================

// GET /panel - Dashboard
router.get('/', requireAuth, async (req, res) => {
    try {
        // Получаем счётчики из кэша
        let counts = await cache.getDashboardCounts();
        
        if (!counts) {
            // Если кэша нет — запрашиваем из БД
            const [trafficAgg, usersTotal, usersEnabled, nodesTotal, nodesOnline] = await Promise.all([
                HyUser.aggregate([
                    { $group: { 
                        _id: null, 
                        tx: { $sum: '$traffic.tx' }, 
                        rx: { $sum: '$traffic.rx' } 
                    }}
                ]),
                HyUser.countDocuments(),
                HyUser.countDocuments({ enabled: true }),
                HyNode.countDocuments(),
                HyNode.countDocuments({ status: 'online' }),
            ]);
            
            const trafficStats = trafficAgg[0] || { tx: 0, rx: 0 };
            
            counts = {
                usersTotal,
                usersEnabled,
                nodesTotal,
                nodesOnline,
                trafficStats,
            };
            
            // Сохраняем в кэш на 1 минуту
            await cache.setDashboardCounts(counts);
        }
        
        const { usersTotal, usersEnabled, nodesTotal, nodesOnline, trafficStats } = counts;
        
        const nodes = await HyNode.find({ active: true })
            .select('name ip status onlineUsers maxOnlineUsers groups traffic')
            .populate('groups', 'name color')
            .sort({ name: 1 });
        
        const totalOnline = nodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);
        
        // Общий трафик в байтах
        const totalTrafficBytes = (trafficStats.tx || 0) + (trafficStats.rx || 0);
        
        render(res, 'dashboard', {
            title: 'Dashboard',
            page: 'dashboard',
            stats: {
                users: { total: usersTotal, enabled: usersEnabled },
                nodes: { total: nodesTotal, online: nodesOnline },
                onlineUsers: totalOnline,
                lastSync: syncService.lastSyncTime,
                traffic: {
                    tx: trafficStats.tx || 0,
                    rx: trafficStats.rx || 0,
                    total: totalTrafficBytes,
                },
            },
            nodes,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// ==================== NODES ====================

// GET /panel/nodes - Список нод
router.get('/nodes', requireAuth, async (req, res) => {
    try {
        const [nodes, groups] = await Promise.all([
            HyNode.find().populate('groups', 'name color').sort({ name: 1 }),
            getActiveGroups(),
        ]);
        
        render(res, 'nodes', {
            title: 'Ноды',
            page: 'nodes',
            nodes,
            groups,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// GET /panel/nodes/add - Форма добавления ноды
router.get('/nodes/add', requireAuth, async (req, res) => {
    const groups = await getActiveGroups();
    render(res, 'node-form', {
        title: 'Новая нода',
        page: 'nodes',
        node: null,
        groups,
    });
});

// POST /panel/nodes - Создание ноды
router.post('/nodes', requireAuth, async (req, res) => {
    try {
        // Шифруем SSH пароль
        const sshPassword = req.body['ssh.password'] || '';
        const encryptedPassword = sshPassword ? cryptoService.encrypt(sshPassword) : '';
        
        // Группы (массив ID)
        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }
        
        const nodeData = {
            name: req.body.name,
            ip: req.body.ip,
            domain: req.body.domain || '',
            port: parseInt(req.body.port) || 443,
            portRange: req.body.portRange || '20000-50000',
            statsPort: parseInt(req.body.statsPort) || 9999,
            statsSecret: req.body.statsSecret || '',
            groups,
            maxOnlineUsers: parseInt(req.body.maxOnlineUsers) || 0,
            rankingCoefficient: parseFloat(req.body.rankingCoefficient) || 1,
            active: req.body.active === 'on',
            useCustomConfig: req.body.useCustomConfig === 'on',
            customConfig: req.body.customConfig || '',
            ssh: {
                port: parseInt(req.body['ssh.port']) || 22,
                username: req.body['ssh.username'] || 'root',
                password: encryptedPassword,
            },
        };
        
        await HyNode.create(nodeData);
        res.redirect('/panel/nodes');
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// GET /panel/nodes/:id - Редактирование ноды
router.get('/nodes/:id', requireAuth, async (req, res) => {
    try {
        const [node, groups] = await Promise.all([
            HyNode.findById(req.params.id).populate('groups', 'name color'),
            getActiveGroups(),
        ]);
        
        if (!node) {
            return res.redirect('/panel/nodes');
        }
        
        render(res, 'node-form', {
            title: `Редактирование: ${node.name}`,
            page: 'nodes',
            node,
            groups,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/nodes/:id - Обновление ноды
router.post('/nodes/:id', requireAuth, async (req, res) => {
    try {
        // Группы (массив ID)
        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }
        
        const updates = {
            name: req.body.name,
            ip: req.body.ip,
            domain: req.body.domain || '',
            port: parseInt(req.body.port) || 443,
            portRange: req.body.portRange || '20000-50000',
            statsPort: parseInt(req.body.statsPort) || 9999,
            statsSecret: req.body.statsSecret || '',
            groups,
            maxOnlineUsers: parseInt(req.body.maxOnlineUsers) || 0,
            rankingCoefficient: parseFloat(req.body.rankingCoefficient) || 1,
            active: req.body.active === 'on',
            useCustomConfig: req.body.useCustomConfig === 'on',
            customConfig: req.body.customConfig || '',
            flag: req.body.flag || '',
            'ssh.port': parseInt(req.body['ssh.port']) || 22,
            'ssh.username': req.body['ssh.username'] || 'root',
        };
        
        // Обновляем пароль только если указан (шифруем)
        if (req.body['ssh.password']) {
            updates['ssh.password'] = cryptoService.encrypt(req.body['ssh.password']);
        }
        
        await HyNode.findByIdAndUpdate(req.params.id, { $set: updates });
        res.redirect('/panel/nodes');
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/nodes/:id/setup - Автонастройка ноды через SSH
router.post('/nodes/:id/setup', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ error: 'SSH данные не настроены' });
        }
        
        // Запускаем настройку
        const result = await nodeSetup.setupNode(node, {
            installHysteria: true,
            setupPortHopping: true,
            restartService: true,
        });
        
        if (result.success) {
            // Обновляем статус
            await HyNode.findByIdAndUpdate(req.params.id, { 
                $set: { status: 'online', lastSync: new Date(), lastError: '' } 
            });
            res.json({ success: true, message: 'Нода успешно настроена', logs: result.logs });
        } else {
            await HyNode.findByIdAndUpdate(req.params.id, { 
                $set: { status: 'error', lastError: result.error } 
            });
            res.status(500).json({ success: false, error: result.error, logs: result.logs });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/nodes/:id/stats - Получение системной статистики ноды
router.get('/nodes/:id/stats', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ success: false, error: 'Нода не найдена' });
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH данные не настроены' });
        }
        
        const ssh = new NodeSSH(node);
        await ssh.connect();
        const stats = await ssh.getSystemStats();
        ssh.disconnect();
        
        res.json(stats);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/nodes/:id/speed - Получение текущей скорости сети
router.get('/nodes/:id/speed', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ success: false, error: 'Нода не найдена' });
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH данные не настроены' });
        }
        
        const ssh = new NodeSSH(node);
        await ssh.connect();
        const speed = await ssh.getNetworkSpeed();
        ssh.disconnect();
        
        res.json(speed);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/nodes/:id/get-config - Получение текущего конфига с ноды
router.get('/nodes/:id/get-config', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ success: false, error: 'Нода не найдена' });
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ success: false, error: 'SSH данные не настроены' });
        }
        
        const conn = await nodeSetup.connectSSH(node);
        const configPath = node.paths?.config || '/etc/hysteria/config.yaml';
        const result = await nodeSetup.execSSH(conn, `cat ${configPath}`);
        conn.end();
        
        if (result.success) {
            res.json({ success: true, config: result.output });
        } else {
            res.json({ success: false, error: result.error || 'Не удалось прочитать конфиг' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/nodes/:id/logs - Получение логов ноды
router.get('/nodes/:id/logs', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ error: 'SSH данные не настроены' });
        }
        
        const result = await nodeSetup.getNodeLogs(node, 100);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== USERS ====================

// GET /panel/users - Список пользователей (с поиском и сортировкой)
router.get('/users', requireAuth, async (req, res) => {
    try {
        const { enabled, group, page = 1, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
        const limit = 50;
        
        const filter = {};
        if (enabled !== undefined) filter.enabled = enabled === 'true';
        if (group) filter.groups = group;
        
        // Поиск по userId или username
        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim(), 'i');
            filter.$or = [
                { userId: searchRegex },
                { username: searchRegex }
            ];
        }
        
        let users;
        const order = sortOrder === 'asc' ? 1 : -1;
        
        // Если сортировка по трафику - используем aggregation
        if (sortBy === 'traffic') {
            const pipeline = [
                { $match: filter },
                {
                    $addFields: {
                        totalTraffic: { $add: [{ $ifNull: ['$traffic.tx', 0] }, { $ifNull: ['$traffic.rx', 0] }] }
                    }
                },
                { $sort: { totalTraffic: order } },
                { $skip: (page - 1) * limit },
                { $limit: limit }
            ];
            
            const usersAggregated = await HyUser.aggregate(pipeline);
            users = await HyUser.populate(usersAggregated, [
                { path: 'groups', select: 'name color' }
            ]);
        } else {
            // Обычная сортировка
            let sortField = {};
            switch (sortBy) {
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
            
            users = await HyUser.find(filter)
                .sort(sortField)
                .skip((page - 1) * limit)
                .limit(limit)
                .populate('groups', 'name color')
                .lean();
        }
        
        const [total, groups] = await Promise.all([
            HyUser.countDocuments(filter),
            getActiveGroups(),
        ]);
        
        render(res, 'users', {
            title: 'Пользователи',
            page: 'users',
            users,
            groups,
            pagination: {
                page: parseInt(page),
                limit,
                total,
                pages: Math.ceil(total / limit),
            },
            query: req.query,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// GET /panel/users/add - Форма создания пользователя
router.get('/users/add', requireAuth, async (req, res) => {
    const groups = await getActiveGroups();
    render(res, 'user-form', {
        title: 'Новый пользователь',
        page: 'users',
        groups,
    });
});

// POST /panel/users - Создание пользователя
router.post('/users', requireAuth, async (req, res) => {
    try {
        const { userId, username, trafficLimitGB, expireDays, enabled, maxDevices } = req.body;
        
        if (!userId) {
            return res.status(400).send('userId обязателен');
        }
        
        // Проверяем существование
        const existing = await HyUser.findOne({ userId });
        if (existing) {
            return res.status(409).send('Пользователь уже существует');
        }
        
        // Генерируем пароль
        const password = cryptoService.generatePassword(userId);
        
        // Группы (массив ID)
        let groups = [];
        if (req.body.groups) {
            groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.groups];
        }
        
        // Expire
        let expireAt = null;
        if (expireDays && parseInt(expireDays) > 0) {
            expireAt = new Date();
            expireAt.setDate(expireAt.getDate() + parseInt(expireDays));
        }
        
        // Traffic limit в байтах
        const trafficLimit = trafficLimitGB ? parseInt(trafficLimitGB) * 1024 * 1024 * 1024 : 0;
        
        // Max devices (0 = use group limit, -1 = unlimited)
        const userMaxDevices = parseInt(maxDevices) || 0;
        
        await HyUser.create({
            userId,
            username: username || '',
            password,
            groups,
            enabled: enabled === 'on',
            trafficLimit,
            maxDevices: userMaxDevices,
            expireAt,
            nodes: [], // Ноды автоматически по группам
        });
        
        res.redirect(`/panel/users/${userId}`);
    } catch (error) {
        res.status(500).send('Ошибка: ' + error.message);
    }
});

// GET /panel/users/:userId - Детали пользователя
router.get('/users/:userId', requireAuth, async (req, res) => {
    try {
        const [user, allGroups] = await Promise.all([
            HyUser.findOne({ userId: req.params.userId })
                .populate('nodes', 'name ip domain')
                .populate('groups', 'name color'),
            getActiveGroups(),
        ]);
        
        if (!user) {
            return res.redirect('/panel/users');
        }
        
        render(res, 'user-detail', {
            title: `Пользователь ${user.userId}`,
            page: 'users',
            user,
            allGroups,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// ==================== GROUPS ====================

// GET /panel/groups - Список групп
router.get('/groups', requireAuth, async (req, res) => {
    try {
        const groups = await ServerGroup.find().sort({ name: 1 });
        
        // Считаем количество нод и пользователей в каждой группе
        const groupsWithCounts = await Promise.all(groups.map(async (group) => {
            const [nodesCount, usersCount] = await Promise.all([
                HyNode.countDocuments({ groups: group._id }),
                HyUser.countDocuments({ groups: group._id }),
            ]);
            return {
                ...group.toObject(),
                nodesCount,
                usersCount,
            };
        }));
        
        render(res, 'groups', {
            title: 'Группы серверов',
            page: 'groups',
            groups: groupsWithCounts,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/groups - Создать группу
router.post('/groups', requireAuth, async (req, res) => {
    try {
        const { name, description, color, maxDevices, subscriptionTitle } = req.body;
        
        if (!name || !name.trim()) {
            return res.status(400).send('Название обязательно');
        }
        
        await ServerGroup.create({
            name: name.trim(),
            description: description || '',
            color: color || '#6366f1',
            maxDevices: parseInt(maxDevices) || 0,
            subscriptionTitle: subscriptionTitle?.trim() || '',
        });
        
        // Инвалидируем кэш групп
        await invalidateGroupsCache();
        
        res.redirect('/panel/groups');
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).send('Группа с таким названием уже существует');
        }
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/groups/:id - Обновить группу
router.post('/groups/:id', requireAuth, async (req, res) => {
    try {
        const { name, description, color, active, maxDevices, subscriptionTitle } = req.body;
        
        await ServerGroup.findByIdAndUpdate(req.params.id, {
            $set: {
                name: name?.trim() || '',
                description: description || '',
                color: color || '#6366f1',
                active: active === 'on',
                maxDevices: parseInt(maxDevices) || 0,
                subscriptionTitle: subscriptionTitle?.trim() || '',
            }
        });
        
        // Инвалидируем кэш групп
        await invalidateGroupsCache();
        
        res.redirect('/panel/groups');
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// POST /panel/groups/:id/delete - Удалить группу
router.post('/groups/:id/delete', requireAuth, async (req, res) => {
    try {
        // Удаляем группу из всех нод и пользователей
        await Promise.all([
            HyNode.updateMany({ groups: req.params.id }, { $pull: { groups: req.params.id } }),
            HyUser.updateMany({ groups: req.params.id }, { $pull: { groups: req.params.id } }),
            ServerGroup.findByIdAndDelete(req.params.id),
        ]);
        
        // Инвалидируем кэш групп
        await invalidateGroupsCache();
        
        res.redirect('/panel/groups');
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// ==================== SETTINGS ====================

// GET /panel/settings
router.get('/settings', requireAuth, async (req, res) => {
    const ssl = {
        enabled: !!config.PANEL_DOMAIN,
        domain: config.PANEL_DOMAIN || null,
    };
    
    // Получаем данные админа и настройки
    const [admin, settings] = await Promise.all([
        Admin.findOne({ username: req.session.adminUsername }),
        Settings.get(),
    ]);
    
    render(res, 'settings', {
        title: 'Настройки',
        page: 'settings',
        ssl,
        admin,
        settings,
        message: req.query.message || null,
        error: req.query.error || null,
    });
});

// POST /panel/settings - Сохранение настроек
router.post('/settings', requireAuth, async (req, res) => {
    try {
        const { reloadSettings } = require('../../index');
        
        const updates = {
            'loadBalancing.enabled': req.body['loadBalancing.enabled'] === 'on',
            'loadBalancing.hideOverloaded': req.body['loadBalancing.hideOverloaded'] === 'on',
            // Лимит устройств
            'deviceGracePeriod': parseInt(req.body['deviceGracePeriod']) || 15,
            // TTL кэша
            'cache.subscriptionTTL': parseInt(req.body['cache.subscriptionTTL']) || 3600,
            'cache.userTTL': parseInt(req.body['cache.userTTL']) || 900,
            'cache.onlineSessionsTTL': parseInt(req.body['cache.onlineSessionsTTL']) || 10,
            'cache.activeNodesTTL': parseInt(req.body['cache.activeNodesTTL']) || 30,
            // Rate limits
            'rateLimit.subscriptionPerMinute': parseInt(req.body['rateLimit.subscriptionPerMinute']) || 100,
        };
        
        await Settings.update(updates);
        
        // Сбрасываем кэш настроек и перезагружаем в память
        await invalidateSettingsCache();
        await reloadSettings();
        
        logger.info(`[Panel] Settings updated`);
        
        res.redirect('/panel/settings?message=' + encodeURIComponent('Настройки сохранены'));
    } catch (error) {
        logger.error('[Panel] Settings save error:', error.message);
        res.redirect('/panel/settings?error=' + encodeURIComponent('Ошибка: ' + error.message));
    }
});

// POST /panel/settings/password - Смена пароля
router.post('/settings/password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        
        // Валидация
        if (!currentPassword || !newPassword || !confirmPassword) {
            return res.redirect('/panel/settings?error=' + encodeURIComponent('Заполните все поля'));
        }
        
        if (newPassword.length < 6) {
            return res.redirect('/panel/settings?error=' + encodeURIComponent('Новый пароль должен быть минимум 6 символов'));
        }
        
        if (newPassword !== confirmPassword) {
            return res.redirect('/panel/settings?error=' + encodeURIComponent('Пароли не совпадают'));
        }
        
        // Проверяем текущий пароль
        const admin = await Admin.verifyPassword(req.session.adminUsername, currentPassword);
        if (!admin) {
            return res.redirect('/panel/settings?error=' + encodeURIComponent('Неверный текущий пароль'));
        }
        
        // Меняем пароль
        await Admin.changePassword(req.session.adminUsername, newPassword);
        
        logger.info(`[Panel] Password changed for: ${req.session.adminUsername}`);
        
        res.redirect('/panel/settings?message=' + encodeURIComponent('Пароль успешно изменён'));
    } catch (error) {
        logger.error('[Panel] Password change error:', error.message);
        res.redirect('/panel/settings?error=' + encodeURIComponent('Ошибка: ' + error.message));
    }
});

// POST /panel/settings/reset-traffic - Сброс счетчика трафика для всех пользователей
router.post('/settings/reset-traffic', requireAuth, async (req, res) => {
    try {
        // Сбрасываем трафик у всех пользователей
        const result = await HyUser.updateMany(
            {},
            {
                $set: {
                    'traffic.tx': 0,
                    'traffic.rx': 0,
                    'traffic.lastUpdate': new Date()
                }
            }
        );
        
        logger.warn(`[Panel] Traffic reset for ${result.modifiedCount} users by admin: ${req.session.adminUsername}`);
        
        // Инвалидируем кэш всех пользователей
        const users = await HyUser.find({}).select('userId subscriptionToken').lean();
        for (const user of users) {
            await cache.invalidateUser(user.userId);
            if (user.subscriptionToken) {
                await cache.invalidateSubscription(user.subscriptionToken);
            }
        }
        
        // Инвалидируем статистику
        await cache.invalidateDashboardCounts();
        await cache.invalidateTrafficStats();
        
        res.json({ 
            success: true, 
            count: result.modifiedCount,
            message: `Трафик сброшен у ${result.modifiedCount} пользователей`
        });
    } catch (error) {
        logger.error('[Panel] Traffic reset error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /panel/settings/flush-cache - Flush all Redis cache
router.post('/settings/flush-cache', requireAuth, async (req, res) => {
    try {
        const result = await cache.flushAll();
        
        if (result.success) {
            logger.info(`[Panel] Cache flushed by admin: ${req.session.adminUsername}`);
            res.json({ success: true, message: 'Cache cleared' });
        } else {
            res.status(500).json({ success: false, error: result.error || 'Failed to flush cache' });
        }
    } catch (error) {
        logger.error('[Panel] Cache flush error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /panel/nodes/:id/restart - Перезапуск Hysteria на ноде
router.post('/nodes/:id/restart', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).json({ error: 'SSH данные не настроены' });
        }
        
        const conn = await nodeSetup.connectSSH(node);
        const result = await nodeSetup.execSSH(conn, 'systemctl restart hysteria-server && sleep 2 && systemctl is-active hysteria-server');
        conn.end();
        
        const isActive = result.output.trim().includes('active');
        
        await HyNode.findByIdAndUpdate(req.params.id, { 
            $set: { status: isActive ? 'online' : 'error', lastSync: new Date() } 
        });
        
        res.json({ success: isActive, output: result.output });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/system-stats - Статистика системы панели
router.get('/system-stats', requireAuth, async (req, res) => {
    try {
        const cpus = os.cpus();
        const loadAvg = os.loadavg();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const processMemory = process.memoryUsage();
        
        // CPU в процентах - используем load average (мгновенно, без задержек!)
        // load1 / cores * 100 = примерный % загрузки
        const cpuPercent = Math.min(Math.round((loadAvg[0] / cpus.length) * 100), 100);
        
        // RPS/RPM из счетчиков (O(1) операция!)
        const requestStats = rpsCounter.getStats();
        const rps = requestStats.rps;
        const rpm = requestStats.rpm;
        
        // Cache stats (Redis быстрый)
        const cacheStats = await cache.getStats();
        
        // Active connections - берем из кеша dashboard (уже есть!)
        let totalConnections = 0;
        const dashboardCounts = await cache.getDashboardCounts();
        if (dashboardCounts) {
            // Если есть кеш - берем оттуда
            const nodes = await HyNode.find({ active: true }).select('onlineUsers').lean();
            totalConnections = nodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);
        } else {
            // Если нет - быстрый подсчет без aggregate
            const nodes = await HyNode.find({ active: true }).select('onlineUsers').lean();
            totalConnections = nodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);
        }
        
        res.json({
            success: true,
            cpu: {
                cores: cpus.length,
                model: cpus[0]?.model || 'Unknown',
                percent: cpuPercent, // ← NEW!
                load1: loadAvg[0],
                load5: loadAvg[1],
                load15: loadAvg[2],
            },
            mem: {
                total: totalMem,
                used: usedMem,
                free: freeMem,
                percent: Math.round((usedMem / totalMem) * 100),
            },
            process: {
                heapUsed: processMemory.heapUsed,
                heapTotal: processMemory.heapTotal,
                rss: processMemory.rss,
            },
            requests: {
                rps: rps,           // ← NEW!
                rpm: rpm,           // ← NEW!
            },
            connections: totalConnections, // ← NEW!
            cache: cacheStats,              // ← NEW!
            uptime: Math.floor(process.uptime()),
            platform: os.platform(),
            nodeVersion: process.version,
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/logs - Последние логи приложения
router.get('/logs', requireAuth, async (req, res) => {
    try {
        const logsDir = path.join(__dirname, '../../logs');
        let logs = [];
        
        // Winston с maxFiles создаёт файлы combined1.log, combined2.log и т.д.
        // Ищем все combined*.log файлы
        if (fs.existsSync(logsDir)) {
            const files = fs.readdirSync(logsDir)
                .filter(f => f.startsWith('combined') && f.endsWith('.log'))
                .map(f => ({
                    name: f,
                    path: path.join(logsDir, f),
                    mtime: fs.statSync(path.join(logsDir, f)).mtime
                }))
                .sort((a, b) => b.mtime - a.mtime); // Сортируем по времени изменения
            
            // Берём самый свежий файл
            if (files.length > 0) {
                const latestFile = files[0].path;
                const content = fs.readFileSync(latestFile, 'utf8');
                // Берём последние 100 строк, новые сверху
                logs = content.split('\n').filter(Boolean).slice(-100).reverse();
            }
        }
        
        res.json({ logs });
    } catch (error) {
        logger.error(`[Panel] Logs read error: ${error.message}`);
        res.json({ logs: [], error: error.message });
    }
});

// POST /panel/backup - Backup MongoDB и скачать
router.post('/backup', requireAuth, async (req, res) => {
    try {
        const backupDir = path.join(__dirname, '../../backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `hysteria-backup-${timestamp}`;
        const backupPath = path.join(backupDir, backupName);
        const archivePath = path.join(backupDir, `${backupName}.tar.gz`);
        
        // mongodump
        const mongoUri = config.MONGO_URI;
        const dumpCmd = `mongodump --uri="${mongoUri}" --out="${backupPath}" --gzip`;
        
        await execAsync(dumpCmd);
        logger.info(`[Backup] Dump created: ${backupPath}`);
        
        // Создаём tar.gz архив
        const tarCmd = `cd "${backupDir}" && tar -czf "${backupName}.tar.gz" "${backupName}" && rm -rf "${backupName}"`;
        await execAsync(tarCmd);
        logger.info(`[Backup] Archive created: ${archivePath}`);
        
        // Отдаём файл на скачивание
        res.download(archivePath, `${backupName}.tar.gz`, (err) => {
            // Удаляем файл после скачивания (опционально, можно оставить)
            // fs.unlinkSync(archivePath);
            if (err) {
                logger.error(`[Backup] Send error: ${err.message}`);
            }
        });
    } catch (error) {
        logger.error(`[Backup] Error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/restore - Восстановление из backup
router.post('/restore', requireAuth, backupUpload.single('backup'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл backup не загружен' });
    }
    
    const uploadedFile = req.file.path;
    const extractDir = path.join('/tmp', `restore-${Date.now()}`);
    
    try {
        // Создаём директорию для распаковки
        fs.mkdirSync(extractDir, { recursive: true });
        
        // Распаковываем архив
        await execAsync(`tar -xzf "${uploadedFile}" -C "${extractDir}"`);
        logger.info(`[Restore] Archive extracted to ${extractDir}`);
        
        // Ищем папку с дампом (может быть вложенность hysteria-backup-xxx/hysteria/)
        const findDumpPath = (dir) => {
            const items = fs.readdirSync(dir);
            
            // Если есть папка hysteria - это и есть дамп базы
            if (items.includes('hysteria') && fs.statSync(path.join(dir, 'hysteria')).isDirectory()) {
                return dir;
            }
            
            // Если одна папка - ищем внутри
            if (items.length === 1 && fs.statSync(path.join(dir, items[0])).isDirectory()) {
                return findDumpPath(path.join(dir, items[0]));
            }
            
            return dir;
        };
        
        const dumpPath = findDumpPath(extractDir);
        logger.info(`[Restore] Dump path: ${dumpPath}`);
        
        // Проверяем что там есть папка hysteria
        const dumpContents = fs.readdirSync(dumpPath);
        logger.info(`[Restore] Dump contents: ${dumpContents.join(', ')}`);
        
        // mongorestore - указываем путь к папке базы данных
        const mongoUri = config.MONGO_URI;
        const hysteriaDir = path.join(dumpPath, 'hysteria');
        const restoreCmd = `mongorestore --uri="${mongoUri}" --drop --gzip --db=hysteria "${hysteriaDir}"`;
        
        logger.info(`[Restore] DB folder: ${hysteriaDir}`);
        logger.info(`[Restore] Command: ${restoreCmd.replace(mongoUri, 'MONGO_URI')}`);
        
        const { stdout, stderr } = await execAsync(restoreCmd);
        if (stdout) logger.info(`[Restore] stdout: ${stdout}`);
        if (stderr) logger.info(`[Restore] stderr: ${stderr}`);
        
        logger.info(`[Restore] Database restored successfully`);
        
        // Удаляем временные файлы
        fs.unlinkSync(uploadedFile);
        await execAsync(`rm -rf "${extractDir}"`);
        
        res.json({ success: true, message: 'База данных успешно восстановлена' });
    } catch (error) {
        logger.error(`[Restore] Error: ${error.message}`);
        if (error.stdout) logger.error(`[Restore] stdout: ${error.stdout}`);
        if (error.stderr) logger.error(`[Restore] stderr: ${error.stderr}`);
        
        // Очищаем временные файлы
        try {
            if (fs.existsSync(uploadedFile)) fs.unlinkSync(uploadedFile);
            await execAsync(`rm -rf "${extractDir}"`);
        } catch (e) {}
        
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/nodes/:id/terminal - SSH терминал
router.get('/nodes/:id/terminal', requireAuth, async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.redirect('/panel/nodes');
        }
        
        if (!node.ssh?.password && !node.ssh?.privateKey) {
            return res.status(400).send('SSH данные не настроены для этой ноды');
        }
        
        res.render('terminal', { node });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// ==================== STATS ====================

// GET /panel/stats - Страница статистики
router.get('/stats', requireAuth, async (req, res) => {
    try {
        const summary = await statsService.getSummary();
        
        render(res, 'stats', {
            title: 'Статистика',
            page: 'stats',
            summary,
        });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// GET /panel/stats/api/summary - Сводная статистика
router.get('/stats/api/summary', requireAuth, async (req, res) => {
    try {
        const summary = await statsService.getSummary();
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/online - Данные для графика онлайна
router.get('/stats/api/online', requireAuth, async (req, res) => {
    try {
        const period = req.query.period || '24h';
        const data = await statsService.getOnlineChart(period);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/traffic - Данные для графика трафика
router.get('/stats/api/traffic', requireAuth, async (req, res) => {
    try {
        const period = req.query.period || '24h';
        const data = await statsService.getTrafficChart(period);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /panel/stats/api/nodes - Данные для графика нод
router.get('/stats/api/nodes', requireAuth, async (req, res) => {
    try {
        const period = req.query.period || '24h';
        const data = await statsService.getNodesChart(period);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/stats/cleanup - Очистка старых данных (ручной запуск)
router.post('/stats/cleanup', requireAuth, async (req, res) => {
    try {
        const result = await statsService.cleanup();
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;

