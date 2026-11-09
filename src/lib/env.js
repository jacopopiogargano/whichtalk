// Values captured once when the bundle starts. main.js imports this module first, so the boot
// timer covers parsing the catalog and building the first render.
export const BOOT_STARTED = performance.now()
export const URL_PARAMS = new URLSearchParams(location.search)
