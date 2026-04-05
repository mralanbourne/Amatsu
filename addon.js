//===============
// AMATSU STREMIO ADDON - CORE LOGIC
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getJikanMeta, fetchEpisodeDetails } = require("./lib/anilist");
const { searchNyaaForAnime, cleanTorrentTitle } = require("./lib/nyaa");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch, verifyTitleMatch } = require("./lib/parser");

let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7002";
BASE_URL = BASE_URL.replace(/\/+$/, "");

//===============
// SECURITY: INTERNAL KEYS
//===============
const INTERNAL_TB_KEY = process.env.INTERNAL_TORBOX_KEY || "";

//===============
// HELPER FUNCTIONS
//===============

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

function parseConfig(config) {
    let parsed = {};
    try { 
        if (config && config.Amatsu) { 
            const decoded = Buffer.from(config.Amatsu.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); 
            parsed = JSON.parse(decoded); 
        } else { 
            parsed = config || {}; 
        } 
    } catch (e) {
        console.error("Fehler beim Parsen der Konfiguration:", e);
    }
    return parsed;
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
    if (/(4320p|8k|FUHD)/i.test(title)) res = "8K";
    else if (/(2160p|4k|UHD)/i.test(title)) res = "4K";
    else if (/(1440p|2k|QHD)/i.test(title)) res = "2K";
    else if (/(1080p|1080|FHD)/i.test(title)) res = "1080p";
    else if (/(720p|720|HD)/i.test(title)) res = "720p";
    else if (/(480p|480)/i.test(title)) res = "480p";
    return { res };
}

//===============
// LANGUAGE MAPPING
//===============

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
        const res = await axios.get(url, { "timeout": 4000 });
        return res.data.metas || [];
    } catch (e) { return []; }
}

//===============
// ADDON MANIFEST
//===============

const manifest = {
    "id": "org.community.amatsu", "version": "7.7.6", "name": "Amatsu", "logo": BASE_URL + "/amatsu.png",
    "description": "The ultimate Debrid-powered Nyaa gateway. Holistic Parallel Search for Anime, Live-Action, and more.",
    "resources": ["catalog", "meta", "stream"], "types": ["movie", "series"],
    "idPrefixes": ["amatsu:", "anilist:", "nyaa:", "kitsu:", "tt", "amatsu_raw:"],
    "catalogs": [
        { "id": "amatsu_trending_series", "type": "series", "name": "Amatsu Trending Series" },
        { "id": "amatsu_top_series", "type": "series", "name": "Amatsu Top Rated Series" },
        { "id": "amatsu_trending_movie", "type": "movie", "name": "Amatsu Trending Movies" },
        { "id": "amatsu_top_movie", "type": "movie", "name": "Amatsu Top Rated Movies" },
        { "id": "amatsu_search", "type": "series", "name": "Amatsu Search", "extra": [{ "name": "search", "isRequired": true }] },
        { "id": "amatsu_search", "type": "movie", "name": "Amatsu Search", "extra": [{ "name": "search", "isRequired": true }] }
    ],
    "config": [{ "key": "Amatsu", "type": "text", "title": "Amatsu Internal Payload" }],
    "behaviorHints": { "configurable": true, "configurationRequired": true }
};

const builder = new addonBuilder(manifest);

//===============
// CATALOG HANDLER
//===============

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    try {
        const userConfig = parseConfig(config);

        if (id === "amatsu_trending_series" && userConfig.showTrendingSeries !== false) {
            const results = await getTrendingAnime("series");
            return { "metas": results.filter(m => m.type === type), "cacheMaxAge": 21600 };
        }
        if (id === "amatsu_top_series" && userConfig.showTopSeries !== false) {
            const results = await getTopAnime("series");
            return { "metas": results.filter(m => m.type === type), "cacheMaxAge": 86400 };
        }
        if (id === "amatsu_trending_movie" && userConfig.showTrendingMovies !== false) {
            const results = await getTrendingAnime("movie");
            return { "metas": results.filter(m => m.type === type), "cacheMaxAge": 21600 };
        }
        if (id === "amatsu_top_movie" && userConfig.showTopMovies !== false) {
            const results = await getTopAnime("movie");
            return { "metas": results.filter(m => m.type === type), "cacheMaxAge": 86400 };
        }

        if (id === "amatsu_search" && extra.search) {
            const nyaaPromise = searchNyaaForAnime(extra.search).catch(() => []);
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 3500));

            const [anilistRes, cinemetaRes, nyaaRes] = await Promise.all([
                searchAnime(extra.search).catch(() => []),
                searchCinemeta(extra.search, type).catch(() => []),
                Promise.race([nyaaPromise, timeoutPromise])
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
                    "id": `amatsu_raw:${type}:${toBase64Safe(extra.search)}`,
                    "type": type,
                    "name": extra.search + " (RAW SEARCH)",
                    "poster": `https://dummyimage.com/600x900/1a1a1a/42a5f5.png?text=${encodeURIComponent(extra.search)}\nRaw+Search`,
                    "background": `https://dummyimage.com/1920x1080/1a1a1a/42a5f5.png?text=${encodeURIComponent(extra.search)}`,
                    "description": `Found ${nyaaRes.length} raw torrents directly on Nyaa. Use this if no official metadata matches.`
                });
            }

            return { "metas": results, "cacheMaxAge": 86400 };
        }
        
        return { "metas": [] };
    } catch (e) { return { "metas": [] }; }
});

