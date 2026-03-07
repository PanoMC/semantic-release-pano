const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const SemanticReleaseError = require('@semantic-release/error');

const DEFAULT_PANO_URL = 'https://api.panomc.com';

function getConfigs(pluginConfig) {
    if (Array.isArray(pluginConfig.configs)) {
        return pluginConfig.configs.map(config => {
            const { configs, ...baseConfig } = pluginConfig;
            return {
                ...baseConfig,
                ...config
            };
        });
    }
    return [pluginConfig];
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

async function verifyConditions(pluginConfig, context) {
    const { env } = context;
    const configs = getConfigs(pluginConfig);
    const errors = [];

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
    const configs = getConfigs(pluginConfig);
    const results = [];

    for (const config of configs) {
        const { resourceId, file, panoUrl, panoVersion, tokenVar, useGitHubLink, repositoryUrl } = config;
        const panoToken = tokenVar ? env[tokenVar] : env.PANO_TOKEN;
        const apiUrl = panoUrl || DEFAULT_PANO_URL;

        const version = nextRelease.version;
        const tagName = nextRelease.gitTag || `v${version}`;
        const notes = nextRelease.notes || '';

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

            const formData = new FormData();
            formData.append('title', `v${version}`);
            formData.append('changelog', notes);
            formData.append('tag', tagName);
            formData.append('panoVersion', panoVersion);
            formData.append('url', assetUrl);
            formData.append('hash', fileHash);

            try {
                const response = await axios.post(`${apiUrl}/v1/resources/${resourceId}/versions`, formData, {
                    headers: {
                        ...formData.getHeaders(),
                        'Authorization': `Bearer ${panoToken}`
                    }
                });

                logger.log(`Successfully published version ${version} to Pano (GitHub link mode)!`);
                logger.log(`Response: ${JSON.stringify(response.data)}`);

                results.push({
                    name: `Pano Resource Release ${version}`,
                    url: `${apiUrl}/resources/${resourceId}`
                });
            } catch (error) {
                handleError(error, logger);
            }
        } else {
            // Upload mode: upload file directly (original behavior)
            logger.log(`Mode: File Upload`);

            const formData = new FormData();
            formData.append('title', `v${version}`);
            formData.append('changelog', notes);
            formData.append('tag', tagName);
            formData.append('panoVersion', panoVersion);
            formData.append('file', fs.createReadStream(filePath));

            try {
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

function handleError(error, logger) {
    logger.error('Failed to publish to Pano.');
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
    publish
};
