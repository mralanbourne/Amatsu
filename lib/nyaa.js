//===============
// AMATSU SCRAPING HUB - FAIL-FAST EDITION
// Base32 Decoder, Bencode Extraktor, Strict Timeouts
//===============

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const crypto = require("crypto");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || null;

const NYAA_MIRRORS = [
    "https://nyaa.si", 
    "https://nyaa.iss.one",
    "https://nyaa.net",
    "https://nyaa.tracker.wf",
    "https://nyaa.land"
];
let currentNyaaMirror = 0;

function getNextNyaaMirror() {
    currentNyaaMirror = (currentNyaaMirror + 1) % NYAA_MIRRORS.length;
    return NYAA_MIRRORS[currentNyaaMirror];
}

const parserConfig = { ignoreAttributes: false, attributeNamePrefix: "", processEntities: false };

function decodeEntities(text) {
    if (!text) return "";
    return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return "Unknown";
    const k = 1024; const dm = decimals < 0 ? 0 : decimals; const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function makeStrictQuery(query) {
    return query.replace(/\s+(\d+)$/, " - $1");
}

function decodeBase32InfoHash(base32) {
    if (!base32 || base32.length !== 32) return null;
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (let i = 0; i < base32.length; i++) {
        const val = chars.indexOf(base32.charAt(i).toUpperCase());
        if (val === -1) return null;
        bits += val.toString(2).padStart(5, "0");
    }
    let hex = "";
    for (let i = 0; i < bits.length; i += 4) {
        hex += parseInt(bits.substring(i, i + 4), 2).toString(16);
    }
    return hex.toLowerCase();
}

function getInfoHash(buffer) {
    if (!buffer || !Buffer.isBuffer(buffer)) return null;
    const infoIndex = buffer.indexOf(Buffer.from("4:info"));
    if (infoIndex === -1) return null;
    const start = infoIndex + 6; let i = start;
    function skip() {
        if (i >= buffer.length) return;
        const char = buffer[i];
        if (char === 0x69) { i++; while(buffer[i] !== 0x65 && i < buffer.length) i++; i++; }
        else if (char === 0x6c || char === 0x64) { i++; while(buffer[i] !== 0x65 && i < buffer.length) skip(); i++; }
        else if (char >= 0x30 && char <= 0x39) { let colon = i; while(buffer[colon] !== 0x3a && colon < buffer.length) colon++; const len = parseInt(buffer.toString("utf8", i, colon), 10); i = colon + 1 + len; } 
        else { throw new Error("Bencode Error"); }
    }
    try { skip(); const infoBuffer = buffer.slice(start, i); return crypto.createHash("sha1").update(infoBuffer).digest("hex"); }
    catch(e) { return null; }
}

async function solverRequest(url, isJson = false) {
    // Timeout drastisch reduziert, da Stremio ohnehin nicht lange wartet.
    if (!FLARESOLVERR_URL) {
        const res = await axios.get(url, { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } });
        return res.data;
    }
    try {
        const response = await axios.post(FLARESOLVERR_URL, { "cmd": "request.get", "url": url, "maxTimeout": 5000 }, { timeout: 6000 });
        const content = response.data?.solution?.response;
        if (isJson && typeof content === "string") return JSON.parse(content);
        return content;
    } catch (e) {
        const fallback = await axios.get(url, { timeout: 4000 });
        return fallback.data;
    }
}

function parseGenericRSS(xmlData, sourceName) {
    const parser = new XMLParser(parserConfig);
    const jsonObj = parser.parse(xmlData);
    const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
    
    return items.map(item => {
        let hash = ""; let torrentLink = "";
        const fullText = JSON.stringify(item);
        const hashMatch = fullText.match(/btih:([a-zA-Z0-9]{32,40})/i);
        const guid = item.guid?.["#text"] || item.guid || "";
        
        if (hashMatch) {
            let extracted = hashMatch[1];
            if (extracted.length === 32) extracted = decodeBase32InfoHash(extracted) || "";
            if (extracted.length === 40) hash = extracted.toLowerCase();
        } else if (item["nyaa:infoHash"]) {
            hash = item["nyaa:infoHash"].toLowerCase();
        } else if (guid && guid.length === 32 && !guid.includes("http")) {
            const decoded = decodeBase32InfoHash(guid);
            if (decoded && decoded.length === 40) hash = decoded;
        }

        const link = item.link || "";
        const enc = item.enclosure;
        const enclosureUrl = enc ? (enc.url || enc["@_url"] || enc["url"] || "") : "";

        if (!hash) {
            if (enclosureUrl && enclosureUrl.endsWith(".torrent")) torrentLink = enclosureUrl;
            else if (link.endsWith(".torrent")) torrentLink = link;
            else if (guid.endsWith(".torrent")) torrentLink = guid;
        }

        let size = item["nyaa:size"] || "Unknown";
        if (size === "Unknown") {
            const sizeMatch = fullText.match(/Size:\s*([\d.]+\s*[MGTK]?i?B)/i);
            if (sizeMatch) size = sizeMatch[1];
        }

        return {
            title: decodeEntities(item.title) || "Unknown",
            hash: hash, torrentLink: torrentLink,
            seeders: parseInt(item["nyaa:seeders"] || item.seeders || item.seeds, 10) || 0,
            size: size, source: sourceName
        };
    });
}

