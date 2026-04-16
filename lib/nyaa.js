//===============
// AMATSU NYAA SCRAPER - DOCKER WARP MULTI-MIRROR EDITION
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

function getNyaaCache(key) {
    if (searchCache.has(key)) {
        const item = searchCache.get(key);
        if (item.expiresAt > Date.now()) {
            searchCache.delete(key);
            searchCache.set(key, item);
            return item;
        }
        searchCache.delete(key);
    }
    return null;
}

async function searchNyaaForAnime(romajiTitle) {
    if (!romajiTitle || romajiTitle.trim().length < 3) return [];

    const queryKey = romajiTitle.trim().toLowerCase();
    const cachedItem = getNyaaCache(queryKey);
    if (cachedItem) return cachedItem.data;

    const fetchPromise = (async () => {
        const encodedQuery = encodeURIComponent(romajiTitle);
        
        const agent = new SocksProxyAgent("socks5h://warp-proxy:9091");

        for (const baseUrl of MIRRORS) {
            try {
                const rssUrl = `${baseUrl}/?page=rss&q=${encodedQuery}&s=seeders&o=desc&c=1_0`;
                console.log(`[NYAA NETWORK] Searching via WARP (${baseUrl}): ${romajiTitle}`);

                const response = await axios.get(rssUrl, {
                    timeout: 15000,
                    headers: { 
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                        "Accept": "application/rss+xml, application/xml, text/xml, */*"
                    },
                    httpsAgent: agent
                });

                if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
                    console.warn(`[NYAA WARN] Cloudflare HTML detected on ${baseUrl}, trying next...`);
                    continue;
                }

                const parser = new XMLParser({ ignoreAttributes: true });
                const jsonObj = parser.parse(response.data);
                const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
                
                const uniqueResults = new Map();
                items.forEach(item => {
                    const categoryName = item["nyaa:category"] || "";
                    const catLower = categoryName.toLowerCase();
                    if (catLower.includes("art") || catLower.includes("doujinshi") || catLower.includes("pictures")) return;

                    const hash = item["nyaa:infoHash"]?.toLowerCase();
                    if (!hash || uniqueResults.has(hash)) return;

                    uniqueResults.set(hash, {
                        title: item.title || "Unknown",
                        hash: hash,
                        seeders: parseInt(item["nyaa:seeders"], 10) || 0,
                        size: item["nyaa:size"] || "Unknown"
                    });
                });

                const results = Array.from(uniqueResults.values()).sort((a, b) => b.seeders - a.seeders);
                
                if (searchCache.size >= MAX_CACHE_ENTRIES) searchCache.delete(searchCache.keys().next().value);
                searchCache.set(queryKey, { data: results, expiresAt: Date.now() + CACHE_TTL_MS });
                
                return results;

            } catch (error) {
                console.warn(`[NYAA WARN] Mirror ${baseUrl} failed via WARP: ${error.message}`);
            }
        }

        console.error(`[NYAA ERROR] All mirrors failed via WARP for: ${romajiTitle}`);
        return [];
    })();

    return fetchPromise;
}

module.exports = { searchNyaaForAnime };
