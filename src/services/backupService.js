/**
 * Backup Service - автоматические бэкапы MongoDB с опциональной загрузкой в S3
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const config = require('../../config');
const logger = require('../utils/logger');

const execAsync = promisify(exec);

// Lazy-load S3 client (только если нужен)
let s3Client = null;

function getS3Client(settings) {
    if (!s3Client && settings?.backup?.s3?.enabled) {
        try {
            const { S3Client } = require('@aws-sdk/client-s3');
            s3Client = new S3Client({
                region: settings.backup.s3.region || 'us-east-1',
                endpoint: settings.backup.s3.endpoint || undefined,
                credentials: {
                    accessKeyId: settings.backup.s3.accessKeyId,
                    secretAccessKey: settings.backup.s3.secretAccessKey,
                },
                forcePathStyle: !!settings.backup.s3.endpoint, // для MinIO и подобных
            });
        } catch (err) {
            logger.error(`[Backup] Failed to initialize S3 client: ${err.message}`);
            return null;
        }
    }
    return s3Client;
}

/**
 * Создание бэкапа MongoDB
 */
async function createBackup(settings) {
    const backupDir = path.join(__dirname, '../../backups');
    
    // Создаём папку если нет
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `hysteria-backup-${timestamp}`;
    const backupPath = path.join(backupDir, backupName);
    const archivePath = path.join(backupDir, `${backupName}.tar.gz`);
    
    try {
        // Получаем MongoDB URI
        const mongoUri = config.MONGO_URI;
        
        // Выполняем mongodump
        logger.info(`[Backup] Starting backup: ${backupName}`);
        const dumpCmd = `mongodump --uri="${mongoUri}" --out="${backupPath}" --gzip`;
        await execAsync(dumpCmd);
        logger.info(`[Backup] Dump created: ${backupPath}`);
        
        // Создаём tar архив
        const tarCmd = `cd "${backupDir}" && tar -czf "${backupName}.tar.gz" "${backupName}" && rm -rf "${backupName}"`;
        await execAsync(tarCmd);
        logger.info(`[Backup] Archive created: ${archivePath}`);
        
        // Получаем размер файла
        const stats = fs.statSync(archivePath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        
        // Загружаем в S3 если настроено
        if (settings?.backup?.s3?.enabled) {
            await uploadToS3(archivePath, `${backupName}.tar.gz`, settings);
        }
        
        // Ротация старых бэкапов
        const keepLast = settings?.backup?.keepLast || 7;
        await rotateBackups(backupDir, keepLast);
        
        // Обновляем время последнего бэкапа
        const Settings = require('../models/settingsModel');
        await Settings.update({ 'backup.lastBackup': new Date() });
        
        logger.info(`[Backup] Completed: ${backupName} (${sizeMB} MB)`);
        
        return {
            success: true,
            filename: `${backupName}.tar.gz`,
            path: archivePath,
            size: stats.size,
            sizeMB: parseFloat(sizeMB),
        };
        
    } catch (error) {
        logger.error(`[Backup] Error: ${error.message}`);
        
        // Cleanup при ошибке
        try {
            if (fs.existsSync(backupPath)) {
                fs.rmSync(backupPath, { recursive: true });
            }
        } catch (e) {}
        
        throw error;
    }
}

/**
 * Загрузка файла в S3
 */
async function uploadToS3(filePath, fileName, settings) {
    const client = getS3Client(settings);
    if (!client) {
        logger.warn('[Backup] S3 client not available, skipping upload');
        return;
    }
    
    try {
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        const fileStream = fs.createReadStream(filePath);
        const stats = fs.statSync(filePath);
        
        const bucket = settings.backup.s3.bucket;
        const prefix = settings.backup.s3.prefix || 'backups';
        const key = `${prefix}/${fileName}`;
        
        logger.info(`[Backup] Uploading to S3: ${bucket}/${key}`);
        
        await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: fileStream,
            ContentLength: stats.size,
            ContentType: 'application/gzip',
        }));
        
        logger.info(`[Backup] Uploaded to S3: ${key}`);
        
        // Ротация в S3 если настроена
        if (settings.backup.s3.keepLast) {
            await rotateS3Backups(settings);
        }
        
    } catch (error) {
        logger.error(`[Backup] S3 upload error: ${error.message}`);
        // Не прерываем - локальный бэкап всё равно создан
    }
}

/**
 * Ротация бэкапов в S3
 */
