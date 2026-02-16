export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    let count = 0;
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const body = {
        page_size: 100,
        filter: {
          property: "Status", // must match your Notion property name exactly
          rich_text: {
            starts_with: "📘" // counts 📘 and 📘✨ ARC (and any future 📘 variants)
          }
        }
      };

      if (startCursor) body.start_cursor = startCursor;

      const resp = await fetch(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        }
      );

      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      count += data.results?.length || 0;
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({ count });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
