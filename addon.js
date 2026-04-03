//===============
// AMATSU STREMIO ADDON - CORE LOGIC
// The main entry point for the Stremio logic.
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
    return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

//===============
// ADDON MANIFEST
//===============
const manifest = {
    id: "org.community.amatsu",
    version: "6.7.0", 
    name: "Amatsu",
    logo: BASE_URL + "/amatsu.png", 
    description: "The ultimate Debrid-powered Nyaa gateway. Streams Anime directly via Real-Debrid or Torbox. Smart-parsing tames chaotic torrent names for a clean catalog. Pure quality, zero buffering.",
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
        console.error("[Config] CRITICAL PARSING ERROR:", err.message);
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
    if (unit.includes("K")) return val * 1024;
    return val;
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
    if (/\b(ita|italian)\b/i.test(lower)) return "ITA";
    if (/\b(fre|fra|french|vostfr|vf)\b/i.test(lower)) return "FRE";
    if (/\b(spa|esp|spanish)\b/i.test(lower)) return "SPA";
    if (/\b(rus|russian)\b/i.test(lower)) return "RUS";
    if (/\b(por|pt-br|portuguese)\b/i.test(lower)) return "POR";
    if (/\b(ara|arabic)\b/i.test(lower)) return "ARA";
    if (/\b(chinese|mandarin|chs|cht|big5)\b|(简|繁|中文字幕)/i.test(lower)) return "CHI";
    if (/\b(kor|korean)\b/i.test(lower)) return "KOR";
    if (/\b(hin|hindi)\b/i.test(lower)) return "HIN";
    if (/\b(pol|polish)\b/i.test(lower)) return "POL";
    if (/\b(nld|dut|dutch)\b/i.test(lower)) return "NLD";
    if (/\b(tur|turkish)\b/i.test(lower)) return "TUR";
    if (/\b(vie|vietnamese)\b/i.test(lower)) return "VIE";
    if (/\b(ind|indonesian)\b/i.test(lower)) return "IND";
    if (/\b(jpn|japanese|raw)\b/i.test(lower)) return "JPN";
    if (/\b(eng|english|subbed)\b/i.test(lower)) return "ENG";
    return "ENG"; 
}

function sanitizeSearchQuery(title) {
    return title.replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "").replace(/\s{2,}/g, " ").trim();
}

function isTitleMatchingEpisode(title, requestedEp) {
    if (/batch|complete|all\s+episodes/i.test(title)) return true;
    return isEpisodeMatch(title, requestedEp);
}

function generateDynamicPoster(title) {
    let clean = title.replace(/^\[.*?\]\s*/g, "").replace(/\[.*?\]/g, " ").replace(/\(.*?\)/g, " ");
    let safeTitle = clean.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s{2,}/g, " ").substring(0, 30).trim().toUpperCase();
    let words = safeTitle.split(" ");
    let lines = [];
    let line = "";
    for (let word of words) {
        if ((line + word).length > 12) {
            if (line) lines.push(line.trim());
            line = word + " ";
        } else { line += word + " "; }
    }
    if (line) lines.push(line.trim());
    return "https://dummyimage.com/600x900/1a1a1a/42a5f5.png?text=" + encodeURIComponent(lines.join("\n"));
}

