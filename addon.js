//===============
// AMATSU STREMIO ADDON - CORE LOGIC
// (Consistent UI + StremThru Cache + Strict Episode Enforcing + Dynamic Season & Episode Extraction)
// Version 9.6.0 - Parallel Acceleration & Timeout Guard
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getAiringAnime, getSeasonalAnime, getJikanMeta, fetchEpisodeDetails, getCurrentSeasonInfo } = require("./lib/anilist");
const { searchNyaaForAnime } = require("./lib/nyaa");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch, verifyTitleMatch } = require("./lib/parser");

let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7002";
BASE_URL = BASE_URL.replace(/\/+$/, "");

const INTERNAL_TB_KEY = process.env.INTERNAL_TORBOX_KEY || "";
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || null;

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
    } catch (e) {}
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

const LANG_REGEX = {
    "GER": /\b(ger|deu|german|deutsch|de-de)\b|(?:^|[\[\(\-_ ])(de)(?:[\]\)\-_ ]|$)/i,
    "FRE": /\b(fre|fra|french|vostfr|vf|fr-fr)\b|(?:^|[\[\(\-_ ])(fr)(?:[\]\)\-_ ]|$)/i,
    "ITA": /\b(ita|italian|it-it)\b|(?:^|[\[\(\-_ ])(it)(?:[\]\)\-_ ]|$)/i,
    "SPA": /\b(spa|esp|spanish|es-es|es-mx)\b|(?:^|[\[\(\-_ ])(es)(?:[\]\)\-_ ]|$)/i,
    "RUS": /\b(rus|russian|ru-ru)\b|(?:^|[\[\(\-_ ])(ru)(?:[\]\)\-_ ]|$)/i,
    "POR": /\b(por|pt-br|portuguese|pt-pt)\b|(?:^|[\[\(\-_ ])(pt)(?:[\]\)\-_ ]|$)/i,
    "ARA": /\b(ara|arabic|ar-sa)\b|(?:^|[\[\(\-_ ])(ar)(?:[\]\)\-_ ]|$)/i,
    "CHI": /\b(chi|chinese|chs|cht|mandarin|zh-cn|zh-tw)\b|(?:^|[\[\(\-_ ])(zh)(?:[\]\)\-_ ]|$)|(简|繁|中文字幕)/i,
    "KOR": /\b(kor|korean|ko-kr)\b|(?:^|[\[\(\-_ ])(ko)(?:[\]\)\-_ ]|$)/i,
    "HIN": /\b(hin|hindi|hi-in)\b|(?:^|[\[\(\-_ ])(hi)(?:[\]\)\-_ ]|$)/i,
    "POL": /\b(pol|polish|pl-pl)\b|(?:^|[\[\(\-_ ])(pl)(?:[\]\)\-_ ]|$)/i,
    "NLD": /\b(nld|dut|dutch|nl-nl)\b|(?:^|[\[\(\-_ ])(nl)(?:[\]\)\-_ ]|$)/i,
    "TUR": /\b(tur|turkish|tr-tr)\b|(?:^|[\[\(\-_ ])(tr)(?:[\]\)\-_ ]|$)/i,
    "VIE": /\b(vie|vietnamese|vi-vn)\b|(?:^|[\[\(\-_ ])(vi)(?:[\]\)\-_ ]|$)/i,
    "IND": /\b(ind|indonesian|id-id)\b|(?:^|[\[\(\-_ ])(id)(?:[\]\)\-_ ]|$)/i,
    "ENG": /\b(eng|english|dubbed|subbed|en-us|en-gb)\b|(?:^|[\[\(\-_ ])(en)(?:[\]\)\-_ ]|$)/i,
    "JPN": /\b(jpn|japanese|raw|jp-jp)\b|(?:^|[\[\(\-_ ])(jp)(?:[\]\)\-_ ]|$)/i,
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
    if (!title) return "";
    return title.replace(/\(.*?\)/g, "")
                .replace(/\[.*?\]/g, "")
                .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"'<>?+|\\・、。「」『』【】［］（）〈〉≪≫《》〔〕…—～〜♥♡★☆♪]/g, " ")
                .replace(/\s{2,}/g, " ")
                .trim(); 
}

