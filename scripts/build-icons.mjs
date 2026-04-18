import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import png2icons from 'png2icons'

const ROOT = resolve(process.cwd(), 'resources')

async function renderPng(svgPath, size) {
  const svg = await readFile(svgPath)
  return sharp(svg, { density: 512 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
}

async function main() {
  const trayTemplate1x = await renderPng(resolve(ROOT, 'tray-template.svg'), 22)
  const trayTemplate2x = await renderPng(resolve(ROOT, 'tray-template.svg'), 44)
  await writeFile(resolve(ROOT, 'trayTemplate.png'), trayTemplate1x)
  await writeFile(resolve(ROOT, 'trayTemplate@2x.png'), trayTemplate2x)

  const icon512 = await renderPng(resolve(ROOT, 'icon.svg'), 512)
  const icon1024 = await renderPng(resolve(ROOT, 'icon.svg'), 1024)
  await writeFile(resolve(ROOT, 'icon.png'), icon1024)

  const icns = png2icons.createICNS(icon1024, png2icons.BICUBIC, 0)
  if (!icns) throw new Error('Failed to generate ICNS')
  await writeFile(resolve(ROOT, 'icon.icns'), icns)

  const ico = png2icons.createICO(icon512, png2icons.BICUBIC, 0, false)
  if (ico) await writeFile(resolve(ROOT, 'icon.ico'), ico)

  console.log('✓ Icons generated in resources/')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