//===============
// STREMIO HANDLERS
//===============

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    const userConfig = parseConfig(config);
    if (id === "amatsu_trending") {
        if (userConfig.showTrending === false) return { metas: [] };
        const metas = await getTrendingAnime();
        return { metas: metas.filter(m => m.type === type), cacheMaxAge: 43200 };
    }
    if (id === "amatsu_top") {
        if (userConfig.showTop === false) return { metas: [] };
        const metas = await getTopAnime();
        return { metas: metas.filter(m => m.type === type), cacheMaxAge: 43200 };
    }
    if (id === "amatsu_search" && extra.search) {
        const [anilistMetas, nyaaTorrents] = await Promise.all([
            searchAnime(extra.search), 
            searchNyaaForAnime(extra.search)
        ]);
        
        anilistMetas.sort((a, b) => {
            const dateA = a.released ? new Date(a.released).getTime() : Infinity;
            const dateB = b.released ? new Date(b.released).getTime() : Infinity;
            return dateA - dateB;
        });

        const finalMetas = [...anilistMetas];
        const rawGroups = {};
        
        nyaaTorrents.forEach(t => {
            let cleanName = t.title.replace(/\.(mkv|mp4|avi|wmv|ts|flv)$/i, "");
            cleanName = cleanName.replace(/\[.*?\]/g, " ").replace(/\(.*?\)/g, " ").replace(/【.*?】/g, " ").replace(/「.*?」/g, " ");
            
            const epMatch = cleanName.match(/(?:\s+-\s+\d{1,4}(?:v\d)?\b|\b(?:Ep|Episode|E|S\d+E\d+)\b)/i);
            if (epMatch && epMatch.index > 0) cleanName = cleanName.substring(0, epMatch.index);
            
            cleanName = cleanName.replace(/\b(1080p|720p|4k|FHD|HD|SD|Uncensored|Decensored|Eng Sub|Raw|Subbed|Censored|Dual-Audio|HEVC|x265|x264|10bit|8bit)\b/ig, "");
            cleanName = cleanName.replace(/_/g, " ").replace(/\s{2,}/g, " ").trim();
            
            if (cleanName.length < 2) cleanName = t.title.replace(/^\[.*?\]\s*/, "").split("-")[0].trim();
            if (cleanName.length > 2 && !rawGroups[cleanName]) rawGroups[cleanName] = t;
        });
        
        Object.keys(rawGroups).forEach(cleanName => {
            const isAlreadyInAnilist = anilistMetas.some(m => {
                const aName = m.name.toLowerCase();
                const cName = cleanName.toLowerCase();
                return aName.includes(cName) || cName.includes(aName);
            });
            if (!isAlreadyInAnilist) {
                finalMetas.push({ id: "nyaa:" + toBase64Safe(cleanName), type: "series", name: cleanName, poster: generateDynamicPoster(cleanName) });
            }
        });

        const filteredMetas = finalMetas.filter(m => m.type === type);
        return { metas: filteredMetas, cacheMaxAge: filteredMetas.length === 0 ? 60 : 86400 };
    }
    return { metas: [] };
});

