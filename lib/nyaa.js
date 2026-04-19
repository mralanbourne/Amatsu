//===============
// AMATSU NYAA SCRAPER
// (FlareSolverr Tunneled: Nyaa + AnimeTosho + TokyoTosho)
//===============

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || null;

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return "Unknown";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Hilfsfunktion für FlareSolverr-Anfragen
async function solverRequest(url) {
    if (!FLARESOLVERR_URL) {
        const res = await axios.get(url, {
            timeout: 8000,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        return res.data;
    }

    const response = await axios.post(FLARESOLVERR_URL, {
        "cmd": "request.get",
        "url": url,
        "maxTimeout": 60000
    }, { timeout: 65000 });

    if (response.data?.solution?.response) {
        return response.data.solution.response;
    }
    throw new Error("FlareSolverr failed to return a solution");
}

async function searchRealNyaa(query) {
    try {
        const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0`;
        const data = await solverRequest(url);
        
        const parser = new XMLParser({ ignoreAttributes: false });
        const jsonObj = parser.parse(data);
        const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
        
        return items.map(item => ({
            title: item.title || "Unknown",
            hash: (item["nyaa:infoHash"] || "").toLowerCase(),
            seeders: parseInt(item["nyaa:seeders"], 10) || 0,
            size: item["nyaa:size"] || "Unknown"
        })).filter(i => i.hash && i.hash.length === 40);
    } catch(e) {
        throw new Error(`Nyaa Error: ${e.message}`);
    }
}

async function searchAnimeTosho(query) {
    try {
        const url = `https://feed.animetosho.org/json?qx=1&q=${encodeURIComponent(query)}`;
        // AnimeTosho JSON API braucht meist keinen FlareSolverr, wir nutzen ihn für Konsistenz
        const data = await solverRequest(url);
        const results = typeof data === "string" ? JSON.parse(data) : data;
        
        if (!Array.isArray(results)) return [];
        
        return results.map(item => ({
            title: item.title,
            hash: (item.info_hash || "").toLowerCase(),
            seeders: parseInt(item.seeders, 10) || 0,
            size: item.total_size ? formatBytes(item.total_size) : "Unknown"
        })).filter(i => i.hash && i.hash.length === 40);
    } catch(e) {
        throw new Error(`AnimeTosho Error: ${e.message}`);
    }
}

async function searchTokyoTosho(query) {
    try {
        const url = `https://www.tokyotosho.info/rss.php?terms=${encodeURIComponent(query)}&type=0`;
        const data = await solverRequest(url);
        
        const parser = new XMLParser({ ignoreAttributes: false });
        const jsonObj = parser.parse(data);
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
        throw new Error(`TokyoTosho Error: ${e.message}`);
    }
}

async function searchNyaaForAnime(title) {
    if (!title || title.trim().length < 2) return [];
    
    const query = title.replace(/\s+/g, " ").trim();
    const queryKey = query.toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) return item.data;
    }

    console.log(`\n[SCRAPER] 🚀 Tunnel-Suche (FlareSolverr: ${!!FLARESOLVERR_URL}) für: "${query}"`);

    const allTorrents = [];
    const trackers = [
        { name: "Nyaa", fn: searchRealNyaa },
        { name: "AnimeTosho", fn: searchAnimeTosho },
        { name: "TokyoTosho", fn: searchTokyoTosho }
    ];

    for (const tracker of trackers) {
        try {
            const results = await tracker.fn(query);
            if (results.length > 0) {
                console.log(`[SCRAPER] ✅ ${tracker.name} lieferte ${results.length} Ergebnisse.`);
                allTorrents.push(...results);
            }
        } catch (e) {
            console.log(`[SCRAPER] ⚠️ ${tracker.name} Fehler: ${e.message}`);
        }
        // Kleiner Delay zwischen Trackern zur Schonung
        await new Promise(r => setTimeout(r, 800));
    }

    const uniqueTorrents = new Map();
    allTorrents.forEach(item => {
        if (!uniqueTorrents.has(item.hash) || item.seeders > uniqueTorrents.get(item.hash).seeders) {
            uniqueTorrents.set(item.hash, item);
        }
    });

    const finalResults = Array.from(uniqueTorrents.values()).sort((a, b) => b.seeders - a.seeders);
    searchCache.set(queryKey, { data: finalResults, expiresAt: Date.now() + CACHE_TTL_MS });
    
    return finalResults;
}

module.exports = { searchNyaaForAnime };
