//===============
// AMATSU METADATA PROVIDER - ANILIST & MYANIMELIST (JIKAN)
// This module handles all metadata requests for the add-on.
//===============

const axios = require("axios");

const ANILIST_URL = "https://graphql.anilist.co";

function toBase64Safe(str) {
    return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

//===============
// CACHE & RATE LIMITING CONFIGURATION
//===============
const apiCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

function setLRUCache(key, dataOrPromise) {
    if (apiCache.has(key)) {
        apiCache.delete(key);
    } else if (apiCache.size >= MAX_CACHE_ENTRIES) {
        apiCache.delete(apiCache.keys().next().value);
    }
    apiCache.set(key, { timestamp: Date.now(), data: dataOrPromise });
}

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

function formatDescription(anime) {
    let text = anime.description || anime.synopsis || "No description available.";
    text = text.replace(/~![\s\S]*?!~/g, "[Spoiler removed]");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<[^>]*>?/gm, "");
    text = text.replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#039;/g, "\"").replace(/&mdash;/g, "—");
    text = text.replace(/\[Written by MAL Rewrite\]/gi, "").trim();
    text = text.replace(/\r/g, "");
    text = text.replace(/\n{3,}/g, "\n\n").trim();

    let header = [];
    if (anime.format) header.push("📺 Format: " + anime.format);
    if (anime.status) header.push("📌 Status: " + anime.status.replace(/_/g, " "));
    if (anime.releaseDate) header.push("📅 Released: " + anime.releaseDate);
    
    if (anime.averageScore) {
        let finalScore = parseInt(anime.averageScore);
        if (finalScore > 100) finalScore = Math.round(finalScore / 10);
        if (finalScore > 100) finalScore = 100;
        header.push("⭐️ Score: " + finalScore + "%");
    }
    
    if (header.length > 0) return header.join(" | ") + "\n\n" + text;
    return text;
}

async function _fetchAniList(query, variables, retries = 3) {
    const cacheKey = "anilist_" + JSON.stringify(variables || {});
    const cachedItem = getLRUCache(cacheKey);
    if (cachedItem) return cachedItem;

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
                    const englishTitle = anime.title.english || anime.title.romaji || "Unknown";
                    
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

                    const stremioType = anime.format === "MOVIE" ? "movie" : "anime";

                    return {
                        id: "anilist:" + anime.id,
                        type: stremioType, 
                        name: cleanTitle,
                        englishName: englishTitle,
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
                if (attempt < retries - 1) await sleep((status === 429) ? 2000 * (attempt + 1) : 1000);
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
                    nextAiringEpisode { episode airingAt }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { search: query });
}