builder.defineMetaHandler(async ({ id }) => {
    if (!id.startsWith("amatsu:") && !id.startsWith("anilist:") && !id.startsWith("nyaa:")) return Promise.resolve({ meta: null });

    let meta = null;
    let searchTitle = "";

    try {
        if (id.startsWith("amatsu:") || id.startsWith("anilist:")) {
            const parts = id.split(":");
            let aniListId = parts[1];
            if (isNaN(aniListId)) aniListId = parts.find(p => !isNaN(p) && p.length > 0) || parts[1];
	
            const rawMeta = await getAnimeMeta(aniListId);
            if (rawMeta) {
                searchTitle = rawMeta.name;
                meta = { ...rawMeta }; 
            } else {
                return Promise.resolve({ meta: null });
            }
        } else if (id.startsWith("nyaa:")) {
            const parts = id.split(":");
            const base64Str = parts[1];
            searchTitle = base64Str ? fromBase64Safe(base64Str) : "Unknown";
            let cleanQuery = searchTitle.replace(/^\[.*?\]\s*/g, "").replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
            const malData = await getJikanMeta(cleanQuery);
            if (malData) {
                meta = { 
                    id, type: malData.type || "series", name: searchTitle.replace(/^\[.*?\]\s*/g, "").trim(), poster: malData.poster || generateDynamicPoster(searchTitle),
                    background: malData.background, description: malData.description, releaseInfo: malData.releaseInfo,
                    released: malData.released, episodes: malData.episodes, baseTime: malData.baseTime, epMeta: {}
                };
            } else {
                meta = { id, type: "series", name: searchTitle.replace(/^\[.*?\]\s*/g, "").trim(), poster: generateDynamicPoster(searchTitle), baseTime: Date.now(), epMeta: {} };
            }
        }
        
        meta.type = meta.type || "series";
        
        let epCount = meta.episodes || 1;
        if (epCount === 1 || !meta.episodes) {
            try {
                const torrents = await searchNyaaForAnime(searchTitle);
                let maxDetected = 1;
                torrents.forEach(t => {
                    const batch = getBatchRange(t.title);
                    if (batch && batch.end > maxDetected && batch.end < 5000) maxDetected = batch.end;
                    const ext = extractEpisodeNumber(t.title);
                    if (ext && ext > maxDetected && ext < 5000) maxDetected = ext;
                });
                if (maxDetected > epCount) epCount = maxDetected;
            } catch(e) {}
        }
        
        const videos = [];
        const defaultThumb = meta.background || meta.poster || "https://dummyimage.com/600x337/1a1a1a/42a5f5.png?text=AMATSU+EPISODE";
        
        const jikanEps = meta.idMal ? await fetchEpisodeDetails(meta.idMal) : {};
        const baseTime = meta.baseTime || Date.now();
        const epMeta = meta.epMeta || {};
        
        const nextAiring = meta.nextAiringEpisode;
        
        for (let i = 1; i <= epCount; i++) {
            const epData = epMeta[i] || {};
            const jData = jikanEps[i] || {};
            
            const finalTitle = jData.title || epData.title || ("Episode " + i);
            
            let finalDate;
            if (jData.aired) {
                finalDate = new Date(jData.aired).toISOString();
            } else if (nextAiring && nextAiring.episode && nextAiring.airingAt) {
                const weeksBehind = nextAiring.episode - i;
                finalDate = new Date((nextAiring.airingAt * 1000) - (weeksBehind * 7 * 24 * 60 * 60 * 1000)).toISOString();
            } else {
                finalDate = new Date(baseTime + (i - 1) * 7 * 24 * 60 * 60 * 1000).toISOString();
            }

            videos.push({ 
                id: meta.id + ":1:" + i, 
                title: finalTitle, 
                season: 1, 
                episode: i, 
                released: finalDate, 
                thumbnail: epData.thumbnail || defaultThumb 
            });
        }
        meta.videos = videos;
        return { meta, cacheMaxAge: 604800 };
    } catch (err) {
        if (id.startsWith("amatsu:") || id.startsWith("anilist:")) return Promise.resolve({ meta: null });
        return { meta: { id, type: "series", name: "Unknown (Error)", poster: generateDynamicPoster("Error") }, cacheMaxAge: 60 };
    }
});