async function rotateS3Backups(settings) {
    const client = getS3Client(settings);
    if (!client) return;
    
    try {
        const { ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
        
        const bucket = settings.backup.s3.bucket;
        const prefix = settings.backup.s3.prefix || 'backups';
        const keepLast = settings.backup.s3.keepLast || 7;
        
        // Получаем список объектов
        const listResult = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${prefix}/hysteria-backup-`,
        }));
        
        if (!listResult.Contents || listResult.Contents.length <= keepLast) {
            return;
        }
        
        // Сортируем по дате (старые первые)
        const sorted = listResult.Contents
            .filter(obj => obj.Key.endsWith('.tar.gz'))
            .sort((a, b) => a.LastModified - b.LastModified);
        
        // Удаляем лишние
        const toDelete = sorted.slice(0, sorted.length - keepLast);
        
        for (const obj of toDelete) {
            await client.send(new DeleteObjectCommand({
                Bucket: bucket,
                Key: obj.Key,
            }));
            logger.info(`[Backup] Deleted from S3: ${obj.Key}`);
        }
        
    } catch (error) {
        logger.error(`[Backup] S3 rotation error: ${error.message}`);
    }
}

/**
 * Ротация локальных бэкапов
 */
async function rotateBackups(backupDir, keepLast) {
    try {
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('hysteria-backup-') && f.endsWith('.tar.gz'))
            .map(f => ({
                name: f,
                path: path.join(backupDir, f),
                mtime: fs.statSync(path.join(backupDir, f)).mtime,
            }))
            .sort((a, b) => a.mtime - b.mtime); // старые первые
        
        if (files.length <= keepLast) {
            return;
        }
        
        const toDelete = files.slice(0, files.length - keepLast);
        
        for (const file of toDelete) {
            fs.unlinkSync(file.path);
            logger.info(`[Backup] Rotated old backup: ${file.name}`);
        }
        
        logger.info(`[Backup] Rotation complete. Kept ${keepLast} backups, deleted ${toDelete.length}`);
        
    } catch (error) {
        logger.error(`[Backup] Rotation error: ${error.message}`);
    }
}

/**
 * Получить список локальных бэкапов
 */
function listBackups() {
    const backupDir = path.join(__dirname, '../../backups');
    
    if (!fs.existsSync(backupDir)) {
        return [];
    }
    
    return fs.readdirSync(backupDir)
        .filter(f => f.startsWith('hysteria-backup-') && f.endsWith('.tar.gz'))
        .map(f => {
            const filePath = path.join(backupDir, f);
            const stats = fs.statSync(filePath);
            return {
                name: f,
                path: filePath,
                size: stats.size,
                sizeMB: (stats.size / 1024 / 1024).toFixed(2),
                created: stats.mtime,
            };
        })
        .sort((a, b) => b.created - a.created); // новые первые
}

/**
 * Проверка, нужен ли бэкап
 */
async function shouldRunBackup(settings) {
    if (!settings?.backup?.enabled) {
        return false;
    }
    
    const intervalHours = settings.backup.intervalHours || 24;
    const lastBackup = settings.backup.lastBackup;
    
    if (!lastBackup) {
        return true; // Никогда не делали бэкап
    }
    
    const hoursSinceLastBackup = (Date.now() - new Date(lastBackup).getTime()) / (1000 * 60 * 60);
    
    return hoursSinceLastBackup >= intervalHours;
}

/**
 * Запланированный бэкап (вызывается из cron)
 */
async function scheduledBackup() {
    try {
        const Settings = require('../models/settingsModel');
        const settings = await Settings.get();
        
        if (await shouldRunBackup(settings)) {
            logger.info('[Backup] Starting scheduled backup');
            await createBackup(settings);
        }
    } catch (error) {
        logger.error(`[Backup] Scheduled backup failed: ${error.message}`);
    }
}

/**
 * Тест подключения к S3
 */
async function testS3Connection(s3Config) {
    try {
        const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
        
        const client = new S3Client({
            region: s3Config.region || 'us-east-1',
            endpoint: s3Config.endpoint || undefined,
            credentials: {
                accessKeyId: s3Config.accessKeyId,
                secretAccessKey: s3Config.secretAccessKey,
            },
            forcePathStyle: !!s3Config.endpoint,
        });
        
        // Проверяем доступ к bucket
        const { HeadBucketCommand } = require('@aws-sdk/client-s3');
        await client.send(new HeadBucketCommand({ Bucket: s3Config.bucket }));
        
        return { success: true };
        
    } catch (error) {
        return { 
            success: false, 
            error: error.message,
        };
    }
}

/**
 * Получить список бэкапов из S3
 */
async function listS3Backups(settings) {
    const client = getS3Client(settings);
    if (!client) {
        return [];
    }
    
    try {
        const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
        
        const bucket = settings.backup.s3.bucket;
        const prefix = settings.backup.s3.prefix || 'backups';
        
        const result = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${prefix}/hysteria-backup-`,
        }));
        
        if (!result.Contents) {
            return [];
        }
        
        return result.Contents
            .filter(obj => obj.Key.endsWith('.tar.gz'))
            .map(obj => ({
                name: obj.Key.split('/').pop(),
                key: obj.Key,
                size: obj.Size,
                sizeMB: (obj.Size / 1024 / 1024).toFixed(2),
                created: obj.LastModified,
                source: 's3',
            }))
            .sort((a, b) => b.created - a.created); // новые первые
            
    } catch (error) {
        logger.error(`[Backup] List S3 backups error: ${error.message}`);
        return [];
    }
}

