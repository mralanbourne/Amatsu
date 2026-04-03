//===============
// AMATSU STREMIO ADDON - CORE LOGIC
// Advanced Targeted Routing and Parallel Search Engine.
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getJikanMeta, fetchEpisodeDetails } = require("./lib/anilist");
const { searchNyaaForAnime, cleanTorrentTitle } = require("./lib/nyaa");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile } = require("./lib/parser");

let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7002";
BASE_URL = BASE_URL.replace(/\/+$/, "");

function toBase64Safe(str) { return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""); }
function fromBase64Safe(str) { try { return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch (e) { return ""; } }

const manifest = {
    id: "org.community.amatsu", version: "6.9.0", name: "Amatsu", logo: BASE_URL + "/amatsu.png",
    description: "The ultimate Debrid-powered Nyaa gateway. Advanced multi-vector search routing.",
    resources: ["catalog", "meta", "stream"], types: ["movie", "series"],
    idPrefixes: ["amatsu:", "anilist:", "nyaa:"],
    catalogs: [
        { id: "amatsu_trending", type: "series", name: "Amatsu Trending" },
        { id: "amatsu_trending", type: "movie", name: "Amatsu Trending" },
        { id: "amatsu_search", type: "series", name: "Amatsu Search", extra: [{ name: "search", isRequired: true }] },
        { id: "amatsu_search", type: "movie", name: "Amatsu Search", extra: [{ name: "search", isRequired: true }] }
    ],
    config: [{ key: "Amatsu", type: "text", title: "Amatsu Internal Payload" }],
    behaviorHints: { configurable: true, configurationRequired: true },
    stremioAddonsConfig: { issuer: "https://stremio-addons.net", signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..5hpukX-AKAcOLTxpQ18hYg.syyrg4fQnbdNs0yua4AQknUXvoHTLvj11tMeCAtIaUdTAhdYF8r6F16tEVeWgx7m4yaCGi9gIMd0YD13nbBjPHPJGAe8GbxdO0SI0w6h8lRSeKkwP6Mes8hZnKPK5YNs.GSbCSwFj3Thfj-NYgZlj4g" }
};

const builder = new addonBuilder(manifest);

function parseConfig(config) {
    let parsed = {};
    try { if (config && config.Amatsu) { const decoded = Buffer.from(config.Amatsu.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); parsed = JSON.parse(decoded); } else { parsed = config || {}; } } catch (e) {}
    return parsed;
}

function parseSizeToBytes(sizeStr) {
    if (!sizeStr || typeof sizeStr !== "string") return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|GiB|MiB|KiB|B)/i);
    if (!match) return 0;
    const val = parseFloat(match[1]); const unit = match[2].toUpperCase();
    if (unit.includes("G")) return val * 1024 * 1024 * 1024;
    return val * 1024 * 1024;
}

function sanitizeSearchQuery(title) { return title.replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "").replace(/\s{2,}/g, " ").trim(); }

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    try {
        if (id === "amatsu_search" && extra.search) {
            const [anilistMetas, nyaaTorrents] = await Promise.all([searchAnime(extra.search).catch(() => []), searchNyaaForAnime(extra.search).catch(() => [])]);
            return { metas: (anilistMetas || []).filter(m => m.type === type), cacheMaxAge: 86400 };
        }
        return { metas: [] };
    } catch (e) { return { metas: [] }; }
});

builder.defineMetaHandler(async ({ id }) => {
    try {
        const aniListId = id.split(":")[1];
        if (!aniListId || isNaN(aniListId)) return { meta: null };
        const meta = await getAnimeMeta(aniListId);
        if (!meta) return { meta: null };
        if (meta.type === "series") {
            meta.videos = Array.from({ length: meta.episodes || 12 }, (_, i) => ({ id: `${id}:1:${i + 1}`, title: `Episode ${i + 1}`, season: 1, episode: i + 1 }));
        }
        return { meta, cacheMaxAge: 604800 };
    } catch (e) { return { meta: null }; }
});

builder.defineStreamHandler(async ({ type, id, config }) => {
    try {
        const userConfig = parseConfig(config);
        if (!userConfig.rdKey && !userConfig.tbKey) return { streams: [] };

        const parts = id.split(":");
        const aniListId = parts[1];
        const requestedEp = parseInt(parts[parts.length - 1], 10) || 1;
        
        const freshMeta = await getAnimeMeta(aniListId);
        if (!freshMeta) return { streams: [] };
        const mainTitle = sanitizeSearchQuery(freshMeta.name);

        // TARGETED SEARCH ENGINE
        const fetchTorrents = async (title, ep) => {
            const epStr = ep < 10 ? `0${ep}` : `${ep}`;
            const queries = [`${title}`, `${title} ${epStr}`, `${title} Batch`];
            // Parallel execution to beat Nyaa pagination clutter
            const results = await Promise.all(queries.map(q => searchNyaaForAnime(q).catch(() => [])));
            const deduplicated = new Map();
            results.flat().forEach(t => deduplicated.set(t.hash, t));
            return Array.from(deduplicated.values());
        };

        // SEASON DETECTION
        const extractSeason = (t) => {
            const m = t.match(/\b(?:S|Season|Part|Cour|Dai|Di)\s*0*(\d+)\b/i);
            return m ? parseInt(m[1], 10) : (/\b(?:second|ii)\b/i.test(t) ? 2 : (/\b(?:third|iii)\b/i.test(t) ? 3 : 1));
        };
        const expectedSeason = extractSeason(mainTitle);

        let torrents = await fetchTorrents(mainTitle, requestedEp);

        // Filter and Verify
        torrents = torrents.filter(t => {
            const tS = extractSeason(t.title);
            if (tS !== null && tS !== expectedSeason && !/\b0*1\s*[-~to]\s*0*\d+\b/i.test(t.title)) return false;
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
            if (files) {
                const matchedFile = selectBestVideoFile(files, requestedEp, expectedSeason);
                if (matchedFile) {
                    streams.push({
                        name: `AMATSU [⚡ DEBRID]\n🎥 ${t.title.includes("1080") ? "1080p" : "720p"}`,
                        description: `Nyaa | ${t.title}\n💾 ${t.size}`,
                        url: BASE_URL + "/resolve/" + (rdC[hashLow] ? "realdebrid/" + userConfig.rdKey : "torbox/" + userConfig.tbKey) + "/" + t.hash + "/" + requestedEp,
                        behaviorHints: { bingeGroup: "amatsu_" + t.hash, filename: matchedFile.name },
                        _bytes: parseSizeToBytes(t.size)
                    });
                }
            }
        });

        return { streams: streams.sort((a, b) => b._bytes - a._bytes), cacheMaxAge: 3600 };
    } catch (err) { return { streams: [] }; }
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