async function fillMissingHashes(results) {
    const missing = results.filter(r => !r.hash && r.torrentLink);
    if (missing.length === 0) return 0;
    
    let filled = 0;
    await Promise.all(missing.map(async (item) => {
        try {
            const tRes = await axios.get(item.torrentLink, { responseType: "arraybuffer", timeout: 3500 });
            const extracted = getInfoHash(tRes.data);
            if (extracted) { item.hash = extracted; filled++; }
        } catch(e) {}
    }));
    return filled;
}

//===============
// HILFSFUNKTION: TRACKER TIMEOUT WRAPPER
// Tötet einen hängenden Tracker nach exakt X Millisekunden
//===============
const withTimeout = (promise, ms, name) => {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => {
            console.log(`  ➔ [TRACKER] ⏱️ TIMEOUT: ${name} hat die Limitierung von ${ms}ms ueberschritten.`);
            resolve([]);
        }, ms))
    ]).catch(() => []);
};

//===============
// TRACKER IMPLEMENTIERUNGEN
//===============

async function searchNyaa(query) {
    let attempts = 0;
    while (attempts < 2) { // Absolutes Limit: Maximal 2 Mirrors testen, um Endlosschleife zu verhindern
        const domain = NYAA_MIRRORS[currentNyaaMirror];
        try {
            const data = await solverRequest(`${domain}/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0`);
            if (typeof data === "string" && !data.includes("<rss")) throw new Error("Cloudflare Block");
            
            const res = parseGenericRSS(data, "Nyaa").filter(i => i.hash);
            console.log(`  ➔ [TRACKER] Nyaa: ${res.length} Ergebnisse (via ${domain})`);
            return res;
        } catch(e) { 
            console.log(`  ➔ [TRACKER] ⚠️ Nyaa Error auf ${domain}, wechsle Mirror...`);
            getNextNyaaMirror();
            attempts++;
        }
    }
    return [];
}

async function searchAnimeTosho(query) {
    try {
        const results = await solverRequest(`https://feed.animetosho.org/json?qx=1&q=${encodeURIComponent(query)}`, true);
        if (!Array.isArray(results)) return [];
        const res = results.map(item => ({
            title: decodeEntities(item.title),
            hash: (item.info_hash || "").toLowerCase(),
            seeders: parseInt(item.seeders, 10) || 0,
            size: formatBytes(item.total_size),
            source: "AnimeTosho"
        })).filter(i => i.hash);
        console.log(`  ➔ [TRACKER] AnimeTosho: ${res.length} Ergebnisse`);
        return res;
    } catch(e) { return []; }
}

async function searchAniRena(query) {
    try {
        const data = await solverRequest(`https://www.anirena.com/rss?s=${encodeURIComponent(query)}`);
        if (typeof data === "string" && !data.includes("<rss")) throw new Error("Invalid XML");
        let results = parseGenericRSS(data, "AniRena");
        const filled = await fillMissingHashes(results);
        const res = results.filter(i => i.hash);
        console.log(`  ➔ [TRACKER] AniRena: ${res.length} Ergebnisse (${filled} via Bencode)`);
        return res;
    } catch(e) { return []; }
}

async function searchSubsPlease(query) {
    try {
        const strictQuery = makeStrictQuery(query);
        const data = await solverRequest(`https://subsplease.org/rss/?t&q=${encodeURIComponent(strictQuery)}`);
        if (typeof data === "string" && !data.includes("<rss")) throw new Error("Invalid XML");
        const res = parseGenericRSS(data, "SubsPlease").filter(i => i.hash);
        console.log(`  ➔ [TRACKER] SubsPlease: ${res.length} Ergebnisse`);
        return res;
    } catch(e) { return []; }
}

