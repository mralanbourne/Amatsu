//===============
// AMATSU NYAA SCRAPER
// Accesses the standard Nyaa RSS feed directly and processes the torrents.
// Includes a dynamic Proxy Rotator to bypass Cloudflare and 429 IP bans.
//===============

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

//===============
// IN-MEMORY CACHE
//===============

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;
const MAX_CACHE_ENTRIES = 2000;

//===============
// PROXY ROTATOR CONFIGURATION
//===============
let PROXIES = [
    "https://nyaa.si",
    "https://nyaa.iss.one"
];

if (process.env.NYAA_DOMAIN) {
    PROXIES.unshift(process.env.NYAA_DOMAIN.replace(/\/+$/, ""));
    PROXIES = [...new Set(PROXIES)];
}

let currentProxyIndex = 0;
    
function setNyaaCache(key, dataOrPromise) {
    if (searchCache.has(key)) {
        searchCache.delete(key);
    } else if (searchCache.size >= MAX_CACHE_ENTRIES) {
        searchCache.delete(searchCache.keys().next().value);
    }
    searchCache.set(key, {
        "data": dataOrPromise,
        "expiresAt": Date.now() + CACHE_TTL_MS
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

//===============
// SEARCH QUERY OPTIMIZER
//===============
function generateSearchQueries(title) {
    const queries = new Set();
    if (!title) return [];
    queries.add(title.trim());
    
    const delimiters = /[:!\-~]/;
    if (delimiters.test(title)) {
        const shortTitle = title.split(delimiters)[0].trim();
        if (shortTitle && shortTitle.length > 2) {
            queries.add(shortTitle);
        }
    }
    return Array.from(queries);
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
        const queries = generateSearchQueries(romajiTitle);
        const allItems = [];

        for (const query of queries) {
            const encodedQuery = encodeURIComponent(query);
            let querySuccess = false;
            let proxyAttempts = 0;

            //===============
            // PROXY ROTATION LOOP
            //===============
            while (!querySuccess && proxyAttempts < PROXIES.length) {
                const activeProxy = PROXIES[currentProxyIndex];
                const rssUrl = activeProxy + "/?page=rss&c=0_0&f=0&q=" + encodedQuery + "&s=seeders&o=desc";

                try {
                    console.log("[NYAA NETWORK] Executing query on " + activeProxy + ": " + query);
                    
                    const response = await axios.get(rssUrl, {
                        "timeout": 8000,
                        "headers": { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36" }
                    });

                    if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
                        throw new Error("Cloudflare HTML block received.");
                    }

                    const parser = new XMLParser({ "ignoreAttributes": true });
                    const jsonObj = parser.parse(response.data);
                    const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
                    
                    if (Array.isArray(items)) {
                        allItems.push(...items);
                    }
                    
                    querySuccess = true; 
                    
                } catch (error) {
                    const status = error.response ? error.response.status : error.message;
                    console.warn("[NYAA ERROR] Query failed on " + activeProxy + " for \"" + query + "\": " + status);
                    
                    currentProxyIndex = (currentProxyIndex + 1) % PROXIES.length;
                    proxyAttempts++;
                }
            }
            
            if (queries.indexOf(query) < queries.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        if (allItems.length === 0) {
            searchCache.delete(queryKey);
            return [];
        }

        const uniqueResults = new Map();

        allItems.forEach(item => {
            const category = item["nyaa:categoryId"] || "";
            if (!category.startsWith("1_") && !category.startsWith("4_")) {
                return;
            }

            const hash = item["nyaa:infoHash"] ? item["nyaa:infoHash"].toLowerCase() : null;
            if (!hash || uniqueResults.has(hash)) return;

            let rawSize = item["nyaa:size"] || "Unknown";
            if (typeof rawSize === "string" && (rawSize.includes("NOT_INDEX") || rawSize === "Unknown")) {
                rawSize = "? GB"; 
            }

            let seeders = parseInt(item["nyaa:seeders"], 10);
            if (isNaN(seeders)) {
                seeders = 0; 
            }

            uniqueResults.set(hash, {
                "title": item.title || "Unknown Release",
                "hash": hash,
                "seeders": seeders,
                "size": rawSize
            });
        });

        const results = Array.from(uniqueResults.values()).sort((a, b) => b.seeders - a.seeders);

        setNyaaCache(queryKey, results);
        return results;

    })();

    setNyaaCache(queryKey, fetchPromise);
    return fetchPromise;
}

module.exports = { searchNyaaForAnime, cleanTorrentTitle };
