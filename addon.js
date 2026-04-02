//===============
// AMATSU STREMIO ADDON - CORE LOGIC
// The main entry point for the Stremio logic.
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getJikanMeta } = require("./lib/anilist");
const { searchNyaaForAnime, cleanTorrentTitle } = require("./lib/nyaa");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile } = require("./lib/parser");

let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7002";
BASE_URL = BASE_URL.replace(/\/+$/, "");

function toBase64Safe(str) {
    return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64Safe(str) {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), "base64").toString("utf8");
}

//===============
// ADDON MANIFEST
//===============
const manifest = {
    id: "org.community.amatsu",
    version: "1.0.10", // BUMPED VERSION: Clear Stremio cache
    name: "Amatsu",
    logo: BASE_URL + "/amatsu.png", 
    description: "The ultimate Debrid-powered Nyaa gateway. Streams Anime directly via Real-Debrid or Torbox. Smart-parsing tames chaotic torrent names for a clean catalog. Pure quality, zero buffering.",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["anilist:", "nyaa:"],
    catalogs: [
        { id: "amatsu_trending", type: "series", name: "Amatsu Trending" },
        { id: "amatsu_top", type: "series", name: "Amatsu Top Rated" },
        { id: "amatsu_search", type: "series", name: "Amatsu Search", extra: [{ name: "search", isRequired: true }] }
    ],
    
    // CRITICAL FIX: The restrictive "config: [...]" array was removed.
    // Stremio's internal validator was rejecting your Base64 "rdKey" because it wasn't listed,
    // resulting in the SDK actively deleting your keys and passing a boolean `false` instead.
    behaviorHints: { configurable: true, configurationRequired: true },
};

const builder = new addonBuilder(manifest);

