const express = require("express");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const STATUSES = ["Pending", "In Progress", "Completed"];
const TYPES = ["Accounting", "Activity Booking"];
const FIELDS = ["client", "fund", "ttype", "period", "signoff", "co", "help", "by", "htype", "status"];

function clean(b) {
  const r = {};
  for (const k of FIELDS) r[k] = String(b[k] == null ? "" : b[k]).trim().slice(0, 200);
  if (!r.client || !r.fund) return { error: "Client Name and Fund Name are required." };
  if (!TYPES.includes(r.ttype)) return { error: "Invalid task type." };
  if (!STATUSES.includes(r.status)) return { error: "Invalid status." };
  if (r.help !== "Yes") { r.help = "No"; r.by = ""; r.htype = ""; }
  return { rec: r };
}

/* ---------- storage: your existing Firestore "entries" collection ---------- */
let store;
const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
if (sa) {
  let cred;
  try { cred = JSON.parse(sa); } catch (e) { console.error("FIREBASE_SERVICE_ACCOUNT is not valid JSON."); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(cred) });
  const col = admin.firestore().collection("entries");
  store = {
    async init() { await col.limit(1).get(); console.log("Connected to Firestore project " + cred.project_id); },
    async list() {
      const snap = await col.orderBy("ts", "asc").get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async add(r) {
      const rec = { ...r, ts: Date.now() };
      const ref = await col.add(rec);
      return { id: ref.id, ...rec };
    },
    async update(id, r) {
      const ref = col.doc(id);
      return admin.firestore().runTransaction(async (t) => {
        const s = await t.get(ref);
        if (!s.exists) return { code: 404 };
        if (s.data().status === "Completed") return { code: 409 };
        t.update(ref, r);
        return { rec: { id, ...s.data(), ...r } };
      });
    },
  };
} else {
  /* local dev fallback only */
  const file = path.join(__dirname, "data.json");
  const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; } };
  const save = (d) => fs.writeFileSync(file, JSON.stringify(d));
  store = {
    async init() { console.log("FIREBASE_SERVICE_ACCOUNT not set: using local data.json (dev only)."); },
    async list() { return load(); },
    async add(r) { const d = load(); const e = { id: String(Date.now()) + Math.floor(Math.random() * 1000), ts: Date.now(), ...r }; d.push(e); save(d); return e; },
    async update(id, r) {
      const d = load(); const e = d.find((x) => x.id === id);
      if (!e) return { code: 404 };
      if (e.status === "Completed") return { code: 409 };
      Object.assign(e, r); save(d); return { rec: e };
    },
  };
}

/* ---------- API ---------- */
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: "Server error" }); });

app.get("/api/entries", wrap(async (req, res) => { res.set("Cache-Control", "no-store"); res.json(await store.list()); }));

app.post("/api/entries", wrap(async (req, res) => {
  const { rec, error } = clean(req.body || {});
  if (error) return res.status(400).json({ error });
  res.status(201).json(await store.add(rec));
}));

app.put("/api/entries/:id", wrap(async (req, res) => {
  const { rec, error } = clean(req.body || {});
  if (error) return res.status(400).json({ error });
  const out = await store.update(req.params.id, rec);
  if (out.code === 404) return res.status(404).json({ error: "Entry not found." });
  if (out.code === 409) return res.status(409).json({ error: "This entry is completed and locked." });
  res.json(out.rec);
}));

app.get("/healthz", (req, res) => res.send("ok"));

const port = process.env.PORT || 3000;
store.init().then(() => app.listen(port, () => console.log("Listening on " + port)))
  .catch((e) => { console.error("Startup failed:", e); process.exit(1); });