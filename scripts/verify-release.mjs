import { readFile } from "node:fs/promises";
import process from "node:process";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function readJson(fileName) {
  try {
    return JSON.parse(await readFile(fileName, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("无法读取 " + fileName + "：" + message);
  }
}

function readTagArgument(argv) {
  let tag = process.env.RELEASE_TAG?.trim() || "";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tag") {
      const value = argv[index + 1]?.trim();
      if (!value) throw new Error("--tag 后必须提供版本号");
      tag = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--tag=")) {
      tag = argument.slice("--tag=".length).trim();
      if (!tag) throw new Error("--tag 后必须提供版本号");
      continue;
    }
    throw new Error("未知参数：" + argument);
  }

  return tag;
}

async function verify() {
  const [manifest, packageJson, packageLock, versions] = await Promise.all([
    readJson("manifest.json"),
    readJson("package.json"),
    readJson("package-lock.json"),
    readJson("versions.json"),
  ]);
  const tag = readTagArgument(process.argv.slice(2));
  const expected = manifest.version;
  const versionLocations = [
    ["manifest.json", manifest.version],
    ["package.json", packageJson.version],
    ["package-lock.json", packageLock.version],
    ['package-lock.json packages[""]', packageLock.packages?.[""]?.version],
  ];
  const errors = [];

  if (typeof expected !== "string" || !STABLE_VERSION.test(expected)) {
    errors.push(
      "manifest.json version 必须是 x.y.z 格式，当前为 " + JSON.stringify(expected),
    );
  }

  for (const [location, version] of versionLocations) {
    if (version !== expected) {
      errors.push(
        location +
          " version " +
          JSON.stringify(version) +
          " 与 manifest.json " +
          JSON.stringify(expected) +
          " 不一致",
      );
    }
  }

  if (!Object.prototype.hasOwnProperty.call(versions, expected)) {
    errors.push("versions.json 缺少版本 " + JSON.stringify(expected));
  } else if (versions[expected] !== manifest.minAppVersion) {
    errors.push(
      "versions.json 的最低 Obsidian 版本 " +
        JSON.stringify(versions[expected]) +
        " 与 manifest.json minAppVersion " +
        JSON.stringify(manifest.minAppVersion) +
        " 不一致",
    );
  }

  if (tag) {
    if (!STABLE_VERSION.test(tag)) {
      errors.push(
        "发布标签必须是 x.y.z 格式且不能带 v 前缀，当前为 " + JSON.stringify(tag),
      );
    }
    if (tag !== expected) {
      errors.push(
        "发布标签 " +
          JSON.stringify(tag) +
          " 与 manifest.json " +
          JSON.stringify(expected) +
          " 不一致",
      );
    }
  }

  if (errors.length > 0) {
    throw new Error("发布版本校验失败：\n- " + errors.join("\n- "));
  }

  const locations = tag
    ? "tag、manifest、package、package-lock 和 versions"
    : "manifest、package、package-lock 和 versions";
  console.log("PASS: " + locations + " 均为 " + expected);
}

verify().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
