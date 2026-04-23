// Converte logo.svg em PNG buffer + data URL (cacheia em memória)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_SVG_PATH = path.join(__dirname, '..', 'logo.svg');

let _cache = null;     // { png: Buffer, dataUrl: string, dataUrlWhite: string }
let _loading = null;

async function generate() {
  try {
    const { default: sharp } = await import('sharp');
    const svg = fs.readFileSync(LOGO_SVG_PATH);
    // PNG colorido (default roxo)
    const colored = await sharp(svg, { density: 300 })
      .resize({ width: 800, withoutEnlargement: false })
      .png({ compressionLevel: 9 })
      .toBuffer();
    // PNG branco (pra usar em background roxo) — trica-se todos os tons por branco preservando alpha
    const white = await sharp(svg, { density: 300 })
      .resize({ width: 800 })
      .ensureAlpha()
      .tint({ r: 255, g: 255, b: 255 })
      .png()
      .toBuffer();
    _cache = {
      png: colored,
      dataUrl: 'data:image/png;base64,' + colored.toString('base64'),
      dataUrlWhite: 'data:image/png;base64,' + white.toString('base64'),
    };
    return _cache;
  } catch (e) {
    console.error('[logo] failed to render:', e.message);
    _cache = { png: null, dataUrl: null, dataUrlWhite: null, error: e.message };
    return _cache;
  }
}

export async function getLogo() {
  if (_cache) return _cache;
  if (!_loading) _loading = generate();
  return _loading;
}
