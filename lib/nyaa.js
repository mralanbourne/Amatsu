//===============
// AMATSU NYAA SCRAPER
// (FlareSolverr Selective Tunneling + Parallel Execution + Micro-Queues)
//===============

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const http = require("http");
const https = require("https");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || null;

//===============
// CONNECTION POOLING (KEEP-ALIVE)
// Nur noch für AnimeTosho & FlareSolverr. TokyoTosho mag kein Keep-Alive.
//===============
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 15 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 15 });
const scraperClient = axios.create({ httpAgent, httpsAgent });

//===============
// PARSER KONFIGURATION
// processEntities: false verhindert den "Entity expansion limit exceeded" Fehler komplett!
//===============
const parserConfig = {
    ignoreAttributes: false,
    attributeNamePrefix: "",
    processEntities: false 
};

function decodeEntities(text) {
    if (!text) return "";
    return text.replace(/&amp;/g, "&")
               .replace(/&lt;/g, "<")
               .replace(/&gt;/g, ">")
               .replace(/&quot;/g, "\"")
               .replace(/&#39;/g, "\"");
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return "Unknown";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

//===============
// TIMEOUT WRAPPER
//===============
function withTimeout(promise, ms) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error("Timeout exceeded after " + ms + "ms"));
        }, ms);
    });

    return Promise.race([
        promise.finally(() => clearTimeout(timeoutId)),
        timeoutPromise
    ]);
}

