// Actualiza los datos del muro de cada jugador de jugadores.json.
//
// Uso: RIOT_API_KEY=... node scripts/actualizar.mjs
// (en local: node --env-file=.env scripts/actualizar.mjs)
//
// Por jugador escribe un archivo por modo (ver MODES) y data/jugadores.json con la lista para el generador.
// Es incremental: solo pide las partidas que todavía no están guardadas.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { slugOf } from "./slug.mjs";

const ROOT = join(import.meta.dirname, "..");
const DATA = join(ROOT, "data");
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
    let res;
    try {
      res = await fetch(`https://${host}.api.riotgames.com${path}`, { headers: { "X-Riot-Token": API_KEY } });
    } catch {
      await sleep(10_000); // corte de red: esperar y reintentar
      continue;
    }
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

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);
const content = (d) => JSON.stringify({ ...d, updated: undefined });

// Modos del muro. Cada uno se guarda en su propio archivo.
//   solo   -> data/<slug>.json         ranked solo/duo, partidas de la temporada (victorias + derrotas del rango)
//   flex   -> data/<slug>.flex.json    ranked flex, ídem
//   normal -> data/<slug>.normal.json  draft, blind, Swiftplay y Quickplay; sin ARAM ni modos especiales
const MODES = {
  solo: { file: "", queues: [420], league: "RANKED_SOLO_5x5", label: "CLASIFICATORIA SOLO/DUO" },
  flex: { file: ".flex", queues: [440], league: "RANKED_FLEX_SR", label: "CLASIFICATORIA FLEXIBLE" },
  normal: { file: ".normal", queues: [400, 430, 480, 490], league: null, label: "PARTIDAS NORMALES", cap: 500 },
};
const matchNumber = (id) => Number(id.split("_")[1]);

async function updateMode(mode, { riotId, slug, puuid, entries }) {
  const M = MODES[mode];
  const file = join(DATA, `${slug}${M.file}.json`);
  const prev = readJson(file, null);
  const league = M.league ? entries?.find((e) => e.queueType === M.league) : null;

  // Partidas nuevas: la API da la más reciente primero; en cada cola se corta al llegar a una ya conocida.
  const known = new Set([...(prev?.games ?? []).map((g) => g.id), ...(prev?.remakes ?? [])]);
  const fresh = [];
  const remakes = [...(prev?.remakes ?? [])];
  for (const queue of M.queues) {
    let found = 0;
    let done = false;
    for (let start = 0; !done; start += 100) {
      const page = await riot(REGIONAL, `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${queue}&start=${start}&count=100`);
      for (const id of page) {
        if (known.has(id) || (M.cap && found >= M.cap)) { done = true; break; }
        found++;
        const m = await riot(REGIONAL, `/lol/match/v5/matches/${id}`);
        if (!m) continue;
        const me = m.info.participants.find((p) => p.puuid === puuid);
        if (!me || m.info.gameDuration < MIN_DURATION_S || me.gameEndedInEarlySurrender) { remakes.push(id); continue; }
        fresh.push({ id, w: me.win ? 1 : 0, c: me.championName, d: me.deaths });
      }
      if (page.length < 100) done = true;
    }
  }

  // De la más vieja a la más nueva. En ranked, solo la temporada actual (victorias + derrotas del rango).
  const all = [...(prev?.games ?? []), ...fresh].sort((a, b) => matchNumber(a.id) - matchNumber(b.id));
  const season = (league?.wins ?? 0) + (league?.losses ?? 0);
  const games = M.league ? (season ? all.slice(-season) : []) : all.slice(-M.cap);
  const last = games.at(-1)?.c;
  const won = games.filter((g) => g.w).length;

  const data = {
    riotId,
    slug,
    mode,
    queueLabel: M.label,
    tier: M.league ? (league ? TIERS[league.tier] ?? league.tier : "SIN RANGO") : "NORMALES",
    division: league && !["MASTER", "GRANDMASTER", "CHALLENGER"].includes(league.tier) ? league.rank : "",
    lp: M.league ? league?.leaguePoints ?? 0 : null,
    wins: M.league ? league?.wins ?? 0 : won,
    losses: M.league ? league?.losses ?? 0 : games.length - won,
    updated: new Date().toISOString(),
    splash: last ? DDRAGON_IDS[last] ?? last : null,
    remakes: remakes.slice(-300),
    games,
  };
  if (!prev || content(prev) !== content(data)) {
    writeFileSync(file, JSON.stringify(data));
    console.log(`${riotId} [${mode}]: ${data.tier} ${data.division} ${data.lp ?? ""}, ${games.length} partidas (+${fresh.length})`);
  } else {
    console.log(`${riotId} [${mode}]: sin cambios`);
  }
  return data;
}

async function updatePlayer({ gameName, tagLine }) {
  const riotId = `${gameName}#${tagLine}`;
  const slug = slugOf(riotId);
  const account = await riot(REGIONAL, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
  if (!account) throw new Error(`no existe la cuenta ${riotId}`);
  const ctx = { riotId, slug, puuid: account.puuid, entries: await riot(PLATFORM, `/lol/league/v4/entries/by-puuid/${account.puuid}`) };
  const solo = await updateMode("solo", ctx);
  for (const mode of ["flex", "normal"]) await updateMode(mode, ctx);
  return { riotId, slug, tier: solo.tier, division: solo.division, lp: solo.lp };
}

mkdirSync(DATA, { recursive: true });
const players = readJson(join(ROOT, "jugadores.json"), []);
const index = [];
let failed = 0;
// SOLO=<slug> actualiza solo esa cuenta (al agregar una nueva); las demás se toman como están.
const ONLY = process.env.SOLO;
for (const p of players) {
  const saved = readJson(join(DATA, `${slugOf(`${p.gameName}#${p.tagLine}`)}.json`), null);
  if (ONLY && slugOf(`${p.gameName}#${p.tagLine}`) !== ONLY) {
    if (saved) index.push({ riotId: saved.riotId, slug: saved.slug, tier: saved.tier, division: saved.division, lp: saved.lp });
    continue;
  }
  try {
    index.push(await updatePlayer(p));
  } catch (err) {
    failed++;
    console.error(`${p.gameName}#${p.tagLine}: ${err.message}`);
    if (err.fatal) process.exit(1);
    if (saved) index.push({ riotId: saved.riotId, slug: saved.slug, tier: saved.tier, division: saved.division, lp: saved.lp });
  }
}

const indexFile = join(DATA, "jugadores.json");
const indexJson = JSON.stringify(index, null, 2);
if (!existsSync(indexFile) || readFileSync(indexFile, "utf8") !== indexJson) writeFileSync(indexFile, indexJson);
console.log(`${requests} requests${failed ? `, ${failed} jugador(es) con error` : ""}`);
