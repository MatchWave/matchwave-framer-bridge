import { connect } from "framer-api";
import crypto from "node:crypto";

export const config = { maxDuration: 60 };

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function toFieldValue(field, raw) {
  if (raw === undefined) return undefined;
  const t = field.type;
  if (raw === null || raw === "") {
    if (t === "string" || t === "formattedText" || t === "link") return { type: t, value: "" };
    if (t === "boolean") return { type: t, value: false };
    return { type: t, value: null };
  }
  switch (t) {
    case "string":
      return { type: t, value: String(raw) };
    case "formattedText":
      return { type: t, value: String(raw), contentType: "auto" };
    case "link":
      return { type: t, value: String(raw) };
    case "number": {
      const n = Number(String(raw).replace(",", "."));
      return { type: t, value: isNaN(n) ? null : n };
    }
    case "boolean":
      return { type: t, value: raw === true || raw === "true" || raw === 1 };
    case "date":
      return { type: t, value: new Date(raw).toISOString() };
    case "image":
      return { type: t, value: String(raw) };
    case "enum": {
      const c = (field.cases || []).find(c => c.name.toLowerCase() === String(raw).toLowerCase());
      if (!c) throw new Error("Enum-optie " + raw + " bestaat niet in veld " + field.name);
      return { type: t, value: c.id };
    }
    default:
      throw new Error("Veldtype " + t + " (veld " + field.name + ") wordt niet ondersteund");
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!safeEqual(req.headers["x-bridge-secret"], process.env.BRIDGE_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { upserts = [], removeSlugs = [], fullSync = false, dryRun = false, autoPublish = true } = req.body || {};
  const result = { created: 0, updated: 0, removed: 0, published: false, errors: [] };
  let framer;
  try {
    framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY);
    const collections = await framer.getCollections();
    const collection = collections.find(c => c.name === process.env.FRAMER_COLLECTION_NAME);
    if (!collection) throw new Error("Collectie " + process.env.FRAMER_COLLECTION_NAME + " niet gevonden");
    if (collection.managedBy && collection.managedBy !== "user") {
      throw new Error("Collectie is plugin-managed; gebruik een eigen (unmanaged) collectie");
    }

    const fields = await collection.getFields();
    const fieldByName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
    const existing = await collection.getItems();
    const idBySlug = new Map(existing.map(i => [i.slug, i.id]));
    const itemBySlug = new Map(existing.map(i => [i.slug, i]));
    const norm = v => (v === null || v === undefined) ? "" : (v instanceof Date ? v.toISOString() : (typeof v === "object" ? JSON.stringify(v) : String(v)));
    const unchanged = (old, fieldData) => Object.entries(fieldData).every(([fid, nv]) => {
      const ov = old.fieldData?.[fid];
      const o = ov && typeof ov === "object" && "value" in ov ? ov.value : ov;
      if (nv.type === "date") return o && nv.value && new Date(o).getTime() === new Date(nv.value).getTime();
      return norm(o) === norm(nv.value);
    });

    const items = [];
    for (const u of upserts) {
      try {
        if (!u.slug) throw new Error("slug ontbreekt");
        const fieldData = {};
        for (const [name, raw] of Object.entries(u.fields || {})) {
          const f = name.split("|").map(n => fieldByName.get(n.trim().toLowerCase())).find(Boolean);
          if (!f) throw new Error("Onbekend Framer-veld " + name);
          const v = toFieldValue(f, raw);
          if (v !== undefined) fieldData[f.id] = v;
        }
        const id = idBySlug.get(u.slug);
        if (id && unchanged(itemBySlug.get(u.slug), fieldData)) {
          result.unchanged = (result.unchanged || 0) + 1;
          continue;
        }
        items.push(id ? { id, slug: u.slug, fieldData } : { slug: u.slug, fieldData });
        id ? result.updated++ : result.created++;
      } catch (e) {
        result.errors.push({ slug: u.slug, error: e.message });
      }
    }

    const keep = new Set(upserts.map(u => u.slug));
    const removeIds = fullSync
      ? existing.filter(i => !keep.has(i.slug)).map(i => i.id)
      : removeSlugs.map(s => idBySlug.get(s)).filter(Boolean);
    result.removed = removeIds.length;

    const force = req.body?.force === true;
    if (fullSync && !force && (upserts.length === 0 || (existing.length >= 10 && removeIds.length > existing.length * 0.5))) {
      return res.status(409).json({
        ...result,
        error: "Afgebroken: " + removeIds.length + " van " + existing.length + " items zouden verdwijnen. Stuur force:true als dit bedoeld is."
      });
    }

    if (dryRun) return res.status(200).json({ ...result, dryRun: true });

    for (let i = 0; i < items.length; i += 100) {
      await collection.addItems(items.slice(i, i + 100));
    }
    if (removeIds.length) {
      await collection.removeItems(removeIds);
    }

    const hasChanges = items.length > 0 || removeIds.length > 0;
    if (autoPublish && hasChanges && typeof framer.publish === "function") {
      try {
        const pub = await framer.publish();
        if (pub?.deployment?.id && typeof framer.deploy === "function") {
          await framer.deploy(pub.deployment.id);
        }
        result.published = true;
        result.note = "CMS bijgewerkt en automatisch gepubliceerd in Framer";
      } catch (pubErr) {
        result.publishError = pubErr.message;
        result.note = "CMS bijgewerkt, maar automatisch publiceren mislukte: " + pubErr.message;
      }
    } else {
      result.note = "CMS bijgewerkt (geen wijzigingen om te publiceren of autoPublish uit)";
    }

    return res.status(result.errors.length ? 207 : 200).json(result);
  } catch (e) {
    return res.status(500).json({ ...result, error: e.message });
  } finally {
    if (framer) await framer.disconnect().catch(() => {});
  }
}
