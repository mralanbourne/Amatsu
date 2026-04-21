//===============
// AMATSU SCRAPING HUB - OPTIMISTIC FETCHING EDITION
// Base32 Decoder, Bencode Extraktor, Smart Cloudflare Routing
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

function makeStrictQuery(query) { return query.replace(/\s+(\d+)$/, " - $1"); }

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
    for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.substring(i, i + 4), 2).toString(16);
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

//===============
// SMART REQUEST: Verhindert FlareSolverr Überlastung!
// Versucht direkten Abruf in < 500ms. Nutzt FlareSolverr nur bei Cloudflare-Blocks.
//===============
async function smartRequest(url, isJson = false, forceSolver = false) {
    if (!forceSolver) {
        try {
            const res = await axios.get(url, { timeout: 6000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
            if (typeof res.data === "string" && (res.data.includes("<title>Just a moment...</title>") || res.data.includes("cloudflare"))) {
                throw new Error("Cloudflare Challenge Detected");
            }
            return res.data;
        } catch (e) {
            if (!FLARESOLVERR_URL) return null;
            // Fällt durch und versucht es unten mit FlareSolverr
        }
    }

    if (FLARESOLVERR_URL) {
        try {
            const response = await axios.post(FLARESOLVERR_URL, {
                "cmd": "request.get",
                "url": url,
                "maxTimeout": 15000 
            }, { timeout: 18000 });
            
            const content = response.data?.solution?.response;
            if (isJson && typeof content === "string") return JSON.parse(content);
            return content;
        } catch (e) { return null; }
    }
    return null;
}

function parseGenericRSS(xmlData, sourceName) {
    if (!xmlData) return [];
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

        const link = item.link || ""; const enc = item.enclosure;
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
            const tRes = await axios.get(item.torrentLink, { responseType: "arraybuffer", timeout: 4000 });
            const extracted = getInfoHash(tRes.data);
            if (extracted) { item.hash = extracted; filled++; }
        } catch(e) {}
    }));
    return filled;
}

//===============
// TRACKER IMPLEMENTIERUNGEN
//===============

async function searchRealNyaa(query, reqId) {
    let attempts = 0;
    while (attempts < 2) { 
        const domain = NYAA_MIRRORS[currentNyaaMirror];
        try {
            // Nyaa ist IMMER hinter Cloudflare -> forceSolver = true
            const data = await smartRequest(`${domain}/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0`, false, true);
            if (!data || (typeof data === "string" && !data.includes("<rss"))) throw new Error("Cloudflare Block");
            
            const res = parseGenericRSS(data, "Nyaa").filter(i => i.hash);
            console.log(`[${reqId}] ➔ [TRACKER] Nyaa: ${res.length} Ergebnisse`);
            return res;
        } catch(e) { 
            getNextNyaaMirror(); attempts++;
        }
    }
    return [];
}

async function searchAnimeTosho(query, reqId) {
    // AnimeTosho ist extrem schnell und API-basiert -> forceSolver = false
    const results = await smartRequest(`https://feed.animetosho.org/json?qx=1&q=${encodeURIComponent(query)}`, true, false);
    if (!Array.isArray(results)) return [];
    const res = results.map(item => ({
        title: decodeEntities(item.title), hash: (item.info_hash || "").toLowerCase(),
        seeders: parseInt(item.seeders, 10) || 0, size: formatBytes(item.total_size), source: "AnimeTosho"
    })).filter(i => i.hash);
    console.log(`[${reqId}] ➔ [TRACKER] AnimeTosho: ${res.length} Ergebnisse`);
    return res;
}

async function searchTokyoTosho(query, reqId) {
    const data = await smartRequest(`https://www.tokyotosho.info/rss.php?terms=${encodeURIComponent(query)}&type=1`, false, false);
    if (!data || (typeof data === "string" && !data.includes("<rss"))) return [];
    const res = parseGenericRSS(data, "TokyoTosho").filter(i => i.hash);
    console.log(`[${reqId}] ➔ [TRACKER] TokyoTosho: ${res.length} Ergebnisse`);
    return res;
}

