// MatchWave Framer Bridge - POST /api/sync
// Env: FRAMER_API_KEY, FRAMER_PROJECT_URL, FRAMER_COLLECTION_NAME, BRIDGE_SECRET
// Optioneel: FRAMER_REF_FORMAT = "id" (standaard) of "slug" -> hoe verwijzingen naar AddItems gaan
import { connect } from "framer-api";
import crypto from "node:crypto";

export const config = { maxDuration: 60 };

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Laadt (en cachet per request) de items van een gerefereerde collectie,
// zodat we zowel item-ID's als slugs/namen kunnen accepteren en valideren.
async function makeRefResolver(framer) {
  const cache = new Map();
  let allCollections = null;
  return async function resolve(field, raw) {
    const target = field.collectionId;
    if (!cache.has(target)) {
      if (!allCollections) allCollections = await framer.getCollections();
      const col = allCollections.find(c => c.id === target);
      if (!col) throw new Error(`Gerefereerde collectie "${target}" (veld "${field.name}") niet gevonden`);
      const items = await col.getItems();
      const byId = new Map(items.map(i => [i.id, i]));
      const bySlug = new Map(items.map(i => [String(i.slug).toLowerCase(), i]));
      cache.set(target, { byId, bySlug });
    }
    const { byId, bySlug } = cache.get(target);
    const key = String(raw).trim();
    const item = byId.get(key) || bySlug.get(key.toLowerCase());
    if (!item) throw new Error(`Verwijzing "${key}" bestaat niet in de gekoppelde collectie (veld "${field.name}")`);
    return (process.env.FRAMER_REF_FORMAT || "id").toLowerCase() === "slug" ? item.slug : item.id;
  };
}

// Zet een ruwe waarde om naar Framer typed fieldData o.b.v. het veldtype
async function toFieldValue(field, raw, resolveRef) {
  if (raw === undefined) return undefined;
  const t = field.type;
  if (t === "multiCollectionReference") {
    const list = raw === null || raw === "" ? [] : (Array.isArray(raw) ? raw : [raw]);
    const ids = [];
    for (const r of list) {
      if (r === null || r === undefined || r === "") continue;
      const id = await resolveRef(field, r);
      if (!ids.includes(id)) ids.push(id);
    }
    return { type: t, value: ids };
  }
  if (t === "collectionReference") {
    const r = Array.isArray(raw) ? raw[0] : raw;
    if (r === null || r === undefined || r === "") return { type: t, value: null };
    return { type: t, value: await resolveRef(field, r) };
  }
  if (raw === null || raw === "") {
    if (t === "string" || t === "formattedText" || t === "link") return { type: t, value: "" };
    if (t === "boolean") return { type: t, value: false };
    return { type: t, value: null };
  }
  switch (t) {
    case "string": return { type: t, value: String(raw) };
    case "formattedText": return { type: t, value: String(raw), contentType: "auto" };
    case "link": return { type: t, value: String(raw) };
    case "number": { const n = Number(String(raw).replace(",", ".")); return { type: t, value: isNaN(n) ? null : n }; }
    case "boolean": return { type: t, value: raw === true || raw === "true" || raw === 1 };
    case "date": return { type: t, value: new Date(raw).toISOString() };
    case "image": return { type: t, value: String(raw) };
    case "enum": {
      const c = (field.cases || []).find(c => c.name.toLowerCase() === String(raw).toLowerCase());
      if (!c) throw new Error(`Enum-optie "${raw}" bestaat niet in veld "${field.name}"`);
      return { type: t, value: c.id };
    }
    default: throw new Error(`Veldtype "${t}" (veld "${field.name}") wordt niet ondersteund`);
  }
}

