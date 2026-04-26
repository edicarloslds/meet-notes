import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = join(root, 'native', 'apple-speech-helper')
const outputPath = join(root, 'resources', 'bin', 'apple-speech-helper')

if (process.platform !== 'darwin') {
  console.log('Skipping Apple Speech helper build: macOS only.')
  process.exit(0)
}

const build = spawnSync(
  'swift',
  ['build', '-c', 'release', '--package-path', packagePath],
  { stdio: 'inherit' }
)

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

const binaryPath = join(packagePath, '.build', 'release', 'apple-speech-helper')
if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
  console.error(`Apple Speech helper binary not found at ${binaryPath}`)
  process.exit(1)
}

mkdirSync(dirname(outputPath), { recursive: true })
copyFileSync(binaryPath, outputPath)
console.log(`Apple Speech helper copied to ${outputPath}`)
