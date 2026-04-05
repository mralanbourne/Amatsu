//===============
// YOMI DEBRID PROVIDER INTERFACE
// This module manages communication with Debrid services (Real-Debrid & Torbox).
// Includes intelligent chunking, Promise deduplication, and LRU caching.
//===============

const axios = require("axios");

//===============
// IN-MEMORY CACHE & PROMISE DEDUPING
// A high-performance LRU cache to prevent 429 Too Many Requests errors.
//===============
const apiCache = new Map();
const MAX_CACHE_ENTRIES = 500;

// Utility function: Sets the cache with a dynamic TTL to rotate entries efficiently
function setCache(key, dataOrPromise, ttlMs = 60000) {
    if (apiCache.has(key)) {
        apiCache.delete(key);
    } else if (apiCache.size >= MAX_CACHE_ENTRIES) {
        apiCache.delete(apiCache.keys().next().value);
    }
    apiCache.set(key, { data: dataOrPromise, expiresAt: Date.now() + ttlMs });
}

// Utility function: Retrieves data and updates LRU position
function getCache(key) {
    if (apiCache.has(key)) {
        const item = apiCache.get(key);
        if (item.expiresAt > Date.now()) {
            apiCache.delete(key);
            apiCache.set(key, item);
            return item.data;
        } else {
            apiCache.delete(key);
        }
    }
    return null;
}

//===============
// Checks Real-Debrid for immediate availability.
// Uses deduplication to absorb parallel requests from Stremio pre-fetching.
//===============
async function checkRD(hashes, apiKey) {
    if (!hashes || hashes.length === 0) return {};
    
    // Create a deterministic cache key based on the requested hashes
    const hashKey = [...hashes].sort().join("");
    const cacheKey = "rd_chk_" + apiKey.substring(0, 5) + "_" + hashKey;
    
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const results = {};
            
            // A block size of 40 prevents URL overflows
            for (let i = 0; i < hashes.length; i += 40) {
                const chunk = hashes.slice(i, i + 40);
                const url = "https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/" + chunk.join("/");
                const res = await axios.get(url, { headers: { Authorization: "Bearer " + apiKey } });
                
                Object.keys(res.data).forEach(hash => {
                    const h = hash.toLowerCase();
                    const availability = res.data[hash];
                    
                    if (availability && availability.rd && availability.rd.length > 0) {
                        let allFilesMap = new Map();
                        
                        availability.rd.forEach(variant => {
                            Object.keys(variant).forEach(fileId => {
                                if (!allFilesMap.has(fileId)) {
                                    allFilesMap.set(fileId, { 
                                        id: fileId, 
                                        name: variant[fileId].filename, 
                                        size: variant[fileId].filesize 
                                    });
                                }
                            });
                        });
                        
                        results[h] = Array.from(allFilesMap.values());
                    }
                });
                
                // Short delay between chunks to respect rate limits
                if (i + 40 < hashes.length) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
            return { data: results, ttl: 60000 };
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            console.error("[Real-Debrid Error] Error at checkRD: Request failed with status code " + status);
            
            //===============
            // DYNAMIC ERROR CACHING
            // Prevents spamming Debrid APIs when the key is invalid or rate limited.
            //===============
            let errorTtl = 10000;
            if (status === 401 || status === 403) {
                errorTtl = 3600000; // Lock for 1 hour
            } else if (status === 429) {
                errorTtl = 30000; // Lock for 30 seconds
            }
            
            return { data: {}, ttl: errorTtl }; 
        }
    };

    const fetchPromise = performFetch().then(result => {
        setCache(cacheKey, result.data, result.ttl);
        return result.data;
    });
    
    setCache(cacheKey, fetchPromise, 30000); // Temporary promise cache
    return fetchPromise;
}

