//===============
// AMATSU NYAA SCRAPER - WORKER EDITION
//===============

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;
const MAX_CACHE_ENTRIES = 2000;

const WORKER_URL = process.env.NYAA_WORKER_URL;

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
        const baseUrl = WORKER_URL || "https://nyaa.si";
        const encodedQuery = encodeURIComponent(romajiTitle);
        const rssUrl = `${baseUrl}/?q=${encodedQuery}&s=seeders&o=desc&c=1_0`;

        try {
            console.log(`[NYAA NETWORK] Searching via ${WORKER_URL ? 'Cloudflare Worker' : 'Direct'}: ${romajiTitle}`);
            
            const response = await axios.get(rssUrl, {
                timeout: 10000,
                headers: { "User-Agent": "Amatsu-Addon/1.0" }
            });

            if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
                throw new Error("Cloudflare block on Worker (unlikely) or Direct IP");
            }

            const parser = new XMLParser({ ignoreAttributes: true });
            const jsonObj = parser.parse(response.data);
            const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
            
            const uniqueResults = new Map();
            items.forEach(item => {
                const categoryName = item["nyaa:category"] || "";
                
                // POISON FILTER:
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
            console.error(`[NYAA ERROR] Worker Search failed: ${error.message}`);
            return [];
        }
    })();

    return fetchPromise;
}

module.exports = { searchNyaaForAnime };
