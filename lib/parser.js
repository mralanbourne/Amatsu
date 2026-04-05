//===============
// AMATSU & YOMI PARSING ENGINE
//===============

function sanitizeFilename(filename) {
    return filename.replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov|srt|ass|ssa|vtt|sub|idx)$/i, "")
        .replace(/^\[.*?\]/g, "")
        .replace(/\b(?:\d{3,4}x\d{3,4})\b/gi, "")
        .replace(/\b(?:2160|1080|810|720|540|480|360)[pi]?\b/gi, "")
        .replace(/\b(?:x|h)26[45]\b/gi, "")
        .replace(/\b(?:HEVC|AVC|FHD|HD|SD|10-?bit|8-?bit|12-?bit|Hi10P|Hi444P)\b/gi, "")
        .replace(/\b(?:BD|BDRip|Blu-?ray|WEB-?DL|WEB-?Rip|DVD|DVDRip|TVRip|HDTV|CAM)\b/gi, "")
        .replace(/\b(?:FLAC|AAC|AC3|DTS|DTS-HD|TrueHD|Vorbis|Opus|MP3|PCM)\b/gi, "")
        .replace(/\b(?:Uncensored|Censored|Decensored|Uncen|Dual-?Audio|Multi-?Subs|RAW)\b/gi, "")
        .replace(/\[[a-fA-F0-9]{8}\]/g, "")
        .replace(/\b(?:NC)?(?:OP|ED|Opening|Ending)\s*\d*\b/gi, " ")
        .replace(/\b(?:v\d)\b/gi, "")
        .replace(/\b(?:19|20)\d{2}\b/g, "");
}

