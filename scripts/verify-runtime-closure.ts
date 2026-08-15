/**
 * Verify that a deploy-root manifest supplies every required workspace
 * peer in its dependency graph. With auto peer installation disabled, a missing
 * root peer can otherwise fail only when Cordis loads the packaged plugin.
 */
import { globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface WorkspacePackage {
  path: string
  manifest: PackageManifest
}

const root = resolve(import.meta.dirname, '..')
const DEFAULT_MANIFESTS = [
  'python/sdk-runtime/package.json',
  'desktop/runtime-root/package.json',
] as const
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { manifest: { type: 'string', multiple: true } },
})
const manifests = values.manifest !== undefined && values.manifest.length > 0
  ? values.manifest
  : [...DEFAULT_MANIFESTS]
const workspace = await loadWorkspacePackages()
let failed = false
for (const relative of manifests) {
  if (!await verifyManifest(relative, workspace)) failed = true
}
if (failed) process.exit(1)

async function verifyManifest(
  relative: string,
  packages: Map<string, WorkspacePackage>,
): Promise<boolean> {
  const runtimeManifestPath = resolve(root, relative)
  const runtimeManifest = await loadManifest(runtimeManifestPath)
  const runtimeName = runtimeManifest.name ?? relative
  const runtimeDependencies = runtimeManifest.dependencies ?? {}
  const parents = new Map<string, string | undefined>()
  const queue: string[] = []

  for (const dependency of Object.keys(runtimeDependencies).sort()) {
    if (!packages.has(dependency)) continue
    parents.set(dependency, undefined)
    queue.push(dependency)
  }

  const failures: string[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const packageName = queue[index]
    if (packageName === undefined) continue
    const current = packages.get(packageName)
    if (current === undefined) continue
    const peers = current.manifest.peerDependencies ?? {}
    const peerMeta = current.manifest.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(peers).sort()) {
      if (!packages.has(peer) || peerMeta[peer]?.optional === true) continue
      if (runtimeDependencies[peer]?.startsWith('workspace:') === true) continue
      failures.push(`${formatChain(runtimeName, packageName, parents)} -> ${peer}`)
    }
    const dependencies = {
      ...current.manifest.dependencies,
      ...current.manifest.optionalDependencies,
    }
    for (const dependency of Object.keys(dependencies).sort()) {
      if (!packages.has(dependency) || parents.has(dependency)) continue
      parents.set(dependency, packageName)
      queue.push(dependency)
    }
  }

  if (failures.length > 0) {
    console.error(`verify-runtime-closure: required workspace peers are missing from ${relative} dependencies:`)
    for (const failure of failures) console.error(`  ${failure}`)
    return false
  }

  console.log(`verify-runtime-closure: ${runtimeName}: ${queue.length} workspace packages form a closed runtime dependency graph.`)
  return true
}

async function loadWorkspacePackages(): Promise<Map<string, WorkspacePackage>> {
  const paths = globSync(
    ['packages/*/*/package.json', 'vendor/*/package.json', 'apps/*/package.json'],
    { cwd: root },
  )
    .sort()
    .map(relative => resolve(root, relative))
  const result = new Map<string, WorkspacePackage>()
  for (const path of paths) {
    const manifest = await loadManifest(path)
    if (manifest.name !== undefined) result.set(manifest.name, { path, manifest })
  }
  return result
}

async function loadManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest
}

function formatChain(
  runtimeName: string,
  packageName: string,
  parents: ReadonlyMap<string, string | undefined>,
): string {
  const chain = [packageName]
  let parent = parents.get(packageName)
  while (parent !== undefined) {
    chain.unshift(parent)
    parent = parents.get(parent)
  }
  return [runtimeName, ...chain].join(' -> ')
}
