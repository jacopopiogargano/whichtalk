// The catalog the build embeds in the page as JSON (format documented in whichtalk/dataset.py).
// Parsed once here; conference.js and catalog.js decode their parts of it.
export const EMBEDDED_CATALOG = readEmbeddedCatalog()

function readEmbeddedCatalog () {
  const block = document.getElementById('catalog-data')
  if (!block) throw new Error('This page has no schedule data (#catalog-data is missing)')
  const catalog = JSON.parse(block.textContent)
  if (!catalog || catalog.format !== 'whichtalk-catalog' || catalog.version !== 1) {
    throw new Error('Unsupported schedule data format')
  }
  return catalog
}