async function searchSubsPlease(query, reqId) {
    const strictQuery = makeStrictQuery(query);
    const data = await smartRequest(`https://subsplease.org/rss/?t&q=${encodeURIComponent(strictQuery)}`, false, false);
    if (!data || (typeof data === "string" && !data.includes("<rss"))) return [];
    const res = parseGenericRSS(data, "SubsPlease").filter(i => i.hash);
    console.log(`[${reqId}] ➔ [TRACKER] SubsPlease: ${res.length} Ergebnisse`);
    return res;
}

async function searchEraiRaws(query, reqId) {
    const strictQuery = makeStrictQuery(query);
    const data = await smartRequest(`https://www.erai-raws.info/rss-600/?type=all&query=${encodeURIComponent(strictQuery)}`, false, false);
    if (!data || (typeof data === "string" && !data.includes("<rss"))) return [];
    const res = parseGenericRSS(data, "Erai-Raws").filter(i => i.hash);
    console.log(`[${reqId}] ➔ [TRACKER] Erai-Raws: ${res.length} Ergebnisse`);
    return res;
}

async function searchAniRena(query, reqId) {
    const data = await smartRequest(`https://www.anirena.com/rss?s=${encodeURIComponent(query)}`, false, false);
    if (!data || (typeof data === "string" && !data.includes("<rss"))) return [];
    let results = parseGenericRSS(data, "AniRena");
    const filled = await fillMissingHashes(results);
    const res = results.filter(i => i.hash);
    console.log(`[${reqId}] ➔ [TRACKER] AniRena: ${res.length} Ergebnisse (${filled} via Bencode)`);
    return res;
}

async function searchAcgRip(query, reqId) {
    const data = await smartRequest(`https://acg.rip/1.xml?term=${encodeURIComponent(query)}`, false, false);
    if (!data || (typeof data === "string" && !data.includes("<rss"))) return [];
    let results = parseGenericRSS(data, "ACG.RIP");
    const filled = await fillMissingHashes(results);
    const res = results.filter(i => i.hash);
    console.log(`[${reqId}] ➔ [TRACKER] ACG.RIP: ${res.length} Ergebnisse`);
    return res;
}

async function searchBangumiMoe(query, reqId) {
    const data = await smartRequest(`https://bangumi.moe/rss/latest?search=${encodeURIComponent(query)}`, false, false);
    if (!data || (typeof data === "string" && !data.includes("<rss"))) return [];
    let results = parseGenericRSS(data, "Bangumi.moe");
    const filled = await fillMissingHashes(results);
    const res = results.filter(i => i.hash);
    console.log(`[${reqId}] ➔ [TRACKER] Bangumi.moe: ${res.length} Ergebnisse`);
    return res;
}

//===============
// MAIN AGGREGATOR
//===============
async function searchNyaaForAnime(title, reqId = "SYS") {
    if (!title || title.trim().length < 2) return [];
    const query = title.trim();
    const queryKey = query.toLowerCase();
    
    if (searchCache.has(queryKey)) {
        const item = searchCache.get(queryKey);
        if (item.expiresAt > Date.now()) return item.data;
    }

    console.log(`[${reqId}] 🚀 Suche für: "${query}"`);
    
    // Alle Abfragen laufen komplett parallel ab. Dank Optimistic Fetching stirbt FlareSolverr nicht mehr!
    const tasks = [
        searchRealNyaa(query, reqId).catch(() => []),
        searchAnimeTosho(query, reqId).catch(() => []),
        searchTokyoTosho(query, reqId).catch(() => []),
        searchSubsPlease(query, reqId).catch(() => []),
        searchEraiRaws(query, reqId).catch(() => []),
        searchAniRena(query, reqId).catch(() => []),
        searchAcgRip(query, reqId).catch(() => []),
        searchBangumiMoe(query, reqId).catch(() => [])
    ];

    const resultsArray = await Promise.all(tasks);
    const allTorrents = [].concat(...resultsArray);

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
