const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 Stunde Cache

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return "Unknown";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

async function searchAnimeTosho(cleanTitle) {
    try {
        const url = `https://feed.animetosho.org/json?qx=1&q=${encodeURIComponent(cleanTitle)}`;
        const res = await axios.get(url, {
            timeout: 6000,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        
        if (!res.data || !Array.isArray(res.data)) return [];
        
        return res.data.map(item => ({
            title: item.title,
            hash: item.info_hash ? item.info_hash.toLowerCase() : "",
            seeders: parseInt(item.seeders, 10) || 0,
            size: item.total_size ? formatBytes(item.total_size) : "Unknown"
        })).filter(i => i.hash);
    } catch(e) {
        console.log(`[SCRAPER] ⚠️ AnimeTosho Fehler: ${e.message}`);
        return [];
    }
}

async function searchTokyoTosho(cleanTitle) {
    try {
        const url = `https://www.tokyotosho.info/rss.php?filter=1&terms=${encodeURIComponent(cleanTitle)}`;
        const res = await axios.get(url, {
            timeout: 6000,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });
        
        const parser = new XMLParser({ ignoreAttributes: true });
        const jsonObj = parser.parse(res.data);
        const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
        
        return items.map(item => {
            let hash = "";
            const link = item.link || "";
            const match = link.match(/btih:([a-zA-Z0-9]+)/i);
            if (match) hash = match[1].toLowerCase();
            
            return {
                title: item.title || "Unknown",
                hash: hash,
                seeders: 5, 
                size: "Unknown"
            };
        }).filter(i => i.hash);
    } catch(e) {
        console.log(`[SCRAPER] ⚠️ TokyoTosho Fehler: ${e.message}`);
        return [];
    }
}

async function searchNyaaForAnime(romajiTitle) {
    if (!romajiTitle || romajiTitle.trim().length < 2) return [];
    
    const cleanTitle = romajiTitle.replace(/[^\w\s]/gi, " ").replace(/\s+/g, " ").trim();
    const queryKey = cleanTitle.toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) return item.data;
    }

    console.log(`\n[SCRAPER] 🚀 API Suche: "${cleanTitle}"`);

    const [toshoResults, tokyoResults] = await Promise.all([
        searchAnimeTosho(cleanTitle),
        searchTokyoTosho(cleanTitle)
    ]);

    const uniqueTorrents = new Map();
    
    [...toshoResults, ...tokyoResults].forEach(item => {
        if (!uniqueTorrents.has(item.hash)) {
            uniqueTorrents.set(item.hash, item);
        } else {
            const existing = uniqueTorrents.get(item.hash);
            if (item.seeders > existing.seeders) {
                uniqueTorrents.set(item.hash, item);
            }
        }
    });

    const finalResults = Array.from(uniqueTorrents.values()).sort((a, b) => b.seeders - a.seeders);
    searchCache.set(queryKey, { data: finalResults, expiresAt: Date.now() + CACHE_TTL_MS });
    
    console.log(`[SCRAPER] ✅ ${finalResults.length} Torrents gefunden für "${cleanTitle}"`);
    return finalResults;
}

module.exports = { searchNyaaForAnime };