// Vergelijkbare waarde van een (oud of nieuw) veld, ook voor arrays met verwijzingen
function comparable(v) {
  const x = v && typeof v === "object" && !Array.isArray(v) && "value" in v ? v.value : v;
  if (x === null || x === undefined) return "";
  if (Array.isArray(x)) return JSON.stringify(x.map(e => (e && typeof e === "object" ? (e.id ?? e.slug ?? JSON.stringify(e)) : String(e))).sort());
  if (x instanceof Date) return x.toISOString();
  if (typeof x === "object") return x.id ?? x.slug ?? x.url ?? JSON.stringify(x);
  return String(x);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!safeEqual(req.headers["x-bridge-secret"], process.env.BRIDGE_SECRET))
    return res.status(401).json({ error: "unauthorized" });

  // Body: { upserts:[{slug, fields:{"Veldnaam": waarde}}], removeSlugs:[], fullSync:false, dryRun:false, autoPublish:false, force:false }
  // autoPublish:true -> na het bijwerken van het CMS wordt de site gepubliceerd en naar productie gezet.
  // n8n stuurt autoPublish:false bij de upsert-porties en autoPublish:true alleen bij de laatste opruim-call.
  const { upserts = [], removeSlugs = [], fullSync = false, dryRun = false, autoPublish = false } = req.body || {};
  const result = { created: 0, updated: 0, unchanged: 0, removed: 0, errors: [] };
  let framer;
  try {
    framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY);
    const collections = await framer.getCollections();
    const collection = collections.find(c => c.name === process.env.FRAMER_COLLECTION_NAME);
    if (!collection) throw new Error(`Collectie "${process.env.FRAMER_COLLECTION_NAME}" niet gevonden`);
    if (collection.managedBy && collection.managedBy !== "user") throw new Error("Collectie is plugin-managed; gebruik een eigen (unmanaged) collectie");

    const resolveRef = await makeRefResolver(framer);
    const fields = await collection.getFields();
    const fieldByName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
    const existing = await collection.getItems();
    const idBySlug = new Map(existing.map(i => [i.slug, i.id]));
    const itemBySlug = new Map(existing.map(i => [i.slug, i]));
    const unchanged = (old, fieldData) => Object.entries(fieldData).every(([fid, nv]) => {
      const ov = old.fieldData?.[fid];
      if (nv.type === "date") {
        const o = ov && typeof ov === "object" && "value" in ov ? ov.value : ov;
        if (!o && !nv.value) return true;
        return o && nv.value && new Date(o).getTime() === new Date(nv.value).getTime();
      }
      return comparable(ov) === comparable(nv);
    });

    // Upserts opbouwen
    const items = [];
    for (const u of upserts) {
      try {
        if (!u.slug) throw new Error("slug ontbreekt");
        const fieldData = {};
        for (const [name, raw] of Object.entries(u.fields || {})) {
          // "Functietitel|Opdrachtnaam" = probeer de alternatieven in volgorde
          const f = name.split("|").map(n => fieldByName.get(n.trim().toLowerCase())).find(Boolean);
          if (!f) throw new Error(`Onbekend Framer-veld "${name}"`);
          const v = await toFieldValue(f, raw, resolveRef);
          if (v !== undefined) fieldData[f.id] = v;
        }
        const id = idBySlug.get(u.slug);
        if (id && unchanged(itemBySlug.get(u.slug), fieldData)) { result.unchanged++; continue; }
        items.push(id ? { id, slug: u.slug, fieldData } : { slug: u.slug, fieldData });
        id ? result.updated++ : result.created++;
      } catch (e) { result.errors.push({ slug: u.slug, error: e.message }); }
    }

    // Te verwijderen items
    const keep = new Set(upserts.map(u => u.slug));
    const removeIds = fullSync
      ? existing.filter(i => !keep.has(i.slug)).map(i => i.id)
      : removeSlugs.map(s => idBySlug.get(s)).filter(Boolean);
    result.removed = removeIds.length;
    // Veiligheidsrem: nooit de collectie leeghalen door een lege/halve Airtable-respons
    const force = req.body?.force === true;
    if (fullSync && !force && (upserts.length === 0 || (existing.length >= 10 && removeIds.length > existing.length * 0.5)))
      return res.status(409).json({ ...result, error: `Afgebroken: ${removeIds.length} van ${existing.length} items zouden verdwijnen. Stuur force:true als dit bedoeld is.` });

    if (dryRun) return res.status(200).json({ ...result, dryRun: true, autoPublish: !!autoPublish, published: false });

    for (let i = 0; i < items.length; i += 100) await collection.addItems(items.slice(i, i + 100));
    if (removeIds.length) await collection.removeItems(removeIds);

    // Publiceren: alleen bij autoPublish:true en zonder fouten in deze call
    if (autoPublish === true) {
      if (result.errors.length) {
        result.published = false;
        result.note = "CMS bijgewerkt; NIET gepubliceerd omdat er fouten waren";
      } else {
        const pub = await framer.publish();
        const deploymentId = pub?.deployment?.id;
        if (deploymentId) await framer.deploy(deploymentId);
        result.published = !!deploymentId;
        result.deploymentId = deploymentId || null;
        result.hostnames = pub?.hostnames || null;
        result.note = deploymentId ? "CMS bijgewerkt en site gepubliceerd naar productie" : "CMS bijgewerkt; publicatie gaf geen deployment-id terug";
      }
    } else {
      result.published = false;
      result.note = "CMS bijgewerkt; niet gepubliceerd (autoPublish:false)";
    }
    return res.status(result.errors.length ? 207 : 200).json(result);
  } catch (e) {
    return res.status(500).json({ ...result, error: e.message });
  } finally {
    if (framer) await framer.disconnect().catch(() => {});
  }
}