builder.defineStreamHandler(async ({ type, id, config }) => {
    if (!id.startsWith("amatsu:") && !id.startsWith("anilist:") && !id.startsWith("nyaa:")) return Promise.resolve({ streams: [] });
    
    try {
        const userConfig = parseConfig(config);
        if (!userConfig.rdKey && !userConfig.tbKey) return Promise.resolve({ streams: [] });

        let searchTitle = "", requestedEp = 1;
        let aniListIdForFallback = null;
        
        if (id.startsWith("amatsu:") || id.startsWith("anilist:")) {
            const parts = id.split(":");
            aniListIdForFallback = isNaN(parts[1]) ? parts.find(p => !isNaN(p) && p.length > 0) : parts[1];
            
            if (parts.length > 2 && parts[2]) {
                searchTitle = sanitizeSearchQuery(fromBase64Safe(parts[2]));
            } else {
                if (aniListIdForFallback) {
                    const freshMeta = await getAnimeMeta(aniListIdForFallback);
                    if (freshMeta) searchTitle = sanitizeSearchQuery(freshMeta.name);
                }
            }
            const lastPart = parts[parts.length - 1];
            if (!isNaN(lastPart) && parts.length > 2) requestedEp = parseInt(lastPart, 10);

        } else if (id.startsWith("nyaa:")) {
            const parts = id.split(":");
            searchTitle = parts[1] ? sanitizeSearchQuery(fromBase64Safe(parts[1])) : "";
            if (parts.length >= 4) requestedEp = parseInt(parts[3], 10);
        }

        if (!searchTitle) return { streams: [] };
        
        let torrents = await searchNyaaForAnime(searchTitle);

        if (type === "series") {
            torrents = torrents.filter(t => !/\b(movie|film|gekijouban|theatrical)\b/i.test(t.title));
        }
        
        if (!torrents.length) {
            let fallbackMeta = null;
            if (aniListIdForFallback) {
                fallbackMeta = await getAnimeMeta(aniListIdForFallback);
            } else if (id.startsWith("nyaa:")) {
                let cleanQuery = searchTitle.replace(/^\[.*?\]\s*/g, "").replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
                fallbackMeta = await getJikanMeta(cleanQuery);
            }
            
            if (fallbackMeta) {
                const fallbackTitles = new Set();
                if (fallbackMeta.altName && fallbackMeta.altName.length > 2 && fallbackMeta.altName !== searchTitle) fallbackTitles.add(fallbackMeta.altName);
                if (fallbackMeta.synonyms && fallbackMeta.synonyms.length > 0) {
                    fallbackMeta.synonyms.forEach(syn => {
                        if (/^[a-zA-Z0-9\s\-_!:]+$/.test(syn)) fallbackTitles.add(syn);
                    });
                }
                const primaryWords = searchTitle.split(/\s+/);
                if (primaryWords.length > 3) fallbackTitles.add(primaryWords.slice(0, 3).join(" "));
                if (primaryWords.length > 4) fallbackTitles.add(primaryWords.slice(0, 4).join(" "));
                if (fallbackMeta.altName) {
                    const altWords = fallbackMeta.altName.split(/\s+/);
                    if (altWords.length > 3) fallbackTitles.add(altWords.slice(0, 3).join(" "));
                }

                for (const altTitle of fallbackTitles) {
                    const cleanAlt = sanitizeSearchQuery(altTitle);
                    torrents = await searchNyaaForAnime(cleanAlt);
                    
                    if (type === "series") {
                        torrents = torrents.filter(t => !/\b(movie|film|gekijouban|theatrical)\b/i.test(t.title));
                    }

                    if (torrents.length > 0) break;
                }
            }
        }

        if (!torrents.length) return { streams: [], cacheMaxAge: 60 };

        const hashes = torrents.map(t => t.hash);
        
        const [rdC, tbC, rdA, tbA] = await Promise.all([
            userConfig.rdKey ? checkRD(hashes, userConfig.rdKey) : {},
            userConfig.tbKey ? checkTorbox(hashes, userConfig.tbKey) : {},
            userConfig.rdKey ? getActiveRD(userConfig.rdKey) : {},
            userConfig.tbKey ? getActiveTorbox(userConfig.tbKey) : {}
        ]);

        const streams = [];
        
        const flags = { 
            "GER": "🇩🇪", "ITA": "🇮🇹", "FRE": "🇫🇷", "SPA": "🇪🇸", "RUS": "🇷🇺", 
            "POR": "🇵🇹", "ARA": "🇸🇦", "CHI": "🇨🇳", "KOR": "🇰🇷", "HIN": "🇮🇳", 
            "POL": "🇵🇱", "NLD": "🇳🇱", "TUR": "🇹🇷", "VIE": "🇻🇳", "IND": "🇮🇩", 
            "JPN": "🇯🇵", "ENG": "🇬🇧", "MULTI": "🌍" 
        };

        torrents.forEach(t => {
            const hashLow = t.hash.toLowerCase();
            const files = rdC[hashLow] || tbC[hashLow];
            
            const isBatch = getBatchRange(t.title) !== null;
            const batchIndicator = isBatch ? "📦 BATCH" : "🎬 EPISODE";
            
            const streamLang = extractLanguage(t.title);
            const flag = flags[streamLang] || "🇬🇧";
            
            let displayTitle = `${flag} Nyaa | ${batchIndicator}\n💾 ${t.size} | 👤 ${t.seeders}`;
            let matchedFileName = undefined;

            if (files) {
                const matchedFile = selectBestVideoFile(files, requestedEp);
                if (!matchedFile) return; 
                displayTitle += "\n🎯 File: " + matchedFile.name;
                matchedFileName = matchedFile.name;
            } else {
                if (!isTitleMatchingEpisode(t.title, requestedEp)) return; 
                displayTitle += "\n📄 " + t.title;
            }

            const { res } = extractTags(t.title);
            const bytes = parseSizeToBytes(t.size);
            
            const buildSubs = (fileList, provider, apiKey, currentEp) => {
                if (!fileList) return [];
                return fileList
                    .filter(f => {
                        const name = f.name || f.path || "";
                        if (!/\.(ass|srt|ssa|vtt)$/i.test(name)) return false;
                        const extEp = extractEpisodeNumber(name);
                        if (extEp !== null) return extEp === currentEp;
                        return isEpisodeMatch(name, currentEp);
                    })
                    .map(f => {
                        let subLang = "English";
                        const n = (f.name || f.path || "").toLowerCase();
                        if (/ger|deu|deutsch/i.test(n)) subLang = "German";
                        else if (/spa|esp|spanish/i.test(n)) subLang = "Spanish";
                        else if (/rus|russian/i.test(n)) subLang = "Russian";
                        else if (/fre|fra|french|vostfr/i.test(n)) subLang = "French";
                        else if (/ita|italian/i.test(n)) subLang = "Italian";
                        else if (/por|portuguese/i.test(n)) subLang = "Portuguese";
                        else if (/pol|polish/i.test(n)) subLang = "Polish";
                        else if (/chinese|chs|cht|big5|简|繁|中文字幕/i.test(n)) subLang = "Chinese";
                        else if (/ara|arabic/i.test(n)) subLang = "Arabic";
                        else if (/jpn|japanese/i.test(n)) subLang = "Japanese";
                        else if (/kor|korean/i.test(n)) subLang = "Korean";
                        else if (/hin|hindi/i.test(n)) subLang = "Hindi";
                        else if (/eng|english/i.test(n)) subLang = "English";

                        const extMatch = n.match(/\.(ass|srt|ssa|vtt)$/);
                        const ext = extMatch ? extMatch[1].toUpperCase() : "SUB";

                        return { 
                            id: f.id, 
                            url: BASE_URL + "/sub/" + provider + "/" + apiKey + "/" + t.hash + "/" + f.id + "?filename=" + encodeURIComponent(n), 
                            lang: subLang + " (" + ext + ")" 
                        };
                    });
            };

            if (userConfig.rdKey) {
                const fRD = rdC[hashLow];
                const prog = rdA[hashLow];
                const name = (fRD || prog === 100) ? `AMATSU [⚡ RD]\n🎥 ${res}` : (prog !== undefined ? `AMATSU [⏳ ${prog}% RD]\n🎥 ${res}` : `AMATSU [☁️ RD DL]\n🎥 ${res}`);
                streams.push({ name: name, description: displayTitle, url: BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp, subtitles: buildSubs(fRD, "realdebrid", userConfig.rdKey, requestedEp), behaviorHints: { notWebReady: true, bingeGroup: "amatsu_rd_" + t.hash, filename: matchedFileName }, _bytes: bytes, _lang: streamLang });
            }

            if (userConfig.tbKey) {
                const fTB = tbC[hashLow];
                const prog = tbA[hashLow];
                const name = (fTB || prog === 100) ? `AMATSU [⚡ TB]\n🎥 ${res}` : (prog !== undefined ? `AMATSU [⏳ ${prog}% TB]\n🎥 ${res}` : `AMATSU [☁️ TB DL]\n🎥 ${res}`);
                streams.push({ name: name, description: displayTitle, url: BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp, subtitles: buildSubs(fTB, "torbox", userConfig.tbKey, requestedEp), behaviorHints: { notWebReady: true, bingeGroup: "amatsu_tb_" + t.hash, filename: matchedFileName }, _bytes: bytes, _lang: streamLang });
            }
        });
        
        const rawLangs = userConfig.language || ["ENG"];
        const userLangs = Array.isArray(rawLangs) ? rawLangs : [rawLangs];
        
        return { 
            streams: streams.sort((a, b) => {
                const getLangScore = (lang) => {
                    if (userLangs.includes(lang) || lang === "MULTI") return 3; 
                    if (lang === "ENG") return 2;                               
                    return 1;                                                   
                };

                const scoreA = getLangScore(a._lang);
                const scoreB = getLangScore(b._lang);
                
                if (scoreA !== scoreB) return scoreB - scoreA;
                
                const aCached = a.name.includes("⚡");
                const bCached = b.name.includes("⚡");
                if (aCached && !bCached) return -1;
                if (!aCached && bCached) return 1;
                
                return b._bytes - a._bytes;
            }), 
            cacheMaxAge: 5 
        };
    } catch (err) {
        console.error(`[!] CRITICAL ERROR in Stream Pipeline:`, err);
        return { streams: [] };
    }
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