//===============
// FLARESOLVERR TUNNEL (NUR FÜR NYAA)
//===============
async function solverRequest(url) {
    if (!FLARESOLVERR_URL) {
        const res = await scraperClient.get(url, {
            timeout: 8000,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        return res.data;
    }

    try {
        const response = await scraperClient.post(FLARESOLVERR_URL, {
            "cmd": "request.get",
            "url": url,
            "maxTimeout": 15000
        }, { timeout: 18000 });

        const content = response.data?.solution?.response;
        return content;
    } catch (e) {
        const fallback = await scraperClient.get(url, { timeout: 8000 });
        return fallback.data;
    }
}

//===============
// TOKYOTOSHO ANTI-500 QUEUE
// Beschränkt TokyoTosho isoliert auf max. 2 parallele Requests und zwingt
// einen automatischen Retry bei 5xx Fehlern auf.
//===============
const tokyoToshoQueue = [];
let activeTokyoTosho = 0;
const MAX_TOKYO_CONCURRENT = 2;

async function enqueueTokyoTosho(url) {
    return new Promise((resolve, reject) => {
        const task = async () => {
            activeTokyoTosho++;
            let attempt = 0;
            let successData = null;
            let lastError = null;

            while (attempt < 2) {
                try {
                    // WICHTIG: Standard axios verwenden, KEIN scraperClient (kein Keep-Alive)
                    const res = await axios.get(url, {
                        timeout: 6000,
                        headers: { 
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            "Accept": "application/rss+xml, application/xml, text/xml, */*"
                        }
                    });
                    successData = res.data;
                    break; // Erfolgreich, Schleife abbrechen
                } catch (err) {
                    lastError = err;
                    attempt++;
                    const status = err.response ? err.response.status : null;
                    
                    // Nur bei 5xx Server-Fehlern oder Timeouts einen Retry durchführen
                    if (attempt >= 2 || (status !== 500 && status !== 502 && status !== 503 && status !== 504 && !err.code)) {
                        break; 
                    }
                    
                    // 800ms warten, bevor der zweite Versuch startet
                    await new Promise(r => setTimeout(r, 800));
                }
            }

            activeTokyoTosho--;

            if (tokyoToshoQueue.length > 0) {
                // 250ms künstliches Delay zwischen den Requests um Micro-Bursts zu verhindern
                setTimeout(() => {
                    const nextTask = tokyoToshoQueue.shift();
                    nextTask();
                }, 250);
            }

            if (successData) resolve(successData);
            else reject(lastError);
        };

        if (activeTokyoTosho < MAX_TOKYO_CONCURRENT) {
            task();
        } else {
            tokyoToshoQueue.push(task);
        }
    });
}

//===============
// TRACKER IMPLEMENTIERUNGEN
//===============

async function searchRealNyaa(query) {
    try {
        const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0`;
        const data = await solverRequest(url);
        
        const parser = new XMLParser(parserConfig);
        const jsonObj = parser.parse(data);
        const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
        
        return items.map(item => ({
            title: decodeEntities(item.title) || "Unknown",
            hash: (item["nyaa:infoHash"] || "").toLowerCase(),
            seeders: parseInt(item["nyaa:seeders"], 10) || 0,
            size: item["nyaa:size"] || "Unknown"
        })).filter(i => i.hash && i.hash.length === 40);
    } catch(e) { throw new Error(`Nyaa: ${e.message}`); }
}

async function searchAnimeTosho(query) {
    try {
        const url = `https://feed.animetosho.org/json?qx=1&q=${encodeURIComponent(query)}`;
        // AnimeTosho nutzt weiterhin die schnelle Keep-Alive Verbindung
        const res = await scraperClient.get(url, { timeout: 6000 });
        const results = res.data;
        
        if (!Array.isArray(results)) return [];
        
        return results.map(item => ({
            title: decodeEntities(item.title),
            hash: (item.info_hash || "").toLowerCase(),
            seeders: parseInt(item.seeders, 10) || 0,
            size: item.total_size ? formatBytes(item.total_size) : "Unknown"
        })).filter(i => i.hash && i.hash.length === 40);
    } catch(e) { throw new Error(`AnimeTosho: ${e.message}`); }
}

async function searchTokyoTosho(query) {
    try {
        const url = `https://www.tokyotosho.info/rss.php?terms=${encodeURIComponent(query)}&type=0`;
        // TokyoTosho nutzt nun die dedizierte Micro-Queue mit Retry-Logik
        const data = await enqueueTokyoTosho(url);
        
        const parser = new XMLParser(parserConfig);
        const jsonObj = parser.parse(data);
        const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
        
        return items.map(item => {
            let hash = "";
            const link = item.link || "";
            if (link.includes("btih:")) hash = link.split("btih:")[1].split("&")[0].toLowerCase();
            const sizeMatch = (item.description || "").match(/Size:\s*([\d.]+\s*[MGTK]?B)/i);
            return {
                title: decodeEntities(item.title) || "Unknown",
                hash: hash,
                seeders: 0, 
                size: sizeMatch ? sizeMatch[1] : "Unknown"
            };
        }).filter(i => i.hash && i.hash.length === 40);
    } catch(e) { throw new Error(`TokyoTosho: ${e.message}`); }
}

//===============
// MAIN SEARCH CONTROLLER
//===============
async function searchNyaaForAnime(title) {
    if (!title || title.trim().length < 2) return [];
    const query = title.replace(/\s+/g, " ").trim();
    const queryKey = query.toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) return item.data;
    }

    console.log(`[SCRAPER] 🚀 Suche für: "${query}"`);
    const allTorrents = [];
    const trackers = [
        { name: "Nyaa", fn: searchRealNyaa },
        { name: "AnimeTosho", fn: searchAnimeTosho },
        { name: "TokyoTosho", fn: searchTokyoTosho }
    ];

    const MAX_TRACKER_TIME = 12000;
    
    const results = await Promise.allSettled(
        trackers.map(tracker => 
            withTimeout(tracker.fn(query), MAX_TRACKER_TIME)
                .then(res => ({ name: tracker.name, data: res }))
                .catch(err => { throw { name: tracker.name, error: err }; })
        )
    );

    for (const result of results) {
        if (result.status === "fulfilled" && result.value.data) {
            allTorrents.push(...result.value.data);
        } else if (result.status === "rejected") {
            console.log(`[SCRAPER] ⚠️ ${result.reason.name} Fehler/Timeout: ${result.reason.error.message}`);
        }
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
