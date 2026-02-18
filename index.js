"use strict";

const core = require("@actions/core");
const {
  LambdaClient,
  ListVersionsByFunctionCommand,
  ListAliasesCommand,
  DeleteFunctionCommand,
} = require("@aws-sdk/client-lambda");

function parseBooleanInput(name, defaultValue) {
  const raw = core.getInput(name);
  if (!raw) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new Error(`Input "${name}" must be "true" or "false".`);
}

function parseIntegerInput(name, options = {}) {
  const raw = core.getInput(name);
  if (!raw) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) {
    throw new Error(`Input "${name}" must be an integer.`);
  }

  if (options.min !== undefined && value < options.min) {
    throw new Error(`Input "${name}" must be >= ${options.min}.`);
  }

  return value;
}

async function listAllVersions(client, functionName) {
  const versions = [];
  let marker;

  do {
    const response = await client.send(
      new ListVersionsByFunctionCommand({
        FunctionName: functionName,
        Marker: marker,
      }),
    );

    versions.push(...(response.Versions || []));
    marker = response.NextMarker;
  } while (marker);

  return versions;
}

async function listAliasedVersions(client, functionName) {
  const aliased = new Set();
  let marker;

  do {
    const response = await client.send(
      new ListAliasesCommand({
        FunctionName: functionName,
        Marker: marker,
      }),
    );

    for (const alias of response.Aliases || []) {
      if (alias.FunctionVersion && alias.FunctionVersion !== "$LATEST") {
        aliased.add(alias.FunctionVersion);
      }
    }

    marker = response.NextMarker;
  } while (marker);

  return aliased;
}

function toEpochMillis(lastModified) {
  const epoch = Date.parse(lastModified);
  if (Number.isNaN(epoch)) {
    throw new Error(`Failed to parse LastModified: ${lastModified}`);
  }
  return epoch;
}

async function run() {
  const functionName = core.getInput("function-name", { required: true });
  const region = core.getInput("aws-region", { required: true });
  const keepLatest = parseIntegerInput("keep-latest", { min: 0 });
  const olderThanDays = parseIntegerInput("older-than-days", { min: 1 });
  const dryRun = parseBooleanInput("dry-run", false);
  const deleteAliasedVersions = parseBooleanInput(
    "delete-aliased-versions",
    false,
  );

  if (keepLatest === undefined && olderThanDays === undefined) {
    throw new Error(
      'At least one of "keep-latest" or "older-than-days" must be specified.',
    );
  }

  const client = new LambdaClient({ region });
  const allVersions = await listAllVersions(client, functionName);
  const publishedVersions = allVersions
    .filter((version) => version.Version && version.Version !== "$LATEST")
    .map((version) => ({
      version: version.Version,
      versionNumber: Number.parseInt(version.Version, 10),
      lastModified: version.LastModified,
    }))
    .filter(
      (version) =>
        Number.isInteger(version.versionNumber) && !!version.lastModified,
    )
    .sort((a, b) => b.versionNumber - a.versionNumber);

  const keepSet = new Set();
  if (keepLatest !== undefined) {
    for (let i = 0; i < Math.min(keepLatest, publishedVersions.length); i += 1) {
      keepSet.add(publishedVersions[i].version);
    }
  }

  const olderThanThresholdMillis =
    olderThanDays !== undefined
      ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000
      : undefined;

  const aliasedVersions = deleteAliasedVersions
    ? new Set()
    : await listAliasedVersions(client, functionName);

  const selected = [];
  for (const version of publishedVersions) {
    const byCount =
      keepLatest !== undefined ? !keepSet.has(version.version) : false;
    const byAge =
      olderThanThresholdMillis !== undefined
        ? toEpochMillis(version.lastModified) < olderThanThresholdMillis
        : false;
    const selectedByRule = byCount || byAge;
    const excludedByAlias =
      !deleteAliasedVersions && aliasedVersions.has(version.version);

    if (selectedByRule && !excludedByAlias) {
      selected.push(version.version);
    }
  }

  const deleted = [];
  const failures = [];

  core.info(`Function: ${functionName}`);
  core.info(`Region: ${region}`);
  core.info(`dry-run: ${dryRun}`);
  core.info(`delete-aliased-versions: ${deleteAliasedVersions}`);
  core.info(`total published versions: ${publishedVersions.length}`);
  core.info(`selected candidates: ${selected.length}`);
  core.info(`selected versions: ${JSON.stringify(selected)}`);

  if (!dryRun) {
    for (const version of selected) {
      try {
        await client.send(
          new DeleteFunctionCommand({
            FunctionName: functionName,
            Qualifier: version,
          }),
        );
        deleted.push(version);
      } catch (error) {
        failures.push({
          version,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  core.setOutput("total-versions", String(publishedVersions.length));
  core.setOutput("selected-count", String(selected.length));
  core.setOutput("deleted-count", String(deleted.length));
  core.setOutput("selected-versions", JSON.stringify(selected));
  core.setOutput("deleted-versions", JSON.stringify(deleted));

  await core.summary
    .addHeading("AWS Lambda Version Pruner")
    .addRaw(`Function: ${functionName}\n`, true)
    .addRaw(`Region: ${region}\n`, true)
    .addRaw(`Dry run: ${dryRun}\n`, true)
    .addRaw(`Total versions: ${publishedVersions.length}\n`, true)
    .addRaw(`Selected candidates: ${selected.length}\n`, true)
    .addRaw(`Deleted: ${deleted.length}\n`, true)
    .write();

  if (failures.length > 0) {
    core.setFailed(
      `Failed to delete ${failures.length} version(s): ${JSON.stringify(failures)}`,
    );
  }
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
