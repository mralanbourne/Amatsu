//===============
// AMATSU NYAA - PUBLIC API RACE MODE
//===============
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60;

const MIRRORS = [
    "https://nyaa.si",
    "https://nyaa.iss.one"
];


const PUBLIC_PROXIES = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`
];

async function fetchFromMirror(baseUrl, encodedQuery, proxyWrapper) {
    const targetUrl = `${baseUrl}/?page=rss&q=${encodedQuery}&s=seeders&o=desc&c=1_0`;
    const rssUrl = proxyWrapper(targetUrl);
    
    const start = Date.now();
    try {
        const response = await axios.get(rssUrl, {
            timeout: 5000,
            headers: { 
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "application/rss+xml, application/xml, text/xml, */*"
            }
        });

        const duration = Date.now() - start;

        if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
            throw new Error("CF HTML Block");
        }

        return { data: response.data, proxy: rssUrl.split('/')[2], mirror: baseUrl, duration };

    } catch (err) {
        throw err;
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

    console.log(`\n[NYAA] 🏁 RACE-START (Public Proxies): "${cleanTitle}"`);
    const encodedQuery = encodeURIComponent(cleanTitle);

    const searchPromises = [];
    for (const mirror of MIRRORS) {
        for (const proxy of PUBLIC_PROXIES) {
            searchPromises.push(fetchFromMirror(mirror, encodedQuery, proxy));
        }
    }

    try {
        const result = await Promise.any(searchPromises);
        console.log(`[NYAA] 🏆 ERFOLG über ${result.proxy} (${result.mirror}) in ${result.duration}ms`);

        const parser = new XMLParser({ ignoreAttributes: true });
        const jsonObj = parser.parse(result.data);
        const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
        
        const results = items.map(item => ({
            title: item.title || "Unknown",
            hash: item["nyaa:infoHash"]?.toLowerCase(),
            seeders: parseInt(item["nyaa:seeders"], 10) || 0,
            size: item["nyaa:size"] || "Unknown"
        })).filter(i => i.hash).sort((a, b) => b.seeders - a.seeders);

        searchCache.set(queryKey, { data: results, expiresAt: Date.now() + CACHE_TTL_MS });
        return results;

    } catch (error) {
        console.error(`[NYAA] 💀 FEHLSCHLAG: Kein Web-Proxy konnte "${cleanTitle}" erreichen.`);
        return [];
    }
}

module.exports = { searchNyaaForAnime };
