import { boot } from './boot';
import { initMatrix } from './matrix';
import { initPaper } from './paper';
import type { AppData } from './data';

/** The first screen is the globe console. When WebGL or its data is unavailable, the 2D survey plate stands in. */
async function initHero(el: HTMLElement, data: AppData): Promise<void> {
  el.innerHTML = '<p class="hero-boot" role="status">Loading the globe…</p>';
  let ok = false;
  try {
    const { initGlobe } = await import('./globe');
    ok = await initGlobe(el, data);
  } catch (err) {
    console.error(err);
  }
  if (!ok) {
    el.className = '';
    el.innerHTML = '';
    const { initPlate } = await import('./plate');
    initPlate(el, data);
  }
}

void boot((data) => {
  const plate = document.getElementById('plate');
  const matrix = document.getElementById('matrix');
  if (plate) void initHero(plate, data);
  if (matrix) initMatrix(matrix, data);
  initPaper(data);
});
