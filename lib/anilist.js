//===============
// AMATSU METADATA PROVIDER - ANILIST & MYANIMELIST (JIKAN)
// This module handles all metadata requests for the add-on.
// RESTORED: Uses standard "anilist:" prefixes for native Stremio compatibility.
// Added nextAiringEpisode logic to dynamically count episodes for ongoing anime.
//===============

const axios = require("axios");

const ANILIST_URL = "https://graphql.anilist.co";

// Polyfill for base64url encoding to ensure compatibility across all Node.js versions
function toBase64Safe(str) {
    return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

//===============
// CACHE & RATE LIMITING CONFIGURATION
// To avoid a "Too Many Requests" error at 429, we store results in RAM.
// We use LRU (Least Recently Used) logic to prevent memory leaks 
// and selectively replace old data instead of clearing the entire cache.
//===============
const apiCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

// Utility function: Adds an entry to the LRU cache and evicts old entries.
function setLRUCache(key, dataOrPromise) {
    if (apiCache.has(key)) {
        apiCache.delete(key);
    } else if (apiCache.size >= MAX_CACHE_ENTRIES) {
        apiCache.delete(apiCache.keys().next().value);
    }
    apiCache.set(key, { timestamp: Date.now(), data: dataOrPromise });
}

// Utility function: Retrieves an entry and refreshes its position in the LRU cache.
function getLRUCache(key) {
    if (apiCache.has(key)) {
        const item = apiCache.get(key);
        if (Date.now() - item.timestamp < CACHE_TTL) {
            apiCache.delete(key);
            apiCache.set(key, item);
            return item.data;
        } else {
            apiCache.delete(key);
        }
    }
    return null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

//===============
// Cleans up descriptions, formats line breaks, and filters out spoilers.
// Works universally for AniList and MyAnimeList (Jikan).
//===============
function formatDescription(anime) {
    let text = anime.description || anime.synopsis || "No description available.";

    text = text.replace(/~![\s\S]*?!~/g, "[Spoiler removed]");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<[^>]*>?/gm, "");
    text = text.replace(/&quot;/g, "\"")
               .replace(/&amp;/g, "&")
               .replace(/&lt;/g, "<")
               .replace(/&gt;/g, ">")
               .replace(/&#039;/g, "\"")
               .replace(/&mdash;/g, "—");
               
    text = text.replace(/\[Written by MAL Rewrite\]/gi, "").trim();
    text = text.replace(/\r/g, "");
    text = text.replace(/\n{3,}/g, "\n\n").trim();

    let header = [];
    if (anime.format) header.push("📺 Format: " + anime.format);
    if (anime.status) header.push("📌 Status: " + anime.status.replace(/_/g, " "));
    if (anime.releaseDate) header.push("📅 Released: " + anime.releaseDate);
    if (anime.averageScore) header.push("⭐️ Score: " + anime.averageScore + "%");
    
    if (header.length > 0) {
        return header.join(" | ") + "\n\n" + text;
    }

    return text;
}

//===============
// INTERNAL: Generic GraphQL fetcher for AniList
// Includes automatic retries, LRU caching, error handling and promise deduplication.
//===============
async function _fetchAniList(query, variables, retries = 3) {
    const cacheKey = "anilist_" + JSON.stringify(variables || {});
    const cachedItem = getLRUCache(cacheKey);
    
    if (cachedItem) {
        return cachedItem;
    }

    const fetchPromise = (async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await axios.post(ANILIST_URL, { query, variables }, { timeout: 6000 });
                
                if (!response.data || !response.data.data || !response.data.data.Page) {
                    apiCache.delete(cacheKey);
                    return [];
                }
                
                const results = response.data.data.Page.media.map(anime => {
                    const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
                    const base64Title = toBase64Safe(cleanTitle);
                    
                    const year = anime.startDate?.year || anime.seasonYear;
                    const month = anime.startDate?.month;
                    const day = anime.startDate?.day;
                    
                    const releaseDateStr = year ? (month ? month.toString().padStart(2, "0") + "/" + year : "" + year) : null;
                    const releaseInfo = year ? "" + year : undefined;
                    const released = year ? new Date(Date.UTC(year, (month || 1) - 1, day || 1)).toISOString() : undefined;
                    
                    // DYNAMIC EPISODE COUNT: Detects ongoing anime by checking the next airing episode
                    let epCount = anime.episodes;
                    if (!epCount && anime.nextAiringEpisode && anime.nextAiringEpisode.episode) {
                        epCount = anime.nextAiringEpisode.episode - 1;
                    }
                    if (!epCount || epCount < 1) epCount = 1;

                    return {
                        id: "anilist:" + anime.id + ":" + base64Title,
                        type: "series", 
                        name: cleanTitle,
                        poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                        background: anime.bannerImage || "",
                        description: formatDescription({ ...anime, releaseDate: releaseDateStr }),
                        releaseInfo: releaseInfo,
                        released: released,
                        episodes: epCount
                    };
                });

                setLRUCache(cacheKey, results);
                return results;

            } catch (error) {
                const status = error.response ? error.response.status : "Network";
                console.error("[AniList] Fetch Error (Attempt " + (attempt + 1) + "/" + retries + "): Status " + status);
                
                if (attempt < retries - 1) {
                    const waitTime = (status === 429) ? 2000 * (attempt + 1) : 1000;
                    await sleep(waitTime);
                }
            }
        }
        apiCache.delete(cacheKey);
        return [];
    })();

    setLRUCache(cacheKey, fetchPromise);
    return fetchPromise;
}

