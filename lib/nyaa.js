//===============
// AMATSU NYAA - DEEP LOGGING & RACE MODE
//===============
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const { SocksProxyAgent } = require("socks-proxy-agent");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;
const MAX_CACHE_ENTRIES = 2000;

const MIRRORS = [
    "https://nyaa.si",
    "https://nyaa.iss.one",
    "https://nyaa.land",
    "https://nyaa.tracker.wf"
];

async function fetchFromMirror(baseUrl, encodedQuery, agent) {
    const rssUrl = `${baseUrl}/?page=rss&q=${encodedQuery}&s=seeders&o=desc&c=1_0`;
    const start = Date.now();
    
    try {
        const response = await axios.get(rssUrl, {
            timeout: 8000, 
            headers: { 
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "application/rss+xml, application/xml, text/xml, */*"
            },
            httpsAgent: agent
        });

        const duration = Date.now() - start;

        if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
            console.log(`[MIRROR INFO] ❌ ${baseUrl} -> CLOUDFLARE BLOCK (HTML) [${duration}ms]`);
            throw new Error("CF Block");
        }

        console.log(`[MIRROR INFO] ✅ ${baseUrl} -> SUCCESS [${duration}ms]`);
        return { data: response.data, mirror: baseUrl };

    } catch (err) {
        const duration = Date.now() - start;
        const status = err.response ? err.response.status : err.message;
        console.log(`[MIRROR INFO] ❌ ${baseUrl} -> FAIL (${status}) [${duration}ms]`);
        throw err;
    }
}

async function searchNyaaForAnime(romajiTitle) {
    if (!romajiTitle || romajiTitle.trim().length < 3) return [];
    const queryKey = romajiTitle.trim().toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) return item.data;
    }

    console.log(`\n[NYAA] 🏁 RACE-START: "${romajiTitle}"`);
    const encodedQuery = encodeURIComponent(romajiTitle);
    const agent = new SocksProxyAgent("socks5h://warp-proxy:9091");

    const searchPromises = MIRRORS.map(mirror => fetchFromMirror(mirror, encodedQuery, agent));

    try {
        const firstSuccess = await Promise.any(searchPromises);
        const parser = new XMLParser({ ignoreAttributes: true });
        const jsonObj = parser.parse(firstSuccess.data);
        const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
        
        const results = items.map(item => ({
            title: item.title || "Unknown",
            hash: item["nyaa:infoHash"]?.toLowerCase(),
            seeders: parseInt(item["nyaa:seeders"], 10) || 0,
            size: item["nyaa:size"] || "Unknown"
        })).filter(i => i.hash).sort((a, b) => b.seeders - a.seeders);

        searchCache.set(queryKey, { data: results, expiresAt: Date.now() + CACHE_TTL_MS });
        console.log(`[NYAA] 🏆 WINNER: ${firstSuccess.mirror} (Found ${results.length} results)`);
        return results;

    } catch (error) {
        console.error(`[NYAA] 💀 TOTAL FAILURE: All mirrors failed for "${romajiTitle}"`);
        return [];
    }
}

module.exports = { searchNyaaForAnime };
