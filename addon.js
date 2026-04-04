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
        { id: "amatsu_trending_series", type: "series", name: "Amatsu Trending Series" },
        { id: "amatsu_top_series", type: "series", name: "Amatsu Top Rated Series" },
        { id: "amatsu_trending_movie", type: "movie", name: "Amatsu Trending Movies" },
        { id: "amatsu_top_movie", type: "movie", name: "Amatsu Top Rated Movies" },
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
    if (/(4320p|8k|FUHD)/i.test(title)) res = "8K";
    else if (/(2160p|4k|UHD)/i.test(title)) res = "4K";
    else if (/(1440p|2k|QHD)/i.test(title)) res = "2K";
    else if (/(1080p|1080|FHD)/i.test(title)) res = "1080p";
    else if (/(720p|720|HD)/i.test(title)) res = "720p";
    else if (/(480p|480)/i.test(title)) res = "480p";
    return { res };
}

const LANG_REGEX = {
    "GER": /\b(ger|deu|german|deutsch|de-de)\b|(?:^|\[|\()(de)(?:\]|\)|$)/i,
    "FRE": /\b(fre|fra|french|vostfr|vf|fr-fr)\b|(?:^|\[|\()(fr)(?:\]|\)|$)/i,
    "ITA": /\b(ita|italian|it-it)\b|(?:^|\[|\()(it)(?:\]|\)|$)/i,
    "SPA": /\b(spa|esp|spanish|es-es|es-mx)\b|(?:^|\[|\()(es)(?:\]|\)|$)/i,
    "RUS": /\b(rus|russian|ru-ru)\b|(?:^|\[|\()(ru)(?:\]|\)|$)/i,
    "POR": /\b(por|pt-br|portuguese|pt-pt)\b|(?:^|\[|\()(pt)(?:\]|\)|$)/i,
    "ARA": /\b(ara|arabic|ar-sa)\b|(?:^|\[|\()(ar)(?:\]|\)|$)/i,
    "CHI": /\b(chi|chinese|chs|cht|mandarin|zh-cn|zh-tw)\b|(?:^|\[|\()(zh)(?:\]|\)|$)|(简|繁|中文字幕)/i,
    "KOR": /\b(kor|korean|ko-kr)\b|(?:^|\[|\()(ko)(?:\]|\)|$)/i,
    "HIN": /\b(hin|hindi|hi-in)\b|(?:^|\[|\()(hi)(?:\]|\)|$)/i,
    "POL": /\b(pol|polish|pl-pl)\b|(?:^|\[|\()(pl)(?:\]|\)|$)/i,
    "NLD": /\b(nld|dut|dutch|nl-nl)\b|(?:^|\[|\()(nl)(?:\]|\)|$)/i,
    "TUR": /\b(tur|turkish|tr-tr)\b|(?:^|\[|\()(tr)(?:\]|\)|$)/i,
    "VIE": /\b(vie|vietnamese|vi-vn)\b|(?:^|\[|\()(vi)(?:\]|\)|$)/i,
    "IND": /\b(ind|indonesian|id-id)\b|(?:^|\[|\()(id)(?:\]|\)|$)/i,
    "ENG": /\b(eng|english|dubbed|subbed|en-us|en-gb)\b|(?:^|\[|\()(en)(?:\]|\)|$)/i,
    "JPN": /\b(jpn|japanese|raw|jp-jp)\b|(?:^|\[|\()(jp)(?:\]|\)|$)/i,
    "MULTI": /(multi|dual|multi-audio|multi-sub)/i
};

