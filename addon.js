//===============
// AMATSU STREMIO ADDON - CORE LOGIC
// Nyaa Exclusion Matrix & isSeasonBatch Logic
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getJikanMeta, fetchEpisodeDetails } = require("./lib/anilist");
const { searchNyaaForAnime, cleanTorrentTitle } = require("./lib/nyaa");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch } = require("./lib/parser");

let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7002";
BASE_URL = BASE_URL.replace(/\/+$/, "");

function toBase64Safe(str) { return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""); }
function fromBase64Safe(str) { try { return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch (e) { return ""; } }

const manifest = {
    id: "org.community.amatsu", version: "7.0.0", name: "Amatsu", logo: BASE_URL + "/amatsu.png",
    description: "The ultimate Debrid-powered Nyaa gateway. Built with advanced Negative Exclusion Querying to defeat Nyaa pagination limits.",
    resources: ["catalog", "meta", "stream"], types: ["movie", "series"],
    idPrefixes: ["amatsu:", "anilist:", "nyaa:"],
    catalogs: [
        { id: "amatsu_trending", type: "series", name: "Amatsu Trending" },
        { id: "amatsu_top", type: "series", name: "Amatsu Top Rated" },
        { id: "amatsu_search", type: "series", name: "Amatsu Search", extra: [{ name: "search", isRequired: true }] }
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

function extractLanguage(title) {
    const lower = title.toLowerCase();
    if (/(multi|dual|multi-audio|multi-sub)/i.test(lower)) return "MULTI";
    if (/\b(ger|deu|german|deutsch)\b/i.test(lower)) return "GER";
    if (/\b(fre|fra|french|vostfr|vf)\b/i.test(lower)) return "FRE";
    if (/\b(ita|italian|it)\b/i.test(lower)) return "ITA";
    if (/\b(spa|esp|spanish|es)\b/i.test(lower)) return "SPA";
    if (/\b(rus|russian|ru)\b/i.test(lower)) return "RUS";
    if (/\b(por|portuguese|pt-br|pt)\b/i.test(lower)) return "POR";
    if (/\b(ara|arabic|ar)\b/i.test(lower)) return "ARA";
    if (/\b(chi|chinese|chs|cht|mandarin|zh)\b|(简|繁|中文字幕)/i.test(lower)) return "CHI";
    if (/\b(kor|korean|ko)\b/i.test(lower)) return "KOR";
    if (/\b(hin|hindi|hi)\b/i.test(lower)) return "HIN";
    if (/\b(pol|polish|pl)\b/i.test(lower)) return "POL";
    if (/\b(nld|dutch|nl)\b/i.test(lower)) return "NLD";
    if (/\b(tur|turkish|tr)\b/i.test(lower)) return "TUR";
    if (/\b(vie|vietnamese|vi)\b/i.test(lower)) return "VIE";
    if (/\b(ind|indonesian|id)\b/i.test(lower)) return "IND";
    if (/\b(jpn|japanese|raw|jp)\b/i.test(lower)) return "JPN";
    if (/\b(eng|english|subbed|en)\b/i.test(lower)) return "ENG";
    return "ENG"; 
}

function sanitizeSearchQuery(title) { return title.replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "").replace(/\s{2,}/g, " ").trim(); }

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    try {
        if (id === "amatsu_search" && extra.search) {
            const anilistMetas = await searchAnime(extra.search).catch(() => []);
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
            const jikanEps = meta.idMal ? await fetchEpisodeDetails(meta.idMal).catch(() => ({})) : {};
            meta.videos = Array.from({ length: meta.episodes || 12 }, (_, i) => {
                const epNum = i + 1;
                const jData = jikanEps[epNum] || {};
                return { id: `${id}:1:${epNum}`, title: jData.title || `Episode ${epNum}`, season: 1, episode: epNum };
            });
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
        
        const allTitles = new Set();
        if (freshMeta.name) allTitles.add(sanitizeSearchQuery(freshMeta.name));
        if (freshMeta.altName) allTitles.add(sanitizeSearchQuery(freshMeta.altName));
        if (freshMeta.synonyms) freshMeta.synonyms.forEach(s => allTitles.add(sanitizeSearchQuery(s)));

        const extractSeason = (t) => {
            const m = t.match(/\b(?:S|Season|Part|Cour|Dai|Di)\s*0*(\d+)\b/i);
            return m ? parseInt(m[1], 10) : (/\b(?:second|ii)\b/i.test(t) ? 2 : (/\b(?:third|iii)\b/i.test(t) ? 3 : 1));
        };
        const expectedSeason = extractSeason(freshMeta.name);

        const buildExclusions = (season) => {
            if (season === 1) return "-S2 -S02 -S3 -S03 -S4 -S04 -2nd -3rd -4th -Season 2 -Season 3";
            if (season === 2) return "-S3 -S03 -S4 -S04 -3rd -4th -Season 3 -Season 4";
            if (season === 3) return "-S4 -S04 -S5 -S05 -4th -5th -Season 4 -Season 5";
            return "";
        };

        const fetchAllPossibleTorrents = async () => {
            const epStr = requestedEp < 10 ? `0${requestedEp}` : `${requestedEp}`;
            const sStr = expectedSeason < 10 ? `0${expectedSeason}` : `${expectedSeason}`;
            const exclusions = buildExclusions(expectedSeason);
            
            const searchPromises = [];
            allTitles.forEach(title => {

                searchPromises.push(searchNyaaForAnime(`${title} ${epStr} ${exclusions}`.trim()).catch(() => []));

                searchPromises.push(searchNyaaForAnime(`${title} S${sStr}E${epStr}`).catch(() => []));

                searchPromises.push(searchNyaaForAnime(`${title} Season ${expectedSeason} Complete`).catch(() => []));
                searchPromises.push(searchNyaaForAnime(`${title} S${sStr} Batch`).catch(() => []));
            });
            const results = await Promise.all(searchPromises);
            const deduplicated = new Map();
            results.flat().forEach(t => deduplicated.set(t.hash, t));
            return Array.from(deduplicated.values());
        };

        let torrents = await fetchAllPossibleTorrents();
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

        const flags = { 
            "GER": "🇩🇪", "ITA": "🇮🇹", "FRE": "🇫🇷", "SPA": "🇪🇸", "RUS": "🇷🇺", 
            "POR": "🇵🇹", "ARA": "🇸🇦", "CHI": "🇨🇳", "KOR": "🇰🇷", "HIN": "🇮🇳",
            "POL": "🇵🇱", "NLD": "🇳🇱", "TUR": "🇹🇷", "VIE": "🇻🇳", "IND": "🇮🇩",
            "JPN": "🇯🇵", "ENG": "🇬🇧", "MULTI": "🌍" 
        };

        const rawLangs = userConfig.language || ["ENG"];
        const userLangs = Array.isArray(rawLangs) ? rawLangs : [rawLangs];

        const streams = [];
        torrents.forEach(t => {
            const hashLow = t.hash.toLowerCase();
            const files = rdC[hashLow] || tbC[hashLow];
            const streamLang = extractLanguage(t.title);
            const flag = flags[streamLang] || "🇬🇧";
            
            if (files) {
                const matchedFile = selectBestVideoFile(files, requestedEp, expectedSeason);
                if (matchedFile) {
                    streams.push({
                        name: `AMATSU [⚡ DEBRID]\n🎥 ${t.title.includes("1080") ? "1080p" : "720p"}`,
                        description: `${flag} Nyaa | ${t.title}\n💾 ${t.size}`,
                        url: BASE_URL + "/resolve/" + (rdC[hashLow] ? "realdebrid/" + userConfig.rdKey : "torbox/" + userConfig.tbKey) + "/" + t.hash + "/" + requestedEp,
                        behaviorHints: { bingeGroup: "amatsu_" + t.hash, filename: matchedFile.name },
                        _bytes: parseSizeToBytes(t.size),
                        _lang: streamLang
                    });
                }
            } else {
                const isBatchTitle = getBatchRange(t.title) !== null;
                const isSB = isSeasonBatch(t.title, expectedSeason);
                if (!isEpisodeMatch(t.title, requestedEp, expectedSeason) && !isBatchTitle && !isSB) return;
                
                streams.push({
                    name: `AMATSU [☁️ UNCACHED]\n🎥 ${t.title.includes("1080") ? "1080p" : "720p"}`,
                    description: `${flag} Nyaa | 📥 DL to Debrid\n📄 ${t.title}\n💾 ${t.size}`,
                    url: BASE_URL + "/resolve/" + (userConfig.rdKey ? "realdebrid/" + userConfig.rdKey : "torbox/" + userConfig.tbKey) + "/" + t.hash + "/" + requestedEp,
                    behaviorHints: { notWebReady: true, bingeGroup: "amatsu_uncached_" + t.hash },
                    _bytes: parseSizeToBytes(t.size),
                    _lang: streamLang
                });
            }
        });

        return { 
            streams: streams.sort((a, b) => {
                const getLangScore = (l) => (userLangs.includes(l) || l === "MULTI") ? 100 : 0;
                const scoreA = getLangScore(a._lang) + (a.name.includes("⚡") ? 10 : 0);
                const scoreB = getLangScore(b._lang) + (b.name.includes("⚡") ? 10 : 0);
                if (scoreA !== scoreB) return scoreB - scoreA;
                return b._bytes - a._bytes;
            }), 
            cacheMaxAge: 3600 
        };
    } catch (err) { return { streams: [] }; }
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
