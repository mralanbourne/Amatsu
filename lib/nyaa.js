//===============
// AMATSU SCRAPING HUB - BULLETPROOF EDITION
// (Aggressives Hash-Hunting, Auto-Bencode-Fallback für alle Tracker)
//===============

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const crypto = require("crypto");

const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || null;

const NYAA_MIRRORS = ["https://nyaa.si", "https://nyaa.iss.one"];
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
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Bencode Extraktor für Tracker ohne Magnet-Links (z.B. ACG.RIP, AniRena)
function getInfoHash(buffer) {
    if (!buffer || !Buffer.isBuffer(buffer)) return null;
    const infoIndex = buffer.indexOf(Buffer.from("4:info"));
    if (infoIndex === -1) return null;
    const start = infoIndex + 6;
    let i = start;
    function skip() {
        if (i >= buffer.length) return;
        const char = buffer[i];
        if (char === 0x69) { i++; while(buffer[i] !== 0x65 && i < buffer.length) i++; i++; }
        else if (char === 0x6c || char === 0x64) { i++; while(buffer[i] !== 0x65 && i < buffer.length) skip(); i++; }
        else if (char >= 0x30 && char <= 0x39) {
            let colon = i; while(buffer[colon] !== 0x3a && colon < buffer.length) colon++;
            const len = parseInt(buffer.toString("utf8", i, colon), 10); i = colon + 1 + len;
        } else { throw new Error("Bencode Error"); }
    }
    try { skip(); const infoBuffer = buffer.slice(start, i); return crypto.createHash("sha1").update(infoBuffer).digest("hex"); }
    catch(e) { return null; }
}

async function solverRequest(url, isJson = false) {
    if (!FLARESOLVERR_URL) {
        const res = await axios.get(url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
        return res.data;
    }
    try {
        const response = await axios.post(FLARESOLVERR_URL, { "cmd": "request.get", "url": url, "maxTimeout": 60000 }, { timeout: 65000 });
        const content = response.data?.solution?.response;
        if (isJson && typeof content === "string") return JSON.parse(content);
        return content;
    } catch (e) {
        const fallback = await axios.get(url, { timeout: 8000 });
        return fallback.data;
    }
}

//===============
// DER NEUE, AGGRESSIVE XML PARSER
//===============
function parseGenericRSS(xmlData, sourceName) {
    const parser = new XMLParser(parserConfig);
    const jsonObj = parser.parse(xmlData);
    const items = jsonObj?.rss?.channel?.item ? (Array.isArray(jsonObj.rss.channel.item) ? jsonObj.rss.channel.item : [jsonObj.rss.channel.item]) : [];
    
    return items.map(item => {
        let hash = "";
        let torrentLink = "";
        
        const link = item.link || "";
        const guid = item.guid?.["#text"] || item.guid || "";
        const desc = item.description || "";
        const enclosure = item.enclosure?.url || "";

        // 1. Aggressiv nach 'btih:' (InfoHash) im gesamten String suchen (Fixt TokyoTosho!)
        const fullText = `${link} ${guid} ${desc} ${enclosure}`;
        const hashMatch = fullText.match(/btih:([a-fA-F0-9]{40})/i);
        if (hashMatch) {
            hash = hashMatch[1].toLowerCase();
        } else if (item["nyaa:infoHash"]) {
            hash = item["nyaa:infoHash"].toLowerCase();
        }

        // 2. Fallback-Download Link für Bencode (Fixt ACG.RIP!)
        if (!hash) {
            if (enclosure.endsWith(".torrent")) torrentLink = enclosure;
            else if (link.endsWith(".torrent")) torrentLink = link;
            else if (guid.endsWith(".torrent")) torrentLink = guid;
        }

        // 3. Dateigröße finden
        let size = item["nyaa:size"] || "Unknown";
        if (size === "Unknown") {
            const sizeMatch = desc.match(/Size:\s*([\d.]+\s*[MGTK]?i?B)/i);
            if (sizeMatch) size = sizeMatch[1];
        }

        return {
            title: decodeEntities(item.title) || "Unknown",
            hash: hash,
            torrentLink: torrentLink,
            seeders: parseInt(item["nyaa:seeders"] || item.seeders || item.seeds, 10) || 0,
            size: size,
            source: sourceName
        };
    });
}

//===============
// AUTO-BENCODE FILLER
//===============
async function fillMissingHashes(results) {
    const missing = results.filter(r => !r.hash && r.torrentLink);
    if (missing.length === 0) return 0;
    
    let filled = 0;
    await Promise.all(missing.map(async (item) => {
        try {
            const tRes = await axios.get(item.torrentLink, { responseType: "arraybuffer", timeout: 4500 });
            const extracted = getInfoHash(tRes.data);
            if (extracted) { item.hash = extracted; filled++; }
        } catch(e) {}
    }));
    return filled;
}


//===============
// TRACKER IMPLEMENTIERUNGEN MIT KORREKTEN PARAMETERN
//===============

async function searchNyaa(query) {
    const domain = NYAA_MIRRORS[currentNyaaMirror];
    try {
        const data = await solverRequest(`${domain}/?page=rss&q=${encodeURIComponent(query)}&c=0_0&f=0`);
        const res = parseGenericRSS(data, "Nyaa").filter(i => i.hash);
        console.log(`  ➔ [TRACKER] Nyaa: ${res.length} Ergebnisse`);
        return res;
    } catch(e) { 
        console.log(`  ➔ [TRACKER] ⚠️ Nyaa Error, wechsle Mirror...`);
        getNextNyaaMirror(); return []; 
    }
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
        let results = parseGenericRSS(data, "AniRena");
        const filled = await fillMissingHashes(results);
        const res = results.filter(i => i.hash);
        console.log(`  ➔ [TRACKER] AniRena: ${res.length} Ergebnisse (${filled} via Bencode)`);
        return res;
    } catch(e) { return []; }
}

