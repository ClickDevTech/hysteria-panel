// Hysteria Panel - Frontend JS

// API Key для запросов
window.API_KEY = document.querySelector('meta[name="api-key"]')?.content || '';

// Refresh stats on dashboard
async function refreshStats() {
    try {
        const res = await fetch('/api/stats', {
            headers: { 'X-API-Key': API_KEY }
        });
        if (res.ok) {
            location.reload();
        }
    } catch (err) {
        console.error('Error refreshing stats:', err);
    }
}

// Sync all nodes
async function syncAll() {
    if (!confirm('Запустить синхронизацию со всеми нодами?')) return;
    
    try {
        const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'X-API-Key': API_KEY }
        });
        
        if (res.ok) {
            alert('Синхронизация запущена');
        } else {
            const data = await res.json();
            alert('Ошибка: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        alert('Ошибка: ' + err.message);
    }
}

// Format bytes to human readable
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Auto-refresh stats every 30 seconds on dashboard
if (location.pathname === '/panel' || location.pathname === '/panel/') {
    setInterval(() => {
        fetch('/api/stats', { headers: { 'X-API-Key': API_KEY } })
            .then(res => res.json())
            .then(data => {
                // Update online count
                const onlineEl = document.querySelector('.stat-value');
                if (onlineEl && data.onlineUsers !== undefined) {
                    // Could update DOM here
                }
            })
            .catch(() => {});
    }, 30000);
}

// Copy to clipboard helper
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        // Could show toast notification
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

// Confirm before dangerous actions
document.querySelectorAll('[data-confirm]').forEach(el => {
    el.addEventListener('click', (e) => {
        if (!confirm(el.dataset.confirm)) {
            e.preventDefault();
        }
    });
});

console.log('⚡ Hysteria Panel loaded');












