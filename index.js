const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
// @semantic-release/error v4+ is ESM with a default export; older versions
// exported the class directly. Support both so handleError can actually throw.
const semanticReleaseErrorModule = require('@semantic-release/error');
const SemanticReleaseError = semanticReleaseErrorModule.default || semanticReleaseErrorModule;

const DEFAULT_PANO_URL = 'https://api.panomc.com';
const DEFAULT_MAX_CHANGELOG_LENGTH = 6500;
const TRUNCATION_SUFFIX = '...';

function getConfigs(pluginConfig) {
    if (Array.isArray(pluginConfig.configs)) {
        return pluginConfig.configs.map(config => {
            // Do NOT inherit `branches` from the top level in multi-config mode:
            // semantic-release merges the resolved GLOBAL options (including the
            // release configuration's `branches`, e.g. [{name:"dev"},"main"]) into
            // the plugin config. Inheriting that into every entry would activate
            // ALL entries on ALL release branches — e.g. a dev prerelease would
            // also publish to the production store. Branch scoping in multi-config
            // mode must be declared per entry.
            const { configs, branches, ...baseConfig } = pluginConfig;
            return {
                ...baseConfig,
                ...config
            };
        });
    }
    return [pluginConfig];
}

function currentBranchName(context) {
    return (
        (context && context.branch && context.branch.name) ||
        (context && context.envCi && context.envCi.branch) ||
        null
    );
}

// A config without `branches` runs everywhere (backward compat). With `branches`,
// it only runs when the release branch matches one of the listed names. If we
// can't resolve the branch (unusual — semantic-release normally sets it), we
// fall back to running so a missing context can't silently drop a release.
//
// IMPORTANT: semantic-release merges the resolved GLOBAL options into every
// plugin's config, so `config.branches` is usually the release configuration's
// top-level branch list — whose entries are branch SPECS (strings OR objects
// like { name: "dev", prerelease: true }), not the plain name list this option
// documents. A plain `includes(branch)` therefore missed every object entry and
// silently skipped publishing on prerelease branches (dev releases never reached
// the Pano store while string-spec branches like "main" kept working). Normalize
// specs to names before matching.
function configMatchesBranch(config, branch) {
    const branches = config && config.branches;
    if (!Array.isArray(branches) || branches.length === 0) return true;
    if (!branch) return true;
    const names = branches
        .map((entry) => (typeof entry === 'string' ? entry : entry && entry.name))
        .filter(Boolean);
    if (names.length === 0) return true;
    return names.includes(branch);
}

function getActiveConfigs(pluginConfig, context) {
    const branch = currentBranchName(context);
    return getConfigs(pluginConfig).filter(c => configMatchesBranch(c, branch));
}

// Truncate the changelog to fit the receiving Pano resource system's `changelog`
// validation budget. semantic-release-generated notes can balloon when the first
// stable release on a branch aggregates a long prerelease history, and the Pano
// backend rejects oversized payloads with BAD_REQUEST. We cut to `maxLength`
// characters total — `TRUNCATION_SUFFIX` included — so the body never grows past
// the configured budget, regardless of where the cut lands inside a word.
function truncateChangelog(notes, maxLength) {
    if (!notes) return notes || '';
    const cap = Number.isFinite(maxLength) && maxLength > 0
        ? Math.floor(maxLength)
        : DEFAULT_MAX_CHANGELOG_LENGTH;
    if (notes.length <= cap) return notes;
    const suffixLen = TRUNCATION_SUFFIX.length;
    if (cap <= suffixLen) return TRUNCATION_SUFFIX.slice(0, cap);
    return notes.slice(0, cap - suffixLen) + TRUNCATION_SUFFIX;
}

/**
 * Compute SHA-256 hash of a file.
 */
async function computeFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/**
 * Build the GitHub Release asset download URL.
 *
 * @param {string} repositoryUrl - e.g. "https://github.com/PanoMC/pano-mc-plugin.git"
 * @param {string} tagName - e.g. "v1.2.3"
 * @param {string} fileName - basename of the asset, e.g. "Pano-Spigot-1.2.3.jar"
 */
function buildGitHubAssetUrl(repositoryUrl, tagName, fileName) {
    // Normalize: strip .git suffix, trailing slashes
    let repoUrl = repositoryUrl.replace(/\.git$/, '').replace(/\/+$/, '');

    // Convert SSH URLs to HTTPS
    if (repoUrl.startsWith('git@')) {
        repoUrl = repoUrl.replace(':', '/').replace('git@', 'https://');
    }

    return `${repoUrl}/releases/download/${tagName}/${encodeURIComponent(fileName)}`;
}

