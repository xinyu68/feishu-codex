import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const ARTIFACT_TOOL_NAME = 'send_artifact_to_feishu';
export const MAX_ARTIFACTS = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export async function validateArtifactPaths(value: unknown): Promise<string[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ARTIFACTS) throw new Error(`paths must contain 1-${MAX_ARTIFACTS} files`);
  const resolved: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim() || /[*?]/.test(entry)) throw new Error('each path must be an absolute file path without wildcards');
    const candidate = entry.trim();
    if (!path.isAbsolute(candidate)) throw new Error('each path must be absolute');
    const linkInfo = await lstat(candidate).catch(() => undefined);
    if (!linkInfo?.isFile() || linkInfo.isSymbolicLink()) throw new Error(`not a regular file: ${path.basename(candidate) || candidate}`);
    const canonical = await realpath(candidate);
    const info = await stat(canonical);
    const limit = IMAGE_EXTENSIONS.has(path.extname(canonical).toLowerCase()) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (info.size <= 0) throw new Error(`file is empty: ${path.basename(canonical)}`);
    if (info.size > limit) throw new Error(`${path.basename(canonical)} exceeds the ${limit / 1024 / 1024} MB limit`);
    resolved.push(canonical);
  }
  return [...new Set(resolved)];
}
