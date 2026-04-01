
//===============
// AMATSU STREMIO ADDON - CORE LOGIC
// The main entry point for the Stremio logic.
// Uses an isolated "amatsu:" prefix to prevent Yomi's fallback engine from overwriting Nyaa metadata.
// Version bumped to 1.0.2 to clear Stremio's aggressive manifest cache.
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getJikanMeta } = require("./lib/anilist");
const { searchNyaaForAnime, cleanTorrentTitle } = require("./lib/nyaa");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile } = require("./lib/parser");


// Fallback for missing environment variables when self-hosting, sanitizing trailing slashes
let BASE_URL = process.env.BASE_URL || "http://127.0.0.1:7002";
BASE_URL = BASE_URL.replace(/\/+$/, "");


// Polyfill for base64url encoding to ensure compatibility across all Node.js versions
function toBase64Safe(str) {
    return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}


// Polyfill for base64url decoding
function fromBase64Safe(str) {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), "base64").toString("utf8");
}

//===============
// ADDON MANIFEST
//===============
const manifest = {
    id: "org.community.amatsu",
    version: "1.0.2", // BUMPED VERSION: Forces Stremio to drop the cache and apply the isolated prefix
    name: "Amatsu",
    logo: BASE_URL + "/amatsu.png", 
    description: "The ultimate Debrid-powered Nyaa gateway. Streams Anime directly via Real-Debrid or Torbox. Smart-parsing tames chaotic torrent names for a clean catalog. Pure quality, zero buffering.",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    
    
    // ISOLATION: "amatsu:" protects the metadata from Yomi's interference.
    idPrefixes: ["amatsu:", "nyaa:"],
    catalogs: [
        { id: "amatsu_trending", type: "series", name: "Amatsu Trending" },
        { id: "amatsu_top", type: "series", name: "Amatsu Top Rated" },
        { id: "amatsu_search", type: "series", name: "Amatsu Search", extra: [{ name: "search", isRequired: true }] }
    ],
    config: [{ key: "apiKey", type: "text", title: "API Key (RD or TB)", required: true }],
    behaviorHints: { configurable: true, configurationRequired: true },
};

const builder = new addonBuilder(manifest);


// Safe parsing of the user configuration.
function parseConfig(config) {
    if (!config) return {};
    if (typeof config === "object") return config;
    try { return JSON.parse(Buffer.from(config, "base64").toString()); } catch (e) {
        try { return JSON.parse(decodeURIComponent(config)); } catch (e2) { return {}; }
    }
}


// Safely parses varying size units from Nyaa to prevent sorting metric explosions.
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


// Analyses the file extension and language tags from filenames.
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


// Prepares the search query for Jikan fallbacks.
function sanitizeSearchQuery(title) {
    return title.replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "").replace(/\s{2,}/g, " ").trim();
}


// Checks if the episode requested is found inside the Nyaa torrents
function isTitleMatchingEpisode(title, requestedEp) {
    if (/batch|complete|all\s+episodes/i.test(title)) return true;
    return isEpisodeMatch(title, requestedEp);
}


// Generates posters for streams with no known metadata.
function generateDynamicPoster(title) {
    let clean = title.replace(/^\[.*?\]\s*/g, "").replace(/\[.*?\]/g, " ").replace(/\(.*?\)/g, " ");
    let safeTitle = clean.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s{2,}/g, " ").substring(0, 30).trim().toUpperCase();
    let words = safeTitle.split(" ");
    let lines = [];
    let line = "";
    for (let word of words) {
        if ((line + word).length > 10) {
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
            const cleanName = cleanTorrentTitle(t.title);
            if (cleanName.length > 2 && !rawGroups[cleanName]) rawGroups[cleanName] = t;
        });
        
        Object.keys(rawGroups).forEach(cleanName => {
            if (!anilistMetas.some(m => m.name.toLowerCase().includes(cleanName.toLowerCase()))) {
                finalMetas.push({ 
                    id: "nyaa:" + toBase64Safe(cleanName), 
                    type: "series", 
                    name: cleanName.replace(/^\[.*?\]\s*/g, "").trim(), 
                    poster: generateDynamicPoster(cleanName) 
                });
            }
        });
        return { metas: finalMetas, cacheMaxAge: finalMetas.length === 0 ? 60 : 86400 };
    }
    return { metas: [] };
});