//===============
// META HANDLER
//===============

builder.defineMetaHandler(async ({ id }) => {
    try {
        if (id.startsWith("amatsu_raw:")) {
            const parts = id.split(":");
            const mType = parts[1];
            const query = fromBase64Safe(parts[2]);
            const meta = {
                "id": id, "type": mType, "name": query + " (Raw Search)",
                "poster": `https://dummyimage.com/600x900/1a1a1a/42a5f5.png?text=${encodeURIComponent(query)}\nRaw+Search`,
                "background": `https://dummyimage.com/1920x1080/1a1a1a/42a5f5.png?text=${encodeURIComponent(query)}`,
                "description": `Dynamically generated metadata for "${query}".`,
            };
            if (mType === "series") {
                meta.videos = [];
                for (let s = 1; s <= 10; s++) {
                    for (let e = 1; e <= 100; e++) {
                        meta.videos.push({
                            "id": `${id}:${s}:${e}`,
                            "title": `Episode ${e}`,
                            "season": s,
                            "episode": e
                        });
                    }
                }
            }
            return { "meta": meta, "cacheMaxAge": 86400 };
        }

        if (!id.startsWith("amatsu:") && !id.startsWith("anilist:")) return { "meta": null };
        const aniListId = id.split(":")[1];
        if (!aniListId || isNaN(aniListId)) return { "meta": null };
        const meta = await getAnimeMeta(aniListId);
        if (!meta) return { "meta": null };
        
        if (meta.type === "series") {
            const jikanEps = meta.idMal ? await fetchEpisodeDetails(meta.idMal).catch(() => ({})) : {};
            const epMeta = meta.epMeta || {};
            const defaultThumb = meta.background || meta.poster || "https://dummyimage.com/600x337/1a1a1a/42a5f5.png?text=AMATSU+EPISODE";
            meta.videos = Array.from({ "length": meta.episodes || 12 }, (_, i) => {
                const epNum = i + 1;
                const jData = jikanEps[epNum] || {};
                const epData = epMeta[epNum] || {};
                return { "id": `${id}:1:${epNum}`, "title": jData.title || epData.title || `Episode ${epNum}`, "season": 1, "episode": epNum, "thumbnail": epData.thumbnail || defaultThumb };
            });
        }
        return { "meta": meta, "cacheMaxAge": 604800 };
    } catch (e) { return { "meta": null }; }
});

//===============
// STREAM HANDLER
//===============

