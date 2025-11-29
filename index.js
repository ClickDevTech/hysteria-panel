/**
 * C³ CELERITY - Management panel for Hysteria 2 nodes
 * by Click Connect
 * 
 * Включает:
 * - REST API для интеграции
 * - HTTP Auth для нод
 * - Веб-панель управления (SSR)
 * - Автоматический SSL сертификат (Let's Encrypt)
 */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const cron = require('node-cron');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const config = require('./config');
const logger = require('./src/utils/logger');
const requireAuth = require('./src/middleware/auth');
const { i18nMiddleware } = require('./src/middleware/i18n');
const syncService = require('./src/services/syncService');
const cacheService = require('./src/services/cacheService');

// Роуты API
const usersRoutes = require('./src/routes/users');
const nodesRoutes = require('./src/routes/nodes');
const subscriptionRoutes = require('./src/routes/subscription');
const authRoutes = require('./src/routes/auth');
const panelRoutes = require('./src/routes/panel');

const app = express();

// Trust proxy (Caddy) - 1 уровень прокси
app.set('trust proxy', 1);

// ==================== MIDDLEWARE ====================

// Compression (gzip/brotli) для всех ответов
app.use(compression({
    filter: (req, res) => {
        // Не сжимаем если клиент не хочет
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    },
    level: 6, // Баланс между скоростью и степенью сжатия
}));

// CORS: ограничиваем только на свой домен
app.use(cors({
    origin: config.BASE_URL,
    credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Сессии для панели (Redis store + secure cookies для HTTPS)
// RedisStore инициализируется после подключения к Redis в startServer()
let sessionMiddleware = null;

function initSessionMiddleware() {
    sessionMiddleware = session({
        store: new RedisStore({ 
            client: cacheService.redis,
            prefix: 'sess:',
        }),
        secret: config.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { 
            secure: true,
            maxAge: 24 * 60 * 60 * 1000 // 24 часа
        }
    });
}

// Middleware-обёртка для отложенной инициализации сессий
app.use((req, res, next) => {
    if (sessionMiddleware) {
        return sessionMiddleware(req, res, next);
    }
    // Fallback если Redis ещё не подключен
    next();
});

// Интернационализация (i18n)
app.use(i18nMiddleware);

// Статика
app.use(express.static(path.join(__dirname, 'public')));

// EJS шаблоны
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Логирование запросов (debug уровень, кроме статики и частых API)
app.use((req, res, next) => {
    // Пропускаем статику и высокочастотные эндпоинты
    const skipPaths = ['/css', '/js', '/api/auth', '/api/files', '/health'];
    const shouldSkip = skipPaths.some(p => req.path.startsWith(p));
    
    if (!shouldSkip) {
        logger.debug(`${req.method} ${req.path}`);
    }
    next();
});

// ==================== HEALTH CHECK ====================

app.get('/health', async (req, res) => {
    const cacheStats = await cacheService.getStats();
    
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        lastSync: syncService.lastSyncTime,
        isSyncing: syncService.isSyncing,
        cache: cacheStats,
    });
});

// ==================== API ROUTES ====================

// HTTP Auth для Hysteria нод (без авторизации панели)
app.use('/api/auth', authRoutes);

// API логин/логаут
const Admin = require('./src/models/adminModel');
const rateLimit = require('express-rate-limit');

const apiLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Слишком много попыток. Попробуйте через 15 минут.' },
});

app.post('/api/login', apiLoginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Укажите username и password' });
        }
        
        const admin = await Admin.verifyPassword(username, password);
        
        if (!admin) {
            logger.warn(`[API] Неудачный вход: ${username} (IP: ${req.ip})`);
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }
        
        req.session.authenticated = true;
        req.session.adminUsername = admin.username;
        
        logger.info(`[API] Успешный вход: ${admin.username} (IP: ${req.ip})`);
        
        res.json({ 
            success: true, 
            username: admin.username,
            message: 'Авторизация успешна. Используйте cookies для последующих запросов.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/logout', (req, res) => {
    const username = req.session?.adminUsername;
    req.session.destroy();
    if (username) {
        logger.info(`[API] Выход: ${username}`);
    }
    res.json({ success: true });
});

// Глобальные настройки rate limit (обновляются при старте и изменении настроек)
const rateLimitSettings = {
    subscriptionPerMinute: 100,
    authPerSecond: 200,
};

// Rate limiter для подписок (защита от перебора токенов)
const subscriptionLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 минута
    max: () => rateLimitSettings.subscriptionPerMinute,
    handler: (req, res) => {
        logger.warn(`[Sub] Rate limit: ${req.ip}`);
        res.status(429).type('text/plain').send('# Too many requests');
    },
});