function extractLanguage(title, userLangs = []) {
    const lower = title.toLowerCase();
    
    for (let lang of userLangs) {
        if (LANG_REGEX[lang] && LANG_REGEX[lang].test(lower)) return lang;
    }
    
    if (LANG_REGEX["MULTI"].test(lower)) return "MULTI";
    if (LANG_REGEX["ENG"].test(lower)) return "ENG";
    if (LANG_REGEX["JPN"].test(lower)) return "JPN";
    
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
        const userConfig = parseConfig(config);

        if (id === "amatsu_trending_series" && userConfig.showTrendingSeries !== false) {
            const results = await getTrendingAnime("series");
            return { metas: results.filter(m => m.type === type), cacheMaxAge: 21600 };
        }
        if (id === "amatsu_top_series" && userConfig.showTopSeries !== false) {
            const results = await getTopAnime("series");
            return { metas: results.filter(m => m.type === type), cacheMaxAge: 86400 };
        }
        if (id === "amatsu_trending_movie" && userConfig.showTrendingMovies !== false) {
            const results = await getTrendingAnime("movie");
            return { metas: results.filter(m => m.type === type), cacheMaxAge: 21600 };
        }
        if (id === "amatsu_top_movie" && userConfig.showTopMovies !== false) {
            const results = await getTopAnime("movie");
            return { metas: results.filter(m => m.type === type), cacheMaxAge: 86400 };
        }

        if (id === "amatsu_search" && extra.search) {
            const [anilistRes, cinemetaRes, nyaaRes] = await Promise.all([
                searchAnime(extra.search).catch(() => []),
                searchCinemeta(extra.search, type).catch(() => []),
                searchNyaaForAnime(extra.search).catch(() => [])
            ]);

            const results = [];
            const seenIds = new Set();

            anilistRes.filter(m => m.type === type).forEach(m => {
                results.push(m);
                seenIds.add(m.id);
            });

            cinemetaRes.forEach(m => {
                if (!seenIds.has(m.id)) {
                    results.push(m);
                    seenIds.add(m.id);
                }
            });

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
                meta.videos = [];
                for (let s = 1; s <= 10; s++) {
                    let maxEp = s === 1 ? 1000 : 100;
                    for (let e = 1; e <= maxEp; e++) {
                        meta.videos.push({
                            id: `${id}:${s}:${e}`,
                            title: `Episode ${e}`,
                            season: s,
                            episode: e
                        });
                    }
                }
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
            if (mType === "series" && parts.length >= 5) {
                expectedSeason = parseInt(parts[3], 10) || 1;
                requestedEp = parseInt(parts[4], 10) || 1;
            } else if (mType === "series" && parts.length === 4) {
                expectedSeason = 1;
                requestedEp = parseInt(parts[3], 10) || 1;
            } else { expectedSeason = 1; requestedEp = 1; }
            isRawSearch = true;
        } else if (id.startsWith("amatsu:") || id.startsWith("anilist:")) {
            aniListId = parts[1];
            if (parts.length >= 5) {
                expectedSeason = parseInt(parts[parts.length - 2], 10) || 1;
                requestedEp = parseInt(parts[parts.length - 1], 10) || 1;
            } else if (parts.length === 4) {
                expectedSeason = parseInt(parts[2], 10) || 1;
                requestedEp = parseInt(parts[3], 10) || 1;
            } else {
                expectedSeason = 1;
                requestedEp = 1;
            }
        } else if (id.startsWith("kitsu:")) {
            const lastPart = parts[parts.length - 1];
            requestedEp = !isNaN(lastPart) ? parseInt(lastPart, 10) : 1;
        } else if (id.startsWith("tt")) {
            const imdbId = parts[0];
            if (parts.length > 2) {
                expectedSeason = parseInt(parts[1], 10) || 1;
                requestedEp = parseInt(parts[2], 10) || 1;
            } else { requestedEp = 1; }
        }

        const metaTasks = [];
        
        if (id.startsWith("tt")) {
            metaTasks.push(axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${parts[0]}.json`, { timeout: 3000 })
                .then(res => ({ source: 'cinemeta', name: res.data?.meta?.name }))
                .catch(() => null));
        }

        if (aniListId) {
            metaTasks.push(getAnimeMeta(aniListId).then(meta => ({ source: 'anilist', meta }))
                .catch(() => null));
        }

        const metaResults = await Promise.all(metaTasks);
        let freshMeta = null;
        
        metaResults.forEach(r => {
            if (!r) return;
            if (r.source === 'cinemeta') searchTitleFallback = r.name;
            if (r.source === 'anilist') freshMeta = r.meta;
        });

        if (!freshMeta && searchTitleFallback && !isRawSearch) {
            try {
                const searchResults = await searchAnime(searchTitleFallback);
                if (searchResults && searchResults.length > 0) {
                    const matchedId = searchResults[0].id.split(":")[1];
                    freshMeta = await getAnimeMeta(matchedId);
                }
            } catch (e) {}
        }

        if (!freshMeta && !searchTitleFallback) return { streams: [] };

        const allTitles = new Set();
        if (freshMeta) {
            if (freshMeta.name) allTitles.add(sanitizeSearchQuery(freshMeta.name));
            if (freshMeta.altName) allTitles.add(sanitizeSearchQuery(freshMeta.altName));
            if (freshMeta.synonyms) freshMeta.synonyms.forEach(s => allTitles.add(sanitizeSearchQuery(s)));
        } 
        
        if (searchTitleFallback) {
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
                    searchPromises.push(searchNyaaForAnime(`${searchTitleFallback} S${sStr}E${epStr}`).catch(() => []));
                    if (expectedSeason > 1) {
                        searchPromises.push(searchNyaaForAnime(`${searchTitleFallback} S${sStr}`).catch(() => []));
                        searchPromises.push(searchNyaaForAnime(`${searchTitleFallback} Season ${expectedSeason}`).catch(() => []));
                    }
                }
            } else {
                allTitles.forEach(title => {
                    searchPromises.push(searchNyaaForAnime(`${title} ${exclusions}`.trim()).catch(() => []));
                    searchPromises.push(searchNyaaForAnime(`${title} ${epStr} ${exclusions}`.trim()).catch(() => []));
                    searchPromises.push(searchNyaaForAnime(`${title} S${sStr}E${epStr}`).catch(() => []));
                    searchPromises.push(searchNyaaForAnime(`${title} Season ${expectedSeason} Complete`).catch(() => []));
                    searchPromises.push(searchNyaaForAnime(`${title} S${sStr} Batch`).catch(() => []));
                    searchPromises.push(searchNyaaForAnime(`${title} Batch`).catch(() => []));
                    searchPromises.push(searchNyaaForAnime(`${title} Complete`).catch(() => []));
                    searchPromises.push(searchNyaaForAnime(`${title}`).catch(() => []));

                    if (requestedEp === 1 && releaseYear) {
                        searchPromises.push(searchNyaaForAnime(`${title} ${releaseYear}`).catch(() => []));
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
            if (isRawSearch) return true;
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
            
            const streamLang = extractLanguage(t.title, userLangs);
            const flag = flags[streamLang] || "🇬🇧";
            
            const isBatchTitle = getBatchRange(t.title) !== null;
            const isSB = isSeasonBatch(t.title, expectedSeason);
            const isValidUncachedMatch = isRawSearch ? true : (isEpisodeMatch(t.title, requestedEp, expectedSeason) || isBatchTitle || isSB);

            const buildSubs = (fileList, provider, apiKey, currentEp, currentSeason) => {
                if (!fileList) return [];
                return fileList.filter(f => {
                    const name = f.name || f.path || "";
                    if (!/\.(ass|srt|ssa|vtt)$/i.test(name)) return false;
                    const extEp = extractEpisodeNumber(name, currentSeason);
                    if (extEp !== null) return extEp === currentEp;
                    return isEpisodeMatch(name, currentEp, currentSeason);
                }).map(f => {
                    let subLang = "English";
                    const n = (f.name || f.path || "").toLowerCase();
                    const safeName = n.replace(/[\W_]+/g, " "); 
                    
                    if (/\b(ger|deu|deutsch|de|de de)\b/i.test(safeName)) subLang = "German";
                    else if (/\b(spa|esp|spanish|es|es es|es mx)\b/i.test(safeName)) subLang = "Spanish";
                    else if (/\b(rus|russian|ru|ru ru)\b/i.test(safeName)) subLang = "Russian";
                    else if (/\b(fre|fra|french|vostfr|vf|fr|fr fr)\b/i.test(safeName)) subLang = "French";
                    else if (/\b(ita|italian|it|it it)\b/i.test(safeName)) subLang = "Italian";
                    else if (/\b(por|portuguese|pt br|pt|pt pt)\b/i.test(safeName)) subLang = "Portuguese";
                    else if (/\b(pol|polish|pl|pl pl)\b/i.test(safeName)) subLang = "Polish";
                    else if (/\b(chi|chinese|zho|zh|zh cn|zh tw)\b/i.test(safeName)) subLang = "Chinese";
                    else if (/\b(ara|arabic|ar|ar sa)\b/i.test(safeName)) subLang = "Arabic";
                    else if (/\b(jpn|japanese|jp|jp jp)\b/i.test(safeName)) subLang = "Japanese";
                    else if (/\b(kor|korean|ko|ko kr)\b/i.test(safeName)) subLang = "Korean";
                    else if (/\b(hin|hindi|hi|hi in)\b/i.test(safeName)) subLang = "Hindi";
                    else if (/\b(eng|english|en|en us|en gb|en au)\b/i.test(safeName)) subLang = "English";
                    
                    const extMatch = n.match(/\.(ass|srt|ssa|vtt)$/);
                    const ext = extMatch ? extMatch[1].toUpperCase() : "SUB";
                    return { id: f.id, url: BASE_URL + "/sub/" + provider + "/" + apiKey + "/" + t.hash + "/" + f.id + "?filename=" + encodeURIComponent(n), lang: subLang + " (" + ext + ")" };
                });
            };

            if (userConfig.rdKey) {
                const files = rdC[hashLow];
                const prog = rdA[hashLow];
                let matchedFile = files ? selectBestVideoFile(files, requestedEp, expectedSeason) : null;
                if (!matchedFile && isRawSearch && files && files.length > 0) { matchedFile = files.sort((a, b) => (b.size || b.bytes || 0) - (a.size || a.bytes || 0))[0]; }
                const isCached = matchedFile || prog === 100;
                const isDownloading = prog !== undefined && prog < 100;
                const uiName = isCached ? `AMATSU [⚡ RD]\n🎥 ${res}` : (isDownloading ? `AMATSU [⏳ ${prog}% RD]\n🎥 ${res}` : `AMATSU [☁️ RD]\n🎥 ${res}`);
                
                if (isCached) {
                    streams.push({ name: uiName, description: `${flag} Nyaa | ⚡ Cached\n📄 ${t.title}\n💾 ${t.size} | 👥 ${t.seeders || 0} Seeders`, url: BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp, subtitles: buildSubs(files, "realdebrid", userConfig.rdKey, requestedEp, expectedSeason), behaviorHints: { bingeGroup: "amatsu_rd_" + t.hash, filename: matchedFile ? matchedFile.name : undefined }, _bytes: bytes, _lang: streamLang, _isCached: true, _res: res });
                } else if (isValidUncachedMatch) {
                    streams.push({ name: uiName, description: `${flag} Nyaa | ☁️ Download\n📄 ${t.title}\n💾 ${t.size} | 👥 ${t.seeders || 0} Seeders`, url: BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp, behaviorHints: { notWebReady: true, bingeGroup: "amatsu_uncached_rd_" + t.hash }, _bytes: bytes, _lang: streamLang, _isCached: false, _res: res });
                }
            }

            if (userConfig.tbKey) {
                const files = tbC[hashLow];
                const prog = tbA[hashLow];
                let matchedFile = files ? selectBestVideoFile(files, requestedEp, expectedSeason) : null;
                if (!matchedFile && isRawSearch && files && files.length > 0) { matchedFile = files.sort((a, b) => (b.size || b.bytes || 0) - (a.size || a.bytes || 0))[0]; }
                const isCached = matchedFile || prog === 100;
                const isDownloading = prog !== undefined && prog < 100;
                const uiName = isCached ? `AMATSU [⚡ TB]\n🎥 ${res}` : (isDownloading ? `AMATSU [⏳ ${prog}% TB]\n🎥 ${res}` : `AMATSU [☁️ TB]\n🎥 ${res}`);
                
                if (isCached) {
                    streams.push({ name: uiName, description: `${flag} Nyaa | ⚡ Cached\n📄 ${t.title}\n💾 ${t.size} | 👥 ${t.seeders || 0} Seeders`, url: BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp, subtitles: buildSubs(files, "torbox", userConfig.tbKey, requestedEp, expectedSeason), behaviorHints: { bingeGroup: "amatsu_tb_" + t.hash, filename: matchedFile ? matchedFile.name : undefined }, _bytes: bytes, _lang: streamLang, _isCached: true, _res: res });
                } else if (isValidUncachedMatch) {
                    streams.push({ name: uiName, description: `${flag} Nyaa | ☁️ Download\n📄 ${t.title}\n💾 ${t.size} | 👥 ${t.seeders || 0} Seeders`, url: BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp, behaviorHints: { notWebReady: true, bingeGroup: "amatsu_uncached_tb_" + t.hash }, _bytes: bytes, _lang: streamLang, _isCached: false, _res: res });
                }
            }
        });

        return { streams: streams.sort((a, b) => {
            const getLangScore = (l) => {
                if (userLangs.includes(l)) return 200 - userLangs.indexOf(l);
                if (l === "MULTI") return 150;
                if (l === "ENG") return 50;
                if (l === "JPN") return 40;
                return 0;
            };

            const getResScore = (r) => {
                if (r === "8K") return 8000;
                if (r === "4K") return 4000;
                if (r === "2K") return 2000;
                if (r === "1080p") return 1080;
                if (r === "720p") return 720;
                if (r === "480p") return 480;
                return 0; 
            };

            const langScoreA = getLangScore(a._lang) + (a._isCached ? 10 : 0);
            const langScoreB = getLangScore(b._lang) + (b._isCached ? 10 : 0);
            
            if (langScoreA !== langScoreB) return langScoreB - langScoreA;

            const resScoreA = getResScore(a._res);
            const resScoreB = getResScore(b._res);

            if (resScoreA !== resScoreB) return resScoreB - resScoreA;
            
            return b._bytes - a._bytes;
        }), cacheMaxAge: 3600 };
    } catch (err) { return { streams: [] }; }
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
