/**
 * C³ CELERITY - Management panel for Hysteria 2 nodes
 * by Click Connect
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
const { countRequest } = require('./src/middleware/rpsCounter');
const syncService = require('./src/services/syncService');
const cacheService = require('./src/services/cacheService');
const statsService = require('./src/services/statsService');

const usersRoutes = require('./src/routes/users');
const nodesRoutes = require('./src/routes/nodes');
const subscriptionRoutes = require('./src/routes/subscription');
const authRoutes = require('./src/routes/auth');
const panelRoutes = require('./src/routes/panel');

const app = express();

app.set('trust proxy', 1);

// ==================== MIDDLEWARE ====================

app.use(compression({
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    },
    level: 6,
}));

app.use(cors({
    origin: config.BASE_URL,
    credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
            maxAge: 24 * 60 * 60 * 1000
        }
    });
}

app.use((req, res, next) => {
    if (sessionMiddleware) {
        return sessionMiddleware(req, res, next);
    }
    next();
});

app.use(i18nMiddleware);
app.use(countRequest);
app.use(express.static(path.join(__dirname, 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
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

app.use('/api/auth', authRoutes);

const Admin = require('./src/models/adminModel');
const rateLimit = require('express-rate-limit');

const apiLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

app.post('/api/login', apiLoginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        
        const admin = await Admin.verifyPassword(username, password);
        
        if (!admin) {
            logger.warn(`[API] Failed login: ${username} (IP: ${req.ip})`);
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        
        req.session.authenticated = true;
        req.session.adminUsername = admin.username;
        
        logger.info(`[API] Login: ${admin.username} (IP: ${req.ip})`);
        
        res.json({ 
            success: true, 
            username: admin.username,
            message: 'Authentication successful. Use cookies for subsequent requests.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/logout', (req, res) => {
    const username = req.session?.adminUsername;
    req.session.destroy();
    if (username) {
        logger.info(`[API] Logout: ${username}`);
    }
    res.json({ success: true });
});

const rateLimitSettings = {
    subscriptionPerMinute: 100,
    authPerSecond: 200,
};

const subscriptionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: () => rateLimitSettings.subscriptionPerMinute,
    handler: (req, res) => {
        logger.warn(`[Sub] Rate limit: ${req.ip}`);
        res.status(429).type('text/plain').send('# Too many requests');
    },
});

async function reloadSettings() {
    const Settings = require('./src/models/settingsModel');
    const settings = await Settings.get();
    
    cacheService.updateTTL(settings);
    
    if (settings.rateLimit) {
        rateLimitSettings.subscriptionPerMinute = settings.rateLimit.subscriptionPerMinute || 100;
        rateLimitSettings.authPerSecond = settings.rateLimit.authPerSecond || 200;
        logger.info(`[Settings] Rate limits: sub=${rateLimitSettings.subscriptionPerMinute}/min`);
    }
}
module.exports = { reloadSettings };

app.use('/api/files', subscriptionLimiter);
app.use('/api/info', subscriptionLimiter);
app.use('/api', subscriptionRoutes);

app.use('/api/users', requireAuth, usersRoutes);
app.use('/api/nodes', requireAuth, nodesRoutes);

app.get('/api/groups', requireAuth, async (req, res) => {
    try {
        const { getActiveGroups } = require('./src/utils/helpers');
        const groups = await getActiveGroups();
        res.json(groups.map(g => ({ _id: g._id, name: g.name })));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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

app.post('/api/sync', requireAuth, async (req, res) => {
    if (syncService.isSyncing) {
        return res.status(409).json({ error: 'Sync already in progress' });
    }
    
    syncService.syncAllNodes().catch(err => {
        logger.error(`[API] Sync error: ${err.message}`);
    });
    
    res.json({ message: 'Sync started' });
});

app.post('/api/kick/:userId', requireAuth, async (req, res) => {
    try {
        await syncService.kickUser(req.params.userId);
        await cacheService.clearDeviceIPs(req.params.userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== WEB PANEL ====================

app.use('/panel', panelRoutes);

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
        await mongoose.connect(config.MONGO_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        logger.info('[MongoDB] Connected');
        
        await cacheService.connect();
        
        initSessionMiddleware();
        logger.info('[Redis] Session store initialized');
        
        await reloadSettings();
        
        const PORT = process.env.PORT || 3000;
        const useCaddy = process.env.USE_CADDY === 'true';
        
        if (useCaddy) {
            const http = require('http');
            const server = http.createServer(app);
            
            setupWebSocketServer(server);
            
            server.listen(PORT, () => {
                logger.info(`[Server] HTTP listening on port ${PORT} (behind Caddy)`);
                logger.info(`[Server] Panel: https://${config.PANEL_DOMAIN}/panel`);
            });
        } else {
            // Standalone with Greenlock (for local development)
        logger.info(`[Server] Starting HTTPS for ${config.PANEL_DOMAIN}`);
        
        const Greenlock = require('@root/greenlock-express');
            const greenlockDir = path.join(__dirname, 'greenlock.d');
            
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
                logger.warn(`[Greenlock] Config error: ${err.message}`);
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
                    logger.info('[Server] HTTP listening on port 80');
            });
            
            const httpsServer = glx.httpsServer(null, app);
            setupWebSocketServer(httpsServer);
            
            httpsServer.listen(443, () => {
                logger.info('[Server] HTTPS listening on port 443');
                logger.info(`[Server] Panel: https://${config.PANEL_DOMAIN}/panel`);
            });
        });
        }
        
            // Cron jobs
        setupCronJobs();
        
    } catch (err) {
        logger.error(`[Server] Startup failed: ${err.message}`);
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
            const cookies = cookie.parse(request.headers.cookie || '');
            const sessionId = cookies['connect.sid'];
            
            if (!sessionId) {
                logger.warn(`[WS] Connection attempt without session: ${request.socket.remoteAddress}`);
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
        
        logger.info(`[WS] SSH terminal for node ${nodeId}`);
        
        try {
            const node = await HyNode.findById(nodeId);
            
            if (!node) {
                ws.send(JSON.stringify({ type: 'error', message: 'Node not found' }));
                ws.close();
                return;
            }
            
            if (!node.ssh?.password && !node.ssh?.privateKey) {
                ws.send(JSON.stringify({ type: 'error', message: 'SSH credentials not configured' }));
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
                    logger.error(`[WS] Error: ${err.message}`);
                }
            });
            
            ws.on('close', () => {
                logger.info(`[WS] Connection closed for node ${nodeId}`);
                sshTerminal.closeSession(sessionId);
            });
            
        } catch (error) {
            logger.error(`[WS] Terminal error: ${error.message}`);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
            ws.close();
        }
    });
    
    logger.info('[WS] SSH terminal initialized');
}

function setupCronJobs() {
    // Collect stats every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
        logger.debug('[Cron] Collecting stats');
        await syncService.collectAllStats();
        
        // Save stats snapshot for charts
        await statsService.saveHourlySnapshot();
    });
    
    // Health check every minute
    cron.schedule('* * * * *', async () => {
        await syncService.healthCheck();
    });
    
    // Save daily snapshot every hour
    cron.schedule('0 * * * *', async () => {
        logger.debug('[Cron] Saving daily stats snapshot');
        await statsService.saveDailySnapshot();
    });
    
    // Save monthly snapshot and cleanup at 00:05
    cron.schedule('5 0 * * *', async () => {
        logger.info('[Cron] Saving monthly stats snapshot');
        await statsService.saveMonthlySnapshot();
        await statsService.cleanup();
    });
    
    // Clean old logs daily at 3:00
    cron.schedule('0 3 * * *', () => {
        logger.info('[Cron] Cleaning old logs');
        cleanOldLogs(30);
    });
    
    // Initial health check and stats snapshot after 5 seconds
    setTimeout(async () => {
        logger.info('[Startup] Checking nodes status');
        await syncService.healthCheck();
        
        // Initial stats snapshot
        await statsService.saveHourlySnapshot();
        logger.info('[Startup] Initial stats snapshot saved');
    }, 5000);
}

/**
 * Clean logs older than N days
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
        
        // Active Winston files (skip)
        const activeFiles = ['error.log', 'combined.log'];
        for (let i = 1; i <= 5; i++) {
            activeFiles.push(`combined${i}.log`);
        }
        
        let deleted = 0;
        
        files.forEach(file => {
            if (activeFiles.includes(file)) {
                return;
            }
            
            const filePath = path.join(logsDir, file);
            const stats = fs.statSync(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                fs.unlinkSync(filePath);
                deleted++;
                logger.info(`[Cleanup] Deleted old log: ${file}`);
            }
        });
        
        if (deleted > 0) {
            logger.info(`[Cleanup] Removed ${deleted} old log files`);
        }
    } catch (err) {
        logger.error(`[Cleanup] Failed to clean logs: ${err.message}`);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('[Server] Shutting down...');
    await mongoose.disconnect();
    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('[Server] Shutting down...');
    await mongoose.disconnect();
    process.exit(0);
});

startServer();
