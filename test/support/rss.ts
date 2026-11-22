export interface SyntheticRssItem {
  readonly code: string;
  readonly guid: string;
  readonly publishedAt?: string;
  readonly link?: string;
}

/** Synthetic RSS 2.0 fixture matching the observed title/link/guid/pubDate contract. */
export function rssFeed(items: readonly SyntheticRssItem[] = []): string {
  const rows = items
    .map(
      (item) => `<item>
        <title>${item.code}</title>
        <link>${item.link ?? `https://synthetic.invalid/article/${item.guid}`}</link>
        <guid isPermaLink="false">${item.guid}</guid>
        <pubDate>${item.publishedAt ?? "Tue, 06 Oct 2026 11:00:00 GMT"}</pubDate>
      </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
      <channel>
        <title>Synthetic RSS feed</title>
        <link>https://synthetic.invalid/</link>
        <description>Synthetic fixture only</description>
        <language>en-us</language>
        <lastBuildDate>Tue, 06 Oct 2026 11:00:00 GMT</lastBuildDate>
        <atom:link href="https://synthetic.invalid/rss.php" rel="self" type="application/rss+xml" />
        ${rows}
      </channel>
    </rss>`;
}
