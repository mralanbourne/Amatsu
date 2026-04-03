//===============
// AMATSU NYAA SCRAPER
// Accesses the standard Nyaa RSS feed directly and processes the torrents.
//===============

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

//===============
// IN-MEMORY CACHE & PROMISE DEDUPING
// high-performance LRU cache to prevent memory leaks and handle concurrent requests from Stremio.
//===============

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;
const MAX_CACHE_ENTRIES = 2000;
	
function setNyaaCache(key, dataOrPromise) {
    if (searchCache.has(key)) {
        searchCache.delete(key);
    } else if (searchCache.size >= MAX_CACHE_ENTRIES) {
        searchCache.delete(searchCache.keys().next().value);
    }
    searchCache.set(key, {
        data: dataOrPromise,
        expiresAt: Date.now() + CACHE_TTL_MS
    });
}

function getNyaaCache(key) {
    if (searchCache.has(key)) {
        const item = searchCache.get(key);
        if (item.expiresAt > Date.now()) {
            searchCache.delete(key);
            searchCache.set(key, item);
            return item;
        } else {
            searchCache.delete(key);
        }
    }
    return null;
}

function cleanTorrentTitle(title) {
    let clean = title;
    clean = clean.replace(/\[.*?\]/g, "");
    clean = clean.replace(/\(.*?\)/g, "");
    clean = clean.replace(/\.(mkv|mp4|avi|wmv|ts|flv)$/i, "");
    clean = clean.replace(/\s+-\s+\d{1,3}\b/g, "");
    clean = clean.replace(/\b(?:Ep|Episode|E)\s*\d+\b/ig, "");
    clean = clean.replace(/\b(1080p|720p|4k|FHD|HD|SD|Uncensored|Decensored|Eng Sub|Raw|Subbed|Censored)\b/ig, "");
    clean = clean.replace(/_/g, " ").replace(/\s{2,}/g, " ").trim();
    
    return clean || title; 
}

async function searchNyaaForAnime(romajiTitle) {
    if (!romajiTitle || romajiTitle.trim().length < 3) {
        return [];
    }

    const queryKey = romajiTitle.trim().toLowerCase();
    const cachedItem = getNyaaCache(queryKey);

    if (cachedItem) {
        console.log("[NYAA CACHE HIT] Loading from RAM: " + queryKey);
        return cachedItem.data;
    }

    const fetchPromise = (async () => {
        const encodedQuery = encodeURIComponent(romajiTitle);

        const rssUrl = "https://nyaa.si/?page=rss&c=0_0&f=0&q=" + encodedQuery + "&s=seeders&o=desc";

        try {
            console.log("[NYAA NETWORK] Starting fresh query for: " + queryKey);
            
            const response = await axios.get(rssUrl, {
                timeout: 12000,
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36" }
            });

            if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
                throw new Error("Cloudflare Rate-Limit HTML block received.");
            }

            const parser = new XMLParser({ ignoreAttributes: true });
            const jsonObj = parser.parse(response.data);
            const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];

            const results = items.reduce((acc, item) => {
                const category = item["nyaa:categoryId"] || "";
                
                if (!category.startsWith("1_") && !category.startsWith("4_")) {
                    return acc;
                }

                let rawSize = item["nyaa:size"] || "Unknown";
                if (typeof rawSize === "string" && (rawSize.includes("NOT_INDEX") || rawSize === "Unknown")) {
                    rawSize = "? GB"; 
                }

                let seeders = parseInt(item["nyaa:seeders"], 10);
                if (isNaN(seeders)) {
                    seeders = 0; 
                }

                const hash = item["nyaa:infoHash"] ? item["nyaa:infoHash"].toLowerCase() : null;
                
                if (hash) {
                    acc.push({
                        title: item.title || "Unknown Release",
                        hash: hash,
                        seeders: seeders,
                        size: rawSize
                    });
                }
                
                return acc;
            }, []).sort((a, b) => b.seeders - a.seeders);

            setNyaaCache(queryKey, results);
            return results;

        } catch (error) {
            console.error("[NYAA ERROR] Aborted for " + romajiTitle + ": " + error.message);
            searchCache.delete(queryKey);
            return [];
        }
    })();

    setNyaaCache(queryKey, fetchPromise);
    return fetchPromise;
}

module.exports = { searchNyaaForAnime, cleanTorrentTitle };
