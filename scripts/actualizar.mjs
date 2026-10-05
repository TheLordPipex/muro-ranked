// Actualiza los datos del muro de cada jugador de jugadores.json.
//
// Uso: RIOT_API_KEY=... node scripts/actualizar.mjs
// (en local: node --env-file=.env scripts/actualizar.mjs)
//
// Por jugador escribe data/<slug>.json con su rango y sus partidas de ranked solo/duo de la temporada,
// y data/jugadores.json con la lista para el generador de links.
// Es incremental: solo pide las partidas que todavía no están en data/<slug>.json.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DATA = join(ROOT, "data");
const QUEUE = 420;
const REGIONAL = "americas";
const PLATFORM = "la1"; // LAN
const DELAY_MS = 1250; // 100 requests cada 2 minutos
const MIN_DURATION_S = 300;
const TIERS = {
  IRON: "HIERRO", BRONZE: "BRONCE", SILVER: "PLATA", GOLD: "ORO", PLATINUM: "PLATINO", EMERALD: "ESMERALDA",
  DIAMOND: "DIAMANTE", MASTER: "MAESTRO", GRANDMASTER: "GRAN MAESTRO", CHALLENGER: "RETADOR",
};
const DDRAGON_IDS = { FiddleSticks: "Fiddlesticks" };

const API_KEY = process.env.RIOT_API_KEY;
if (!API_KEY) {
  console.error("Falta RIOT_API_KEY");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;

async function riot(host, path) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await sleep(DELAY_MS);
    requests++;
    const res = await fetch(`https://${host}.api.riotgames.com${path}`, { headers: { "X-Riot-Token": API_KEY } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      await sleep(Number(res.headers.get("retry-after") ?? 5) * 1000);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`${res.status}: clave inválida o vencida`), { fatal: true });
    throw new Error(`${res.status} en ${path}`);
  }
  throw new Error(`Demasiados reintentos en ${path}`);
}

export const slugOf = (riotId) =>
  riotId.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);
const content = (d) => JSON.stringify({ ...d, updated: undefined });

async function updatePlayer({ gameName, tagLine }) {
  const riotId = `${gameName}#${tagLine}`;
  const slug = slugOf(riotId);
  const file = join(DATA, `${slug}.json`);
  const prev = readJson(file, null);

  const account = await riot(REGIONAL, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
  if (!account) throw new Error(`no existe la cuenta ${riotId}`);
  const puuid = account.puuid;
  const solo = (await riot(PLATFORM, `/lol/league/v4/entries/by-puuid/${puuid}`))?.find((e) => e.queueType === "RANKED_SOLO_5x5");

  // Partidas nuevas: la API da la más reciente primero; se corta al llegar a una ya conocida.
  const known = new Set([...(prev?.games ?? []).map((g) => g.id), ...(prev?.remakes ?? [])]);
  const fresh = [];
  const remakes = [...(prev?.remakes ?? [])];
  let done = false;
  for (let start = 0; !done; start += 100) {
    const page = await riot(REGIONAL, `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${QUEUE}&start=${start}&count=100`);
    for (const id of page) {
      if (known.has(id)) { done = true; break; }
      const m = await riot(REGIONAL, `/lol/match/v5/matches/${id}`);
      if (!m) continue;
      const me = m.info.participants.find((p) => p.puuid === puuid);
      if (!me || m.info.gameDuration < MIN_DURATION_S || me.gameEndedInEarlySurrender) { remakes.push(id); continue; }
      fresh.push({ id, w: me.win ? 1 : 0, c: me.championName, d: me.deaths });
    }
    if (page.length < 100) done = true;
    if (fresh.length && fresh.length % 100 === 0) console.log(`  ${riotId}: ${fresh.length} partidas nuevas...`);
  }

  // Solo la temporada actual: tantas partidas como victorias + derrotas del rango.
  const season = (solo?.wins ?? 0) + (solo?.losses ?? 0);
  const all = [...(prev?.games ?? []), ...fresh.reverse()]; // de la más vieja a la más nueva
  const games = season ? all.slice(-season) : [];
  const last = games.at(-1)?.c;

  const data = {
    riotId,
    slug,
    tier: solo ? TIERS[solo.tier] ?? solo.tier : "SIN RANGO",
    division: solo && !["MASTER", "GRANDMASTER", "CHALLENGER"].includes(solo.tier) ? solo.rank : "",
    lp: solo?.leaguePoints ?? 0,
    wins: solo?.wins ?? 0,
    losses: solo?.losses ?? 0,
    updated: new Date().toISOString(),
    splash: last ? DDRAGON_IDS[last] ?? last : null,
    remakes: remakes.slice(-200),
    games,
  };
  if (!prev || content(prev) !== content(data)) {
    writeFileSync(file, JSON.stringify(data));
    console.log(`${riotId}: ${data.tier} ${data.division} ${data.lp} LP, ${games.length} partidas (+${fresh.length})`);
  } else {
    console.log(`${riotId}: sin cambios`);
  }
  return { riotId, slug, tier: data.tier, division: data.division, lp: data.lp };
}

mkdirSync(DATA, { recursive: true });
const players = readJson(join(ROOT, "jugadores.json"), []);
const index = [];
let failed = 0;
for (const p of players) {
  try {
    index.push(await updatePlayer(p));
  } catch (err) {
    failed++;
    console.error(`${p.gameName}#${p.tagLine}: ${err.message}`);
    if (err.fatal) process.exit(1);
    const prev = readJson(join(DATA, `${slugOf(`${p.gameName}#${p.tagLine}`)}.json`), null);
    if (prev) index.push({ riotId: prev.riotId, slug: prev.slug, tier: prev.tier, division: prev.division, lp: prev.lp });
  }
}

const indexFile = join(DATA, "jugadores.json");
const indexJson = JSON.stringify(index, null, 2);
if (!existsSync(indexFile) || readFileSync(indexFile, "utf8") !== indexJson) writeFileSync(indexFile, indexJson);
console.log(`${requests} requests${failed ? `, ${failed} jugador(es) con error` : ""}`);