async function searchSubsPlease(query) {
    try {
        const data = await solverRequest(`https://subsplease.org/rss/?t&q=${encodeURIComponent(query)}`);
        const res = parseGenericRSS(data, "SubsPlease").filter(i => i.hash);
        console.log(`  ➔ [TRACKER] SubsPlease: ${res.length} Ergebnisse`);
        return res;
    } catch(e) { return []; }
}

async function searchEraiRaws(query) {
    try {
        // Fix: Erai-Raws nutzt ?s= statt ?query=
        const data = await solverRequest(`https://www.erai-raws.info/feed/?s=${encodeURIComponent(query)}`);
        const res = parseGenericRSS(data, "Erai-Raws").filter(i => i.hash);
        console.log(`  ➔ [TRACKER] Erai-Raws: ${res.length} Ergebnisse`);
        return res;
    } catch(e) { return []; }
}

async function searchTokyoTosho(query) {
    try {
        // Fix: terms= für TokyoTosho
        const data = await solverRequest(`https://www.tokyotosho.info/rss.php?terms=${encodeURIComponent(query)}&type=1`);
        const res = parseGenericRSS(data, "TokyoTosho").filter(i => i.hash);
        console.log(`  ➔ [TRACKER] TokyoTosho: ${res.length} Ergebnisse`);
        return res;
    } catch(e) { return []; }
}

async function searchAcgRip(query) {
    try {
        // Fix: term= für ACG.RIP
        const data = await solverRequest(`https://acg.rip/1.xml?term=${encodeURIComponent(query)}`);
        let results = parseGenericRSS(data, "ACG.RIP");
        const filled = await fillMissingHashes(results);
        const res = results.filter(i => i.hash);
        console.log(`  ➔ [TRACKER] ACG.RIP: ${res.length} Ergebnisse (${filled} via Bencode)`);
        return res;
    } catch(e) { return []; }
}

async function searchBangumiMoe(query) {
    try {
        const data = await solverRequest(`https://bangumi.moe/rss/latest?search=${encodeURIComponent(query)}`);
        let results = parseGenericRSS(data, "Bangumi.moe");
        const filled = await fillMissingHashes(results);
        const res = results.filter(i => i.hash);
        console.log(`  ➔ [TRACKER] Bangumi.moe: ${res.length} Ergebnisse (${filled} via Bencode)`);
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
            console.log(`[SCRAPER] ⚡ Cache Hit für: "${query}" (${item.data.length} Torrents)`);
            return item.data;
        }
    }

    console.log(`[SCRAPER] 🚀 Starte Multi-Tracker Suche für: "${query}"`);
    const trackers = [
        searchNyaa, searchAnimeTosho, searchAniRena, 
        searchSubsPlease, searchEraiRaws, searchTokyoTosho,
        searchAcgRip, searchBangumiMoe
    ];

    const resultsArray = await Promise.all(trackers.map(fn => fn(query).catch(() => [])));
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