async function searchAnime(query) {
    if (!query || query.length < 3) return [];
    
    // ADDED: nextAiringEpisode to handle missing episode counts
    const graphqlQuery = `
        query ($search: String) { 
            Page(page: 1, perPage: 50) { 
                media(search: $search, type: ANIME, isAdult: false) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { search: query });
}

async function getTrendingAnime() {
    const graphqlQuery = `
        query ($sort: [MediaSort]) { 
            Page(page: 1, perPage: 30) { 
                media(type: ANIME, isAdult: false, sort: $sort) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { sort: ["TRENDING_DESC"] });
}

async function getTopAnime() {
    const graphqlQuery = `
        query ($sort: [MediaSort]) { 
            Page(page: 1, perPage: 30) { 
                media(type: ANIME, isAdult: false, sort: $sort) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { sort: ["SCORE_DESC"] });
}

async function getAnimeMeta(anilistId, retries = 3) {
    const cacheKey = "anilist_meta_" + anilistId;
    const cachedItem = getLRUCache(cacheKey);
    
    if (cachedItem) {
        return cachedItem;
    }

    const graphqlQuery = `
        query ($id: Int) { 
            Media(id: $id, type: ANIME) { 
                id 
                title { romaji english } 
                synonyms 
                coverImage { extraLarge } 
                bannerImage 
                description 
                format 
                episodes 
                nextAiringEpisode { episode }
                averageScore
                status
                seasonYear
                startDate { year month day }
            } 
        }`;
    
    const fetchPromise = (async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await axios.post(ANILIST_URL, { query: graphqlQuery, variables: { id: parseInt(anilistId) } }, { timeout: 6000 });
                const anime = response.data?.data?.Media;
                
                if (!anime) {
                    apiCache.delete(cacheKey);
                    return null;
                }

                const cleanTitle = anime.title.romaji || anime.title.english || "Unknown";
                const base64Title = toBase64Safe(cleanTitle);

                const year = anime.startDate?.year || anime.seasonYear;
                const month = anime.startDate?.month;
                const day = anime.startDate?.day;
                
                const releaseDateStr = year ? (month ? month.toString().padStart(2, "0") + "/" + year : "" + year) : null;
                
                const releaseInfo = year ? "" + year : undefined;
                const released = year ? new Date(Date.UTC(year, (month || 1) - 1, day || 1)).toISOString() : undefined;

                let epCount = anime.episodes;
                if (!epCount && anime.nextAiringEpisode && anime.nextAiringEpisode.episode) {
                    epCount = anime.nextAiringEpisode.episode - 1;
                }
                if (!epCount || epCount < 1) epCount = 1;

                const result = {
                    id: "anilist:" + anime.id + ":" + base64Title,
                    type: "series",
                    name: cleanTitle,
                    altName: anime.title.english || "",
                    synonyms: anime.synonyms || [],
                    poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                    background: anime.bannerImage || "",
                    description: formatDescription({ ...anime, releaseDate: releaseDateStr }),
                    releaseInfo: releaseInfo,
                    released: released,
                    episodes: epCount
                };

                setLRUCache(cacheKey, result);
                return result;

            } catch (error) {
                const status = error.response ? error.response.status : "Network";
                console.error("[AniList] Meta Error (Attempt " + (attempt + 1) + "/" + retries + "): Status " + status);
                
                if (attempt < retries - 1) {
                    const waitTime = (status === 429) ? 2000 * (attempt + 1) : 1000;
                    await sleep(waitTime);
                }
            }
        }
        apiCache.delete(cacheKey);
        return null;
    })();

    setLRUCache(cacheKey, fetchPromise);
    return fetchPromise;
}

//===============
// FALLBACK: MYANIMELIST (JIKAN API)
// Used when AniList does not recognize a specific title from Nyaa.
// Jikan has a strict limit of 3 requests per second.
//===============
async function getJikanMeta(cleanedTitle, retries = 3) {
    const cacheKey = "jikan_" + cleanedTitle;
    const cachedItem = getLRUCache(cacheKey);
    
    if (cachedItem) {
        return cachedItem;
    }

    const fetchPromise = (async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const url = "https://api.jikan.moe/v4/anime?q=" + encodeURIComponent(cleanedTitle) + "&sfw=true&limit=1";
                const response = await axios.get(url, { timeout: 4000 });
                const data = response.data?.data;
                
                if (data && data.length > 0) {
                    const anime = data[0];
                    
                    const year = anime.aired?.prop?.from?.year || anime.year;
                    const month = anime.aired?.prop?.from?.month;
                    const day = anime.aired?.prop?.from?.day;
                    
                    const releaseDateStr = year ? (month ? month.toString().padStart(2, "0") + "/" + year : "" + year) : null;

                    const releaseInfo = year ? "" + year : undefined;
                    const released = year ? new Date(Date.UTC(year, (month || 1) - 1, day || 1)).toISOString() : undefined;

                    const formattedDesc = formatDescription({ 
                        synopsis: anime.synopsis,
                        format: anime.type,
                        status: anime.status,
                        releaseDate: releaseDateStr,
                        averageScore: anime.score ? Math.round(anime.score * 10) : null
                    });

                    const result = {
                        poster: anime.images?.jpg?.large_image_url || null,
                        background: anime.trailer?.images?.maximum_image_url || anime.images?.jpg?.large_image_url || null,
                        description: formattedDesc,
                        releaseInfo: releaseInfo,
                        released: released,
                        episodes: anime.episodes || null,
                        altName: anime.title_english || "",
                        synonyms: anime.title_synonyms || []
                    };

                    setLRUCache(cacheKey, result);
                    return result;
                }
                
                apiCache.delete(cacheKey);
                return null; 
            } catch (error) {
                const status = error.response ? error.response.status : "Network";
                console.error("[Jikan MAL] Fallback Error (Attempt " + (attempt + 1) + "/" + retries + "): Status " + status);
                
                if (attempt < retries - 1) {
                    const waitTime = (status === 429) ? 3000 * (attempt + 1) : 1000;
                    await sleep(waitTime);
                }
            }
        }
        apiCache.delete(cacheKey);
        return null;
    })();

    setLRUCache(cacheKey, fetchPromise);
    return fetchPromise;
}

module.exports = { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getJikanMeta };
