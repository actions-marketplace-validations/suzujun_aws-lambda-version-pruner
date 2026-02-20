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

function parseFunctionNamesInput() {
  const raw = core.getInput("function-name", { required: true });
  const functionNames = raw
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (functionNames.length === 0) {
    throw new Error(
      'Input "function-name" must contain at least one Lambda function name.',
    );
  }

  return [...new Set(functionNames)];
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

async function pruneFunctionVersions({
  client,
  functionName,
  keepLatest,
  olderThanThresholdMillis,
  deleteAliasedVersions,
  dryRun,
}) {
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
          functionName,
          version,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    publishedCount: publishedVersions.length,
    selected,
    deleted,
    failures,
  };
}

async function run() {
  const functionNames = parseFunctionNamesInput();
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
  const olderThanThresholdMillis =
    olderThanDays !== undefined
      ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000
      : undefined;

  const selected = [];
  const deleted = [];
  const failures = [];
  let totalVersions = 0;

  core.info(`Functions: ${functionNames.join(", ")}`);
  core.info(`Region: ${region}`);
  core.info(`dry-run: ${dryRun}`);
  core.info(`delete-aliased-versions: ${deleteAliasedVersions}`);
  for (const functionName of functionNames) {
    const result = await pruneFunctionVersions({
      client,
      functionName,
      keepLatest,
      olderThanThresholdMillis,
      deleteAliasedVersions,
      dryRun,
    });

    totalVersions += result.publishedCount;
    for (const version of result.selected) {
      selected.push({ functionName, version });
    }
    for (const version of result.deleted) {
      deleted.push({ functionName, version });
    }
    failures.push(...result.failures);

    core.info(`[${functionName}] total published versions: ${result.publishedCount}`);
    core.info(`[${functionName}] selected candidates: ${result.selected.length}`);
    core.info(`[${functionName}] selected versions: ${JSON.stringify(result.selected)}`);
  }

  core.setOutput("total-versions", String(totalVersions));
  core.setOutput("selected-count", String(selected.length));
  core.setOutput("deleted-count", String(deleted.length));
  core.setOutput("selected-versions", JSON.stringify(selected));
  core.setOutput("deleted-versions", JSON.stringify(deleted));

  await core.summary
    .addHeading("AWS Lambda Version Pruner")
    .addRaw(`Functions: ${functionNames.join(", ")}\n`, true)
    .addRaw(`Region: ${region}\n`, true)
    .addRaw(`Dry run: ${dryRun}\n`, true)
    .addRaw(`Total versions: ${totalVersions}\n`, true)
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