const manifest = {
    "id": "org.community.amatsu", "version": "9.6.0", "name": "Amatsu", "logo": BASE_URL + "/amatsu.png",
    "description": "The ultimate Debrid-powered Gateway. Parallel Search for Anime, Live-Action, and more.",
    "types": ["anime", "movie", "series"],
    "resources": [
        "catalog",
        {
            "name": "meta",
            "types": ["anime", "movie", "series"],
            "idPrefixes": ["anilist:", "amatsu_raw:"]
        },
        {
            "name": "stream",
            "types": ["anime", "movie", "series"],
            "idPrefixes": ["anilist:", "nyaa:", "kitsu:", "tt", "amatsu_raw:"]
        }
    ],
    "catalogs": [
        { "id": "amatsu_seasonal_series", "type": "anime", "name": "Amatsu Current Season" },
        { "id": "amatsu_airing_series", "type": "anime", "name": "Amatsu Currently Airing" },
        { "id": "amatsu_trending_series", "type": "anime", "name": "Amatsu Trending Series" },
        { "id": "amatsu_top_series", "type": "anime", "name": "Amatsu Top Rated Series" },
        { "id": "amatsu_trending_movie", "type": "anime", "name": "Amatsu Trending Movies" },
        { "id": "amatsu_top_movie", "type": "anime", "name": "Amatsu Top Rated Movies" },
        { "id": "amatsu_search", "type": "anime", "name": "Amatsu Search", "extra": [{ "name": "search", "isRequired": true }] },
        { "id": "amatsu_search", "type": "movie", "name": "Amatsu Search", "extra": [{ "name": "search", "isRequired": true }] },
        { "id": "amatsu_search", "type": "series", "name": "Amatsu Series", "extra": [{ "name": "search", "isRequired": true }] }
    ],
    "config": [{ "key": "Amatsu", "type": "text", "title": "Amatsu Internal Payload" }],
    "behaviorHints": { "configurable": true, "configurationRequired": true }
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    try {
        const userConfig = parseConfig(config);

        if (id === "amatsu_seasonal_series" && userConfig.showSeasonalSeries !== false) {
            const results = await getSeasonalAnime("anime");
            return { "metas": results.filter(m => m.type === type), "cacheMaxAge": 14400 };
        }
        if (id === "amatsu_airing_series" && userConfig.showAiringSeries !== false) {
            const results = await getAiringAnime("anime");
            return { "metas": results.filter(m => m.type === type), "cacheMaxAge": 14400 };
        }
        if (id === "amatsu_trending_series" && userConfig.showTrendingSeries !== false) {
            const results = await getTrendingAnime("anime");
            return { "metas": results.filter(m => m.type === type), "cacheMaxAge": 21600 };
        }
        if (id === "amatsu_top_series" && userConfig.showTopSeries !== false) {
            const results = await getTopAnime("anime");
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
                axios.get(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(extra.search)}.json`, { timeout: 4000 }).then(res => res.data.metas || []).catch(() => []),
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
                    "description": `Found ${nyaaRes.length} raw torrents. Use this if no official metadata matches.`
                });
            }

            return { "metas": results, "cacheMaxAge": 86400 };
        }
        
        return { "metas": [] };
    } catch (e) { return { "metas": [] }; }
});

builder.defineMetaHandler(async ({ type, id }) => {
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
            if (mType === "series" || mType === "anime") {
                meta.videos = [];
                for (let s = 1; s <= 10; s++) {
                    for (let e = 1; e <= 100; e++) {
                        meta.videos.push({
                            "id": `${id}-${e}`,
                            "title": `Episode ${e}`,
                            "season": s,
                            "episode": e
                        });
                    }
                }
            } else if (mType === "movie") {
                meta.videos = [{
                    "id": id,
                    "title": query || "Movie",
                    "released": new Date().toISOString()
                }];
                meta.behaviorHints = { "defaultVideoId": id };
            }
            return { "meta": meta, "cacheMaxAge": 86400 };
        }

        if (!id.startsWith("anilist:")) return { "meta": null };
        const aniListId = id.split(":")[1];
        if (!aniListId || isNaN(aniListId)) return { "meta": null };
        const meta = await getAnimeMeta(aniListId);
        if (!meta) return { "meta": null };
        
        meta.id = id;

        if (meta.type === "anime" || meta.type === "series") {
            meta.type = "anime";
            const jikanEps = meta.idMal ? await fetchEpisodeDetails(meta.idMal).catch(() => ({})) : {};
            const epMeta = meta.epMeta || {};
            const defaultThumb = meta.background || meta.poster || "https://dummyimage.com/600x337/1a1a1a/42a5f5.png?text=AMATSU+EPISODE";
            meta.videos = Array.from({ "length": meta.episodes || 12 }, (_, i) => {
                const epNum = i + 1;
                const jData = jikanEps[epNum] || {};
                const epData = epMeta[epNum] || {};
                return { "id": `${id}-${epNum}`, "title": jData.title || epData.title || `Episode ${epNum}`, "season": 1, "episode": epNum, "thumbnail": epData.thumbnail || defaultThumb };
            });
        } else if (meta.type === "movie") {
            meta.videos = [{
                "id": id,
                "title": meta.name || "Movie",
                "released": meta.released || new Date().toISOString(),
                "thumbnail": meta.poster
            }];
            meta.behaviorHints = { "defaultVideoId": id };
        }
        
        return { "meta": meta, "cacheMaxAge": 604800 };
    } catch (e) { return { "meta": null }; }
});

builder.defineStreamHandler(async ({ type, id, config }) => {
    try {
        console.log(`\n[AMATSU FORENSICS] ===== NEUE SUCHE =====`);
        console.log(`[AMATSU FORENSICS] FlareSolverr Status: ${FLARESOLVERR_URL ? "AKTIV" : "INAKTIV"}`);
        console.log(`[AMATSU FORENSICS] ID: ${id} | Type: ${type}`);

        if (!id.startsWith("anilist:") && !id.startsWith("nyaa:") && !id.startsWith("kitsu:") && !id.startsWith("tt") && !id.startsWith("amatsu_raw:")) return { "streams": [] };

        const userConfig = parseConfig(config);
        if (!userConfig.rdKey && !userConfig.tbKey) return { "streams": [] };

        let aniListId = null;
        let requestedEp = 1;
        let expectedSeason = 1;
        let searchTitleFallback = null;
        let isRawSearch = false;

        const parts = id.split(":");

        if (id.startsWith("kitsu:")) {
            try {
                const kitsuId = parts[1];
                const kRes = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 4000 });
                searchTitleFallback = kRes.data?.data?.attributes?.canonicalTitle || kRes.data?.data?.attributes?.titles?.en_jp;
                requestedEp = parseInt(parts[2], 10) || 1;
            } catch (e) { 
                console.log(`[AMATSU FORENSICS] Kitsu lookup failed für ID: ${id}`); 
            }
        } else if (id.startsWith("amatsu_raw:")) {
            const mType = parts[1];
            let rawPayload = parts[2];
            
            if (rawPayload && rawPayload.includes("-")) {
                let subParts = rawPayload.split("-");
                searchTitleFallback = fromBase64Safe(subParts[0]);
                requestedEp = parseInt(subParts[1], 10) || 1;
            } else {
                searchTitleFallback = fromBase64Safe(rawPayload);
                requestedEp = 1;
            }
            expectedSeason = 1;
            isRawSearch = true;
        } else if (id.startsWith("anilist:")) {
            let payload = parts[1];
            if (payload.includes("-")) {
                let subParts = payload.split("-");
                aniListId = subParts[0];
                requestedEp = parseInt(subParts[1], 10) || 1;
            } else {
                aniListId = payload;
                requestedEp = parts.length > 2 ? parseInt(parts[parts.length - 1], 10) : 1;
            }
        } else if (id.startsWith("tt")) {
            if (parts.length > 2) {
                expectedSeason = parseInt(parts[1], 10) || 1;
                requestedEp = parseInt(parts[2], 10) || 1;
            } else { requestedEp = 1; }
        }

        const metaTasks = [];
        if (id.startsWith("tt")) {
            metaTasks.push((async () => {
                const imdbId = parts[0];
                let name = "";
                try {
                    let res = await axios.get(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${imdbId}.json`, { timeout: 4000 });
                    name = res.data?.metas?.[0]?.name;
                } catch(e) {}

                if (!name) {
                    try {
                        let res2 = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 4000 });
                        name = res2.data?.meta?.name;
                    } catch(e) {}
                }
                return { source: "cinemeta", name: name || "" };
            })());
        }
        if (aniListId) {
            metaTasks.push(getAnimeMeta(aniListId).then(meta => ({ "source": "anilist", "meta": meta })).catch(() => null));
        }

        const metaResults = await Promise.all(metaTasks);
        let freshMeta = null;
        metaResults.forEach(r => {
            if (!r) return;
            if (r.source === "cinemeta" && !searchTitleFallback) searchTitleFallback = r.name;
            if (r.source === "anilist") freshMeta = r.meta;
        });

        if (id.startsWith("tt") && searchTitleFallback) {
             try {
                const searchResults = await searchAnime(searchTitleFallback);
                if (searchResults && searchResults.length > 0) {
                    const matchedId = searchResults[0].id.split(":")[1];
                    const extraMeta = await getAnimeMeta(matchedId);
                    if (extraMeta) {
                        const anilistName = extraMeta.name.toLowerCase();
                        const cinemetaName = searchTitleFallback.toLowerCase();
                        if (anilistName.includes(cinemetaName) || cinemetaName.includes(anilistName)) {
                            freshMeta = extraMeta;
                        }
                    }
                }
            } catch (e) {}
        } else if (!freshMeta && searchTitleFallback && !isRawSearch) {
             try {
                const searchResults = await searchAnime(searchTitleFallback);
                if (searchResults && searchResults.length > 0) {
                    const matchedId = searchResults[0].id.split(":")[1];
                    freshMeta = await getAnimeMeta(matchedId);
                }
            } catch (e) {}
        }

        if (!freshMeta && !searchTitleFallback) {
            console.log(`[AMATSU FORENSICS] Abbruch: Keine Metadaten gefunden.`);
            return { "streams": [] };
        }

        const extractSeason = (t) => {
            const nthMatch = t.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:Season|Part|Cour)\b/i);
            if (nthMatch) return parseInt(nthMatch[1], 10);
            const m = t.match(/\b(?:S|Season|Part|Cour|Dai|Di)\s*0*(\d+)\b/i);
            if (m) return parseInt(m[1], 10);
            if (/\b(?:second|ii)\b/i.test(t)) return 2;
            if (/\b(?:third|iii)\b/i.test(t)) return 3;
            if (/\b(?:fourth|iv)\b/i.test(t)) return 4;
            if (/\b(?:fifth|v)\b/i.test(t)) return 5;
            if (/\b(?:sixth|vi)\b/i.test(t)) return 6;
            return null;
        };

        if (!id.startsWith("tt") && !isRawSearch) {
            let detected = null;
            const sources = [searchTitleFallback, freshMeta ? freshMeta.name : "", freshMeta ? freshMeta.altName : ""];
            for (let s of sources) {
                if (s) {
                    let d = extractSeason(s);
                    if (d && d > 1) {
                        detected = d;
                        break;
                    }
                }
            }
            if (detected) expectedSeason = detected;
        }

        const isMovie = type === "movie" || (freshMeta && freshMeta.format === "MOVIE");

        const titleList = [];
        if (searchTitleFallback) titleList.push(sanitizeSearchQuery(searchTitleFallback));
        if (freshMeta) {
            if (freshMeta.name) titleList.push(sanitizeSearchQuery(freshMeta.name));
            if (freshMeta.altName) titleList.push(sanitizeSearchQuery(freshMeta.altName));
        }

        const uniqueTitles = [...new Set(titleList.filter(Boolean))];
        const searchQueries = new Set();
        
        const baseTitles = new Set();
        uniqueTitles.forEach(t => {
            const stripped = t.replace(/\b(?:\d+(?:st|nd|rd|th)\s+(?:Season|Part|Cour)|Season\s*\d+|S\d+|Part\s*\d+|Cour\s*\d+|Episode\s*\d+|Ep\s*\d+)\b/ig, "")
                              .replace(/第\s*\d+\s*(?:季|期|기|話|话|集)/g, "")
                              .replace(/\s{2,}/g, " ").trim();
            if (stripped.length > 4) baseTitles.add(stripped);
        });
        const validSearchTitles = Array.from(baseTitles);

        // STREMIO FIX: Voller Name ZUERST in die Set-Liste
        validSearchTitles.forEach(t => searchQueries.add(t));

        const primaryTitleToSplit = searchTitleFallback || (freshMeta ? freshMeta.name : null);
        if (primaryTitleToSplit) {
             const words = sanitizeSearchQuery(primaryTitleToSplit).split(/\s+/);
             const w2 = words.slice(0, 2).join(" ");
             const w3 = words.slice(0, 3).join(" ");
             const w4 = words.slice(0, 4).join(" ");
             if (words.length >= 4 && w4.length > 4) searchQueries.add(w4);
             if (words.length >= 3 && w3.length > 4) searchQueries.add(w3);
             if (words.length >= 2 && w2.length > 4) searchQueries.add(w2);
        }

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

            let isFirstTitle = true;
            const absoluteStartTimer = Date.now();
            
            for (const title of searchQueries) {
                // STREMIO TIMEOUT SCHUTZ: Wir stoppen die Schleife rigoros nach 10 Sekunden!
                if (Date.now() - absoluteStartTimer > 10000) {
                    console.log(`[AMATSU FORENSICS] ⏱️ STREMIO-SCHUTZ: 10 Sekunden Limit erreicht. Stoppe weitere Such-Variationen.`);
                    break;
                }
                
                if (deduplicated.size >= 45) {
                    break;
                }

                if (isMovie) {
                    await runTask(() => searchNyaaForAnime(`${title}`));
                } else {
                    await runTask(() => searchNyaaForAnime(`${title} ${epStr}`));
                    
                    if (isFirstTitle || deduplicated.size < 15) {
                        await runTask(() => searchNyaaForAnime(`${title} Batch`));
                        await runTask(() => searchNyaaForAnime(`${title} S${sStr}`));
                    }
                    
                    await runTask(() => searchNyaaForAnime(`${title} S${sStr}E${epStr}`));
                    
                    if (deduplicated.size < 10) {
                        await runTask(() => searchNyaaForAnime(`${title}`));
                    }
                }
                isFirstTitle = false;
                
                // SPEEDUP: Pause zwischen Variationen auf 150ms verkürzt
                await new Promise(r => setTimeout(r, 150));
            }
            return { torrentsArr: Array.from(deduplicated.values()) };
        };

        const searchResult = await fetchAllPossibleTorrents();
        let torrents = searchResult.torrentsArr;
        
        let filterDropCount = 0;
        torrents = torrents.filter(t => {
            if (!isRawSearch && /\b(?:Soundtrack|OST|MP3|CD|Manga|Light Novel|LN|Artbook|Doujinshi|同人誌|同人CG集|Pictures|Images|Novel|Cosplay)\b/i.test(t.title)) {
                filterDropCount++;
                return false;
            }
            if (isRawSearch) return true;
            
            const isValid = verifyTitleMatch(t.title, validSearchTitles);
            if (!isValid) {
                filterDropCount++;
                return false;
            }

            const bytes = parseSizeToBytes(t.size);
            const isBatch = isSeasonBatch(t.title, expectedSeason);
            
            if (!isMovie && !isBatch && bytes > 20.0 * 1024 * 1024 * 1024) {
                filterDropCount++;
                return false;
            }

            return true;
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
            const seeders = parseInt(t.seeders, 10) || 0;
            
            let isValidMatch = false;
            let isBatch = false;

            if (isMovie || isRawSearch) {
                isValidMatch = true;
            } else {
                 isBatch = isSeasonBatch(t.title, expectedSeason);
                 isValidMatch = isBatch || isEpisodeMatch(t.title, requestedEp, expectedSeason);
            }

            if (!isValidMatch) {
                return; 
            }

            const batchStr = isBatch ? " | 📦 Batch" : "";

            if (userConfig.rdKey) {
                const filesRD = rdC[hashLow];
                const prog = rdA[hashLow];
                const tbFiles = tbC[hashLow];
                
                let matchedFile = filesRD ? selectBestVideoFile(filesRD, requestedEp, expectedSeason, isMovie) : null;
                const isStremThruCached = filesRD && filesRD.length > 0;
                const isRadarCached = tbFiles && tbFiles.length > 0;
                const isRDCached = isStremThruCached || isRadarCached;
                const isDownloading = prog !== undefined && prog < 100;

                if (isStremThruCached && !matchedFile && !isMovie) {
                    // Skip
                } else {
                    let uiName = `AMATSU [☁️ RD]`;
                    let streamStatus = "☁️ Download";

                    if (isStremThruCached) {
                        uiName = `AMATSU [⚡ RD+]`;
                        streamStatus = "⚡ Cached (StremThru)";
                    } else if (isRadarCached) {
                        uiName = `AMATSU [⚡ RD+]`;
                        streamStatus = "⚡ Cached (Radar)";
                    } else if (isDownloading) {
                        uiName = `AMATSU [⏳ ${prog}% RD]`;
                        streamStatus = `⏳ ${prog}% Downloading`;
                    }

                    const streamDescLine1 = `${flag} Nyaa | ${streamStatus}${batchStr}`;
                    const streamDescLine2 = `📄 ${t.title}`;
                    const streamDescLine3 = `💾 ${t.size} | 👥 ${seeders} Seeds`;

                    const streamPayload = {
                        "name": uiName + `\n🎥 ${res}`,
                        "description": streamDescLine1 + "\n" + streamDescLine2 + "\n" + streamDescLine3,
                        "url": BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp,
                        "behaviorHints": { "bingeGroup": "amatsu_rd_" + t.hash, "filename": matchedFile ? matchedFile.name : undefined },
                        "_bytes": bytes, "_lang": streamLang, "_isCached": isRDCached, "_res": res, "_prog": prog || 0, "_seeders": seeders, "_isBatch": isBatch
                    };

                    let subtitles = [];
                    if (isStremThruCached && filesRD) {
                        const subFiles = filesRD.filter(f => /\.(srt|vtt|ass|ssa)$/i.test(f.name || f.path || ""));
                        subFiles.forEach(sub => {
                            subtitles.push({
                                id: String(sub.id),
                                url: `${BASE_URL}/sub/realdebrid/${userConfig.rdKey}/${t.hash}/${sub.id}?filename=${encodeURIComponent(sub.name || sub.path || "sub.srt")}`,
                                lang: extractLanguage(sub.name || sub.path || "", userLangs) || "ENG"
                            });
                        });
                    }
                    if (subtitles.length > 0) streamPayload.subtitles = subtitles;

                    streams.push(streamPayload);
                }
            }

            if (userConfig.tbKey) {
                const files = tbC[hashLow];
                const prog = tbA[hashLow];
                
                let matchedFile = files ? selectBestVideoFile(files, requestedEp, expectedSeason, isMovie) : null;
                const isCached = files && files.length > 0;
                const isDownloading = prog !== undefined && prog < 100;

                if (isCached && !matchedFile && !isMovie) {
                    // Skip
                } else {
                    let uiName = `AMATSU [☁️ TB]`;
                    let streamStatus = "☁️ Download";

                    if (isCached) {
                        uiName = `AMATSU [⚡ TB]`;
                        streamStatus = "⚡ Cached";
                    } else if (isDownloading) {
                        uiName = `AMATSU [⏳ ${prog}% TB]`;
                        streamStatus = `⏳ ${prog}% Downloading`;
                    }

                    const streamDescLine1 = `${flag} Nyaa | ${streamStatus}${batchStr}`;
                    const streamDescLine2 = `📄 ${t.title}`;
                    const streamDescLine3 = `💾 ${t.size} | 👥 ${seeders} Seeds`;

                    const streamPayload = {
                        "name": uiName + `\n🎥 ${res}`,
                        "description": streamDescLine1 + "\n" + streamDescLine2 + "\n" + streamDescLine3,
                        "url": BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp,
                        "behaviorHints": { "bingeGroup": "amatsu_tb_" + t.hash, "filename": matchedFile ? matchedFile.name : undefined },
                        "_bytes": bytes, "_lang": streamLang, "_isCached": isCached, "_res": res, "_prog": prog || 0, "_seeders": seeders, "_isBatch": isBatch
                    };
                    
                    let subtitles = [];
                    if (isCached && files) {
                        const subFiles = files.filter(f => /\.(srt|vtt|ass|ssa)$/i.test(f.name || f.path || ""));
                        subFiles.forEach(sub => {
                            subtitles.push({
                                id: String(sub.id),
                                url: `${BASE_URL}/sub/torbox/${userConfig.tbKey}/${t.hash}/${sub.id}?filename=${encodeURIComponent(sub.name || sub.path || "sub.srt")}`,
                                lang: extractLanguage(sub.name || sub.path || "", userLangs) || "ENG"
                            });
                        });
                    }
                    if (subtitles.length > 0) streamPayload.subtitles = subtitles;

                    streams.push(streamPayload);
                }
            }
        });

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

                const aBatch = a._isBatch && (a._seeders > 0 || a._isCached) ? 1 : 0;
                const bBatch = b._isBatch && (b._seeders > 0 || b._isCached) ? 1 : 0;
                if (aBatch !== bBatch) return bBatch - aBatch;

                if (!a._isCached && !b._isCached) {
                    if (a._seeders !== b._seeders) return b._seeders - a._seeders;
                }

                return b._bytes - a._bytes;
            }), 
            "cacheMaxAge": 3600 
        };
    } catch (err) { 
        return { "streams": [] }; 
    }
});

module.exports = { "addonInterface": builder.getInterface(), manifest, parseConfig };
