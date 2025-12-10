/**
 * Модель администратора панели
 * Логин и пароль хранятся в БД (пароль хешируется bcrypt)
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        minlength: 3,
    },
    passwordHash: {
        type: String,
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    lastLogin: {
        type: Date,
        default: null,
    },
});

// Статический метод: создать админа
adminSchema.statics.createAdmin = async function(username, password) {
    const hash = await bcrypt.hash(password, 12);
    return this.create({
        username: username.toLowerCase().trim(),
        passwordHash: hash,
    });
};

// Статический метод: проверить пароль
adminSchema.statics.verifyPassword = async function(username, password) {
    const admin = await this.findOne({ username: username.toLowerCase().trim() });
    if (!admin) return null;
    
    const isValid = await bcrypt.compare(password, admin.passwordHash);
    if (!isValid) return null;
    
    // Обновляем lastLogin
    admin.lastLogin = new Date();
    await admin.save();
    
    return admin;
};

// Статический метод: проверить есть ли хоть один админ
adminSchema.statics.hasAdmin = async function() {
    const count = await this.countDocuments();
    return count > 0;
};

// Статический метод: изменить пароль
adminSchema.statics.changePassword = async function(username, newPassword) {
    const hash = await bcrypt.hash(newPassword, 12);
    return this.findOneAndUpdate(
        { username: username.toLowerCase().trim() },
        { passwordHash: hash },
        { new: true }
    );
};

module.exports = mongoose.model('Admin', adminSchema);