//===============
// STREMIO CATALOG FILTER
//===============
async function getTrendingAnime(stremioType = "anime") {
    const formats = stremioType === "movie" ? ["MOVIE"] : ["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"];
    const graphqlQuery = `
        query ($sort: [MediaSort], $formats: [MediaFormat]) { 
            Page(page: 1, perPage: 40) { 
                media(type: ANIME, isAdult: false, sort: $sort, format_in: $formats) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode airingAt }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { sort: ["TRENDING_DESC"], formats });
}

async function getTopAnime(stremioType = "anime") {
    const formats = stremioType === "movie" ? ["MOVIE"] : ["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"];
    const graphqlQuery = `
        query ($sort: [MediaSort], $formats: [MediaFormat]) { 
            Page(page: 1, perPage: 40) { 
                media(type: ANIME, isAdult: false, sort: $sort, format_in: $formats) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode airingAt }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;
    return _fetchAniList(graphqlQuery, { sort: ["SCORE_DESC"], formats });
}

//===============
// PARALLEL AIRING FETCH
//===============
async function getAiringAnime(stremioType = "anime") {
    const formats = stremioType === "movie" ? ["MOVIE"] : ["TV", "TV_SHORT", "ONA", "OVA"];
    const graphqlQuery = `
        query ($page: Int, $sort: [MediaSort], $formats: [MediaFormat], $status: MediaStatus) { 
            Page(page: $page, perPage: 50) { 
                media(type: ANIME, isAdult: false, sort: $sort, format_in: $formats, status: $status) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode airingAt }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;

    const [page1, page2] = await Promise.all([
        _fetchAniList(graphqlQuery, { page: 1, sort: ["POPULARITY_DESC"], formats: formats, status: "RELEASING" }),
        _fetchAniList(graphqlQuery, { page: 2, sort: ["POPULARITY_DESC"], formats: formats, status: "RELEASING" })
    ]);

    const combined = [...page1, ...page2];
    const unique = Array.from(new Map(combined.map(item => [item.id, item])).values());
    
    return unique;
}

//===============
// CURRENT SEASON DYNAMIC CALCULATOR
//===============
function getCurrentSeasonInfo() {
    const month = new Date().getMonth(); // 0-11
    let year = new Date().getFullYear();
    let season = "WINTER";

    if (month >= 2 && month <= 4) { season = "SPRING"; }
    else if (month >= 5 && month <= 7) { season = "SUMMER"; }
    else if (month >= 8 && month <= 10) { season = "FALL"; }
    else { 
        season = "WINTER"; 
        // In Anime, December counts towards the upcoming year's Winter season
        if (month === 11) year += 1;
    }

    return { season, year };
}

async function getSeasonalAnime(stremioType = "anime") {
    const formats = stremioType === "movie" ? ["MOVIE"] : ["TV", "TV_SHORT", "ONA", "OVA"];
    const { season, year } = getCurrentSeasonInfo();

    const graphqlQuery = `
        query ($page: Int, $sort: [MediaSort], $formats: [MediaFormat], $season: MediaSeason, $seasonYear: Int) { 
            Page(page: $page, perPage: 50) { 
                media(type: ANIME, isAdult: false, sort: $sort, format_in: $formats, season: $season, seasonYear: $seasonYear) { 
                    id 
                    title { romaji english } 
                    coverImage { extraLarge } 
                    bannerImage 
                    description 
                    format 
                    episodes 
                    nextAiringEpisode { episode airingAt }
                    averageScore
                    status
                    seasonYear
                    startDate { year month day }
                } 
            } 
        }`;

    const [page1, page2] = await Promise.all([
        _fetchAniList(graphqlQuery, { page: 1, sort: ["POPULARITY_DESC"], formats: formats, season: season, seasonYear: year }),
        _fetchAniList(graphqlQuery, { page: 2, sort: ["POPULARITY_DESC"], formats: formats, season: season, seasonYear: year })
    ]);

    const combined = [...page1, ...page2];
    const unique = Array.from(new Map(combined.map(item => [item.id, item])).values());
    
    return unique;
}

async function getAnimeMeta(anilistId, retries = 3) {
    const cacheKey = "anilist_meta_" + anilistId;
    const cachedItem = getLRUCache(cacheKey);
    if (cachedItem) return cachedItem;

    const graphqlQuery = `
        query ($id: Int) { 
            Media(id: $id, type: ANIME) { 
                id 
                idMal
                title { romaji english } 
                synonyms 
                coverImage { extraLarge } 
                bannerImage 
                description 
                format 
                episodes 
                nextAiringEpisode { episode airingAt }
                streamingEpisodes { title thumbnail }
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
                const englishTitle = anime.title.english || anime.title.romaji || "Unknown";

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

                let epMeta = {};
                if (anime.streamingEpisodes) {
                    anime.streamingEpisodes.forEach(ep => {
                        const match = ep.title.match(/(?:Episode|Ep)\s+(\d+)\s*[-:]\s*(.*)/i);
                        if (match) {
                            epMeta[parseInt(match[1])] = { title: match[2].trim(), thumbnail: ep.thumbnail };
                        } else {
                            const matchNum = ep.title.match(/\d+/);
                            if (matchNum) epMeta[parseInt(matchNum[0])] = { title: ep.title.trim(), thumbnail: ep.thumbnail };
                        }
                    });
                }

                const baseTime = year ? new Date(Date.UTC(year, (month || 1) - 1, day || 1)).getTime() : Date.now();
                const stremioType = anime.format === "MOVIE" ? "movie" : "anime";

                const result = {
                    id: "anilist:" + anime.id,
                    idMal: anime.idMal,
                    type: stremioType,
                    name: cleanTitle,
                    englishName: englishTitle,
                    altName: anime.title.english || "",
                    synonyms: anime.synonyms || [],
                    poster: anime.coverImage?.extraLarge || "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                    background: anime.bannerImage || "",
                    description: formatDescription({ ...anime, releaseDate: releaseDateStr }),
                    releaseInfo: releaseInfo,
                    released: released,
                    episodes: epCount,
                    epMeta: epMeta,
                    baseTime: baseTime,
                    nextAiringEpisode: anime.nextAiringEpisode
                };

                setLRUCache(cacheKey, result);
                return result;

            } catch (error) {
                const status = error.response ? error.response.status : "Network";
                console.error("[AniList] Meta Error (Attempt " + (attempt + 1) + "/" + retries + "): Status " + status);
                if (attempt < retries - 1) await sleep((status === 429) ? 2000 * (attempt + 1) : 1000);
            }
        }
        apiCache.delete(cacheKey);
        return null;
    })();

    setLRUCache(cacheKey, fetchPromise);
    return fetchPromise;
}

