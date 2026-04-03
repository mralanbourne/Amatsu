//===============
// AMATSU STREMIO ADDON - CORE LOGIC
// Centralized logic for Stremio handlers with robust error handling.
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getJikanMeta, fetchEpisodeDetails } = require("./lib/anilist");
const { searchNyaaForAnime, cleanTorrentTitle } = require("./lib/nyaa");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile } = require("./lib/parser");

let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7002";
BASE_URL = BASE_URL.replace(/\/+$/, "");

function toBase64Safe(str) {
    return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64Safe(str) {
    try {
        return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch (e) {
        return "";
    }
}

//===============
// ADDON MANIFEST
//===============
const manifest = {
    id: "org.community.amatsu",
    version: "6.8.0", 
    name: "Amatsu",
    logo: BASE_URL + "/amatsu.png", 
    description: "The ultimate Debrid-powered Nyaa gateway. Smart-parsing and targeted search routing for Anime.",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["amatsu:", "anilist:", "nyaa:"],
    catalogs: [
        { id: "amatsu_trending", type: "series", name: "Amatsu Trending" },
        { id: "amatsu_trending", type: "movie", name: "Amatsu Trending" },
        { id: "amatsu_top", type: "series", name: "Amatsu Top Rated" },
        { id: "amatsu_top", type: "movie", name: "Amatsu Top Rated" },

        { id: "amatsu_search", type: "series", name: "Amatsu Search", extra: [{ name: "search", isRequired: true }] },
        { id: "amatsu_search", type: "movie", name: "Amatsu Search", extra: [{ name: "search", isRequired: true }] }
    ],
    config: [
        { key: "Amatsu", type: "text", title: "Amatsu Internal Payload", required: false }
    ],
    behaviorHints: { configurable: true, configurationRequired: true },
    stremioAddonsConfig: {
        issuer: "https://stremio-addons.net",
        signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..5hpukX-AKAcOLTxpQ18hYg.syyrg4fQnbdNs0yua4AQknUXvoHTLvj11tMeCAtIaUdTAhdYF8r6F16tEVeWgx7m4yaCGi9gIMd0YD13nbBjPHPJGAe8GbxdO0SI0w6h8lRSeKkwP6Mes8hZnKPK5YNs.GSbCSwFj3Thfj-NYgZlj4g"
    }
};

const builder = new addonBuilder(manifest);

function parseConfig(config) {
    let parsed = {};
    try {
        if (config && config.Amatsu) {
            let b64 = config.Amatsu.replace(/-/g, "+").replace(/_/g, "/");
            while (b64.length % 4) { b64 += "="; } 
            const decoded = Buffer.from(b64, "base64").toString("utf8");
            parsed = JSON.parse(decoded);
        } else {
            parsed = config || {};
        }
    } catch (err) {
        console.error("[Config] Error parsing config:", err.message);
    }
    return parsed || {};
}

function parseSizeToBytes(sizeStr) {
    if (!sizeStr || typeof sizeStr !== "string") return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|GiB|MiB|KiB|B)/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit.includes("G")) return val * 1024 * 1024 * 1024;
    if (unit.includes("M")) return val * 1024 * 1024;
    return val * 1024;
}

function extractTags(title) {
    let res = "SD";
    if (/(1080p|1080|FHD)/i.test(title)) res = "1080p";
    else if (/(720p|720|HD)/i.test(title)) res = "720p";
    else if (/(2160p|4k|UHD)/i.test(title)) res = "4K";
    return { res };
}

function extractLanguage(title) {
    const lower = title.toLowerCase();
    if (/(multi|dual|multi-audio|multi-sub)/i.test(lower)) return "MULTI";
    if (/\b(ger|deu|german|deutsch)\b/i.test(lower)) return "GER";
    if (/\b(eng|english|subbed)\b/i.test(lower)) return "ENG";
    if (/\b(jpn|japanese|raw)\b/i.test(lower)) return "JPN";
    return "ENG"; 
}

function sanitizeSearchQuery(title) {
    return title.replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "").replace(/\s{2,}/g, " ").trim();
}

//===============
// STREMIO HANDLERS
//===============

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    try {
        const userConfig = parseConfig(config);
        
        if (id === "amatsu_trending") {
            const metas = await getTrendingAnime();
            return { metas: metas.filter(m => m.type === type), cacheMaxAge: 43200 };
        }
        
        if (id === "amatsu_top") {
            const metas = await getTopAnime();
            return { metas: metas.filter(m => m.type === type), cacheMaxAge: 43200 };
        }
        
        if (id === "amatsu_search" && extra.search) {
            const [anilistMetas, nyaaTorrents] = await Promise.all([
                searchAnime(extra.search).catch(() => []), 
                searchNyaaForAnime(extra.search).catch(() => [])
            ]);
            
            const finalMetas = (anilistMetas || []).map(m => ({ ...m }));
            
            const filteredMetas = finalMetas.filter(m => m.type === type);
            return { metas: filteredMetas, cacheMaxAge: 86400 };
        }
        
        return { metas: [] };
    } catch (err) {
        console.error("[Catalog] Critical error:", err);
        return { metas: [] };
    }
});

