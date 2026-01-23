/**
 * Hysteria node model
 */

const mongoose = require('mongoose');

const portConfigSchema = new mongoose.Schema({
    name: { type: String, default: '' },
    port: { type: Number, required: true },
    portRange: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
}, { _id: false });

const hyNodeSchema = new mongoose.Schema({
    name: { type: String, required: true },
    flag: { type: String, default: '' },
    ip: { type: String, required: true, unique: true },
    domain: { type: String, default: '' },
    sni: { type: String, default: '' }, // Custom SNI for client (if different from domain)
    port: { type: Number, default: 443 },
    portRange: { type: String, default: '20000-50000' },
    portConfigs: { type: [portConfigSchema], default: [] },
    statsPort: { type: Number, default: 9999 },
    statsSecret: { type: String, default: '' },
    
    groups: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ServerGroup',
    }],
    
    ssh: {
        port: { type: Number, default: 22 },
        username: { type: String, default: 'root' },
        privateKey: { type: String, default: '' },
        password: { type: String, default: '' },
    },
    
    paths: {
        config: { type: String, default: '/etc/hysteria/config.yaml' },
        cert: { type: String, default: '/etc/hysteria/cert.pem' },
        key: { type: String, default: '/etc/hysteria/key.pem' },
    },
    
    active: { type: Boolean, default: true },
    status: { type: String, enum: ['online', 'offline', 'error', 'syncing'], default: 'offline' },
    lastError: { type: String, default: '' },
    lastSync: { type: Date, default: null },
    onlineUsers: { type: Number, default: 0 },
    maxOnlineUsers: { type: Number, default: 0 },
    
    traffic: {
        tx: { type: Number, default: 0 },
        rx: { type: Number, default: 0 },
        lastUpdate: { type: Date, default: null },
    },
    
    rankingCoefficient: { type: Number, default: 1.0 },
    settings: { type: Object, default: {} },
    customConfig: { type: String, default: '' },
    useCustomConfig: { type: Boolean, default: false },
    
}, { timestamps: true });

hyNodeSchema.index({ active: 1 });
hyNodeSchema.index({ groups: 1 });
hyNodeSchema.index({ status: 1 });

hyNodeSchema.virtual('serverAddress').get(function() {
    const host = this.domain || this.ip;
    return `${host}:${this.portRange}`;
});

hyNodeSchema.methods.getSubscriptionAddress = function() {
    const host = this.domain || this.ip;
    if (this.portRange && this.portRange.includes('-')) {
        return `${host}:${this.portRange}`;
    }
    return `${host}:${this.port}`;
};

module.exports = mongoose.model('HyNode', hyNodeSchema);

