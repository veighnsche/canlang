const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

// Keep the adaptive SVG as the geometry source; the IDE selects these variants.
const images = join(__dirname, 'images');
const source = readFileSync(join(images, 'logo.svg'), 'utf8');
const inner = 'class="inner" fill="#F5F5F5"';
if (source.split(inner).length !== 2 || !source.includes('<style>')) {
  throw new Error('Expected the adaptive logo style and one inner-mark path');
}

// IDE file-icon slots are 16px: 128 viewBox units move the mark right by 2px.
const offset = 2 * 1024 / 16;
const fixed = source
  .replace(/\s*<style>[\s\S]*?<\/style>/, '')
  .replace('viewBox="0 0 1024 1024"', 'width="16" height="16" viewBox="0 0 1024 1024"')
  .replace(/\n  /g, '\n    ')
  .replace(/(<svg[^>]*>)/, `$1\n  <g transform="translate(${offset} 0)">`)
  .replace('</svg>', '  </g>\n</svg>');
for (const [theme, color] of [['dark', '#F5F5F5'], ['light', '#141414']]) {
  const svg = fixed
    .replace(inner, `class="inner" fill="${color}"`)
    .replace('<svg ', '<!-- Generated from logo.svg by generate-file-icons.cjs. -->\n<svg ');
  writeFileSync(join(images, `file-icon-${theme}.svg`), svg);
}