//===============
// CONFIG PARSER WITH DEEP LOGGING
//===============
function parseConfig(config) {
    console.log(`\n--- [CONFIG PARSER START] ---`);
    console.log(`[Config] Raw Type: ${typeof config}`);
    
    let parsed = {};
    
    try {
        if (!config) {
            console.log(`[Config] Input is null or undefined.`);
        } else if (typeof config === "object") {
            const keys = Object.keys(config);
            console.log(`[Config] Input is an object with keys: ${JSON.stringify(keys)}`);
            
            if (keys.length === 1 && keys[0].length > 20 && config[keys[0]] === "") {
                console.log(`[Config] Detected Stremio SDK Mangled Object. Attempting Base64 decode of the key...`);
                parsed = JSON.parse(Buffer.from(keys[0], "base64").toString());
            } else {
                console.log(`[Config] Normal object detected. Using directly.`);
                parsed = config;
            }
        } else if (typeof config === "string") {
            console.log(`[Config] Input is a string. Length: ${config.length}`);
            try { 
                parsed = JSON.parse(Buffer.from(config, "base64").toString()); 
                console.log(`[Config] Successfully decoded Base64 string.`);
            } catch (e) {
                console.log(`[Config] Base64 decode failed. Attempting URI Decode...`);
                try {
                    parsed = JSON.parse(decodeURIComponent(config)); 
                    console.log(`[Config] Successfully decoded URI string.`);
                } catch (e2) {
                    console.log(`[Config] URI decode also failed.`);
                }
            }
        }
        
        console.log(`[Config] Extracted RD Key: ${parsed.rdKey ? "YES (Length: " + parsed.rdKey.length + ")" : "NO"}`);
        console.log(`[Config] Extracted TB Key: ${parsed.tbKey ? "YES (Length: " + parsed.tbKey.length + ")" : "NO"}`);
    } catch (err) {
        console.error(`[Config] CRITICAL PARSING ERROR:`, err.message);
    }
    
    console.log(`--- [CONFIG PARSER END] ---\n`);
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
    let res = "SD", lang = "Raw";
    if (/(1080p|1080|FHD)/i.test(title)) res = "1080p";
    else if (/(720p|720|HD)/i.test(title)) res = "720p";
    else if (/(2160p|4k|UHD)/i.test(title)) res = "4K";
    
    if (/(eng|english)/i.test(title)) lang = "Eng Sub";
    else if (/(multi|dual)/i.test(title)) lang = "Multi";
    else if (/(sub)/i.test(title)) lang = "Subbed";
    else if (/(dub)/i.test(title)) lang = "Dubbed";
    
    return { res, lang };
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

builder.defineCatalogHandler(async ({ id, extra, config }) => {
    console.log("[Catalog Request] Fetching catalog: " + id);
    const userConfig = parseConfig(config);
    
    if (id === "amatsu_trending") {
        if (userConfig.showTrending === false) return { metas: [] };
        return { metas: await getTrendingAnime(), cacheMaxAge: 43200 };
    }
    if (id === "amatsu_top") {
        if (userConfig.showTop === false) return { metas: [] };
        return { metas: await getTopAnime(), cacheMaxAge: 43200 };
    }
    if (id === "amatsu_search" && extra.search) {
        const [anilistMetas, nyaaTorrents] = await Promise.all([
            searchAnime(extra.search), 
            searchNyaaForAnime(extra.search)
        ]);
        const finalMetas = [...anilistMetas];
        const rawGroups = {};
        
        nyaaTorrents.forEach(t => {
            let cleanName = t.title.replace(/\.(mkv|mp4|avi|wmv|ts|flv)$/i, "");
            
            cleanName = cleanName.replace(/\[.*?\]/g, " ");
            cleanName = cleanName.replace(/\(.*?\)/g, " ");
            cleanName = cleanName.replace(/【.*?】/g, " ");
            cleanName = cleanName.replace(/「.*?」/g, " ");
            
            const epMatch = cleanName.match(/(?:\s+-\s+\d{1,4}(?:v\d)?\b|\b(?:Ep|Episode|E|S\d+E\d+)\b)/i);
            if (epMatch && epMatch.index > 0) {
                cleanName = cleanName.substring(0, epMatch.index);
            }
            
            cleanName = cleanName.replace(/\b(1080p|720p|4k|FHD|HD|SD|Uncensored|Decensored|Eng Sub|Raw|Subbed|Censored|Dual-Audio|HEVC|x265|x264|10bit|8bit)\b/ig, "");
            cleanName = cleanName.replace(/_/g, " ").replace(/\s{2,}/g, " ").trim();
            
            if (cleanName.length < 2) {
                cleanName = t.title.replace(/^\[.*?\]\s*/, "").split("-")[0].trim();
            }

            if (cleanName.length > 2 && !rawGroups[cleanName]) {
                rawGroups[cleanName] = t;
            }
        });
        
        Object.keys(rawGroups).forEach(cleanName => {
            const isAlreadyInAnilist = anilistMetas.some(m => {
                const aName = m.name.toLowerCase();
                const cName = cleanName.toLowerCase();
                return aName.includes(cName) || cName.includes(aName);
            });

            if (!isAlreadyInAnilist) {
                finalMetas.push({ 
                    id: "nyaa:" + toBase64Safe(cleanName), 
                    type: "series", 
                    name: cleanName, 
                    poster: generateDynamicPoster(cleanName) 
                });
            }
        });
        return { metas: finalMetas, cacheMaxAge: finalMetas.length === 0 ? 60 : 86400 };
    }
    return { metas: [] };
});

builder.defineMetaHandler(async ({ id }) => {
    if (!id.startsWith("anilist:") && !id.startsWith("nyaa:")) return Promise.resolve({ meta: null });

    let meta = null;
    let searchTitle = "";

    try {
        if (id.startsWith("anilist:")) {
            const parts = id.split(":");
            let aniListId = parts[1];
            if (isNaN(aniListId)) aniListId = parts.find(p => !isNaN(p) && p.length > 0) || parts[1];
	
            const rawMeta = await getAnimeMeta(aniListId);
            if (rawMeta) {
                searchTitle = rawMeta.name;
                meta = {
                    id: id,
                    type: rawMeta.type,
                    name: rawMeta.name,
                    poster: rawMeta.poster,
                    background: rawMeta.background,
                    description: rawMeta.description,
                    releaseInfo: rawMeta.releaseInfo,
                    released: rawMeta.released,
                    episodes: rawMeta.episodes
                };
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
                    id, 
                    type: "series", 
                    name: searchTitle.replace(/^\[.*?\]\s*/g, "").trim(), 
                    poster: malData.poster || generateDynamicPoster(searchTitle),
                    background: malData.background, 
                    description: malData.description, 
                    releaseInfo: malData.releaseInfo,
                    released: malData.released,
                    episodes: malData.episodes
                };
            } else {
                meta = { id, type: "series", name: searchTitle.replace(/^\[.*?\]\s*/g, "").trim(), poster: generateDynamicPoster(searchTitle) };
            }
        }
        
        meta.type = "series";
        let epCount = meta.episodes || 1;
        if (epCount === 1 || !meta.episodes) {
            try {
                const torrents = await searchNyaaForAnime(searchTitle);
                let maxDetected = 1;
                torrents.forEach(t => {
                    const batch = getBatchRange(t.title);
                    if (batch && batch.end > maxDetected && batch.end < 500) maxDetected = batch.end;
                    const ext = extractEpisodeNumber(t.title);
                    if (ext && ext > maxDetected && ext < 500) maxDetected = ext;
                });
                if (maxDetected > epCount) epCount = maxDetected;
            } catch(e) {}
        }
        const videos = [];
        const episodeThumbnail = meta.background || meta.poster || "https://dummyimage.com/600x337/1a1a1a/42a5f5.png?text=AMATSU+EPISODE";
        
        for (let i = 1; i <= epCount; i++) {
            videos.push({ id: meta.id + ":1:" + i, title: "Episode " + i, season: 1, episode: i, released: new Date().toISOString(), thumbnail: episodeThumbnail });
        }
        meta.videos = videos;
        return { meta, cacheMaxAge: 604800 };
    } catch (err) {
        if (id.startsWith("anilist:")) return Promise.resolve({ meta: null });
        return { 
            meta: { id, type: "series", name: "Unknown (Error)", poster: generateDynamicPoster("Error") }, 
            cacheMaxAge: 60 
        };
    }
});