builder.defineMetaHandler(async ({ id }) => {
    // ISOLIERT: Lauscht nur noch auf 'amatsu:'
    if (!id.startsWith("amatsu:") && !id.startsWith("nyaa:")) {
        return Promise.resolve({ meta: null });
    }

    console.log("[Meta Request] Fetching details for ID: " + id);

    let meta = null;
    let searchTitle = "";

    try {
        if (id.startsWith("amatsu:")) {
            const parts = id.split(":");
            let aniListId = parts[1];
            
            if (isNaN(aniListId)) {
                aniListId = parts.find(p => !isNaN(p) && p.length > 0) || parts[1];
            }
	
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
                searchTitle = (parts.length > 2 && parts[2]) 
                    ? fromBase64Safe(parts[2]) 
                    : "Unknown Anime";
                
                meta = { id: id, type: "series", name: searchTitle, poster: generateDynamicPoster(searchTitle) };
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
            console.log("[Meta] Scraping Nyaa to detect actual episode count for OVA/Unknown: " + searchTitle);
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
        } else {
            console.log("[Meta] Fast-loading: Episode count known for " + searchTitle + ". Skipping Nyaa scrape.");
        }

        const videos = [];
        const episodeThumbnail = meta.background || meta.poster || "https://dummyimage.com/600x337/1a1a1a/42a5f5.png?text=AMATSU+EPISODE";
        
        for (let i = 1; i <= epCount; i++) {
            videos.push({ id: meta.id + ":1:" + i, title: "Episode " + i, season: 1, episode: i, released: new Date().toISOString(), thumbnail: episodeThumbnail });
        }
        meta.videos = videos;
        return { meta, cacheMaxAge: 604800 };
    } catch (err) {
        console.error("[Meta Error] Crashed during meta generation: " + err.message);
        return { 
            meta: { id, type: "series", name: "Unknown (Error)", poster: generateDynamicPoster("Error") }, 
            cacheMaxAge: 60 
        };
    }
});

