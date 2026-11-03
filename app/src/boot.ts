// Shared boot: styles, theme, data loading, error display.
import './styles/tokens.css';
import './styles/base.css';
import { initTheme } from './theme';
import { loadAll, type AppData } from './data';
import { esc, fmtN } from './ui';

export async function boot(run: (data: AppData) => void | Promise<void>): Promise<void> {
  initTheme();
  try {
    const data = await loadAll();
    const foot = document.getElementById('foot');
    if (foot) {
      const m = data.meta;
      // the commit link is shown only once the repository is public (meta.repo_published); until then the hash is plain text
      const commit = m.repo_published
        ? `<a href="${esc(m.repo_url)}/commit/${esc(m.prereg_commit)}"><code>${esc(m.prereg_commit)}</code></a> · <a href="${esc(m.repo_url)}">source</a>`
        : `<code>${esc(m.prereg_commit)}</code> <span title="The repository has not been made public yet, so the commit cannot be opened from here.">(repository not public yet)</span>`;
      foot.innerHTML = `Overhang · N = ${fmtN(m.N)} (${fmtN(m.N_r1)} registered + ${fmtN(m.N - m.N_r1)} new) · run ${esc(m.run)} · pre-registered at commit ${commit} · generated ${esc(m.generated)} · <a href="index.html#references">references</a>`;
    }
    await run(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const box = document.createElement('div');
    box.className = 'paper';
    box.innerHTML = `<section><h2>Data not available</h2><p class="stub">${esc(msg)}</p></section>`;
    document.querySelector('main')?.prepend(box);
    console.error(err);
  }
}