builder.defineStreamHandler(async ({ id, config }) => {
    console.log(`\n=========================================`);
    console.log(`[AMATSU STREAM REQUEST] ID: ${id}`);
    
    if (!id.startsWith("anilist:") && !id.startsWith("nyaa:")) {
        console.log(`[!] Ignored: ID does not match Amatsu scopes.`);
        console.log(`=========================================\n`);
        return Promise.resolve({ streams: [] });
    }
    
    try {
        const userConfig = parseConfig(config);
        
        if (!userConfig.rdKey && !userConfig.tbKey) {
            console.log(`[!] CRITICAL WARNING: No Debrid API keys found! Cannot resolve streams.`);
        }

        let searchTitle = "", requestedEp = 1;
        let aniListIdForFallback = null;
        
        if (id.startsWith("anilist:")) {
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

        console.log(`[1] Search Title: "${searchTitle}", Ep: ${requestedEp}`);

        if (!searchTitle) {
            console.log(`[!] ABORT: Search title empty.`);
            console.log(`=========================================\n`);
            return { streams: [] };
        }
        
        let torrents = await searchNyaaForAnime(searchTitle);
        console.log(`[2] Nyaa returned ${torrents.length} raw torrents.`);
        
        if (!torrents.length) {
            console.log(`[*] Fallback Engine triggered...`);
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
                    if (torrents.length > 0) {
                        console.log(`[+] Fallback success! Found ${torrents.length} for "${cleanAlt}".`);
                        break;
                    }
                }
            }
        }

        if (!torrents.length) {
            console.log(`[3] 0 Torrents after fallbacks.`);
            console.log(`=========================================\n`);
            return { streams: [], cacheMaxAge: 60 };
        }

        const hashes = torrents.map(t => t.hash);
        console.log(`[4] Executing Debrid Checks for ${hashes.length} hashes...`);
        
        const [rdC, tbC, rdA, tbA] = await Promise.all([
            userConfig.rdKey ? checkRD(hashes, userConfig.rdKey) : {},
            userConfig.tbKey ? checkTorbox(hashes, userConfig.tbKey) : {},
            userConfig.rdKey ? getActiveRD(userConfig.rdKey) : {},
            userConfig.tbKey ? getActiveTorbox(userConfig.tbKey) : {}
        ]);
        
        console.log(`[5] Cache Results -> RD: ${Object.keys(rdC).length}, TB: ${Object.keys(tbC).length}`);

        const streams = [];
        let droppedByParser = 0;
        let droppedNoKey = 0;
        let pushedStreams = 0;

        torrents.forEach(t => {
            const hashLow = t.hash.toLowerCase();
            const files = rdC[hashLow] || tbC[hashLow];
            
            const isBatch = getBatchRange(t.title) !== null;
            const batchIndicator = isBatch ? "📦 BATCH" : "🎬 EPISODE";
            let displayTitle = "🌐 Nyaa | " + batchIndicator + "\n💾 " + t.size + " | 👤 " + t.seeders;
            let matchedFileName = undefined;

            if (files) {
                const matchedFile = selectBestVideoFile(files, requestedEp);
                if (!matchedFile) {
                    droppedByParser++;
                    return; 
                }
                displayTitle += "\n🎯 File: " + matchedFile.name;
                matchedFileName = matchedFile.name;
            } else {
                if (!isTitleMatchingEpisode(t.title, requestedEp)) {
                    droppedByParser++;
                    return; 
                }
                displayTitle += "\n📄 " + t.title;
            }

            // CHECK API KEYS BEFORE PUSHING
            if (!userConfig.rdKey && !userConfig.tbKey) {
                droppedNoKey++;
                return;
            }

            const { res, lang } = extractTags(t.title);
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
                        else if (/fre|fra|french/i.test(n)) subLang = "French";
                        else if (/ita|italian/i.test(n)) subLang = "Italian";
                        else if (/por|portuguese/i.test(n)) subLang = "Portuguese";
                        else if (/pol|polish/i.test(n)) subLang = "Polish";
                        else if (/chi|chinese|zho/i.test(n)) subLang = "Chinese";
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
                const name = (fRD || prog === 100) ? "AMATSU [⚡ RD]\n🎥 " + res : (prog !== undefined ? "AMATSU [⏳ " + prog + "% RD]\n🎥 " + res : "AMATSU [☁️ RD DL]\n🎥 " + res);
                streams.push({ name: name, description: displayTitle, url: BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp, subtitles: buildSubs(fRD, "realdebrid", userConfig.rdKey, requestedEp), behaviorHints: { notWebReady: true, bingeGroup: "amatsu_rd_" + t.hash, filename: matchedFileName }, _bytes: bytes });
                pushedStreams++;
            }

            if (userConfig.tbKey) {
                const fTB = tbC[hashLow];
                const prog = tbA[hashLow];
                const name = (fTB || prog === 100) ? "AMATSU [⚡ TB]\n🎥 " + res : (prog !== undefined ? "AMATSU [⏳ " + prog + "% TB]\n🎥 " + res : "AMATSU [☁️ TB DL]\n🎥 " + res);
                streams.push({ name: name, description: displayTitle, url: BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp, subtitles: buildSubs(fTB, "torbox", userConfig.tbKey, requestedEp), behaviorHints: { notWebReady: true, bingeGroup: "amatsu_tb_" + t.hash, filename: matchedFileName }, _bytes: bytes });
                pushedStreams++;
            }
        });
        
        console.log(`[6] RESULT -> Dropped by Parser: ${droppedByParser} | Dropped (No API Key): ${droppedNoKey} | Successfully Pushed: ${pushedStreams}`);
        console.log(`=========================================\n`);
        
        return { 
            streams: streams.sort((a, b) => {
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
        console.log(`=========================================\n`);
        return { streams: [] };
    }
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