/**
 * Pure: the version fields sent to the Pano store. The store tag is always
 * `v<version>`, even when the git tag is prefixed (monorepo: `stripe-v1.2.0`).
 * The git tag is only used for the GitHub asset URL.
 */
function buildVersionFields({ version, gitTag, notes, panoVersion }) {
    return {
        title: `v${version}`,
        changelog: notes || '',
        tag: `v${version}`,
        panoVersion,
        gitTag: gitTag || `v${version}`
    };
}

async function verifyConditions(pluginConfig, context) {
    const { env, logger } = context;
    const configs = getActiveConfigs(pluginConfig, context);
    const errors = [];

    if (configs.length === 0 && logger) {
        const branch = currentBranchName(context) || '(unknown)';
        logger.log(`No semantic-release-pano configs match branch "${branch}"; skipping.`);
    }

    for (const config of configs) {
        const { resourceId, file, panoVersion, tokenVar, useGitHubLink, repositoryUrl } = config;
        const panoToken = tokenVar ? env[tokenVar] : env.PANO_TOKEN;

        if (!panoToken) {
            errors.push(`PANO_TOKEN environment variable is required${tokenVar ? ` (checked ${tokenVar})` : ''}.`);
        }

        if (!resourceId) {
            errors.push('resourceId configuration is required.');
        }

        if (!file) {
            errors.push('file configuration is required.');
        }

        if (!panoVersion) {
            errors.push('panoVersion configuration is required (e.g. "1.0.0").');
        }

        if (useGitHubLink && !repositoryUrl) {
            errors.push('repositoryUrl is required when useGitHubLink is true.');
        }
    }

    if (errors.length > 0) {
        throw new AggregateError(errors.map(msg => new SemanticReleaseError(msg, 'EINVALIDCONFIG')));
    }
}

async function publish(pluginConfig, context) {
    const { env, nextRelease, logger } = context;
    const configs = getActiveConfigs(pluginConfig, context);
    const results = [];

    if (configs.length === 0) {
        const branch = currentBranchName(context) || '(unknown)';
        logger.log(`No semantic-release-pano configs match branch "${branch}"; nothing to publish.`);
        return undefined;
    }

    for (const config of configs) {
        const { resourceId, file, panoUrl, panoVersion, tokenVar, useGitHubLink, repositoryUrl, maxChangelogLength } = config;
        const panoToken = tokenVar ? env[tokenVar] : env.PANO_TOKEN;
        const apiUrl = panoUrl || DEFAULT_PANO_URL;

        const version = nextRelease.version;
        const tagName = nextRelease.gitTag || `v${version}`;
        const rawNotes = nextRelease.notes || '';
        const notes = truncateChangelog(rawNotes, maxChangelogLength);
        if (notes.length < rawNotes.length) {
            logger.log(`Changelog truncated from ${rawNotes.length} to ${notes.length} chars (maxChangelogLength=${maxChangelogLength ?? DEFAULT_MAX_CHANGELOG_LENGTH}).`);
        }

        const fields = buildVersionFields({ version, gitTag: tagName, notes, panoVersion });
        const storeTag = fields.tag;

        // Resolve file path with version substitution
        const resolvedFile = file.replace(/\${version}/g, version);
        const filePath = path.resolve(resolvedFile);

        if (!(await fs.pathExists(filePath))) {
            throw new SemanticReleaseError(`File ${filePath} not found.`, 'ENOFILE');
        }

        const fileHash = await computeFileHash(filePath);
        const fileName = path.basename(filePath);

        logger.log(`Publishing version ${version} (tag: ${tagName}) to Pano Resource System...`);
        logger.log(`API URL: ${apiUrl}`);
        logger.log(`Resource ID: ${resourceId}`);
        logger.log(`File: ${filePath}`);
        logger.log(`SHA-256: ${fileHash}`);

        if (useGitHubLink) {
            // Link mode: send GitHub Release asset URL + hash instead of uploading the file
            const assetUrl = buildGitHubAssetUrl(repositoryUrl, tagName, fileName);
            logger.log(`Mode: GitHub Link`);
            logger.log(`Asset URL: ${assetUrl}`);

            try {
                await withTransientRetry(logger, async () => {
                    const formData = new FormData();
                    formData.append('title', fields.title);
                    formData.append('changelog', fields.changelog);
                    formData.append('tag', storeTag);
                    formData.append('panoVersion', fields.panoVersion);
                    formData.append('url', assetUrl);
                    formData.append('hash', fileHash);

                    const response = await axios.post(`${apiUrl}/v1/resources/${resourceId}/versions`, formData, {
                        headers: {
                            ...formData.getHeaders(),
                            'Authorization': `Bearer ${panoToken}`
                        }
                    });

                    logger.log(`Successfully published version ${version} to Pano (GitHub link mode)!`);
                    logger.log(`Response: ${JSON.stringify(response.data)}`);
                });

                results.push({
                    name: `Pano Resource Release ${version}`,
                    url: `${apiUrl}/resources/${resourceId}`
                });
            } catch (error) {
                handleError(error, logger);
            }
        } else {
            // Upload mode: direct-to-storage flow first, multipart body upload as fallback
            logger.log(`Mode: File Upload`);

            try {
                await withTransientRetry(logger, async () => {
                    const direct = await tryDirectUpload({ apiUrl, resourceId, panoToken, fields, filePath, fileName, fileHash, logger });

                    if (direct.used) {
                        logger.log(`Successfully published version ${version} to Pano (direct upload)!`);
                    } else {
                        logger.log(`Upload path: multipart body (${direct.reason}).`);

                        const formData = new FormData();
                        formData.append('title', fields.title);
                        formData.append('changelog', fields.changelog);
                        formData.append('tag', storeTag);
                        formData.append('panoVersion', fields.panoVersion);
                        formData.append('file', fs.createReadStream(filePath));

                        const response = await axios.post(`${apiUrl}/v1/resources/${resourceId}/versions`, formData, {
                            headers: {
                                ...formData.getHeaders(),
                                'Authorization': `Bearer ${panoToken}`
                            },
                            maxContentLength: Infinity,
                            maxBodyLength: Infinity
                        });

                        logger.log(`Successfully published version ${version} to Pano (upload mode)!`);
                        logger.log(`Response: ${JSON.stringify(response.data)}`);
                    }
                });

                results.push({
                    name: `Pano Resource Release ${version}`,
                    url: `${apiUrl}/resources/${resourceId}`
                });
            } catch (error) {
                handleError(error, logger);
            }
        }
    }

    return results.length > 0 ? results[0] : undefined;
}

