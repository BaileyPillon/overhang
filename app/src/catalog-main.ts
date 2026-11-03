import { boot } from './boot';
import { initCatalog } from './catalog';

void boot((data) => {
  const el = document.getElementById('catalog');
  if (el) initCatalog(el, data);
});
