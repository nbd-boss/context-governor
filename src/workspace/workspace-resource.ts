import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/** Resolve one real file while preventing a path from escaping the task workspace. */
export async function resolveWorkspaceFile(rootDirectory: string, filePath: string, label: string): Promise<string> {
  if (!isAbsolute(filePath)) throw new Error(`${label} path must be absolute`)
  const [root, path] = await Promise.all([realpath(rootDirectory), realpath(filePath)])
  const inside = relative(root, path)
  if (inside !== '' && (inside.startsWith('..') || isAbsolute(inside))) {
    throw new Error(`${label} must stay inside the allowed workspace: ${resolve(rootDirectory)}`)
  }
  if (!(await stat(path)).isFile()) throw new Error(`${label} must identify a file`)
  return path
}
