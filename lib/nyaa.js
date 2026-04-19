//===============
// AMATSU NYAA SCRAPER
// (Asynchronous Engine: Nyaa + AnimeTosho + TokyoTosho - Refactored for Rate Limit Protection)
//===============

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 Stunde Cache

// Formatierungs-Helper
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return "Unknown";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

//===============
// SCRAPER 1: ECHTES NYAA.SI (Inkl. Live Action)
//===============
async function searchRealNyaa(query) {
    try {
        const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0`;
        const res = await axios.get(url, {
            timeout: 6000,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        
        const parser = new XMLParser({ ignoreAttributes: false });
        const jsonObj = parser.parse(res.data);
        const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
        
        return items.map(item => ({
            title: item.title || "Unknown",
            hash: (item["nyaa:infoHash"] || "").toLowerCase(),
            seeders: parseInt(item["nyaa:seeders"], 10) || 0,
            size: item["nyaa:size"] || "Unknown"
        })).filter(i => i.hash && i.hash.length === 40);
    } catch(e) {
        throw new Error(`Nyaa HTTP ${e.response ? e.response.status : "Timeout"}`);
    }
}

//===============
// SCRAPER 2: ANIMETOSHO JSON API
//===============
async function searchAnimeTosho(query) {
    try {
        const url = `https://feed.animetosho.org/json?qx=1&q=${encodeURIComponent(query)}`;
        const res = await axios.get(url, { timeout: 6000 });
        if (!res.data || !Array.isArray(res.data)) return [];
        
        return res.data.map(item => ({
            title: item.title,
            hash: (item.info_hash || "").toLowerCase(),
            seeders: parseInt(item.seeders, 10) || 0,
            size: item.total_size ? formatBytes(item.total_size) : "Unknown"
        })).filter(i => i.hash && i.hash.length === 40);
    } catch(e) {
        throw new Error(`AnimeTosho HTTP ${e.response ? e.response.status : "Timeout"}`);
    }
}

//===============
// SCRAPER 3: TOKYOTOSHO RSS
//===============
async function searchTokyoTosho(query) {
    try {
        const url = `https://www.tokyotosho.info/rss.php?terms=${encodeURIComponent(query)}&type=0`;
        const res = await axios.get(url, { timeout: 6000 });
        
        const parser = new XMLParser({ ignoreAttributes: false });
        const jsonObj = parser.parse(res.data);
        const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
        
        return items.map(item => {
            let hash = "";
            const link = item.link || "";
            if (link.includes("btih:")) {
                hash = link.split("btih:")[1].split("&")[0].toLowerCase();
            }
            
            const desc = item.description || "";
            const sizeMatch = desc.match(/Size:\s*([\d.]+\s*[MGTK]?B)/i);
            const size = sizeMatch ? sizeMatch[1] : "Unknown";

            return {
                title: item.title || "Unknown",
                hash: hash,
                seeders: 0, 
                size: size
            };
        }).filter(i => i.hash && i.hash.length === 40);
    } catch(e) {
        throw new Error(`TokyoTosho HTTP ${e.response ? e.response.status : "Timeout"}`);
    }
}

//===============
// SEQUENTIAL EXECUTION ENGINE (Rate Limit Protection)
//===============
async function searchNyaaForAnime(title) {
    if (!title || title.trim().length < 2) return [];
    
    const query = title.replace(/\s+/g, " ").trim();
    const queryKey = query.toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) return item.data;
    }

    console.log(`\n[SCRAPER] 🚀 Starte sichere Tracker-Suche für: "${query}"`);

    const allTorrents = [];
    
    try {
        const nyaaRes = await searchRealNyaa(query);
        if (nyaaRes.length > 0) {
            console.log(`[SCRAPER] ✅ Nyaa lieferte ${nyaaRes.length} Roh-Ergebnisse.`);
            allTorrents.push(...nyaaRes);
        } else {
            console.log(`[SCRAPER] ❌ Nyaa lieferte 0 Ergebnisse.`);
        }
    } catch (e) { console.log(`[SCRAPER] ⚠️ Nyaa Fehler: ${e.message}`); }
    
    await new Promise(r => setTimeout(r, 600));

    try {
        const toshoRes = await searchAnimeTosho(query);
        if (toshoRes.length > 0) {
            console.log(`[SCRAPER] ✅ AnimeTosho lieferte ${toshoRes.length} Roh-Ergebnisse.`);
            allTorrents.push(...toshoRes);
        } else {
            console.log(`[SCRAPER] ❌ AnimeTosho lieferte 0 Ergebnisse.`);
        }
    } catch (e) { console.log(`[SCRAPER] ⚠️ AnimeTosho Fehler: ${e.message}`); }

    await new Promise(r => setTimeout(r, 600));

    try {
        const tokyoRes = await searchTokyoTosho(query);
        if (tokyoRes.length > 0) {
            console.log(`[SCRAPER] ✅ TokyoTosho lieferte ${tokyoRes.length} Roh-Ergebnisse.`);
            allTorrents.push(...tokyoRes);
        } else {
            console.log(`[SCRAPER] ❌ TokyoTosho lieferte 0 Ergebnisse.`);
        }
    } catch (e) { console.log(`[SCRAPER] ⚠️ TokyoTosho Fehler: ${e.message}`); }

    const uniqueTorrents = new Map();
    allTorrents.forEach(item => {
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
    
    console.log(`[SCRAPER] 🏆 Gesamt nach Deduplizierung: ${finalResults.length} Torrents für den Parser bereit.`);
    return finalResults;
}

module.exports = { searchNyaaForAnime };