//===============
// Checks Torbox for cached torrents.
// Also splits the request into secure blocks of 40 with caching.
//===============
async function checkTorbox(hashes, apiKey) {
    if (!hashes || hashes.length === 0) return {};

    const hashKey = [...hashes].sort().join("");
    const cacheKey = "tb_chk_" + apiKey.substring(0, 5) + "_" + hashKey;
    
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const results = {};
            
            for (let i = 0; i < hashes.length; i += 40) {
                const chunk = hashes.slice(i, i + 40);
                const url = "https://api.torbox.app/v1/api/torrents/checkcached?hash=" + chunk.join(",") + "&format=list&list_files=true";
                const res = await axios.get(url, { headers: { Authorization: "Bearer " + apiKey } });
                
                if (res.data && res.data.data) {
                    res.data.data.forEach(t => {
                        results[t.hash.toLowerCase()] = t.files.map(f => ({ 
                            id: f.id, 
                            name: f.name, 
                            size: f.size 
                        }));
                    });
                }
                
                if (i + 40 < hashes.length) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
            return { data: results, ttl: 60000 };
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            console.error("[Torbox Error] Error at checkTorbox: Request failed with status code " + status);
            
            let errorTtl = 10000;
            if (status === 401 || status === 403) errorTtl = 3600000;
            else if (status === 429) errorTtl = 30000;
            
            return { data: {}, ttl: errorTtl }; 
        }
    };

    const fetchPromise = performFetch().then(result => {
        setCache(cacheKey, result.data, result.ttl);
        return result.data;
    });
    
    setCache(cacheKey, fetchPromise, 30000);
    return fetchPromise;
}

//===============
// Retrieves the current list of active torrents from Real-Debrid.
// Uses a strict 10-second TTL to ensure accurate progress reporting in the Stremio UI.
//===============
async function getActiveRD(apiKey) {
    const cacheKey = "rd_act_" + apiKey;
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const res = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=100", { 
                headers: { Authorization: "Bearer " + apiKey } 
            });
            const active = {};
            
            res.data.forEach(t => {
                if (t.status === "downloaded") {
                    active[t.hash.toLowerCase()] = 100;
                } else if (t.status !== "error" && t.status !== "dead") {
                    active[t.hash.toLowerCase()] = t.progress || 0;
                }
            });
            return { data: active, ttl: 10000 }; // 10s TTL for live progression
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            console.error("[Real-Debrid Error] Error at getActiveRD: Request failed with status code " + status);
            
            let errorTtl = 10000;
            if (status === 401 || status === 403) errorTtl = 3600000;
            else if (status === 429) errorTtl = 30000;
            
            return { data: {}, ttl: errorTtl }; 
        }
    };

    const fetchPromise = performFetch().then(result => {
        setCache(cacheKey, result.data, result.ttl);
        return result.data;
    });
    
    setCache(cacheKey, fetchPromise, 10000);
    return fetchPromise;
}

//===============
// Retrieves the current list of active torrents from Torbox.
// Uses a strict 10-second TTL to ensure accurate progress reporting in the Stremio UI.
//===============
async function getActiveTorbox(apiKey) {
    const cacheKey = "tb_act_" + apiKey;
    const cachedItem = getCache(cacheKey);
    if (cachedItem) return cachedItem;

    const performFetch = async () => {
        try {
            const res = await axios.get("https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true", { 
                headers: { Authorization: "Bearer " + apiKey } 
            });
            const active = {};
            
            if (res.data && res.data.data) {
                res.data.data.forEach(t => {
                    if (t.download_state === "completed" || t.download_state === "cached") {
                        active[t.hash.toLowerCase()] = 100;
                    } else {
                        let p = t.progress || 0;
                        if (p <= 1 && p > 0) p = p * 100;
                        active[t.hash.toLowerCase()] = Math.round(p);
                    }
                });
            }
            return { data: active, ttl: 10000 };
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            console.error("[Torbox Error] Error at getActiveTorbox: Request failed with status code " + status);
            
            let errorTtl = 10000;
            if (status === 401 || status === 403) errorTtl = 3600000;
            else if (status === 429) errorTtl = 30000;
            
            return { data: {}, ttl: errorTtl }; 
        }
    };

    const fetchPromise = performFetch().then(result => {
        setCache(cacheKey, result.data, result.ttl);
        return result.data;
    });
    
    setCache(cacheKey, fetchPromise, 10000);
    return fetchPromise;
}

module.exports = { checkRD, checkTorbox, getActiveRD, getActiveTorbox };
