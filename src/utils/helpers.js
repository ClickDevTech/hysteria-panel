/**
 * Общие хелперы
 */

const Settings = require('../models/settingsModel');
const ServerGroup = require('../models/serverGroupModel');
const cache = require('../services/cacheService');

/**
 * Получить настройки (с кэшированием через Redis)
 * Единый источник кэша - Redis, без дублирования в памяти
 */
async function getSettings() {
    // Сначала проверяем Redis кэш
    const cached = await cache.getSettings();
    if (cached) return cached;
    
    // Если кэша нет — запрашиваем из MongoDB
    const settings = await Settings.get();
    
    // Сохраняем в Redis (lean объект)
    await cache.setSettings(settings.toObject ? settings.toObject() : settings);
    
    return settings;
}

/**
 * Сбросить кэш настроек (вызывать после изменения)
 */
async function invalidateSettingsCache() {
    await cache.invalidateSettings();
}

/**
 * Получить активные ноды для пользователя по его группам
 * @param {Array<ObjectId>} userGroups - группы пользователя
 * @returns {Promise<Array>}
 */
async function getNodesByGroups(userGroups) {
    const HyNode = require('../models/hyNodeModel');
    
    // Если у пользователя нет групп - возвращаем все активные ноды без групп
    if (!userGroups || userGroups.length === 0) {
        return HyNode.find({ 
            active: true,
            $or: [
                { groups: { $size: 0 } },
                { groups: { $exists: false } }
            ]
        });
    }
    
    // Ищем ноды, у которых есть пересечение с группами пользователя
    // или у которых нет групп вообще (доступны всем)
    return HyNode.find({
        active: true,
        $or: [
            { groups: { $in: userGroups } },
            { groups: { $size: 0 } },
            { groups: { $exists: false } }
        ]
    });
}

/**
 * Получить активные группы (с кэшированием)
 */
async function getActiveGroups() {
    // Проверяем Redis кэш
    const cached = await cache.getGroups();
    if (cached) return cached;
    
    // Если кэша нет — запрашиваем из MongoDB
    const groups = await ServerGroup.find({ active: true }).sort({ name: 1 }).lean();
    
    // Сохраняем в кэш на 5 минут
    await cache.setGroups(groups);
    
    return groups;
}

/**
 * Инвалидировать кэш групп (вызывать после изменения)
 */
async function invalidateGroupsCache() {
    await cache.invalidateGroups();
}

module.exports = {
    getSettings,
    invalidateSettingsCache,
    getNodesByGroups,
    getActiveGroups,
    invalidateGroupsCache,
};
