export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    const notionHeaders = {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    };

    // 1) Fetch database schema so we can stop guessing property names/types
    const dbResp = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}`, {
      method: "GET",
      headers: notionHeaders,
    });

    const db = await dbResp.json();
    if (!dbResp.ok) {
      return res.status(dbResp.status).json({
        error: "Failed to fetch database schema",
        details: db,
      });
    }

    // Debug mode: show properties + types (and options if applicable)
    if (req.query?.debug) {
      const props = db.properties || {};
      const simplified = Object.fromEntries(
        Object.entries(props).map(([name, p]) => {
          const out = { type: p.type };
          // include option names for select/status/multi_select
          if (p.type === "select") out.options = (p.select?.options || []).map(o => o.name);
          if (p.type === "status") out.options = (p.status?.options || []).map(o => o.name);
          if (p.type === "multi_select") out.options = (p.multi_select?.options || []).map(o => o.name);
          return [name, out];
        })
      );

      return res.status(200).json({
        database_title: db.title?.[0]?.plain_text || "(untitled)",
        properties: simplified,
        hint: "Find the property that contains the Finished/ARC options and tell me its name + type.",
      });
    }

    // 2) Auto-detect the most likely "status/select" property that has a Finished option
    const props = db.properties || {};
    let statusPropName = null;
    let statusPropType = null;
    let finishedOptionName = null;

    for (const [name, p] of Object.entries(props)) {
      const t = p.type;
      if (t !== "status" && t !== "select" && t !== "multi_select") continue;

      const options =
        t === "status" ? (p.status?.options || []) :
        t === "select" ? (p.select?.options || []) :
        (p.multi_select?.options || []);

      const finished = options.find(o => (o.name || "").toLowerCase().includes("finished"));
      if (finished) {
        statusPropName = name;
        statusPropType = t;
        finishedOptionName = finished.name;
        break;
      }
    }

    if (!statusPropName) {
      return res.status(500).json({
        error: "Could not auto-detect a Status/Select property with a 'Finished' option.",
        fix: "Open /api/count?debug=1 and tell me which property contains Finished.",
      });
    }

    // 3) Build the correct filter based on the detected property type
    // Note: multi_select uses "contains" + exact option name
    const filter =
      statusPropType === "status"
        ? { property: statusPropName, status: { equals: finishedOptionName } }
        : statusPropType === "select"
        ? { property: statusPropName, select: { equals: finishedOptionName } }
        : { property: statusPropName, multi_select: { contains: finishedOptionName } };

    // 4) Count matching pages with pagination
    let count = 0;
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const body = {
        page_size: 100,
        filter,
      };
      if (startCursor) body.start_cursor = startCursor;

      const resp = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: "POST",
        headers: notionHeaders,
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      if (!resp.ok) {
        return res.status(resp.status).json({
          error: "Database query failed",
          used_property: statusPropName,
          used_type: statusPropType,
          used_filter: filter,
          details: data,
        });
      }

      count += data.results?.length || 0;
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      count,
      used_property: statusPropName,
      used_type: statusPropType,
      used_option: finishedOptionName,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
