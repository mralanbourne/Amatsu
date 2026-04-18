//===============
// AMATSU & YOMI PARSING ENGINE (UNIFIED, FIXED FOR ORDINAL SEASONS)
//===============

function sanitizeFilename(filename) {
    return filename.replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov|srt|ass|ssa|vtt|sub|idx)$/i, "")
        .replace(/^\[.*?\]/g, "")
        .replace(/\b(?:\d{3,4}x\d{3,4})\b/gi, "")
        .replace(/\b(?:2160|1080|810|720|576|540|480|360)[pix]*\b/gi, "")
        .replace(/\b(?:x|h)26[45]\b/gi, "")
        .replace(/\b(?:HEVC|AVC|FHD|HD|SD|10-?bits?|8-?bits?|12-?bits?|Hi10P|Hi444P)\b/gi, "")
        .replace(/\b(?:BD|BDRip|Blu-?ray|WEB-?DL|WEB-?Rip|DVD|DVDRip|TVRip|HDTV|CAM)\b/gi, "")
        .replace(/\b(?:FLAC|AAC|AC3|DTS|DTS-HD|TrueHD|Vorbis|Opus|MP3|PCM)\b/gi, "")
        .replace(/\b(?:Uncensored|Censored|Decensored|Uncen|Dual-?Audio|Multi-?Subs|RAW|Hentai)\b/gi, "")
        .replace(/\b(?:5\.1|2\.0|7\.1|2\.1)\b/g, "")
        .replace(/\[[a-fA-F0-9]{8}\]/g, "")
        .replace(/\b(?:NC)?(?:OP|ED|Opening|Ending)\s*\d*\b/gi, " ")
        .replace(/\b(?:v\d)\b/gi, "")
        .replace(/\b(?:19|20)\d{2}\b/g, "");
}

//===============
// TITLE NORMALIZATION
//===============
function normalizeTitle(text) {
    return text.toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[\u3000]/g, " ")
        .replace(/ⅰ/g, "i").replace(/ⅱ/g, "ii").replace(/ⅲ/g, "iii").replace(/ⅳ/g, "iv").replace(/ⅴ/g, "v")
        .replace(/ⅵ/g, "vi").replace(/ⅶ/g, "vii").replace(/ⅷ/g, "viii").replace(/ⅸ/g, "ix").replace(/ⅹ/g, "x")
        .replace(/Ⅰ/g, "i").replace(/Ⅱ/g, "ii").replace(/Ⅲ/g, "iii").replace(/Ⅳ/g, "iv").replace(/Ⅴ/g, "v")
        .replace(/Ⅵ/g, "vi").replace(/Ⅶ/g, "vii").replace(/Ⅷ/g, "viii").replace(/Ⅸ/g, "ix").replace(/Ⅹ/g, "x")
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"'<>?+|\\・、。「」『』【】［］（）〈〉≪≫《》〔〕…—～〜♥♡★☆♪]/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