const DIRECT_COMPLETE_MAX_WAIT_MS = 120000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The store can be away for a moment (restart, deploy): no answer, a gateway status, or the reverse proxy's own
// "404 page not found" while no backend is up. Such a publish is repeated; every other answer is final.
const TRANSIENT_RETRY_WAITS_MS = [15000, 30000, 60000, 60000];

function isTransientFailure(error) {
    if (error instanceof SemanticReleaseError) return false;
    if (!error.response) return true;
    const { status, data } = error.response;
    return status === 502 || status === 503 || status === 504 || (status === 404 && typeof data === 'string' && data.trim() === '404 page not found');
}

// 429 with a short retryAfter (seconds) is the store pacing requests: wait that long and repeat. A long one (the upload
// ticket limit asks for up to half an hour) is not waited out here.
const MAX_RATE_LIMIT_WAIT_SECONDS = 120;

function rateLimitWaitMs(error) {
    const res = error && error.response;
    if (!res || res.status !== 429) return null;
    const seconds = Number(res.data && res.data.retryAfter);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_RATE_LIMIT_WAIT_SECONDS) return null;
    return (seconds + 1) * 1000;
}

async function withTransientRetry(logger, attempt, waits = TRANSIENT_RETRY_WAITS_MS) {
    for (let i = 0; ; i++) {
        try {
            return await attempt();
        } catch (error) {
            // a repeated publish that answers 409: the lost first attempt did reach the store
            if (i > 0 && error.response && error.response.status === 409) {
                logger.log('The store already has this version (the earlier attempt went through).');
                return undefined;
            }
            if (i >= waits.length) throw error;
            const paced = rateLimitWaitMs(error);
            if (paced === null && !isTransientFailure(error)) throw error;
            const wait = paced === null ? waits[i] : paced;
            logger.log(`Pano store ${paced === null ? 'did not answer' : 'asked to slow down'} (${describeFailure(error)}); retry ${i + 1}/${waits.length} in ${Math.ceil(wait / 1000)}s.`);
            await sleep(wait);
        }
    }
}

// Fallback rule: use the multipart body route ONLY when the ticket request says the
// back-end has no direct upload: 404 (older back-end without the route) or 501 with
// error DIRECT_UPLOAD_UNAVAILABLE (storage not configured / disabled / probe failed).
// It is also used when the account has no free ticket left: 429 with reason
// UPLOAD_PENDING_LIMIT (a release that publishes many resources in one run needs more
// tickets than the store hands out in a ticket lifetime; the body route has its own limits).
// Every other ticket answer (401/403 permission, 400 bad tag, 409 version exists,
// 413 too large, 5xx ...) is a real refusal and fails the release. Once a ticket was
// issued we never fall back: a failed PUT or complete aborts the ticket and fails.
function isDirectUploadUnavailable(error) {
    const res = error && error.response;
    if (!res) return false;
    if (res.status === 404) return !isTransientFailure(error);
    if (res.status === 429) return Boolean(res.data) && res.data.reason === 'UPLOAD_PENDING_LIMIT';
    return res.status === 501 && res.data && res.data.error === 'DIRECT_UPLOAD_UNAVAILABLE';
}