builder.defineStreamHandler(async ({ id, config }) => {
    // ISOLIERT: Lauscht nur noch auf 'amatsu:'
    if (!id.startsWith("amatsu:") && !id.startsWith("nyaa:")) return Promise.resolve({ streams: [] });
    
    console.log("[Stream Request] Processing request for ID: " + id);

    try {
        const userConfig = parseConfig(config);
        let searchTitle = "", requestedEp = 1;
        let aniListIdForFallback = null;
        
        if (id.startsWith("amatsu:")) {
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

        if (!searchTitle) {
            console.log("[Stream] Search aborted. No valid title found for ID: " + id);
            return { streams: [] };
        }
        
        console.log("[Stream] Scraping Nyaa for streams: " + searchTitle + " (Episode " + requestedEp + ")");

        let torrents = await searchNyaaForAnime(searchTitle);
        
        if (!torrents.length) {
            console.log("[Stream] No torrents found for primary title: " + searchTitle + ". Engaging Universal Fallback Engine...");
            
            let fallbackMeta = null;

            if (aniListIdForFallback) {
                fallbackMeta = await getAnimeMeta(aniListIdForFallback);
            } else if (id.startsWith("nyaa:")) {
                let cleanQuery = searchTitle.replace(/^\[.*?\]\s*/g, "").replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
                fallbackMeta = await getJikanMeta(cleanQuery);
            }
            
            if (fallbackMeta) {
                const fallbackTitles = new Set();
                
                if (fallbackMeta.altName && fallbackMeta.altName.length > 2 && fallbackMeta.altName !== searchTitle) {
                    fallbackTitles.add(fallbackMeta.altName);
                }
                
                if (fallbackMeta.synonyms && fallbackMeta.synonyms.length > 0) {
                    fallbackMeta.synonyms.forEach(syn => {
                        if (/^[a-zA-Z0-9\s\-_!:]+$/.test(syn)) fallbackTitles.add(syn);
                    });
                }

                
                // ADVANCED FALLBACK: Truncate long Light Novel titles to bypass strict limits
                const primaryWords = searchTitle.split(/\s+/);
                if (primaryWords.length > 3) fallbackTitles.add(primaryWords.slice(0, 3).join(" "));
                if (primaryWords.length > 4) fallbackTitles.add(primaryWords.slice(0, 4).join(" "));
                
                if (fallbackMeta.altName) {
                    const altWords = fallbackMeta.altName.split(/\s+/);
                    if (altWords.length > 3) fallbackTitles.add(altWords.slice(0, 3).join(" "));
                }

                for (const altTitle of fallbackTitles) {
                    console.log("[Stream] Fallback Engine: Searching Nyaa for synonym: " + altTitle);
                    const cleanAlt = sanitizeSearchQuery(altTitle);
                    torrents = await searchNyaaForAnime(cleanAlt);
                    
                    if (torrents.length > 0) {
                        console.log("[Stream] Success! Found " + torrents.length + " torrents using synonym: " + cleanAlt);
                        break;
                    }
                }
            }
        }

        if (!torrents.length) {
            console.log("[Stream] All searches failed. No streams available.");
            return { streams: [], cacheMaxAge: 60 };
        }

        const hashes = torrents.map(t => t.hash);
        const [rdC, tbC, rdA, tbA] = await Promise.all([
            userConfig.rdKey ? checkRD(hashes, userConfig.rdKey) : {},
            userConfig.tbKey ? checkTorbox(hashes, userConfig.tbKey) : {},
            userConfig.rdKey ? getActiveRD(userConfig.rdKey) : {},
            userConfig.tbKey ? getActiveTorbox(userConfig.tbKey) : {}
        ]);

        const streams = [];
        torrents.forEach(t => {
            const hashLow = t.hash.toLowerCase();
            const files = rdC[hashLow] || tbC[hashLow];
            
            
            // SEMANTIC UX: Clearly identify if the torrent is a batch release or a single episode
            const isBatch = getBatchRange(t.title) !== null;
            const batchIndicator = isBatch ? "📦 BATCH" : "🎬 EPISODE";
            
            let displayTitle = "🌐 Nyaa | " + batchIndicator + "\n💾 " + t.size + " | 👤 " + t.seeders;
            
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

            const { res, lang } = extractTags(t.title);
            const bytes = parseSizeToBytes(t.size);
            
            const buildSubs = (fileList, provider, apiKey, currentEp) => {
                if (!fileList) return [];
                return fileList
                    .filter(f => {
                        const name = f.name || f.path || "";
                        
                        
        				// .idx and .sub (VobSub) are strictly filtered out here as they crash the Stremio web player
                        if (!/\.(ass|srt|ssa|vtt)$/i.test(name)) return false;
                        const extEp = extractEpisodeNumber(name);
                        if (extEp !== null) {
                            return extEp === currentEp;
                        }
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

                        
                        // Append original filename to query to allow correct MIME type parsing for Torbox
                        const extMatch = n.match(/\.(ass|srt|ssa|vtt)$/);
                        const ext = extMatch ? extMatch[1].toUpperCase() : "SUB";

                        return { 
                            id: f.id, 
                            url: BASE_URL + "/sub/" + provider + "/" + apiKey + "/" + t.hash + "/" + f.id + "?filename=" + encodeURIComponent(n), 
                            lang: subLang + " (" + ext + ")" 
                        };
                    });
            };

            
            // Using "description" instead of "title" to ensure complete compliance with the latest Stremio SDK
            if (userConfig.rdKey) {
                const fRD = rdC[hashLow];
                const prog = rdA[hashLow];
                const name = (fRD || prog === 100) ? "AMATSU [⚡ RD]\n🎥 " + res : (prog !== undefined ? "AMATSU [⏳ " + prog + "% RD]\n🎥 " + res : "AMATSU [☁️ RD DL]\n🎥 " + res);
                streams.push({ name: name, description: displayTitle, url: BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/" + requestedEp, subtitles: buildSubs(fRD, "realdebrid", userConfig.rdKey, requestedEp), behaviorHints: { notWebReady: true, bingeGroup: "amatsu_rd_" + t.hash, filename: matchedFileName }, _bytes: bytes });
            }

            if (userConfig.tbKey) {
                const fTB = tbC[hashLow];
                const prog = tbA[hashLow];
                const name = (fTB || prog === 100) ? "AMATSU [⚡ TB]\n🎥 " + res : (prog !== undefined ? "AMATSU [⏳ " + prog + "% TB]\n🎥 " + res : "AMATSU [☁️ TB DL]\n🎥 " + res);
                streams.push({ name: name, description: displayTitle, url: BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/" + requestedEp, subtitles: buildSubs(fTB, "torbox", userConfig.tbKey, requestedEp), behaviorHints: { notWebReady: true, bingeGroup: "amatsu_tb_" + t.hash, filename: matchedFileName }, _bytes: bytes });
            }
        });
        
        
        // Safely sort streams: priority to cached links, then strict fallback to file size descending
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
        console.error("[Stream Error] Crashed during stream generation: " + err.message);
        return { streams: [] };
    }
});

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