//===============
// STRICT TITLE VERIFICATION
//===============
function verifyTitleMatch(filename, searchTitles) {
    if (!searchTitles || searchTitles.length === 0) return true;
    
    let stripped = filename.replace(/\[.*?\]/g, " ");
    
    stripped = stripped.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, " ").toLowerCase();
    stripped = stripped.replace(/\s{2,}/g, " ").trim();

    for (const title of searchTitles) {
        if (!title) continue;
        
        const cleanTitle = title.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, " ").toLowerCase().replace(/\s{2,}/g, " ").trim();
        if (!cleanTitle) continue;
        
        const escapedTitle = cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(?:^|\\s)${escapedTitle}(?:\\s|$)`, "i");
        
        if (regex.test(stripped)) {
            return true;
        }
        
        if (/[^\x00-\x7F]/.test(cleanTitle)) {
            const strippedNoSpaces = stripped.replace(/\s+/g, "");
            const cleanNoSpaces = cleanTitle.replace(/\s+/g, "");
            if (strippedNoSpaces.includes(cleanNoSpaces)) {
                return true;
            }
        }
    }
    return false;
}

function extractEpisodeNumber(filename, expectedSeason = 1) {
    let clean = sanitizeFilename(filename);

    const explicitRegex = /(?:ep(?:isode)?\.?\s*|\be\s*|ova\s*|oad\s*|special\s*|round\s*|act\s*|chapter\s*|part\s*|vol(?:ume)?\.?\s*|第\s*|#\s*|s(\d+)\s*e|season\s*(\d+)\s*ep(?:isode)?\s*)0*(\d+)(?:\s*(?:巻|話|v\d+))?(?:\D|$)/i;
    const explicitMatch = clean.match(explicitRegex);
    if (explicitMatch) {
        const fileSeason = explicitMatch[1] || explicitMatch[2];
        if (fileSeason !== undefined) {
            const parsedSeason = parseInt(fileSeason, 10);
            if (parsedSeason !== expectedSeason) return -1; 
        }
        return parseInt(explicitMatch[3], 10);
    }

    const dashMatch = clean.match(/(?:^|\s)\-\s+0*(\d+)(?:\D|$)/i);
    if (dashMatch) return parseInt(dashMatch[1], 10);
    
    const bracketMatch = clean.match(/\[0*(\d+)\]|\(0*(\d+)\)/i);
    if (bracketMatch) return parseInt(bracketMatch[1] || bracketMatch[2], 10);

    clean = clean.replace(/[\[\]\(\)\{\}_\-\+~,#]/g, " ").trim();
    const tokens = clean.split(/\s+/);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i];
        const numMatch = token.match(/^e?0*(\d+)(?:v\d+)?$/i); 
        if (numMatch) return parseInt(numMatch[1], 10);
    }
    return null;
}

function extractLooseEpisode(filename) {
    let clean = sanitizeFilename(filename);
    clean = clean.replace(/\b(?:S|Season|Part|Cour)\s*0*\d+\b/ig, "");
    
    const digits = clean.match(/0*(\d+)/g);
    if (digits) {
        for (const d of digits) {
            const num = parseInt(d, 10);
            if (num < 2000 && num > 0) return num;
        }
    }
    return null;
}

function getBatchRange(filename) {
    let clean = sanitizeFilename(filename);
                        
    const batchMatch = clean.match(/(?:^|\D)(?:第\s*|vol(?:ume)?\.?\s*)?0*(\d+)\s*(?:-|~|to)\s*0*(\d+)(?:\s*巻)?(?:\D|$)/i);
    if (batchMatch) {
        const start = parseInt(batchMatch[1], 10);
        const end = parseInt(batchMatch[2], 10);
        if (end > start && end - start < 2000) return { start, end };
    }
    return null;
}

function isSeasonBatch(filename, expectedSeason) {
    const clean = filename.replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov|srt|ass|ssa|vtt|sub|idx)$/i, "");
    const hasSeasonTag = new RegExp(`\\b(?:S|Season|Part|Cour)\\s*0*${expectedSeason}\\b`, "i").test(clean);
    
    const hasBatchWord = /\b(batch|complete|all episodes|series|seasons?)\b|全集/i.test(clean);
    
    if (hasSeasonTag || hasBatchWord) {
        const explicitEp = extractEpisodeNumber(filename, expectedSeason);
        if (explicitEp === null) return true;
    }
    
    if (getBatchRange(filename) !== null) return true;
    return false;
}

function isEpisodeMatch(name, requestedEp, expectedSeason = 1) {
    const parts = name.split("/");
    const filename = parts[parts.length - 1];
    const epNum = parseInt(requestedEp, 10);

    if (extractEpisodeNumber(filename, expectedSeason) === epNum) return true;
    
    const batch = getBatchRange(filename);
    if (batch && epNum >= batch.start && epNum <= batch.end) return true;
    
    if (extractLooseEpisode(filename) === epNum) return true;

    if (epNum === 1 && !batch) {
        if (/\b(?:OVA|OAD|Movie|Film|Special)\b/i.test(name) && extractLooseEpisode(filename) === null) {
            return true;
        }
        return !/trailer|promo|menu|teaser|ncop|nced|extra|interview|greeting|geeting|credit|making/i.test(name);
    }
    return false;
}

//===============
// FIX: isMovie Parameter
//===============
function selectBestVideoFile(files, requestedEp, expectedSeason = 1, isMovie = false) {
    if (!files || files.length === 0) return null;
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov)$/i.test(f.name || f.path || ""));
    if (videoFiles.length === 0) return null;

    if (isMovie) {
        return videoFiles.sort((a, b) => {
            const aMkv = (a.name || a.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
            const bMkv = (b.name || b.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
            if (aMkv !== bMkv) return bMkv - aMkv;
            return (b.size || b.bytes || 0) - (a.size || a.bytes || 0);
        })[0];
    }

    const epNum = parseInt(requestedEp, 10);

    let matches = videoFiles.filter(f => {
        const parts = (f.name || f.path || "").split("/");
        const filename = parts[parts.length - 1];
        return extractEpisodeNumber(filename, expectedSeason) === epNum;
    });

    if (matches.length === 0) {
        matches = videoFiles.filter(f => {
            const parts = (f.name || f.path || "").split("/");
            const filename = parts[parts.length - 1];
            const batch = getBatchRange(filename);
            return batch && epNum >= batch.start && epNum <= batch.end;
        });
    }

    if (matches.length === 0) {
        matches = videoFiles.filter(f => {
            const parts = (f.name || f.path || "").split("/");
            const filename = parts[parts.length - 1];
            return extractLooseEpisode(filename) === epNum;
        });
    }

    if (matches.length > 0) {
        return matches.sort((a, b) => {
            const nameA = (a.name || a.path || "").toLowerCase();
            const nameB = (b.name || b.path || "").toLowerCase();
            const aMkv = nameA.endsWith(".mkv") ? 1 : 0;
            const bMkv = nameB.endsWith(".mkv") ? 1 : 0;
            if (aMkv !== bMkv) return bMkv - aMkv;
            return (b.size || b.bytes || 0) - (a.size || a.bytes || 0);
        })[0];
    }

    if (epNum === 1) {
        const cleanVideos = videoFiles.filter(f => {
            const name = (f.name || f.path || "");
            return !/trailer|promo|menu|teaser|ncop|nced|extra|interview|greeting|geeting|credit|making/i.test(name);
        });
        
        if (cleanVideos.length > 0) {
            return cleanVideos.sort((a, b) => {
                const nameA = (a.name || a.path || "").toLowerCase();
                const nameB = (b.name || b.path || "").toLowerCase();
                const aMkv = nameA.endsWith(".mkv") ? 1 : 0;
                const bMkv = nameB.endsWith(".mkv") ? 1 : 0;
                if (aMkv !== bMkv) return bMkv - aMkv;
                return (b.size || b.bytes || 0) - (a.size || a.bytes || 0);
            })[0];
        }
    }

    return null;
}

module.exports = { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch, verifyTitleMatch };