builder.defineMetaHandler(async ({ id }) => {
    try {
        if (!id.startsWith("amatsu:") && !id.startsWith("anilist:") && !id.startsWith("nyaa:")) return { meta: null };

        const parts = id.split(":");
        const aniListId = parts[1];
        if (!aniListId || aniListId === "search" || aniListId === "trending") return { meta: null };

        const rawMeta = await getAnimeMeta(aniListId);
        if (!rawMeta) return { meta: null };
        
        if (rawMeta.type === "series") {
            let epCount = rawMeta.episodes || 12;
            const videos = [];
            for (let i = 1; i <= epCount; i++) {
                videos.push({ id: id + ":1:" + i, title: "Episode " + i, season: 1, episode: i });
            }
            rawMeta.videos = videos;
        }
        
        return { meta: rawMeta, cacheMaxAge: 604800 };
    } catch (err) {
        console.error("[Meta] Critical error:", err);
        return { meta: null };
    }
});

builder.defineStreamHandler(async ({ type, id, config }) => {
    try {
        if (!id.startsWith("amatsu:") && !id.startsWith("anilist:") && !id.startsWith("nyaa:")) return { streams: [] };
        
        const userConfig = parseConfig(config);
        if (!userConfig.rdKey && !userConfig.tbKey) return { streams: [] };

        const parts = id.split(":");
        const aniListId = parts[1];

        const requestedEp = parseInt(parts[parts.length - 1], 10) || 1;
        
        const freshMeta = await getAnimeMeta(aniListId);
        if (!freshMeta) return { streams: [] };
        const searchTitle = sanitizeSearchQuery(freshMeta.name);

        // SEASON EXTRACTION ENGINE
        const extractSeason = (t) => {
            const dynMatch = t.match(/\b(?:S|Season|Part|Cour|Dai|Di)\s*0*(\d+)(?:-?ki|-?ji|-?shou)?\b/i);
            if (dynMatch) return parseInt(dynMatch[1], 10);
            if (/\b(?:second|ii)\b/i.test(t)) return 2;
            if (/\b(?:third|iii)\b/i.test(t)) return 3;
            return 1;
        };
        
        let expectedSeason = extractSeason(searchTitle);

        // TARGETED SEARCH ROUTING
        const fetchTorrents = async (q) => {
            const epStr = requestedEp < 10 ? `0${requestedEp}` : `${requestedEp}`;
            const [broad, targeted] = await Promise.all([
                searchNyaaForAnime(q).catch(() => []),
                searchNyaaForAnime(`${q} ${epStr}`).catch(() => [])
            ]);
            const map = new Map();
            (broad || []).concat(targeted || []).forEach(t => map.set(t.hash, t));
            return Array.from(map.values());
        };

        let torrents = await fetchTorrents(searchTitle);
        
        torrents = torrents.filter(t => {
            const tS = extractSeason(t.title);
            if (tS !== expectedSeason && !/\b0*1\s*[-~to]\s*0*\d+\b/i.test(t.title)) return false;
            if (type === "movie" && !/\b(movie|film|gekijouban)\b/i.test(t.title)) {
            }
            return true;
        });

        const hashes = torrents.map(t => t.hash);
        const [rdC, tbC] = await Promise.all([
            userConfig.rdKey ? checkRD(hashes, userConfig.rdKey).catch(() => ({})) : {},
            userConfig.tbKey ? checkTorbox(hashes, userConfig.tbKey).catch(() => ({})) : {}
        ]);

        const streams = [];
        torrents.forEach(t => {
            const hashLow = t.hash.toLowerCase();
            const files = rdC[hashLow] || tbC[hashLow];
            const { res } = extractTags(t.title);
            const bytes = parseSizeToBytes(t.size);

            if (files) {
                const matchedFile = selectBestVideoFile(files, requestedEp, expectedSeason);
                if (!matchedFile) return;
                const name = `AMATSU [⚡ DEBRID]\n🎥 ${res}`;
                streams.push({ 
                    name, 
                    description: `Nyaa | ${t.title}\n💾 ${t.size}`, 
                    url: BASE_URL + "/resolve/" + (rdC[hashLow] ? "realdebrid/" + userConfig.rdKey : "torbox/" + userConfig.tbKey) + "/" + t.hash + "/" + requestedEp, 
                    behaviorHints: { bingeGroup: "amatsu_" + t.hash, filename: matchedFile.name }, 
                    _bytes: bytes 
                });
            }
        });

        return { streams: streams.sort((a, b) => b._bytes - a._bytes), cacheMaxAge: 3600 };
    } catch (err) {
        console.error("[Stream] Critical error:", err);
        return { streams: [] };
    }
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
