# semantic-release-pano

**semantic-release** plugin to publish resources (plugins/themes) to the Pano Resource System.

## Install

```bash
npm install semantic-release-pano -D
```

## Usage

The plugin can be configured in the **semantic-release** configuration file:

```json
{
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["semantic-release-pano", {
      "resourceId": "YOUR_RESOURCE_UUID",
      "file": "dist/my-plugin.jar",
      "panoVersion": "1.0.0",
      "panoUrl": "https://api.panomc.com"
    }]
  ]
}
```

## Configuration

| Option | Type | Default | Description |
|__ | __ | __ | __|
| `resourceId` | `String` | **Required** | The UUID of the Pano resource to update. |
| `file` | `String` | **Required** | Path to the file to upload (e.g. `.jar` or `.zip`). |
| `panoVersion` | `String` | **Required** | The target Pano version this release is compatible with. |
| `panoUrl` | `String` | `https://api.panomc.com` | Base URL of the Pano API. |

## Environment Variables

| Variable | Description |
|__ | __|
| `PANO_TOKEN` | **Required**. The API token for authentication. |