builder.defineStreamHandler(async ({ type, id, config }) => {
    try {
        if (!id.startsWith("amatsu:") && !id.startsWith("anilist:") && !id.startsWith("nyaa:") && !id.startsWith("kitsu:") && !id.startsWith("tt") && !id.startsWith("amatsu_raw:")) return { "streams": [] };

        const userConfig = parseConfig(config);
        if (!userConfig.rdKey && !userConfig.tbKey) return { "streams": [] };

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
        } else if (id.startsWith("tt")) {
            if (parts.length > 2) {
                expectedSeason = parseInt(parts[1], 10) || 1;
                requestedEp = parseInt(parts[2], 10) || 1;
            } else { requestedEp = 1; }
        }

        const metaTasks = [];
        if (id.startsWith("tt")) {
            metaTasks.push(axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${parts[0]}.json`, { "timeout": 3000 })
                .then(res => ({ "source": "cinemeta", "name": res.data?.meta?.name }))
                .catch(() => null));
        }
        if (aniListId) {
            metaTasks.push(getAnimeMeta(aniListId).then(meta => ({ "source": "anilist", "meta": meta }))
                .catch(() => null));
        }

        const metaResults = await Promise.all(metaTasks);
        let freshMeta = null;
        metaResults.forEach(r => {
            if (!r) return;
            if (r.source === "cinemeta") searchTitleFallback = r.name;
            if (r.source === "anilist") freshMeta = r.meta;
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

        if (!freshMeta && !searchTitleFallback) return { "streams": [] };

        const extractSeason = (t) => {
            const m = t.match(/\b(?:S|Season|Part|Cour|Dai|Di)\s*0*(\d+)\b/i);
            return m ? parseInt(m[1], 10) : (/\b(?:second|ii)\b/i.test(t) ? 2 : (/\b(?:third|iii)\b/i.test(t) ? 3 : 1));
        };
        
        if (!id.startsWith("tt") && !isRawSearch && freshMeta) { expectedSeason = extractSeason(freshMeta.name); }

        //===============
        // CHECK IF IT´S A MOVIE
        //===============
        const isMovie = type === "movie" || (freshMeta && freshMeta.format === "MOVIE");

        const fetchAllPossibleTorrents = async () => {
            const epStr = requestedEp < 10 ? `0${requestedEp}` : `${requestedEp}`;
            const sStr = expectedSeason < 10 ? `0${expectedSeason}` : `${expectedSeason}`;
            const deduplicated = new Map();
            
            const runTask = async (queryFn) => {
                try {
                    const res = await queryFn();
                    if (res && res.length > 0) {
                        res.forEach(t => deduplicated.set(t.hash.toLowerCase(), t));
                    }
                } catch (e) {}
            };

            const titleList = [];
            if (freshMeta) {
                if (freshMeta.name) titleList.push(sanitizeSearchQuery(freshMeta.name));
                if (freshMeta.altName) titleList.push(sanitizeSearchQuery(freshMeta.altName));
            } else if (searchTitleFallback) {
                titleList.push(sanitizeSearchQuery(searchTitleFallback));
            }
            const uniqueTitles = [...new Set(titleList)];

            for (const title of uniqueTitles) {
                if (isMovie) {
                    await runTask(() => searchNyaaForAnime(`${title}`));
                } else {
                    await runTask(() => searchNyaaForAnime(`${title} ${epStr}`));
                    await runTask(() => searchNyaaForAnime(`${title} S${sStr}E${epStr}`));
                    if (deduplicated.size < 10) {
                        await runTask(() => searchNyaaForAnime(`${title} Batch`));
                        await runTask(() => searchNyaaForAnime(`${title} S${sStr}`));
                    }
                    if (deduplicated.size < 5) {
                        await runTask(() => searchNyaaForAnime(`${title}`));
                    }
                }
            }
            return { torrentsArr: Array.from(deduplicated.values()), uniqueTitles };
        };

        const searchResult = await fetchAllPossibleTorrents();
        let torrents = searchResult.torrentsArr;
        const uniqueTitles = searchResult.uniqueTitles;
        
        //===============
        // TRASH & SOUNDTRACK FILTER
        //===============
        torrents = torrents.filter(t => {
            if (!isRawSearch && /\b(?:Soundtrack|OST|FLAC|MP3|CD)\b/i.test(t.title)) {
                return false;
            }
            if (isRawSearch) return true;
            return verifyTitleMatch(t.title, uniqueTitles);
        });

        if (!torrents.length) return { "streams": [], "cacheMaxAge": 60 };

        const hashes = torrents.map(t => t.hash.toLowerCase());
        
        const [rdC, tbC, rdA, tbA] = await Promise.all([
            userConfig.rdKey ? checkRD(hashes, userConfig.rdKey).catch(() => ({})) : {},
            (userConfig.tbKey || INTERNAL_TB_KEY) ? checkTorbox(hashes, userConfig.tbKey || INTERNAL_TB_KEY).catch(() => ({})) : {},
            userConfig.rdKey ? getActiveRD(userConfig.rdKey).catch(() => ({})) : {},
            userConfig.tbKey ? getActiveTorbox(userConfig.tbKey).catch(() => ({})) : {}
        ]);

        const flags = { "GER": "🇩🇪", "ITA": "🇮🇹", "FRE": "🇫🇷", "SPA": "🇪🇸", "RUS": "🇷🇺", "POR": "🇵🇹", "ARA": "🇸🇦", "CHI": "🇨🇳", "KOR": "🇰🇷", "HIN": "🇮🇳", "POL": "🇵🇱", "NLD": "🇳🇱", "TUR": "🇹🇷", "VIE": "🇻🇳", "IND": "🇮🇩", "JPN": "🇯🇵", "ENG": "🇬🇧", "MULTI": "🌍" };
        const userLangs = Array.isArray(userConfig.language) ? userConfig.language : [userConfig.language || "ENG"];

        const streams = [];

        torrents.forEach(t => {
            const hashLow = t.hash.toLowerCase();
            const { res } = extractTags(t.title);
            const bytes = parseSizeToBytes(t.size);
            const streamLang = extractLanguage(t.title, userLangs);
            const flag = flags[streamLang] || "🇬🇧";
            
            const isValidMatch = isMovie || isRawSearch ? true : (isSeasonBatch(t.title, expectedSeason) || isEpisodeMatch(t.title, requestedEp, expectedSeason));

            // RD LOGIC
            if (userConfig.rdKey) {
                const files = rdC[hashLow];
                const prog = rdA[hashLow];
                const tbFiles = tbC[hashLow];
                
                let matchedFile = files ? selectBestVideoFile(files, requestedEp, expectedSeason, isMovie) : null;
                const isCached = !!matchedFile;
                const isDownloading = prog !== undefined && prog < 100;

                let uiName = `AMATSU [☁️ RD]`;
                let streamStatus = "☁️ Download";

                if (isCached) {
                    uiName = `AMATSU [⚡ RD]`;
                    streamStatus = "⚡ Cached";
                } else if (isDownloading) {
                    uiName = `AMATSU [⏳ ${prog}% RD]`;
                    streamStatus = `⏳ ${prog}% Downloading`;
                } else if (tbFiles && tbFiles.length > 0) {
                    uiName = `AMATSU [⚡ RD+]`;
                    streamStatus = "⚡ Fast Download";
                }

                if (isCached || isDownloading || isValidMatch) {
                    streams.push({
                        "name": uiName + `\n🎥 ${res}`,
                        "description": `${flag} Nyaa | ${streamStatus}\n📄 ${t.title}\n💾 ${t.size} | 👥 ${t.seeders || 0} Seeds`,
                        "url": BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp,
                        "behaviorHints": { "bingeGroup": "amatsu_rd_" + t.hash, "filename": matchedFile ? matchedFile.name : undefined },
                        "_bytes": bytes, "_lang": streamLang, "_isCached": isCached, "_res": res, "_prog": prog || 0
                    });
                }
            }

            // TB LOGIC
            if (userConfig.tbKey) {
                const files = tbC[hashLow];
                const prog = tbA[hashLow];
                
                let matchedFile = files ? selectBestVideoFile(files, requestedEp, expectedSeason, isMovie) : null;
                const isCached = !!matchedFile;
                const isDownloading = prog !== undefined && prog < 100;

                let uiName = `AMATSU [☁️ TB]`;
                let streamStatus = "☁️ Download";

                if (isCached) {
                    uiName = `AMATSU [⚡ TB]`;
                    streamStatus = "⚡ Cached";
                } else if (isDownloading) {
                    uiName = `AMATSU [⏳ ${prog}% TB]`;
                    streamStatus = `⏳ ${prog}% Downloading`;
                }

                if (isCached || isDownloading || isValidMatch) {
                    streams.push({
                        "name": uiName + `\n🎥 ${res}`,
                        "description": `${flag} Nyaa | ${streamStatus}\n📄 ${t.title}\n💾 ${t.size} | 👥 ${t.seeders || 0} Seeds`,
                        "url": BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp,
                        "behaviorHints": { "bingeGroup": "amatsu_tb_" + t.hash, "filename": matchedFile ? matchedFile.name : undefined },
                        "_bytes": bytes, "_lang": streamLang, "_isCached": isCached, "_res": res, "_prog": prog || 0
                    });
                }
            }
        });

        //===============
        // SORTING LOGIC
        //===============

        return { 
            "streams": streams.sort((a, b) => {
                if (a._prog > 0 && b._prog === 0) return -1;
                if (b._prog > 0 && a._prog === 0) return 1;

                if (a._isCached !== b._isCached) return b._isCached ? 1 : -1;

                const getLangScore = (l) => {
                    if (userLangs.includes(l)) return 200 - userLangs.indexOf(l);
                    if (l === "MULTI") return 150;
                    return 0;
                };
                const langScoreA = getLangScore(a._lang);
                const langScoreB = getLangScore(b._lang);
                if (langScoreA !== langScoreB) return langScoreB - langScoreA;

                const resMap = { "8K": 8, "4K": 4, "2K": 2, "1080p": 1, "720p": 0.5 };
                const resScoreA = resMap[a._res] || 0;
                const resScoreB = resMap[b._res] || 0;
                if (resScoreA !== resScoreB) return resScoreB - resScoreA;

                return b._bytes - a._bytes;
            }), 
            "cacheMaxAge": 3600 
        };
    } catch (err) { 
        console.error("Stream Handler Error:", err);
        return { "streams": [] }; 
    }
});

module.exports = { "addonInterface": builder.getInterface(), manifest, parseConfig };