//===============
// STRICT TITLE VERIFICATION
//===============
function verifyTitleMatch(filename, searchTitles) {
    if (!searchTitles || searchTitles.length === 0) return true;

    const stripped = normalizeTitle(filename);

    for (const title of searchTitles) {
        if (!title) continue;

        const cleanTitle = normalizeTitle(title);
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

//===============
// WRONG SEASON SHIELD
//===============
function isWrongSeason(filename, expectedSeason) {
    const clean = filename.toLowerCase();
    const seasonRegex = /(?:s|season|part|cour)\s*0*(\d+)\b|第\s*0*(\d+)\s*(?:季|期|기)|\b(\d+)(?:st|nd|rd|th)\s+(?:season|part|cour)\b/ig;

    let match;
    let foundWrong = false;
    let foundRight = false;

    while ((match = seasonRegex.exec(clean)) !== null) {
        const s = parseInt(match[1] || match[2] || match[3], 10);
        if (s === expectedSeason) foundRight = true;
        else foundWrong = true;
    }

    if (foundWrong && !foundRight) {
        const rangeMatch = clean.match(/(?:s|season)\s*0*(\d+)\s*(?:-|~|to|a|&|\+)\s*(?:s|season)?\s*0*(\d+)/i);
        if (rangeMatch) {
            const start = parseInt(rangeMatch[1], 10);
            const end = parseInt(rangeMatch[2], 10);
            if (expectedSeason >= start && expectedSeason <= end) {
                return false;
            }
        }
        return true;
    }
    return false;
}

function extractEpisodeNumber(filename, expectedSeason = 1) {
    let clean = sanitizeFilename(filename);

    clean = clean.replace(/(?:第|시즌\s*)?0*\d+\s*(?:季|期|기)/ig, "");
    clean = clean.replace(/\b\d+(?:st|nd|rd|th)\s+(?:Season|Part|Cour)\b/ig, "");

    const explicitRegex = /(?:ep(?:isode)?\.?\s*|\be\s*|ova\s*|oad\s*|special\s*|round\s*|act\s*|chapter\s*|part\s*|vol(?:ume)?\.?\s*|第\s*|#\s*|s(\d+)\s*e|season\s*(\d+)\s*ep(?:isode)?\s*)0*(\d+)(?:\s*(?:巻|話|话|集|화|회|편|v\d+))?(?:\D|$)/i;
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

    clean = clean.replace(/\b(?:S|Season|Part|Cour)\s*0*\d+\b/ig, "");
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
    clean = clean.replace(/(?:第|시즌\s*)?0*\d+\s*(?:季|期|기)/ig, "");
    clean = clean.replace(/\b\d+(?:st|nd|rd|th)\s+(?:Season|Part|Cour)\b/ig, "");
    clean = clean.replace(/\b\d+\s*-?\s*kai\b/ig, "");

    const regex = /(?:^|[\s\[\]\(\)\{\}_\-\+~,#])0*(\d+)(?:v\d+)?(?:[\s\[\]\(\)\{\}_\-\+~,#\.]|$)/ig;
    let match;
    while ((match = regex.exec(clean)) !== null) {
        const num = parseInt(match[1], 10);
        if (num < 3000 && num > 0) return num;
    }
    return null;
}

function getBatchRange(filename) {
    let clean = sanitizeFilename(filename);

    clean = clean.replace(/\b(?:s|season|part|cour)\s*0*\d+\s*(?:-|~|to|a|&|\+)\s*(?:s|season|part|cour)?\s*0*\d+\b/ig, "");
    clean = clean.replace(/(?:第|시즌\s*)?0*\d+\s*(?:-|~|to|a|&|\+)\s*(?:第|시즌\s*)?0*\d+\s*(?:季|期|기)/ig, "");
    clean = clean.replace(/\b\d+(?:st|nd|rd|th)\s+(?:Season|Part|Cour)\b/ig, "");

    const batchMatch = clean.match(/(?:^|\D)(?:第\s*|vol(?:ume)?\.?\s*|e?p?\.?\s*)?0*(\d+)\s*(?:-|~|to|a|&|\+)\s*(?:e?p?\.?\s*)?0*(\d+)(?:\s*(?:巻|話|话|集|화|회|편))?(?:\D|$)/i);
    if (batchMatch) {
        const start = parseInt(batchMatch[1], 10);
        const end = parseInt(batchMatch[2], 10);
        if (end > start && end - start < 3000) return { start, end };
    }
    return null;
}

function isSeasonBatch(filename, expectedSeason) {
    if (isWrongSeason(filename, expectedSeason)) return false;

    const clean = filename.replace(/\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov|srt|ass|ssa|vtt|sub|idx)$/i, "");
    const hasSeasonTag = new RegExp(`(?:\\b(?:S|Season|Part|Cour)\\s*0*${expectedSeason}\\b|(?:第|시즌\\s*)?0*${expectedSeason}\\s*(?:季|期|기)|\\b${expectedSeason}(?:st|nd|rd|th)\\s+(?:season|part|cour)\\b)`, "i").test(clean);
    
    const hasBatchWord = /\b(batch|complete|collection|boxset|box-set|box\b|bd-box|dvd-box|all episodes|all eps)\b|全集|완결|전편/i.test(clean);

    const batchRange = getBatchRange(filename);
    if (batchRange && batchRange.end > batchRange.start) return true;

    if (hasBatchWord) return true;

    const epNum = extractEpisodeNumber(filename, expectedSeason);
    const loose = extractLooseEpisode(filename);

    if (hasSeasonTag && epNum === null && loose === null && batchRange === null) {
        return true;
    }

    if (epNum === null && loose === null && batchRange === null) {
        return true;
    }

    return false;
}

function isEpisodeMatch(name, requestedEp, expectedSeason = 1) {
    if (isWrongSeason(name, expectedSeason)) return false;

    const parts = name.split("/");
    const filename = parts[parts.length - 1];
    const epNum = parseInt(requestedEp, 10);

    const batch = getBatchRange(filename);
    if (batch && epNum >= batch.start && epNum <= batch.end) return true;

    if (extractEpisodeNumber(filename, expectedSeason) === epNum) return true;
    if (extractLooseEpisode(filename) === epNum) return true;

    if (epNum === 1 && !batch) {
        if (/\b(?:OVA|OAD|Movie|Film|Special)\b/i.test(name) && extractLooseEpisode(filename) === null) {
            return true;
        }
        return !/trailer|promo|menu|teaser|ncop|nced|extra|interview|greeting|geeting|credit|making/i.test(name);
    }
    return false;
}

function selectBestVideoFile(files, requestedEp, expectedSeason = 1, isMovie = false) {
    if (!files || files.length === 0) return null;
    let videoFiles = files.filter(f => /\.(mkv|mp4|avi|wmv|flv|webm|m4v|ts|mov)$/i.test(f.name || f.path || ""));
    if (videoFiles.length === 0) return null;

    const epNum = parseInt(requestedEp, 10);

    if (epNum > 1 || videoFiles.length > 2) {
        isMovie = false;
    }

    if (!isMovie) {
        videoFiles = videoFiles.filter(f => {
            const size = f.size !== undefined ? f.size : (f.bytes || 0);
            if (size === 0) return true; 
            
            const MIN_SIZE = 30 * 1024 * 1024; 
            const MAX_SIZE = 4.5 * 1024 * 1024 * 1024; 
            
            if (size < MIN_SIZE) return false;
            if (size > MAX_SIZE) return false;
            
            return true;
        });
    }

    if (videoFiles.length === 0) return null; 

    if (isMovie) {
        return videoFiles.sort((a, b) => {
            const aMkv = (a.name || a.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
            const bMkv = (b.name || b.path || "").toLowerCase().endsWith(".mkv") ? 1 : 0;
            if (aMkv !== bMkv) return bMkv - aMkv;
            return (b.size || b.bytes || 0) - (a.size || a.bytes || 0);
        })[0];
    }

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

    if (videoFiles.length === 1) {
        return videoFiles[0];
    }

    return null;
}

module.exports = { extractEpisodeNumber, getBatchRange, isEpisodeMatch, selectBestVideoFile, isSeasonBatch, verifyTitleMatch };
