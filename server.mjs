/**
 * fww-b2b-admin — internal Fuzzywumpets ops dashboard.
 * Phase 0: minimal placeholder. The overnight loop will scaffold the real app.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8794);

app.get('/healthz', (req, res) => res.json({ ok: true, app: 'fww-b2b-admin', ts: Date.now() }));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`fww-b2b-admin listening on http://127.0.0.1:${PORT}`);
});