async function searchEraiRaws(query) {
    try {
        const strictQuery = makeStrictQuery(query);
        const data = await solverRequest(`https://www.erai-raws.info/rss-600/?type=all&query=${encodeURIComponent(strictQuery)}`);
        if (typeof data === "string" && !data.includes("<rss")) throw new Error("Invalid XML");
        const res = parseGenericRSS(data, "Erai-Raws").filter(i => i.hash);
        console.log(`  ➔ [TRACKER] Erai-Raws: ${res.length} Ergebnisse`);
        return res;
    } catch(e) { return []; }
}

async function searchTokyoTosho(query) {
    try {
        const data = await solverRequest(`https://www.tokyotosho.info/rss.php?terms=${encodeURIComponent(query)}&type=1`);
        if (typeof data === "string" && !data.includes("<rss")) throw new Error("Invalid XML");
        const res = parseGenericRSS(data, "TokyoTosho").filter(i => i.hash);
        console.log(`  ➔ [TRACKER] TokyoTosho: ${res.length} Ergebnisse`);
        return res;
    } catch(e) { return []; }
}

async function searchAcgRip(query) {
    try {
        const data = await solverRequest(`https://acg.rip/1.xml?term=${encodeURIComponent(query)}`);
        if (typeof data === "string" && !data.includes("<rss")) throw new Error("Invalid XML");
        let results = parseGenericRSS(data, "ACG.RIP");
        const filled = await fillMissingHashes(results);
        const res = results.filter(i => i.hash);
        console.log(`  ➔ [TRACKER] ACG.RIP: ${res.length} Ergebnisse`);
        return res;
    } catch(e) { return []; }
}

async function searchBangumiMoe(query) {
    try {
        const data = await solverRequest(`https://bangumi.moe/rss/latest?search=${encodeURIComponent(query)}`);
        if (typeof data === "string" && !data.includes("<rss")) throw new Error("Invalid XML");
        let results = parseGenericRSS(data, "Bangumi.moe");
        const filled = await fillMissingHashes(results);
        const res = results.filter(i => i.hash);
        console.log(`  ➔ [TRACKER] Bangumi.moe: ${res.length} Ergebnisse`);
        return res;
    } catch(e) { return []; }
}

//===============
// MAIN AGGREGATOR
//===============
async function searchNyaaForAnime(title) {
    if (!title || title.trim().length < 2) return [];
    const query = title.trim();
    const queryKey = query.toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) {
            console.log(`[SCRAPER] ⚡ Cache Hit fuer: "${query}" (${item.data.length} Torrents)`);
            return item.data;
        }
    }

    console.log(`[SCRAPER] 🚀 Starte Multi-Tracker Suche fuer: "${query}"`);
    
    // Maximale Wartezeit pro Tracker: 6500ms
    const trackers = [
        withTimeout(searchNyaa(query), 6500, "Nyaa"),
        withTimeout(searchAnimeTosho(query), 6500, "AnimeTosho"),
        withTimeout(searchAniRena(query), 6500, "AniRena"), 
        withTimeout(searchSubsPlease(query), 6500, "SubsPlease"),
        withTimeout(searchEraiRaws(query), 6500, "EraiRaws"),
        withTimeout(searchTokyoTosho(query), 6500, "TokyoTosho"),
        withTimeout(searchAcgRip(query), 6500, "AcgRip"),
        withTimeout(searchBangumiMoe(query), 6500, "BangumiMoe")
    ];

    const resultsArray = await Promise.all(trackers);
    const allTorrents = [].concat(...resultsArray);

    const uniqueTorrents = new Map();
    allTorrents.forEach(item => {
        if (!uniqueTorrents.has(item.hash) || item.seeders > uniqueTorrents.get(item.hash).seeders) {
            uniqueTorrents.set(item.hash, item);
        }
    });

    const finalResults = Array.from(uniqueTorrents.values()).sort((a, b) => b.seeders - a.seeders);
    console.log(`[SCRAPER] 🏆 Suche beendet. ${finalResults.length} eindeutige Torrents nach Deduplizierung.`);
    
    searchCache.set(queryKey, { data: finalResults, expiresAt: Date.now() + CACHE_TTL_MS });
    return finalResults;
}

module.exports = { searchNyaaForAnime };
