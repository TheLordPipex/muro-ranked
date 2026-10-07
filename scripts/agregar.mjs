// Agrega una cuenta a jugadores.json después de comprobar que existe en Riot.
//
// Uso: RIOT_API_KEY=... RIOT_ID="Nombre#TAG" node scripts/agregar.mjs
// Escribe en $GITHUB_OUTPUT: riot_id, slug, y error (si falló) para que el workflow responda en el issue.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { slugOf } from "./slug.mjs";

const ROOT = join(import.meta.dirname, "..");
const FILE = join(ROOT, "jugadores.json");
const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
const fail = (msg) => { console.error(msg); out("error", msg); process.exit(1); };

const raw = (process.env.RIOT_ID || "").trim();
const m = raw.match(/^(.{3,16})#([^#\s]{2,5})$/u);
if (!m) fail(`"${raw}" no parece un Riot ID. Tiene que ser Nombre#TAG, por ejemplo ONU yamizang#1312.`);
const [, gameName, tagLine] = m;

const res = await fetch(
  `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
  { headers: { "X-Riot-Token": process.env.RIOT_API_KEY } }
);
if (res.status === 404) fail(`No existe ninguna cuenta ${gameName}#${tagLine} en Riot. Revisá mayúsculas, espacios y el tag.`);
if (!res.ok) fail(`Riot respondió ${res.status}. Probá de nuevo en un rato.`);
const account = await res.json(); // trae el nombre con las mayúsculas correctas

const riotId = `${account.gameName}#${account.tagLine}`;
const players = JSON.parse(readFileSync(FILE, "utf8"));
if (!players.some((p) => slugOf(`${p.gameName}#${p.tagLine}`) === slugOf(riotId))) {
  players.push({ gameName: account.gameName, tagLine: account.tagLine });
  writeFileSync(FILE, JSON.stringify(players, null, 2) + "\n");
  console.log(`Agregada ${riotId}`);
} else {
  console.log(`${riotId} ya estaba en la lista`);
}
out("riot_id", riotId);
out("slug", slugOf(riotId));
