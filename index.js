/**
 * Hysteria Backend - управление Hysteria 2 нодами и пользователями
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
const cron = require('node-cron');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const config = require('./config');
const logger = require('./src/utils/logger');
const requireAuth = require('./src/middleware/auth');
const { i18nMiddleware } = require('./src/middleware/i18n');
const syncService = require('./src/services/syncService');

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

// CORS: ограничиваем только на свой домен
app.use(cors({
    origin: config.BASE_URL,
    credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Сессии для панели (secure cookies для HTTPS)
app.use(session({
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 часа
    }
}));

// Интернационализация (i18n)
app.use(i18nMiddleware);

// Статика
app.use(express.static(path.join(__dirname, 'public')));

// EJS шаблоны
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Логирование запросов (кроме статики)
app.use((req, res, next) => {
    if (!req.path.startsWith('/css') && !req.path.startsWith('/js')) {
        logger.info(`${req.method} ${req.path}`);
    }
    next();
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        lastSync: syncService.lastSyncTime,
        isSyncing: syncService.isSyncing,
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

// Подписки - единый роут /api/files/:token
app.use('/api', subscriptionRoutes);

// API роуты (с авторизацией через сессию)
app.use('/api/users', requireAuth, usersRoutes);
app.use('/api/nodes', requireAuth, nodesRoutes);

// Группы API
app.get('/api/groups', requireAuth, async (req, res) => {
    try {
        const ServerGroup = require('./src/models/serverGroupModel');
        const groups = await ServerGroup.find({ active: true }).select('_id name').sort({ name: 1 });
        res.json(groups);
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
        // Подключение к MongoDB
        await mongoose.connect(config.MONGO_URI);
        logger.info('✅ Подключено к MongoDB');
        
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
    
    // Первоначальный health check через 5 секунд
    setTimeout(async () => {
        logger.info('[Startup] Проверка статуса нод');
        await syncService.healthCheck();
    }, 5000);
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
