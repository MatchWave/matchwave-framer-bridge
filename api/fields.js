```js
// GET /api/fields - toont velden van de collectie (naam, type, enum-opties) om de mapping te controleren
import { connect } from "framer-api";
import crypto from "node:crypto";

export default async function handler(req, res) {
 const a = Buffer.from(String(req.headers["x-bridge-secret"] || "")), b = Buffer.from(String(process.env.BRIDGE_SECRET || ""));
 if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "unauthorized" });
 let framer;
 try {
 framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY);
 const cols = await framer.getCollections();
 const col = cols.find(c => c.name === process.env.FRAMER_COLLECTION_NAME);
 if (!col) return res.status(404).json({ error: "collectie niet gevonden", beschikbaar: cols.map(c => c.name) });
 const fields = await col.getFields();
 const items = await col.getItems();
 res.status(200).json({
 collectie: col.name, managedBy: col.managedBy, aantalItems: items.length,
 velden: fields.map(f => ({ naam: f.name, type: f.type, opties: f.cases ? f.cases.map(c => c.name) : undefined }))
 });
 } catch (e) { res.status(500).json({ error: e.message }); }
 finally { if (framer) await framer.disconnect().catch(() => {}); }
}
```
