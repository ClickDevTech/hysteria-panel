/**
 * Сервис шифрования паролей пользователей
 * Пароль = зашифрованный userId
 */

const CryptoJS = require('crypto-js');
const config = require('../../config');

class CryptoService {
    constructor() {
        this.key = config.ENCRYPTION_KEY;
    }

    /**
     * Генерирует пароль для пользователя на основе его userId
     * @param {string} userId - ID пользователя (telegram id)
     * @returns {string} - Зашифрованный пароль
     */
    generatePassword(userId) {
        // Используем HMAC-SHA256 для генерации детерминированного пароля
        const hash = CryptoJS.HmacSHA256(String(userId), this.key);
        // Берём первые 24 символа hex для удобства
        return hash.toString(CryptoJS.enc.Hex).substring(0, 24);
    }

    /**
     * Шифрует данные
     * @param {string} data 
     * @returns {string}
     */
    encrypt(data) {
        return CryptoJS.AES.encrypt(String(data), this.key).toString();
    }

    /**
     * Расшифровывает данные
     * @param {string} encryptedData 
     * @returns {string}
     */
    decrypt(encryptedData) {
        const bytes = CryptoJS.AES.decrypt(encryptedData, this.key);
        return bytes.toString(CryptoJS.enc.Utf8);
    }

    /**
     * Генерирует случайный секрет для API статистики ноды
     * @returns {string}
     */
    generateNodeSecret() {
        return CryptoJS.lib.WordArray.random(16).toString();
    }
}

module.exports = new CryptoService();












