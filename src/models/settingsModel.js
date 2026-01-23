/**
 * Panel settings model
 */

const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    _id: {
        type: String,
        default: 'settings',
    },
    
    loadBalancing: {
        enabled: { type: Boolean, default: false },
        hideOverloaded: { type: Boolean, default: false },
    },
    
    deviceGracePeriod: { type: Number, default: 15 },
    
    cache: {
        subscriptionTTL: { type: Number, default: 3600 },
        userTTL: { type: Number, default: 900 },
        onlineSessionsTTL: { type: Number, default: 10 },
        activeNodesTTL: { type: Number, default: 30 },
    },
    
    rateLimit: {
        subscriptionPerMinute: { type: Number, default: 100 },
        authPerSecond: { type: Number, default: 200 },
    },
    
    sshPool: {
        enabled: { type: Boolean, default: true },
        maxIdleTime: { type: Number, default: 120 },        // seconds
        keepAliveInterval: { type: Number, default: 30 },   // seconds
        connectTimeout: { type: Number, default: 15 },      // seconds
        maxRetries: { type: Number, default: 2 },
    },
    
    nodeAuth: {
        // Allow nodes to connect to panel auth API with self-signed/invalid SSL
        // Enable if panel uses HTTP or self-signed certificate
        insecure: { type: Boolean, default: true },
    },
    
    backup: {
        enabled: { type: Boolean, default: false },
        intervalHours: { type: Number, default: 24 },       // интервал в часах
        keepLast: { type: Number, default: 7 },             // сколько хранить локально
        lastBackup: { type: Date, default: null },          // время последнего бэкапа
        
        // S3 настройки (опционально)
        s3: {
            enabled: { type: Boolean, default: false },
            endpoint: { type: String, default: '' },        // для MinIO и подобных
            region: { type: String, default: 'us-east-1' },
            bucket: { type: String, default: '' },
            prefix: { type: String, default: 'backups' },   // префикс в bucket
            accessKeyId: { type: String, default: '' },
            secretAccessKey: { type: String, default: '' },
            keepLast: { type: Number, default: 30 },        // сколько хранить в S3
        },
    },
    
}, { timestamps: true });

settingsSchema.statics.get = async function() {
    let settings = await this.findById('settings');
    if (!settings) {
        settings = await this.create({ _id: 'settings' });
    }
    return settings;
};

settingsSchema.statics.update = async function(updates) {
    return this.findByIdAndUpdate('settings', { $set: updates }, { 
        new: true, 
        upsert: true,
        setDefaultsOnInsert: true,
    });
};

module.exports = mongoose.model('Settings', settingsSchema);

