//===============
// AMATSU NYAA SCRAPER
// (FlareSolverr Tunneled: Nyaa + TokyoTosho)
//===============

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || null;

//===============
// PARSER KONFIGURATION
// processEntities: false verhindert den "Entity expansion limit exceeded" Fehler komplett.
// removeNSPrefix: true ist extrem wichtig, da Nyaa.si unsere Hauptquelle ist.
// Aus <nyaa:seeders> wird im JSON direkt "seeders".
//===============
const parserConfig = {
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    processEntities: false,
    removeNSPrefix: true
};

function decodeEntities(text) {
    if (!text) return "";
    return text.replace(/&amp;/g, "&")
               .replace(/&lt;/g, "<")
               .replace(/&gt;/g, ">")
               .replace(/&quot;/g, "\"")
               .replace(/&#39;/g, "'");
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return "Unknown";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

async function solverRequest(url, isJson = false) {
    if (!FLARESOLVERR_URL) {
        const res = await axios.get(url, {
            timeout: 8000,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        return res.data;
    }

    try {
        const response = await axios.post(FLARESOLVERR_URL, {
            "cmd": "request.get",
            "url": url,
            "maxTimeout": 60000
        }, { timeout: 65000 });

        const content = response.data?.solution?.response;
        
        if (isJson && typeof content === "string") {
            if (content.trim().startsWith("<")) {
                throw new Error("FlareSolverr returned HTML instead of JSON");
            }
            return JSON.parse(content);
        }
        return content;
    } catch (e) {
        const fallback = await axios.get(url, { timeout: 8000 });
        return fallback.data;
    }
}

async function searchRealNyaa(query) {
    try {
        const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0`;
        console.log(`[AMATSU SCRAPER] Starte Nyaa.si Suche: "${query}"`);
        
        const data = await solverRequest(url);
        const parser = new XMLParser(parserConfig);
        const jsonObj = parser.parse(data);
        const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
        
        const parsedItems = items.map(item => ({
            title: decodeEntities(item.title) || "Unknown",
            hash: (item.infoHash || "").toLowerCase(),
            seeders: parseInt(item.seeders, 10) || 0,
            size: item.size || "Unknown"
        })).filter(i => i.hash && i.hash.length === 40);

        console.log(`[AMATSU SCRAPER] Nyaa.si erfolgreich: ${parsedItems.length} Ergebnisse gefunden.`);
        return parsedItems;
    } catch(e) { 
        console.error(`[AMATSU SCRAPER] Nyaa.si Fehler: ${e.message}`);
        throw new Error(`Nyaa: ${e.message}`); 
    }
}

async function searchTokyoTosho(query) {
    try {
        const url = `https://www.tokyotosho.info/rss.php?terms=${encodeURIComponent(query)}&type=0`;
        console.log(`[AMATSU SCRAPER] Starte TokyoTosho Suche: "${query}"`);
        
        const data = await solverRequest(url);
        const parser = new XMLParser(parserConfig);
        const jsonObj = parser.parse(data);
        const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
        
        const parsedItems = items.map(item => {
            let hash = "";
            const link = item.link || "";
            if (link.includes("btih:")) hash = link.split("btih:")[1].split("&")[0].toLowerCase();
            
            const desc = item.description || "";
            const seedMatch = desc.match(/Seeders:\s*(\d+)/i);
            const sizeMatch = desc.match(/Size:\s*([\d.]+\s*[MGTK]?i?B)/i);
            
            return {
                title: decodeEntities(item.title) || "Unknown",
                hash: hash,
                seeders: seedMatch ? parseInt(seedMatch[1], 10) : 0, 
                size: sizeMatch ? sizeMatch[1] : "Unknown"
            };
        }).filter(i => i.hash && i.hash.length === 40);

        console.log(`[AMATSU SCRAPER] TokyoTosho erfolgreich: ${parsedItems.length} Ergebnisse gefunden.`);
        return parsedItems;
    } catch(e) { 
        console.error(`[AMATSU SCRAPER] TokyoTosho Fehler: ${e.message}`);
        throw new Error(`TokyoTosho: ${e.message}`); 
    }
}

async function searchNyaaForAnime(title) {
    if (!title || title.trim().length < 2) return [];
    const query = title.replace(/\s+/g, " ").trim();
    const queryKey = query.toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) {
            console.log(`[AMATSU SCRAPER] Cache Hit für: "${query}" (${item.data.length} Ergebnisse)`);
            return item.data;
        }
    }

    console.log(`[AMATSU SCRAPER] ========================================`);
    console.log(`[AMATSU SCRAPER] 🚀 NEUE SUCHE FÜR: "${query}"`);
    console.log(`[AMATSU SCRAPER] ========================================`);
    
    const allTorrents = [];
    const trackers = [
        { name: "Nyaa.si", fn: searchRealNyaa },
        { name: "TokyoTosho", fn: searchTokyoTosho }
    ];

    for (const tracker of trackers) {
        try {
            const results = await tracker.fn(query);
            if (results.length > 0) allTorrents.push(...results);
        } catch (e) { 
            console.log(`[AMATSU SCRAPER] ⚠️ Tracker Ausfall (${tracker.name}): Fortfahren mit restlichen Providern.`); 
        }
        await new Promise(r => setTimeout(r, 600));
    }

    const uniqueTorrents = new Map();
    allTorrents.forEach(item => {
        if (!uniqueTorrents.has(item.hash) || item.seeders > uniqueTorrents.get(item.hash).seeders) {
            uniqueTorrents.set(item.hash, item);
        }
    });

    const finalResults = Array.from(uniqueTorrents.values()).sort((a, b) => b.seeders - a.seeders);
    searchCache.set(queryKey, { data: finalResults, expiresAt: Date.now() + CACHE_TTL_MS });
    
    console.log(`[AMATSU SCRAPER] ✅ Suche beendet für "${query}": ${finalResults.length} eindeutige Torrents nach Deduplizierung bereitgestellt.`);
    return finalResults;
}

module.exports = { searchNyaaForAnime };