function describeFailure(error) {
    if (error && error.response) {
        const code = error.response.data && error.response.data.error;
        return `HTTP ${error.response.status}${code ? ` ${code}` : ''}`;
    }
    return (error && error.message) || 'unknown error';
}

async function tryDirectUpload({ apiUrl, resourceId, panoToken, fields, filePath, fileName, fileHash, logger }) {
    const base = `${apiUrl}/v1/resources/${resourceId}/versions/uploads`;
    const auth = { Authorization: `Bearer ${panoToken}` };
    const size = (await fs.stat(filePath)).size;

    let ticket;
    try {
        const response = await axios.post(base, {
            fileName,
            size,
            sha256: fileHash,
            title: fields.title,
            changelog: fields.changelog,
            tag: fields.tag,
            panoVersion: fields.panoVersion
        }, { headers: auth });
        ticket = response.data && response.data.data;
    } catch (error) {
        if (isDirectUploadUnavailable(error)) {
            return { used: false, reason: `direct upload not offered: ${describeFailure(error)}` };
        }
        throw error;
    }

    if (!ticket || !ticket.uploadId || !ticket.upload || !ticket.upload.url) {
        return { used: false, reason: 'direct upload ticket malformed' };
    }

    logger.log('Upload path: direct to storage (presigned PUT).');
    const uploadId = encodeURIComponent(ticket.uploadId);
    const abort = async () => {
        try {
            await axios.delete(`${base}/${uploadId}`, { headers: auth });
        } catch (e) {
            logger.error(`Abort of upload ${ticket.uploadId} failed (${describeFailure(e)}); the ticket will expire by itself.`);
        }
    };

    try {
        // Send exactly the headers the ticket lists (they are part of the signature).
        const putHeaders = { ...(ticket.upload.headers || {}) };
        if (!Object.keys(putHeaders).some((h) => h.toLowerCase() === 'content-length')) {
            putHeaders['Content-Length'] = String(size);
        }
        try {
            await axios.put(ticket.upload.url, fs.createReadStream(filePath), {
                headers: putHeaders,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                maxRedirects: 0
            });
        } catch (error) {
            throw new Error(`Storage upload failed (${describeFailure(error)})`);
        }

        const deadline = Date.now() + DIRECT_COMPLETE_MAX_WAIT_MS;
        for (;;) {
            let response;
            try {
                response = await axios.post(`${base}/${uploadId}/complete`, undefined, { headers: auth });
            } catch (error) {
                const status = error.response && error.response.status;
                // 409 UPLOAD_NOT_FOUND (object not visible yet) and 429 UPLOAD_BUSY are not terminal.
                if ((status === 409 || status === 429) && Date.now() < deadline) {
                    const wait = Number(error.response.data && error.response.data.retryAfter);
                    await sleep(Number.isFinite(wait) ? Math.min(wait, 10) * 1000 : 1000);
                    continue;
                }
                throw new Error(`Completing the upload failed (${describeFailure(error)})`);
            }
            const data = (response.data && response.data.data) || response.data || {};
            if (response.status === 202 || data.status === 'COMPLETING') {
                if (Date.now() >= deadline) throw new Error('Completing the upload timed out');
                const wait = Number(data.retryAfter);
                await sleep(Number.isFinite(wait) ? Math.min(wait, 10) * 1000 : 1000);
                continue;
            }
            return { used: true, versionId: data.id };
        }
    } catch (error) {
        await abort();
        logger.error(error.message);
        throw new SemanticReleaseError(`Direct upload failed after a ticket was issued: ${error.message}`, 'EPANOUPLOAD');
    }
}

function handleError(error, logger) {
    logger.error('Failed to publish to Pano.');
    if (error instanceof SemanticReleaseError) throw error;
    if (error.response) {
        logger.error(`Status: ${error.response.status}`);
        logger.error(`Data: ${JSON.stringify(error.response.data)}`);
        throw new SemanticReleaseError(
            `Pano API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
            'EPANOAPI',
            JSON.stringify(error.response.data)
        );
    } else {
        logger.error(error.message);
        throw new SemanticReleaseError(error.message, 'ENETWORK');
    }
}

module.exports = {
    verifyConditions,
    publish,
    buildVersionFields,
    buildGitHubAssetUrl,
    isTransientFailure,
    rateLimitWaitMs,
    withTransientRetry
};
