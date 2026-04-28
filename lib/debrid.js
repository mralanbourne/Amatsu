//===============
// YOMI & AMATSU DEBRID PROVIDER INTERFACE
// (Clean Architecture + Dead API Bypass via StremThru)
// Ensures we don't spam Debrid services with duplicate requests for the same hashes.
//===============
const axios = require("axios");

const apiCache = new Map();
const MAX_CACHE_ENTRIES = 500;
const API_USER_AGENT = "Amatsu/1.0";

// default URL for StremThru crowdsourced cache
const STREMTHRU_URL = process.env.STREMTHRU_URL || "https://stremthru.13377001.xyz";

function setCache(key, dataOrPromise, ttlMs = 60000) {
    if (apiCache.has(key)) apiCache.delete(key);
    else if (apiCache.size >= MAX_CACHE_ENTRIES) apiCache.delete(apiCache.keys().next().value);
    apiCache.set(key, { data: dataOrPromise, expiresAt: Date.now() + ttlMs });
}

function getCache(key) {
    if (apiCache.has(key)) {
        const item = apiCache.get(key);
        if (item.expiresAt > Date.now()) {
            apiCache.delete(key);
            apiCache.set(key, item);
            return item.data;
        }
        apiCache.delete(key);
    }
    return null;
}

//===============
// STREMTHRU REAL-DEBRID CACHE CHECK
// Checks Real-Debrid via StremThru Crowdsourced Cache.
// Uses deduplication to absorb parallel requests from Stremio pre-fetching,
// chunking arrays of 100 hashes per request to optimize traffic.
//===============
async function checkRD(hashes, apiKey) {
    if (!hashes || hashes.length === 0) return {};
    
    const safeKey = (apiKey || "").trim();
    const hashKey = [...hashes].sort().join("");
    const cacheKey = "rd_chk_st_" + safeKey.substring(0, 5) + "_" + hashKey;
    
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const results = {};
            const chunkSize = 100; 
            for (let i = 0; i < hashes.length; i += chunkSize) {
                const chunk = hashes.slice(i, i + chunkSize);
                const url = `${STREMTHRU_URL}/v0/store/torz/check?hash=${chunk.join(",")}`;
                
                const res = await axios.get(url, { 
                    headers: { 
                        "X-StremThru-Store-Name": "realdebrid",
                        "X-StremThru-Store-Authorization": `Bearer ${safeKey}`,
                        "User-Agent": API_USER_AGENT
                    },
                    timeout: 8000 
                });
                
                // Map the returned StremThru structure to our internal array
                if (res.data && res.data.data && Array.isArray(res.data.data.items)) {
                    res.data.data.items.forEach(item => {
                        if (item.status === "cached") {
                            const mappedFiles = (item.files || []).map(f => ({
                                id: f.index !== undefined ? f.index : -1,
                                name: f.name || f.path || "Unknown",
                                size: f.size !== undefined ? f.size : 0
                            }));
                            results[item.hash.toLowerCase()] = mappedFiles;
                        }
                    });
                }
                
                if (i + chunkSize < hashes.length) await new Promise(resolve => setTimeout(resolve, 300));
            }
            return { data: results, ttl: 60000 };
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            console.error("[StremThru RD Check Error] Request failed with status code " + status);
            let errorTtl = 10000;
            if (status === 401 || status === 403) errorTtl = 3600000;
            else if (status === 429) errorTtl = 30000;
            return { data: {}, ttl: errorTtl }; 
        }
    };

    const fetchPromise = performFetch().then(result => { setCache(cacheKey, result.data, result.ttl); return result.data; });
    setCache(cacheKey, fetchPromise, 10000); 
    return fetchPromise;
}

//===============
// TORBOX CACHE CHECK
// Checks Torbox's internal cache directly via standard API.
//===============
async function checkTorbox(hashes, apiKey) {
    if (!hashes || hashes.length === 0) return {};
    const safeKey = (apiKey || "").trim();
    const hashKey = [...hashes].sort().join("");
    const cacheKey = "tb_chk_" + safeKey.substring(0, 5) + "_" + hashKey;
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const results = {};
            const chunkSize = 20; 
            for (let i = 0; i < hashes.length; i += chunkSize) {
                const chunk = hashes.slice(i, i + chunkSize);
                const url = "https://api.torbox.app/v1/api/torrents/checkcached?hash=" + chunk.join(",") + "&format=list&list_files=true";
                const res = await axios.get(url, { 
                    headers: { 
                        "Authorization": "Bearer " + safeKey,
                        "User-Agent": API_USER_AGENT
                    }, 
                    timeout: 8000 
                });
                if (res.data && res.data.data) {
                    res.data.data.forEach(t => {
                        results[t.hash.toLowerCase()] = t.files.map(f => ({ id: f.id, name: f.name, size: f.size }));
                    });
                }
                if (i + chunkSize < hashes.length) await new Promise(resolve => setTimeout(resolve, 300));
            }
            return { data: results, ttl: 60000 };
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            return { data: {}, ttl: (status === 401 || status === 403) ? 10000 : 30000 }; 
        }
    };
    const fetchPromise = performFetch().then(result => { setCache(cacheKey, result.data, result.ttl); return result.data; });
    setCache(cacheKey, fetchPromise, 10000);
    return fetchPromise;
}

//===============
// DOWNLOADING FETCHERS (GET ACTIVE)
// Queries the active user queues. This allows Amatsu to display `[⏳ 45% RD]`
// indicating to the user that their stream is currently being downloaded to the cloud.
//===============
async function getActiveRD(apiKey) {
    const safeKey = (apiKey || "").trim();
    const cacheKey = "rd_act_" + safeKey;
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const res = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=100", { 
                headers: { 
                    "Authorization": "Bearer " + safeKey,
                    "User-Agent": API_USER_AGENT
                }, 
                timeout: 8000 
            });
            const active = {};
            res.data.forEach(t => {
                if (t.status === "downloaded") active[t.hash.toLowerCase()] = 100;
                else if (t.status !== "error" && t.status !== "dead") active[t.hash.toLowerCase()] = t.progress || 0;
            });
            return { data: active, ttl: 10000 };
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            return { data: {}, ttl: (status === 401 || status === 403) ? 10000 : 30000 }; 
        }
    };
    const fetchPromise = performFetch().then(result => { setCache(cacheKey, result.data, result.ttl); return result.data; });
    setCache(cacheKey, fetchPromise, 10000);
    return fetchPromise;
}

async function getActiveTorbox(apiKey) {
    const safeKey = (apiKey || "").trim();
    const cacheKey = "tb_act_" + safeKey;
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const res = await axios.get("https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true", { 
                headers: { 
                    "Authorization": "Bearer " + safeKey,
                    "User-Agent": API_USER_AGENT
                }, 
                timeout: 8000 
            });
            const active = {};
            if (res.data && res.data.data) {
                res.data.data.forEach(t => {
                    if (t.download_state === "completed" || t.download_state === "cached") active[t.hash.toLowerCase()] = 100;
                    else {
                        let p = t.progress || 0;
                        if (p <= 1 && p > 0) p = p * 100;
                        active[t.hash.toLowerCase()] = Math.round(p);
                    }
                });
            }
            return { data: active, ttl: 10000 };
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            return { data: {}, ttl: (status === 401 || status === 403) ? 10000 : 30000 }; 
        }
    };
    const fetchPromise = performFetch().then(result => { setCache(cacheKey, result.data, result.ttl); return result.data; });
    setCache(cacheKey, fetchPromise, 10000);
    return fetchPromise;
}

module.exports = { checkRD, checkTorbox, getActiveRD, getActiveTorbox };
