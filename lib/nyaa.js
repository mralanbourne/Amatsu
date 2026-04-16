const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const { SocksProxyAgent } = require("socks-proxy-agent");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;
const MAX_CACHE_ENTRIES = 2000;

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
        const baseUrl = "https://nyaa.iss.one";
        const encodedQuery = encodeURIComponent(romajiTitle);
        const rssUrl = `${baseUrl}/?q=${encodedQuery}&s=seeders&o=desc&c=1_0`;

        try {
            console.log(`[NYAA NETWORK] Searching via Tor Network: ${romajiTitle}`);

            const agent = new SocksProxyAgent("socks5h://tor-proxy:9050");

            const response = await axios.get(rssUrl, {
                timeout: 15000,
                headers: { 
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                    "Accept": "application/rss+xml, application/xml, text/xml, */*"
                },
                httpsAgent: agent
            });

            if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
                throw new Error("Cloudflare Captcha block hit!");
            }

            const parser = new XMLParser({ ignoreAttributes: true });
            const jsonObj = parser.parse(response.data);
            const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
            
            const uniqueResults = new Map();
            items.forEach(item => {
                const categoryName = item["nyaa:category"] || "";
                
                // POISON FILTER
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
            console.error(`[NYAA ERROR] Search failed via Tor: ${error.message}`);
            return [];
        }
    })();

    return fetchPromise;
}

module.exports = { searchNyaaForAnime };
