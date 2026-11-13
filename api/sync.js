// MatchWave Framer Bridge - POST /api/sync
// Env: FRAMER_API_KEY, FRAMER_PROJECT_URL, FRAMER_COLLECTION_NAME, BRIDGE_SECRET
// Optioneel: FRAMER_REF_FORMAT = "id" (standaard) of "slug" -> hoe verwijzingen naar AddItems gaan
//
// Body: {
//   upserts: [{ slug, fields: { "Veldnaam": waarde } }],
//   removeSlugs: [], fullSync: false, dryRun: false, autoPublish: false, force: false,
//   inspect: false   // true = alleen tellen (lege items, dubbele slugs), niets schrijven
// }
//
// Opschoonregels:
// - Een upsert zonder velden (fields:{}) maakt NOOIT een nieuw item aan; het is alleen een "behouden"-markering.
// - Dubbele slugs worden bij elke schrijvende call opgeruimd: het meest gevulde exemplaar blijft, de rest gaat weg.
// - Bij fullSync worden lege items (zonder ingevulde velden) verwijderd, tenzij ze in deze call gevuld worden.
// - Slugs worden genormaliseerd (kleine letters, alleen a-z/0-9/-, geen dubbele of afsluitende streepjes).
import { connect } from "framer-api";
import crypto from "node:crypto";

export const config = { maxDuration: 60 };

