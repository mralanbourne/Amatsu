// AMATSU SCRAPER - NO CLOUDFLARE EDITION

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60;

const MIRRORS = [
    { name: "AnimeTosho", url: (q) => `https://feed.animetosho.org/rss2?q=${q}` },
    { name: "AniDex", url: (q) => `https://anidex.info/rss/?q=${q}` }
];

function extractHash(item) {
    let h = (item["torrent:infoHash"] || item.infoHash || "").toLowerCase();
    if (h) return h;
    const link = item.link || "";
    const match = link.match(/btih:([a-zA-Z0-9]+)/i);
    return match ? match[1].toLowerCase() : null;
}

async function searchNyaaForAnime(romajiTitle) {
    if (!romajiTitle || romajiTitle.trim().length < 2) return [];
    
    const cleanTitle = romajiTitle.replace(/[^\w\s]/gi, " ").replace(/\s+/g, " ").trim();
    const queryKey = cleanTitle.toLowerCase();
    
    if (searchCache.has(queryKey)) {
        return searchCache.get(queryKey).data;
    }

    console.log(`\n[SCRAPER] 🚀 Direkte Suche: "${cleanTitle}"`);
    const encodedQuery = encodeURIComponent(cleanTitle);

    const searchPromises = MIRRORS.map(async (mirror) => {
        try {
            const res = await axios.get(mirror.url(encodedQuery), {
                timeout: 5000,
                headers: { "User-Agent": "Amatsu-Gateway/1.0" }
            });
            return { data: res.data, source: mirror.name };
        } catch (e) {
            console.log(`[SCRAPER] ⚠️ ${mirror.name} nicht erreichbar.`);
            return null;
        }
    });

    const results = await Promise.all(searchPromises);
    const parser = new XMLParser({ ignoreAttributes: true });
    const uniqueTorrents = new Map();

    results.forEach(res => {
        if (!res || !res.data) return;
        try {
            const jsonObj = parser.parse(res.data);
            const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
            
            items.forEach(item => {
                const hash = extractHash(item);
                if (!hash || uniqueTorrents.has(hash)) return;

                const category = (item.category || item["nyaa:category"] || "").toLowerCase();
                if (category.includes("manga") || category.includes("book") || category.includes("pictures")) return;

                uniqueTorrents.set(hash, {
                    title: item.title || "Unknown",
                    hash: hash,
                    seeders: parseInt(item["torrent:seeds"] || item["nyaa:seeders"], 10) || 0,
                    size: item["torrent:contentLength"] || item.size || "Unknown"
                });
            });
        } catch (e) {
            console.log(`[SCRAPER] Fehler beim Parsen von ${res.source}`);
        }
    });

    const finalResults = Array.from(uniqueTorrents.values()).sort((a, b) => b.seeders - a.seeders);
    searchCache.set(queryKey, { data: finalResults, expiresAt: Date.now() + CACHE_TTL_MS });
    
    console.log(`[SCRAPER] ✅ ${finalResults.length} Torrents gefunden für "${cleanTitle}"`);
    return finalResults;
}

module.exports = { searchNyaaForAnime };
