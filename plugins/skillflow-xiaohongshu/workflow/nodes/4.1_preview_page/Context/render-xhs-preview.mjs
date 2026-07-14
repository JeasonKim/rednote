import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_BLOCK_PATTERN = /(\s*)\/\/ XHS_PREVIEW_DATA_START[\s\S]*?\/\/ XHS_PREVIEW_DATA_END/;

export function assertPreviewData(data) {
  const requiredTextFields = ["accountName", "title", "body", "commentGuide"];
  for (const field of requiredTextFields) {
    if (typeof data[field] !== "string" || data[field].trim() === "") {
      throw new Error(`Invalid preview data: ${field} must be a non-empty string.`);
    }
  }

  if (!Array.isArray(data.tags) || data.tags.length === 0 || data.tags.some((tag) => typeof tag !== "string" || tag.trim() === "")) {
    throw new Error("Invalid preview data: tags must be a non-empty string array.");
  }

  if (!Array.isArray(data.images) || data.images.length === 0) {
    throw new Error("Invalid preview data: images must be a non-empty array.");
  }

  for (const [index, image] of data.images.entries()) {
    if (!image || typeof image.src !== "string" || image.src.trim() === "") {
      throw new Error(`Invalid preview data: images[${index}].src must be a non-empty string.`);
    }
    if (image.alt !== undefined && typeof image.alt !== "string") {
      throw new Error(`Invalid preview data: images[${index}].alt must be a string when provided.`);
    }
  }
}

export function renderPreviewHtml(templateHtml, previewData) {
  assertPreviewData(previewData);

  if (!DATA_BLOCK_PATTERN.test(templateHtml)) {
    throw new Error("Template is missing XHS_PREVIEW_DATA markers.");
  }

  const serializedData = JSON.stringify(previewData, null, 6)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  return templateHtml.replace(DATA_BLOCK_PATTERN, (_, indent) => `${indent}// XHS_PREVIEW_DATA_START
${indent}window.XHS_PREVIEW_DATA = ${serializedData};
${indent}// XHS_PREVIEW_DATA_END`);
}

export function renderPreviewFile({ dataPath, templatePath, outputPath }) {
  const previewData = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const templateHtml = fs.readFileSync(templatePath, "utf8");
  const renderedHtml = renderPreviewHtml(templateHtml, previewData);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, renderedHtml);
  return outputPath;
}

function printUsage() {
  console.log("Usage: node render-xhs-preview.mjs --data data.json --template xhs-preview-template.html --out xhs-preview.html");
}

function parseCliArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid argument near "${key ?? ""}".`);
    }
    args.set(key.slice(2), value);
  }
  return args;
}

function runCli() {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const dataPath = args.get("data");
    const templatePath = args.get("template");
    const outputPath = args.get("out");

    if (!dataPath || !templatePath || !outputPath) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    renderPreviewFile({ dataPath, templatePath, outputPath });
    console.log(`Rendered preview: ${outputPath}`);
  } catch (error) {
    console.warn("[xhs-preview-render] render failed.", error);
    printUsage();
    process.exitCode = 1;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runCli();
}
