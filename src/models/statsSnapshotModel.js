/**
 * Stats Snapshot model - хранит исторические данные для графиков
 * 
 * Типы снапшотов:
 * - hourly: каждые 5 минут (хранятся 48 часов)
 * - daily: каждый час (хранятся 30 дней)
 * - monthly: каждый день (хранятся 12 месяцев)
 * 
 * Оптимизации:
 * - Составные индексы для быстрых запросов
 * - Уникальный индекс предотвращает дубликаты
 * - Projection для уменьшения передаваемых данных
 */

const mongoose = require('mongoose');

// Статистика по ноде (компактная)
const nodeStatSchema = new mongoose.Schema({
    n: { type: String, required: true },      // name (сокращённо для экономии места)
    o: { type: Number, default: 0 },          // onlineUsers
    s: { type: String, default: 'offline' },  // status
}, { _id: false });

const statsSnapshotSchema = new mongoose.Schema({
    // Тип снапшота: hourly, daily, monthly
    type: {
        type: String,
        enum: ['hourly', 'daily', 'monthly'],
        required: true,
    },
    
    // Timestamp (округлённый до интервала)
    ts: {
        type: Date,
        required: true,
    },
    
    // Общая статистика
    online: { type: Number, default: 0 },
    users: { type: Number, default: 0 },
    activeUsers: { type: Number, default: 0 },
    
    // Трафик (в байтах, за период)
    tx: { type: Number, default: 0 },
    rx: { type: Number, default: 0 },
    
    // Ноды
    nodesOn: { type: Number, default: 0 },
    nodesTotal: { type: Number, default: 0 },
    
    // Детальная статистика по нодам (компактный формат)
    nodes: [nodeStatSchema],
    
}, { 
    timestamps: false,  // Экономим место, ts достаточно
    versionKey: false,  // Убираем __v
});

// КРИТИЧЕСКИ ВАЖНО: уникальный индекс предотвращает дубликаты
statsSnapshotSchema.index({ type: 1, ts: 1 }, { unique: true });

// Составной индекс для быстрых запросов по диапазону
statsSnapshotSchema.index({ type: 1, ts: -1 });

/**
 * Получить данные за период (оптимизированный)
 * @param {string} type - тип снапшота
 * @param {Date} startDate 
 * @param {Date} endDate 
 * @param {boolean} includeNodes - включать ли детали по нодам (default: false для экономии)
 */
statsSnapshotSchema.statics.getRange = async function(type, startDate, endDate, includeNodes = false) {
    const projection = includeNodes 
        ? {} 
        : { nodes: 0 };  // Исключаем массив nodes для экономии
    
    return this.find({
        type,
        ts: { $gte: startDate, $lte: endDate }
    })
    .select(projection)
    .sort({ ts: 1 })
    .lean();
};

/**
 * Получить данные с нодами (для графика нод)
 */
statsSnapshotSchema.statics.getRangeWithNodes = async function(type, startDate, endDate) {
    return this.find({
        type,
        ts: { $gte: startDate, $lte: endDate }
    })
    .select({ ts: 1, nodes: 1 })  // Только нужные поля
    .sort({ ts: 1 })
    .lean();
};

/**
 * Upsert снапшота (избегает дубликатов)
 */
statsSnapshotSchema.statics.upsertSnapshot = async function(type, timestamp, data) {
    return this.findOneAndUpdate(
        { type, ts: timestamp },
        { $set: { ...data, type, ts: timestamp } },
        { upsert: true, new: true }
    );
};

/**
 * Очистка старых данных
 */
statsSnapshotSchema.statics.cleanup = async function() {
    const now = new Date();
    
    // Hourly: хранить 48 часов
    const hourlyExpiry = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    
    // Daily: хранить 30 дней
    const dailyExpiry = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    // Monthly: хранить 365 дней
    const monthlyExpiry = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    
    const [hourlyDeleted, dailyDeleted, monthlyDeleted] = await Promise.all([
        this.deleteMany({ type: 'hourly', ts: { $lt: hourlyExpiry } }),
        this.deleteMany({ type: 'daily', ts: { $lt: dailyExpiry } }),
        this.deleteMany({ type: 'monthly', ts: { $lt: monthlyExpiry } }),
    ]);
    
    return {
        hourly: hourlyDeleted.deletedCount,
        daily: dailyDeleted.deletedCount,
        monthly: monthlyDeleted.deletedCount,
    };
};

/**
 * Агрегированная статистика за 24ч (один запрос вместо нескольких)
 */
statsSnapshotSchema.statics.get24hStats = async function() {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const result = await this.aggregate([
        {
            $match: {
                type: 'hourly',
                ts: { $gte: dayAgo }
            }
        },
        {
            $group: {
                _id: null,
                totalTx: { $sum: '$tx' },
                totalRx: { $sum: '$rx' },
                peakOnline: { $max: '$online' },
                avgOnline: { $avg: '$online' },
                count: { $sum: 1 },
                latest: { $last: '$$ROOT' }
            }
        }
    ]);
    
    return result[0] || null;
};

module.exports = mongoose.model('StatsSnapshot', statsSnapshotSchema);
