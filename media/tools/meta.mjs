import fs from 'node:fs';
function patch(f, title, desc) {
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace(/<title>[^<]*<\/title>\r?\n<meta name="description"[^>]*>\r?\n/, '');
  const block = `<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#0A0F1C">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Overhang">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<!-- %SITE_URL% is a placeholder: the deploy step replaces it with the absolute site URL (no trailing slash) -->
<meta property="og:image" content="%SITE_URL%/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A globe of 1,563 reports with the holes between them marked, and the title Overhang.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="%SITE_URL%/og.png">
`;
  s = s.replace(/(<meta name="viewport"[^>]*>\r?\n)/, (m) => m + block);
  fs.writeFileSync(f, s);
}
patch('index.html', 'Overhang: the holes in the space of Claude use cases', '1,563 things people have done with Claude, mapped on a globe, and the pairs nobody has reported. 19 holes were pre-registered and tested on 1,049 new reports. Every claim checkable.');
patch('catalog.html', 'Overhang catalog: every report', 'Every report in the Overhang corpus, one row each, with its tags, its source, and the hole it belongs to. Filter by hole code (OV-NN).');