function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Zelfde normalisatie voor verzonden slugs en voor slugs die al in Framer staan
function normSlug(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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

// Aantal echt ingevulde velden van een bestaand Framer-item
function filledCount(item) {
  const fd = item?.fieldData || {};
  let n = 0;
  for (const v of Object.values(fd)) {
    const c = comparable(v);
    if (c !== "" && c !== "[]" && c !== "false") n++;
  }
  return n;
}

// Groepeert bestaande items per genormaliseerde slug en bepaalt welke exemplaren overbodig zijn
function analyse(existing) {
  const groups = new Map();
  for (const it of existing) {
    const key = normSlug(it.slug);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const keepByKey = new Map();   // genormaliseerde slug -> te behouden item
  const duplicateIds = [];       // overbodige dubbele exemplaren
  const duplicateSlugs = [];
  for (const [key, list] of groups) {
    if (list.length === 1) { keepByKey.set(key, list[0]); continue; }
    // Meest gevulde exemplaar behouden; bij gelijkspel het exemplaar waarvan de slug al exact klopt
    const sorted = [...list].sort((a, b) =>
      (filledCount(b) - filledCount(a)) || ((b.slug === key) - (a.slug === key)));
    keepByKey.set(key, sorted[0]);
    for (const extra of sorted.slice(1)) duplicateIds.push(extra.id);
    duplicateSlugs.push(key);
  }
  const emptyKeys = [...keepByKey.entries()].filter(([, it]) => filledCount(it) === 0).map(([k]) => k);
  const slugMismatch = existing.filter(i => i.slug !== normSlug(i.slug)).map(i => i.slug);
  return { keepByKey, duplicateIds, duplicateSlugs, emptyKeys, slugMismatch };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!safeEqual(req.headers["x-bridge-secret"], process.env.BRIDGE_SECRET))
    return res.status(401).json({ error: "unauthorized" });

  const body = req.body || {};
  const { upserts = [], removeSlugs = [], fullSync = false, dryRun = false, autoPublish = false, inspect = false } = body;
  const force = body.force === true;
  const result = {
    created: 0, updated: 0, unchanged: 0, removed: 0,
    removedDuplicates: 0, removedEmpty: 0, skippedEmptyNew: 0,
    errors: []
  };
  let framer;
  try {
    framer = await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY);
    const collections = await framer.getCollections();
    const collection = collections.find(c => c.name === process.env.FRAMER_COLLECTION_NAME);
    if (!collection) throw new Error(`Collectie "${process.env.FRAMER_COLLECTION_NAME}" niet gevonden`);
    if (collection.managedBy && collection.managedBy !== "user") throw new Error("Collectie is plugin-managed; gebruik een eigen (unmanaged) collectie");

    const existing = await collection.getItems();
    const { keepByKey, duplicateIds, duplicateSlugs, emptyKeys, slugMismatch } = analyse(existing);

    // Alleen-lezen controle: niets schrijven
    if (inspect === true) {
      return res.status(200).json({
        inspect: true,
        totaalItems: existing.length,
        uniekeSlugs: keepByKey.size,
        dubbeleExemplaren: duplicateIds.length,
        dubbeleSlugs: duplicateSlugs.length,
        voorbeeldDubbeleSlugs: duplicateSlugs.slice(0, 10),
        legeItems: emptyKeys.length,
        voorbeeldLegeItems: emptyKeys.slice(0, 10),
        afwijkendeSlugs: slugMismatch.length,
        voorbeeldAfwijkendeSlugs: slugMismatch.slice(0, 10)
      });
    }

    const resolveRef = await makeRefResolver(framer);
    const fields = await collection.getFields();
    const fieldByName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
    const unchanged = (old, fieldData) => Object.entries(fieldData).every(([fid, nv]) => {
      const ov = old.fieldData?.[fid];
      if (nv.type === "date") {
        const o = ov && typeof ov === "object" && "value" in ov ? ov.value : ov;
        if (!o && !nv.value) return true;
        return o && nv.value && new Date(o).getTime() === new Date(nv.value).getTime();
      }
      return comparable(ov) === comparable(nv);
    });

    // Upserts: dubbele slugs in de payload samenvoegen (laatste wint)
    const upsertByKey = new Map();
    for (const u of upserts) {
      const key = normSlug(u?.slug);
      if (!key) { result.errors.push({ slug: u?.slug ?? null, error: "slug ontbreekt of is ongeldig" }); continue; }
      upsertByKey.set(key, u);
    }

    const items = [];
    const filledKeys = new Set(); // slugs die in deze call echte velden krijgen
    for (const [key, u] of upsertByKey) {
      try {
        const fieldData = {};
        for (const [name, raw] of Object.entries(u.fields || {})) {
          // "Functietitel|Opdrachtnaam" = probeer de alternatieven in volgorde
          const f = name.split("|").map(n => fieldByName.get(n.trim().toLowerCase())).find(Boolean);
          if (!f) throw new Error(`Onbekend Framer-veld "${name}"`);
          const v = await toFieldValue(f, raw, resolveRef);
          if (v !== undefined) fieldData[f.id] = v;
        }
        const hasFields = Object.keys(fieldData).length > 0;
        const old = keepByKey.get(key);
        if (!hasFields) {
          // Alleen "behouden"-markering: nooit een leeg item aanmaken
          if (old) result.unchanged++; else result.skippedEmptyNew++;
          continue;
        }
        filledKeys.add(key);
        if (old && unchanged(old, fieldData)) { result.unchanged++; continue; }
        if (old) { items.push({ id: old.id, slug: key, fieldData }); result.updated++; }
        else { items.push({ slug: key, fieldData }); result.created++; }
      } catch (e) { result.errors.push({ slug: u.slug, error: e.message }); }
    }

    // Opschonen: dubbele exemplaren altijd; lege items alleen bij fullSync (en niet als ze nu gevuld worden)
    const cleanupIds = new Set(duplicateIds);
    result.removedDuplicates = duplicateIds.length;
    if (fullSync) {
      for (const key of emptyKeys) {
        if (filledKeys.has(key)) continue;
        const it = keepByKey.get(key);
        if (it && !cleanupIds.has(it.id)) { cleanupIds.add(it.id); result.removedEmpty++; }
      }
    }

    // Reguliere verwijderingen (items die niet meer in Airtable staan / expliciet gevraagd)
    const keepKeys = new Set(upsertByKey.keys());
    const regularIds = [];
    if (fullSync) {
      for (const [key, it] of keepByKey) {
        if (!keepKeys.has(key) && !cleanupIds.has(it.id)) regularIds.push(it.id);
      }
    } else {
      for (const s of removeSlugs) {
        const it = keepByKey.get(normSlug(s));
        if (it && !cleanupIds.has(it.id)) regularIds.push(it.id);
      }
    }
    result.removed = regularIds.length;

    // Veiligheidsrem: nooit de collectie leeghalen door een lege/halve Airtable-respons.
    // Opruimen van dubbele/lege items telt hier niet mee (die zijn altijd veilig).
    const base = keepByKey.size;
    if (fullSync && !force && (upsertByKey.size === 0 || (base >= 10 && regularIds.length > base * 0.5)))
      return res.status(409).json({ ...result, error: `Afgebroken: ${regularIds.length} van ${base} items zouden verdwijnen. Stuur force:true als dit bedoeld is.` });

    if (dryRun) return res.status(200).json({ ...result, dryRun: true, autoPublish: !!autoPublish, published: false });

    // Eerst opschonen (anders blokkeren dubbele slugs het schrijven), dan schrijven, dan regulier verwijderen
    if (cleanupIds.size) {
      try { await collection.removeItems([...cleanupIds]); }
      catch (e) { result.errors.push({ stap: "opschonen dubbel/leeg", error: e.message }); }
    }
    for (let i = 0; i < items.length; i += 100) {
      try { await collection.addItems(items.slice(i, i + 100)); }
      catch (e) { result.errors.push({ stap: `schrijven items ${i + 1}-${Math.min(i + 100, items.length)}`, error: e.message }); }
    }
    if (regularIds.length) {
      try { await collection.removeItems(regularIds); }
      catch (e) { result.errors.push({ stap: "verwijderen", error: e.message }); }
    }

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
