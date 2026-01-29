const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const SemanticReleaseError = require('@semantic-release/error');

const DEFAULT_PANO_URL = 'https://api.panomc.com';

async function verifyConditions(pluginConfig, context) {
    const { env } = context;
    const { resourceId, file, panoVersion } = pluginConfig;
    const panoToken = env.PANO_TOKEN;

    const errors = [];

    if (!panoToken) {
        errors.push('PANO_TOKEN environment variable is required.');
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

    if (errors.length > 0) {
        throw new AggregateError(errors.map(msg => new SemanticReleaseError(msg, 'EINVALIDCONFIG')));
    }
}

async function publish(pluginConfig, context) {
    const { env, nextRelease, logger } = context;
    const { resourceId, file, panoUrl, panoVersion } = pluginConfig;
    const panoToken = env.PANO_TOKEN;
    const url = panoUrl || DEFAULT_PANO_URL;

    const version = nextRelease.version;
    const tagName = nextRelease.gitTag || `v${version}`;
    const notes = nextRelease.notes || '';

    // Resolve file path with version substitution
    const resolvedFile = file.replace(/\${version}/g, version);
    const filePath = path.resolve(resolvedFile);

    if (!(await fs.pathExists(filePath))) {
        throw new SemanticReleaseError(`File ${filePath} not found.`, 'ENOFILE');
    }

    logger.log(`Publishing version ${version} (tag: ${tagName}) to Pano Resource System...`);
    logger.log(`URL: ${url}`);
    logger.log(`Resource ID: ${resourceId}`);
    logger.log(`File: ${filePath}`);

    const formData = new FormData();
    formData.append('title', `v${version}`);
    formData.append('changelog', notes);
    formData.append('tag', tagName);
    formData.append('panoVersion', panoVersion);
    formData.append('file', fs.createReadStream(filePath));

    try {
        const response = await axios.post(`${url}/v1/resources/${resourceId}/versions`, formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${panoToken}`
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        logger.log(`Successfully published version ${version} to Pano!`);
        logger.log(`Response: ${JSON.stringify(response.data)}`);

        return {
            name: `Pano Resource Release ${version}`,
            url: `${url}/resources/${resourceId}` // Assuming this is the public URL, though api url might differ from frontend.
        };
    } catch (error) {
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
}

module.exports = {
    verifyConditions,
    publish
};