// Функция обновления настроек (экспортируется для panel.js)
async function reloadSettings() {
    const Settings = require('./src/models/settingsModel');
    const settings = await Settings.get();
    
    // Обновляем TTL кэша
    cacheService.updateTTL(settings);
    
    // Обновляем rate limits
    if (settings.rateLimit) {
        rateLimitSettings.subscriptionPerMinute = settings.rateLimit.subscriptionPerMinute || 100;
        rateLimitSettings.authPerSecond = settings.rateLimit.authPerSecond || 200;
        logger.info(`[Settings] Rate limits: sub=${rateLimitSettings.subscriptionPerMinute}/min`);
    }
}
module.exports = { reloadSettings };

// Подписки - единый роут /api/files/:token (с rate limit)
app.use('/api/files', subscriptionLimiter);
app.use('/api/info', subscriptionLimiter);
app.use('/api', subscriptionRoutes);

// API роуты (с авторизацией через сессию)
app.use('/api/users', requireAuth, usersRoutes);
app.use('/api/nodes', requireAuth, nodesRoutes);

// Группы API
app.get('/api/groups', requireAuth, async (req, res) => {
    try {
        const { getActiveGroups } = require('./src/utils/helpers');
        const groups = await getActiveGroups();
        // Возвращаем только нужные поля
        res.json(groups.map(g => ({ _id: g._id, name: g.name })));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Статистика
app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        const HyUser = require('./src/models/hyUserModel');
        const HyNode = require('./src/models/hyNodeModel');
        
        const [usersTotal, usersEnabled, nodesTotal, nodesOnline] = await Promise.all([
            HyUser.countDocuments(),
            HyUser.countDocuments({ enabled: true }),
            HyNode.countDocuments(),
            HyNode.countDocuments({ status: 'online' }),
        ]);
        
        const nodes = await HyNode.find({ active: true }).select('name onlineUsers');
        const totalOnline = nodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);
        
        res.json({
            users: { total: usersTotal, enabled: usersEnabled },
            nodes: { total: nodesTotal, online: nodesOnline },
            onlineUsers: totalOnline,
            nodesList: nodes.map(n => ({ name: n.name, online: n.onlineUsers })),
            lastSync: syncService.lastSyncTime,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ручной запуск синхронизации
app.post('/api/sync', requireAuth, async (req, res) => {
    if (syncService.isSyncing) {
        return res.status(409).json({ error: 'Синхронизация уже запущена' });
    }
    
    syncService.syncAllNodes().catch(err => {
        logger.error(`[API] Ошибка синхронизации: ${err.message}`);
    });
    
    res.json({ message: 'Синхронизация запущена' });
});

// Кик пользователя
app.post('/api/kick/:userId', requireAuth, async (req, res) => {
    try {
        await syncService.kickUser(req.params.userId);
        // Очищаем устройства пользователя из кэша
        await cacheService.clearDeviceIPs(req.params.userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== WEB PANEL ====================

app.use('/panel', panelRoutes);

// Редирект с корня на панель
app.get('/', (req, res) => {
    res.redirect('/panel');
});

// ==================== ERROR HANDLING ====================

// 404
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        res.status(404).json({ error: 'Not Found' });
    } else {
        res.status(404).send('404 - Not Found');
    }
});

// Error handler
app.use((err, req, res, next) => {
    logger.error(`[Error] ${err.message}`);
    if (req.path.startsWith('/api')) {
        res.status(500).json({ error: err.message });
    } else {
        res.status(500).send('Internal Server Error');
    }
});

// ==================== START SERVER ====================

async function startServer() {
    try {
        // Подключение к MongoDB с оптимизированным пулом соединений
        await mongoose.connect(config.MONGO_URI, {
            maxPoolSize: 10,              // Максимум соединений в пуле
            minPoolSize: 2,               // Минимум соединений
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        logger.info('✅ Подключено к MongoDB');
        
        // Подключение к Redis
        await cacheService.connect();
        
        // Инициализируем Redis session store после подключения к Redis
        initSessionMiddleware();
        logger.info('✅ Redis session store инициализирован');
        
        // Загрузка настроек (TTL кэша, rate limits)
        await reloadSettings();
        
        const PORT = process.env.PORT || 3000;
        const useCaddy = process.env.USE_CADDY === 'true';
        
        if (useCaddy) {
            // За Caddy reverse proxy — просто HTTP сервер
            const http = require('http');
            const server = http.createServer(app);
            
            // WebSocket для SSH терминала
            setupWebSocketServer(server);
            
            server.listen(PORT, () => {
                logger.info(`✅ HTTP сервер на порту ${PORT} (за Caddy)`);
                logger.info(`🌐 Панель: https://${config.PANEL_DOMAIN}/panel`);
            });
        } else {
            // Standalone с Greenlock (для локальной разработки)
        logger.info(`🔒 Запуск HTTPS сервера для ${config.PANEL_DOMAIN}`);
        
        const Greenlock = require('@root/greenlock-express');
            const greenlockDir = path.join(__dirname, 'greenlock.d');
            
            // Создаём папки для сертификатов если их нет
            const livePath = path.join(greenlockDir, 'live', config.PANEL_DOMAIN);
            if (!fs.existsSync(livePath)) {
                fs.mkdirSync(livePath, { recursive: true });
            }
            
            const configPath = path.join(greenlockDir, 'config.json');
        try {
            const glConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const siteExists = glConfig.sites.some(s => s.subject === config.PANEL_DOMAIN);
            
            if (!siteExists) {
                glConfig.sites.push({
                    subject: config.PANEL_DOMAIN,
                    altnames: [config.PANEL_DOMAIN],
                });
            }
            glConfig.defaults.subscriberEmail = config.ACME_EMAIL;
                glConfig.defaults.store = {
                    module: 'greenlock-store-fs',
                    basePath: greenlockDir,
                };
            fs.writeFileSync(configPath, JSON.stringify(glConfig, null, 2));
        } catch (err) {
                logger.warn(`⚠️ Greenlock config: ${err.message}`);
        }
        
            const glInstance = Greenlock.init({
            packageRoot: __dirname,
                configDir: greenlockDir,
            maintainerEmail: config.ACME_EMAIL,
            cluster: false,
                staging: false,
            });
            
            glInstance.ready((glx) => {
            const httpServer = glx.httpServer();
            httpServer.listen(80, () => {
                    logger.info('✅ HTTP сервер на порту 80');
            });
            
            const httpsServer = glx.httpsServer(null, app);
            setupWebSocketServer(httpsServer);
            
            httpsServer.listen(443, () => {
                logger.info('✅ HTTPS сервер на порту 443');
                logger.info(`🌐 Панель: https://${config.PANEL_DOMAIN}/panel`);
            });
        });
        }
        
        // Cron задачи
        setupCronJobs();
        
    } catch (err) {
        logger.error(`❌ Ошибка запуска: ${err.message}`);
        process.exit(1);
    }
}

function setupWebSocketServer(server) {
    const wss = new WebSocketServer({ noServer: true });
    const sshTerminal = require('./src/services/sshTerminal');
    const HyNode = require('./src/models/hyNodeModel');
    const crypto = require('crypto');
    const cookie = require('cookie');
    
    server.on('upgrade', (request, socket, head) => {
        const pathname = request.url;
        
        if (pathname && pathname.startsWith('/ws/terminal/')) {
            // Проверяем сессию через cookie
            const cookies = cookie.parse(request.headers.cookie || '');
            const sessionId = cookies['connect.sid'];
            
            if (!sessionId) {
                logger.warn(`[WS] Попытка подключения без сессии: ${request.socket.remoteAddress}`);
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
            
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    });
    
    wss.on('connection', async (ws, req) => {
        const urlParts = req.url.split('/');
        const nodeId = urlParts[urlParts.length - 1];
        const sessionId = crypto.randomUUID();
        
        logger.info(`[WS] SSH терминал для ноды ${nodeId}`);
        
        try {
            const node = await HyNode.findById(nodeId);
            
            if (!node) {
                ws.send(JSON.stringify({ type: 'error', message: 'Нода не найдена' }));
                ws.close();
                return;
            }
            
            if (!node.ssh?.password && !node.ssh?.privateKey) {
                ws.send(JSON.stringify({ type: 'error', message: 'SSH данные не настроены' }));
                ws.close();
                return;
            }
            
            await sshTerminal.createSession(sessionId, node, ws);
            ws.send(JSON.stringify({ type: 'connected', sessionId }));
            
            ws.on('message', (message) => {
                try {
                    const msg = JSON.parse(message.toString());
                    
                    switch (msg.type) {
                        case 'input':
                            sshTerminal.write(sessionId, msg.data);
                            break;
                        case 'resize':
                            sshTerminal.resize(sessionId, msg.cols, msg.rows);
                            break;
                    }
                } catch (err) {
                    logger.error(`[WS] Ошибка: ${err.message}`);
                }
            });
            
            ws.on('close', () => {
                logger.info(`[WS] Закрыто соединение для ноды ${nodeId}`);
                sshTerminal.closeSession(sessionId);
            });
            
        } catch (error) {
            logger.error(`[WS] Ошибка терминала: ${error.message}`);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
            ws.close();
        }
    });
    
    logger.info('[WS] SSH терминал инициализирован');
}

function setupCronJobs() {
    // Сбор статистики каждые 5 минут
    cron.schedule('*/5 * * * *', async () => {
        logger.debug('[Cron] Сбор статистики');
        await syncService.collectAllStats();
    });
    
    // Health check нод каждую минуту
    cron.schedule('* * * * *', async () => {
        await syncService.healthCheck();
    });
    
    // Очистка старых логов каждый день в 3:00
    cron.schedule('0 3 * * *', () => {
        logger.info('[Cron] Очистка старых логов');
        cleanOldLogs(30); // Удаляем логи старше 30 дней
    });
    
    // Первоначальный health check через 5 секунд
    setTimeout(async () => {
        logger.info('[Startup] Проверка статуса нод');
        await syncService.healthCheck();
    }, 5000);
}

/**
 * Очистка логов старше N дней
 */
function cleanOldLogs(days) {
    try {
        const logsDir = path.join(__dirname, 'logs');
        
        if (!fs.existsSync(logsDir)) {
            return;
        }
        
        const files = fs.readdirSync(logsDir);
        const now = Date.now();
        const maxAge = days * 24 * 60 * 60 * 1000;
        
        // Список активных файлов Winston (не трогаем)
        const activeFiles = ['error.log', 'combined.log'];
        for (let i = 1; i <= 5; i++) {
            activeFiles.push(`combined${i}.log`);
        }
        
        let deleted = 0;
        
        files.forEach(file => {
            // Пропускаем активные файлы Winston
            if (activeFiles.includes(file)) {
                return;
            }
            
            // Проверяем возраст файла
            const filePath = path.join(logsDir, file);
            const stats = fs.statSync(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                fs.unlinkSync(filePath);
                deleted++;
                logger.info(`[Cleanup] Удалён старый лог: ${file}`);
            }
        });
        
        if (deleted > 0) {
            logger.info(`[Cleanup] Очищено ${deleted} старых файлов логов`);
        }
    } catch (err) {
        logger.error(`[Cleanup] Ошибка очистки логов: ${err.message}`);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('Завершение работы...');
    await mongoose.disconnect();
    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('Завершение работы...');
    await mongoose.disconnect();
    process.exit(0);
});

// Запуск
startServer();
