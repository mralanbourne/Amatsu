//===============
// YOMI & AMATSU DEBRID PROVIDER INTERFACE
// (Clean Architecture + WAF/Cloudflare Bypass + Strict Rate Limit)
//===============
const axios = require("axios");

const apiCache = new Map();
const MAX_CACHE_ENTRIES = 500;

// Standard Browser-Header, um Cloudflare & Firewalls auszutricksen
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

async function checkRD(hashes, apiKey) {
    if (!hashes || hashes.length === 0) return {};
    const safeKey = (apiKey || "").trim(); // Unsichtbare Leerzeichen entfernen
    const hashKey = [...hashes].sort().join("");
    const cacheKey = "rd_chk_" + safeKey.substring(0, 5) + "_" + hashKey;
    const cachedItem = getCache(cacheKey);
    
    if (cachedItem) return cachedItem;

    console.log(`[DEBRID FORENSICS] Frage Real-Debrid API für ${hashes.length} Hashes ab... (Tarnkappen-Modus)`);

    const performFetch = async () => {
        try {
            const results = {};
            let totalCached = 0;
            const chunkSize = 10; 
            
            for (let i = 0; i < hashes.length; i += chunkSize) {
                const chunk = hashes.slice(i, i + chunkSize);
                const url = "https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/" + chunk.join("/");
                
                const res = await axios.get(url, { 
                    headers: { 
                        "Authorization": "Bearer " + safeKey,
                        "User-Agent": BROWSER_USER_AGENT,
                        "Accept": "application/json"
                    },
                    timeout: 8000
                });

                Object.keys(res.data).forEach(hash => {
                    const h = hash.toLowerCase();
                    const availability = res.data[hash];
                    
                    if (availability && availability.rd) {
                        let allFilesMap = new Map();
                        const variants = Array.isArray(availability.rd) ? availability.rd : Object.values(availability.rd);
                        
                        variants.forEach(variant => {
                            if (variant && typeof variant === 'object') {
                                Object.keys(variant).forEach(fileId => {
                                    if (!allFilesMap.has(fileId)) {
                                        allFilesMap.set(fileId, { 
                                            id: fileId, 
                                            name: variant[fileId].filename || "Unknown", 
                                            size: variant[fileId].filesize || 0 
                                        });
                                    }
                                });
                            }
                        });
                        
                        if (allFilesMap.size > 0) {
                            results[h] = Array.from(allFilesMap.values());
                            totalCached++;
                        }
                    }
                });
                
                if (i + chunkSize < hashes.length) await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            console.log(`[DEBRID FORENSICS] ✅ RD API meldet: ${totalCached} von ${hashes.length} Torrents sind gecached.`);
            return { data: results, ttl: 60000 };
        } catch (e) { 
            const status = e.response ? e.response.status : 500;
            const errorMsg = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
            console.error(`[DEBRID FORENSICS] ❌ Real-Debrid API Error: ${status} - ${errorMsg}`);
            return { data: {}, ttl: (status === 401 || status === 403) ? 10000 : 30000 }; 
        }
    };

    const fetchPromise = performFetch().then(result => {
        setCache(cacheKey, result.data, result.ttl);
        return result.data;
    });
    
    setCache(cacheKey, fetchPromise, 10000);
    return fetchPromise;
}

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
                        "User-Agent": BROWSER_USER_AGENT
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
                    "User-Agent": BROWSER_USER_AGENT
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
                    "User-Agent": BROWSER_USER_AGENT
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