async function fetchEpisodeDetails(malId) {
    if (!malId) return {};
    const cacheKey = "jikan_eps_" + malId;
    const cached = getLRUCache(cacheKey);
    if (cached) return cached;

    const eps = {};
    try {
        let page = 1;
        let hasNextPage = true;
        
        while (hasNextPage && page <= 4) {
            const res = await axios.get(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`, { timeout: 4000 });
            if (res.data && res.data.data) {
                res.data.data.forEach(ep => {
                    eps[ep.mal_id] = { title: ep.title, aired: ep.aired };
                });
            }
            
            hasNextPage = res.data?.pagination?.has_next_page;
            if (hasNextPage) {
                page++;
                await sleep(400); 
            }
        }
        setLRUCache(cacheKey, eps);
    } catch (e) {
        console.error("[Jikan] Episode Pagination Error:", e.message);
    }
    return eps;
}

async function getJikanMeta(cleanedTitle, retries = 3) {
    const cacheKey = "jikan_" + cleanedTitle;
    const cachedItem = getLRUCache(cacheKey);
    if (cachedItem) return cachedItem;

    const fetchPromise = (async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const url = "https://api.jikan.moe/v4/anime?q=" + encodeURIComponent(cleanedTitle) + "&sfw=false&limit=1";
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
                    const stremioType = (anime.type === "Movie") ? "movie" : "anime";

                    const result = {
                        type: stremioType,
                        name: anime.title || "Unknown",
                        englishName: anime.title_english || anime.title || "Unknown",
                        poster: anime.images?.jpg?.large_image_url || null,
                        background: anime.trailer?.images?.maximum_image_url || anime.images?.jpg?.large_image_url || null,
                        description: formatDescription({ 
                            synopsis: anime.synopsis, format: anime.type, status: anime.status, 
                            releaseDate: releaseDateStr, averageScore: anime.score ? Math.round(anime.score * 10) : null
                        }),
                        releaseInfo: releaseInfo,
                        released: released,
                        episodes: anime.episodes || null,
                        altName: anime.title_english || "",
                        synonyms: anime.title_synonyms || [],
                        baseTime: year ? new Date(Date.UTC(year, (month || 1) - 1, day || 1)).getTime() : Date.now(),
                        epMeta: {}
                    };

                    setLRUCache(cacheKey, result);
                    return result;
                }
                apiCache.delete(cacheKey);
                return null; 
            } catch (error) {
                const status = error.response ? error.response.status : "Network";
                console.error("[Jikan MAL] Fallback Error: Status " + status);
                if (attempt < retries - 1) await sleep((status === 429) ? 3000 * (attempt + 1) : 1000);
            }
        }
        apiCache.delete(cacheKey);
        return null;
    })();
    setLRUCache(cacheKey, fetchPromise);
    return fetchPromise;
}

module.exports = { searchAnime, getAnimeMeta, getTrendingAnime, getTopAnime, getAiringAnime, getSeasonalAnime, getJikanMeta, fetchEpisodeDetails, getCurrentSeasonInfo };
