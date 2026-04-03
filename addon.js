//===============
// AMATSU STREMIO ADDON - CORE LOGIC
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getJikanMeta, fetchEpisodeDetails } = require("./lib/anilist");
const { searchNyaaForAnime, cleanTorrentTitle } = require("./lib/nyaa");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch } = require("./lib/parser");

let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7002";
BASE_URL = BASE_URL.replace(/\/+$/, "");

function toBase64Safe(str) { return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""); }
function fromBase64Safe(str) { try { return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch (e) { return ""; } }

const manifest = {
    id: "org.community.amatsu", version: "7.6.0", name: "Amatsu", logo: BASE_URL + "/amatsu.png",
    description: "The ultimate Debrid-powered Nyaa gateway. Holistic Parallel Search for Anime, Live-Action, and more.",
    resources: ["catalog", "meta", "stream"], types: ["movie", "series"],
    idPrefixes: ["amatsu:", "anilist:", "nyaa:", "kitsu:", "tt", "amatsu_raw:"],
    catalogs: [
        { id: "amatsu_trending", type: "series", name: "Amatsu Trending" },
        { id: "amatsu_top", type: "series", name: "Amatsu Top Rated" },
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

function sanitizeSearchQuery(title) { 
    return title.replace(/\(.*?\)/g, "")
                .replace(/\[.*?\]/g, "")
                .replace(/-/g, " ") 
                .replace(/\s{2,}/g, " ")
                .trim(); 
}

async function searchCinemeta(query, type) {
    try {
        const url = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
        const res = await axios.get(url, { timeout: 4000 });
        return res.data.metas || [];
    } catch (e) { return []; }
}

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    try {
        if (id === "amatsu_search" && extra.search) {
            // Parallel Holistic Search
            const [anilistRes, cinemetaRes, nyaaRes] = await Promise.all([
                searchAnime(extra.search).catch(() => []),
                searchCinemeta(extra.search, type).catch(() => []),
                searchNyaaForAnime(extra.search).catch(() => [])
            ]);

            const results = [];
            const seenIds = new Set();

            // 1. Anime
            anilistRes.filter(m => m.type === type).forEach(m => {
                results.push(m);
                seenIds.add(m.id);
            });

            // 2. Live-Action/Movie
            cinemetaRes.forEach(m => {
                if (!seenIds.has(m.id)) {
                    results.push(m);
                    seenIds.add(m.id);
                }
            });

            // 3. Raw Fallback
            if (results.length < 2 && nyaaRes.length > 0) {
                results.push({
                    id: `amatsu_raw:${type}:${toBase64Safe(extra.search)}`,
                    type: type,
                    name: extra.search + " (RAW SEARCH)",
                    poster: `https://dummyimage.com/600x900/1a1a1a/42a5f5.png?text=${encodeURIComponent(extra.search)}\nRaw+Search`,
                    background: `https://dummyimage.com/1920x1080/1a1a1a/42a5f5.png?text=${encodeURIComponent(extra.search)}`,
                    description: `Found ${nyaaRes.length} raw torrents directly on Nyaa. Use this if no official metadata matches.`
                });
            }

            return { metas: results, cacheMaxAge: 86400 };
        }
        return { metas: [] };
    } catch (e) { return { metas: [] }; }
});

builder.defineMetaHandler(async ({ id }) => {
    try {
        if (id.startsWith("amatsu_raw:")) {
            const parts = id.split(":");
            const mType = parts[1];
            const query = fromBase64Safe(parts[2]);
            const meta = {
                id: id, type: mType, name: query + " (Raw Search)",
                poster: `https://dummyimage.com/600x900/1a1a1a/42a5f5.png?text=${encodeURIComponent(query)}\nRaw+Search`,
                background: `https://dummyimage.com/1920x1080/1a1a1a/42a5f5.png?text=${encodeURIComponent(query)}`,
                description: `Dynamically generated metadata for "${query}".`,
            };
            if (mType === "series") {
                meta.videos = Array.from({ length: 150 }, (_, i) => ({ id: `${id}:${i + 1}`, title: `Episode ${i + 1}`, season: 1, episode: i + 1 }));
            }
            return { meta, cacheMaxAge: 86400 };
        }

        if (!id.startsWith("amatsu:") && !id.startsWith("anilist:")) return { meta: null };
        const aniListId = id.split(":")[1];
        if (!aniListId || isNaN(aniListId)) return { meta: null };
        const meta = await getAnimeMeta(aniListId);
        if (!meta) return { meta: null };
        
        if (meta.type === "series") {
            const jikanEps = meta.idMal ? await fetchEpisodeDetails(meta.idMal).catch(() => ({})) : {};
            const epMeta = meta.epMeta || {};
            const defaultThumb = meta.background || meta.poster || "https://dummyimage.com/600x337/1a1a1a/42a5f5.png?text=AMATSU+EPISODE";
            meta.videos = Array.from({ length: meta.episodes || 12 }, (_, i) => {
                const epNum = i + 1;
                const jData = jikanEps[epNum] || {};
                const epData = epMeta[epNum] || {};
                return { id: `${id}:1:${epNum}`, title: jData.title || epData.title || `Episode ${epNum}`, season: 1, episode: epNum, thumbnail: epData.thumbnail || defaultThumb };
            });
        }
        return { meta, cacheMaxAge: 604800 };
    } catch (e) { return { meta: null }; }
});

builder.defineStreamHandler(async ({ type, id, config }) => {
    try {
        if (!id.startsWith("amatsu:") && !id.startsWith("anilist:") && !id.startsWith("nyaa:") && !id.startsWith("kitsu:") && !id.startsWith("tt") && !id.startsWith("amatsu_raw:")) return { streams: [] };

        const userConfig = parseConfig(config);
        if (!userConfig.rdKey && !userConfig.tbKey) return { streams: [] };

        let aniListId = null;
        let requestedEp = 1;
        let expectedSeason = 1;
        let searchTitleFallback = null;
        let isRawSearch = false;

        const parts = id.split(":");

        if (id.startsWith("amatsu_raw:")) {
            const mType = parts[1];
            searchTitleFallback = fromBase64Safe(parts[2]);
            requestedEp = (mType === "series" && parts.length >= 4) ? (parseInt(parts[3], 10) || 1) : 1;
            isRawSearch = true;
        } else if (id.startsWith("amatsu:") || id.startsWith("anilist:")) {
            aniListId = parts[1];
            requestedEp = parts.length >= 4 ? (parseInt(parts[3], 10) || 1) : 1;
        } else if (id.startsWith("kitsu:")) {
            const kitsuId = parts[1];
            requestedEp = parts.length >= 4 ? (parseInt(parts[3], 10) || 1) : 1;
            try {
                const res = await axios.get(`https://anime-kitsu.strem.fun/meta/${type}/kitsu:${kitsuId}.json`, { timeout: 4000 });
                searchTitleFallback = res.data?.meta?.name;
            } catch (e) {}
        } else if (id.startsWith("tt")) {
            const imdbId = parts[0];
            if (parts.length > 2) {
                expectedSeason = parseInt(parts[1], 10) || 1;
                requestedEp = parseInt(parts[2], 10) || 1;
            } else { requestedEp = 1; }
            try {
                const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 4000 });
                searchTitleFallback = res.data?.meta?.name;
            } catch (e) {}
        }

        let freshMeta = null;
        if (aniListId) {
            freshMeta = await getAnimeMeta(aniListId);
        } else if (searchTitleFallback && !isRawSearch) {
            const searchResults = await searchAnime(searchTitleFallback);
            if (searchResults && searchResults.length > 0) {
                const matchedId = searchResults[0].id.split(":")[1];
                freshMeta = await getAnimeMeta(matchedId);
            }
        }

        if (!freshMeta && !searchTitleFallback) return { streams: [] };

        const allTitles = new Set();
        if (freshMeta) {
            if (freshMeta.name) allTitles.add(sanitizeSearchQuery(freshMeta.name));
            if (freshMeta.altName) allTitles.add(sanitizeSearchQuery(freshMeta.altName));
            if (freshMeta.synonyms) freshMeta.synonyms.forEach(s => allTitles.add(sanitizeSearchQuery(s)));
        } else if (searchTitleFallback) {
            allTitles.add(sanitizeSearchQuery(searchTitleFallback));
        }

        const extractSeason = (t) => {
            const m = t.match(/\b(?:S|Season|Part|Cour|Dai|Di)\s*0*(\d+)\b/i);
            return m ? parseInt(m[1], 10) : (/\b(?:second|ii)\b/i.test(t) ? 2 : (/\b(?:third|iii)\b/i.test(t) ? 3 : 1));
        };
        
        if (!id.startsWith("tt") && !isRawSearch && freshMeta) { expectedSeason = extractSeason(freshMeta.name); }

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
            const releaseYear = freshMeta ? freshMeta.releaseInfo : null;
            const searchPromises = [];

            if (isRawSearch) {
                searchPromises.push(searchNyaaForAnime(`${searchTitleFallback}`).catch(() => []));
                if (type === "series") {
                    searchPromises.push(searchNyaaForAnime(`${searchTitleFallback} ${epStr}`).catch(() => []));
                }
            } else {
                allTitles.forEach(title => {
                    searchPromises.push(searchNyaaForAnime(`${title} ${exclusions}`.trim()).catch(() => []));
                    searchPromises.push(searchNyaaForAnime(`${title} ${epStr} ${exclusions}`.trim()).catch(() => []));
                    searchPromises.push(searchNyaaForAnime(`${title} S${sStr}E${epStr}`).catch(() => []));
                    searchPromises.push(searchNyaaForAnime(`${title} Season ${expectedSeason} Complete`).catch(() => []));
                    searchPromises.push(searchNyaaForAnime(`${title} S${sStr} Batch`).catch(() => []));
                    if (requestedEp === 1) {
                        if (releaseYear) searchPromises.push(searchNyaaForAnime(`${title} ${releaseYear}`).catch(() => []));
                        searchPromises.push(searchNyaaForAnime(`${title}`).catch(() => []));
                    }
                });
            }
            const results = await Promise.all(searchPromises);
            const deduplicated = new Map();
            results.flat().forEach(t => deduplicated.set(t.hash, t));
            return Array.from(deduplicated.values());
        };

        let torrents = await fetchAllPossibleTorrents();
        torrents = torrents.filter(t => {
            const tS = extractSeason(t.title);
            if (tS !== null && tS !== expectedSeason) {
                const isMultiSeason = /S0?1\s*-\s*0?\d+/i.test(t.title) || /Season\s*1\s*(?:-|to)\s*\d+/i.test(t.title) || /Complete/i.test(t.title) || /Batch/i.test(t.title);
                if (!isMultiSeason) return false;
            }
            return true;
        });

        const hashes = torrents.map(t => t.hash);
        const [rdC, tbC, rdA, tbA] = await Promise.all([
            userConfig.rdKey ? checkRD(hashes, userConfig.rdKey).catch(() => ({})) : {},
            userConfig.tbKey ? checkTorbox(hashes, userConfig.tbKey).catch(() => ({})) : {},
            userConfig.rdKey ? getActiveRD(userConfig.rdKey).catch(() => ({})) : {},
            userConfig.tbKey ? getActiveTorbox(userConfig.tbKey).catch(() => ({})) : {}
        ]);

        const flags = { "GER": "🇩🇪", "ITA": "🇮🇹", "FRE": "🇫🇷", "SPA": "🇪🇸", "RUS": "🇷🇺", "POR": "🇵🇹", "ARA": "🇸🇦", "CHI": "🇨🇳", "KOR": "🇰🇷", "HIN": "🇮🇳", "POL": "🇵🇱", "NLD": "🇳🇱", "TUR": "🇹🇷", "VIE": "🇻🇳", "IND": "🇮🇩", "JPN": "🇯🇵", "ENG": "🇬🇧", "MULTI": "🌍" };
        const rawLangs = userConfig.language || ["ENG"];
        const userLangs = Array.isArray(rawLangs) ? rawLangs : [rawLangs];

        const streams = [];
        torrents.forEach(t => {
            const hashLow = t.hash.toLowerCase();
            const { res } = extractTags(t.title);
            const bytes = parseSizeToBytes(t.size);
            const streamLang = extractLanguage(t.title);
            const flag = flags[streamLang] || "🇬🇧";
            const isBatchTitle = getBatchRange(t.title) !== null;
            const isSB = isSeasonBatch(t.title, expectedSeason);
            const isValidUncachedMatch = isRawSearch ? true : (isEpisodeMatch(t.title, requestedEp, expectedSeason) || isBatchTitle || isSB);

            if (userConfig.rdKey) {
                const files = rdC[hashLow];
                const prog = rdA[hashLow];
                let matchedFile = files ? selectBestVideoFile(files, requestedEp, expectedSeason) : null;
                if (!matchedFile && isRawSearch && files && files.length > 0) { matchedFile = files.sort((a, b) => (b.size || b.bytes || 0) - (a.size || a.bytes || 0))[0]; }
                const isCached = matchedFile || prog === 100;
                const isDownloading = prog !== undefined && prog < 100;
                const uiName = isCached ? `AMATSU [⚡ RD]\n🎥 ${res}` : (isDownloading ? `AMATSU [⏳ ${prog}% RD]\n🎥 ${res}` : `AMATSU [☁️ RD DL]\n🎥 ${res}`);
                if (isCached) {
                    streams.push({ name: uiName, description: `${flag} Nyaa | ${t.title}\n💾 ${t.size}`, url: BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp, behaviorHints: { bingeGroup: "amatsu_rd_" + t.hash, filename: matchedFile ? matchedFile.name : undefined }, _bytes: bytes, _lang: streamLang, _isCached: true });
                } else if (isValidUncachedMatch) {
                    streams.push({ name: uiName, description: `${flag} Nyaa | 📥 DL to RD\n📄 ${t.title}\n💾 ${t.size}`, url: BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp, behaviorHints: { notWebReady: true, bingeGroup: "amatsu_uncached_rd_" + t.hash }, _bytes: bytes, _lang: streamLang, _isCached: false });
                }
            }

            if (userConfig.tbKey) {
                const files = tbC[hashLow];
                const prog = tbA[hashLow];
                let matchedFile = files ? selectBestVideoFile(files, requestedEp, expectedSeason) : null;
                if (!matchedFile && isRawSearch && files && files.length > 0) { matchedFile = files.sort((a, b) => (b.size || b.bytes || 0) - (a.size || a.bytes || 0))[0]; }
                const isCached = matchedFile || prog === 100;
                const isDownloading = prog !== undefined && prog < 100;
                const uiName = isCached ? `AMATSU [⚡ TB]\n🎥 ${res}` : (isDownloading ? `AMATSU [⏳ ${prog}% TB]\n🎥 ${res}` : `AMATSU [☁️ TB DL]\n🎥 ${res}`);
                if (isCached) {
                    streams.push({ name: uiName, description: `${flag} Nyaa | ${t.title}\n💾 ${t.size}`, url: BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp, behaviorHints: { bingeGroup: "amatsu_tb_" + t.hash, filename: matchedFile ? matchedFile.name : undefined }, _bytes: bytes, _lang: streamLang, _isCached: true });
                } else if (isValidUncachedMatch) {
                    streams.push({ name: uiName, description: `${flag} Nyaa | 📥 DL to TB\n📄 ${t.title}\n💾 ${t.size}`, url: BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp, behaviorHints: { notWebReady: true, bingeGroup: "amatsu_uncached_tb_" + t.hash }, _bytes: bytes, _lang: streamLang, _isCached: false });
                }
            }
        });

        return { streams: streams.sort((a, b) => {
            const getLangScore = (l) => (userLangs.includes(l) || l === "MULTI") ? 100 : 0;
            const scoreA = getLangScore(a._lang) + (a._isCached ? 10 : 0);
            const scoreB = getLangScore(b._lang) + (b._isCached ? 10 : 0);
            if (scoreA !== scoreB) return scoreB - scoreA;
            return b._bytes - a._bytes;
        }), cacheMaxAge: 3600 };
    } catch (err) { return { streams: [] }; }
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