/**
 * Скачать бэкап из S3 для восстановления
 */
async function downloadFromS3(settings, key) {
    const client = getS3Client(settings);
    if (!client) {
        throw new Error('S3 client not available');
    }
    
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { Readable } = require('stream');
    
    const bucket = settings.backup.s3.bucket;
    const fileName = key.split('/').pop();
    const localPath = path.join(__dirname, '../../backups', fileName);
    
    logger.info(`[Backup] Downloading from S3: ${key}`);
    
    const response = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    }));
    
    // Сохраняем во временный файл
    const writeStream = fs.createWriteStream(localPath);
    
    await new Promise((resolve, reject) => {
        response.Body.pipe(writeStream);
        response.Body.on('error', reject);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });
    
    logger.info(`[Backup] Downloaded: ${localPath}`);
    
    return localPath;
}

/**
 * Восстановление из бэкапа (локального или S3)
 */
async function restoreBackup(settings, source, identifier) {
    let archivePath;
    let tempDownload = false;
    
    // Получаем файл
    if (source === 's3') {
        archivePath = await downloadFromS3(settings, identifier);
        tempDownload = true;
    } else {
        archivePath = path.join(__dirname, '../../backups', identifier);
        if (!fs.existsSync(archivePath)) {
            throw new Error('Backup file not found');
        }
    }
    
    const extractDir = path.join('/tmp', `restore-${Date.now()}`);
    
    try {
        // Создаём директорию для распаковки
        fs.mkdirSync(extractDir, { recursive: true });
        
        // Распаковываем архив
        await execAsync(`tar -xzf "${archivePath}" -C "${extractDir}"`);
        logger.info(`[Restore] Archive extracted to ${extractDir}`);
        
        // Ищем папку с дампом
        const findDumpPath = (dir) => {
            const items = fs.readdirSync(dir);
            if (items.includes('hysteria') && fs.statSync(path.join(dir, 'hysteria')).isDirectory()) {
                return dir;
            }
            if (items.length === 1 && fs.statSync(path.join(dir, items[0])).isDirectory()) {
                return findDumpPath(path.join(dir, items[0]));
            }
            return dir;
        };
        
        const dumpPath = findDumpPath(extractDir);
        const hysteriaDir = path.join(dumpPath, 'hysteria');
        
        if (!fs.existsSync(hysteriaDir)) {
            throw new Error('Invalid backup: hysteria database folder not found');
        }
        
        // Восстанавливаем
        const mongoUri = config.MONGO_URI;
        const restoreCmd = `mongorestore --uri="${mongoUri}" --drop --gzip --db=hysteria "${hysteriaDir}"`;
        
        logger.info(`[Restore] Starting restore from ${source}: ${identifier}`);
        await execAsync(restoreCmd);
        logger.info(`[Restore] Database restored successfully`);
        
        // Cleanup
        await execAsync(`rm -rf "${extractDir}"`);
        
        // Удаляем скачанный файл из S3 если это был временный
        if (tempDownload) {
            // Оставляем файл - он теперь и локальный бэкап
        }
        
        return { success: true };
        
    } catch (error) {
        // Cleanup при ошибке
        try {
            await execAsync(`rm -rf "${extractDir}"`);
        } catch (e) {}
        
        throw error;
    }
}

module.exports = {
    createBackup,
    listBackups,
    listS3Backups,
    downloadFromS3,
    restoreBackup,
    shouldRunBackup,
    scheduledBackup,
    testS3Connection,
    rotateBackups,
};

