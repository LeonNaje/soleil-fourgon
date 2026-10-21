/* Alerte solaire du matin : prévisions Open-Meteo -> bilan batterie -> notification ntfy.
   Lancé chaque jour par GitHub Actions (voir alerte.yml). Utilise calc.js et config.json. */
"use strict";
const fs = require("fs");
const path = require("path");
const C = require("./calc.js");

const DEF = { pw: 300, pr: 0.75, tilt: 45, az: 0, ah: 100, nb: 1, volt: 12.8, use: 90, conso: 400, soc0: 80, seuil: 20, gust: 50, gustBas: 40, scen: "flat" };
const NOMS = { flat: "panneau à plat", tilt: "panneau incliné", track: "tracker 2 axes" };

const fmtJour = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
const nomJour = (j) => fmtJour.format(new Date(j + "T12:00:00Z"));
const wh = (v) => Math.round(v).toLocaleString("fr-FR") + " Wh";

async function envoyer(topic, titre, message, priorite, tags) {
  const r = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: topic, title: titre, message: message, priority: priorite, tags: tags }),
  });
  if (!r.ok) throw new Error("ntfy : réponse HTTP " + r.status);
}

async function main() {
  const topic = process.env.NTFY_TOPIC;
  const test = process.env.EVENT_NAME === "workflow_dispatch";
  if (!topic) throw new Error("NTFY_TOPIC manquant : le secret GitHub n’est pas défini.");

  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const lieu = cfg.lieu || {};
  if (!Number.isFinite(lieu.latitude) || !Number.isFinite(lieu.longitude)) {
    throw new Error("config.json : lieu manquant. Copie la config depuis la page et colle-la dans config.json.");
  }
  const S = Object.assign({}, DEF, cfg.reglages || {});
  if (!NOMS[S.scen]) S.scen = "flat";

  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lieu.latitude + "&longitude=" + lieu.longitude
    + "&hourly=shortwave_radiation,direct_normal_irradiance,diffuse_radiation,global_tilted_irradiance,wind_gusts_10m"
    + "&tilt=" + S.tilt + "&azimuth=" + S.az + "&wind_speed_unit=kmh&forecast_days=7&timezone=auto";
  const r = await fetch(url);
  if (!r.ok) throw new Error("Open-Meteo : réponse HTTP " + r.status);
  const json = await r.json();
  if (!json.hourly || !json.hourly.time) throw new Error("Open-Meteo : réponse vide.");

  const jours = C.calculer(json, S, lieu);

  // Bilan de batterie : un solde par jour, en partant de la charge supposée ce matin (soc0).
  const cap = S.ah * S.nb * S.volt * S.use / 100;
  let soc = cap * S.soc0 / 100;
  const pct = jours.map((j) => {
    soc = Math.min(cap, Math.max(0, soc + j[S.scen] - S.conso));
    return soc / cap * 100;
  });
  const iRisque = pct.findIndex((p) => p < S.seuil);
  const risque = iRisque >= 0;

  const lignes = [];
  lignes.push("Lieu : " + (lieu.nom || "?") + " (" + NOMS[S.scen] + ")");
  lignes.push("Aujourd’hui : " + wh(jours[0][S.scen]) + " prévus pour " + wh(S.conso) + " consommés.");
  jours.slice(1, 4).forEach((j) => lignes.push(nomJour(j.jour) + " : " + wh(j[S.scen])));
  if (S.scen === "track" && jours[0].couche > 0) {
    lignes.push("Vent : tracker à plat environ " + jours[0].couche.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " h aujourd’hui.");
  }
  if (risque) {
    lignes.push("Risque : en partant de " + S.soc0 + " % ce matin, la batterie descendrait à "
      + Math.round(pct[iRisque]) + " % le " + nomJour(jours[iRisque].jour) + " (seuil " + S.seuil + " %).");
    if (iRisque >= 5) lignes.push("Prévision peu fiable à cette échéance.");
  } else {
    lignes.push("Pas de risque sur 7 jours (charge minimale prévue : " + Math.round(Math.min.apply(null, pct)) + " %).");
  }

  const titre = (test ? "Test : " : "") + (risque ? "Batterie à risque" : "Soleil du fourgon");
  await envoyer(topic, titre, lignes.join("\n"), risque ? 4 : 3, [risque ? "warning" : "sunny"]);
  console.log("Notification envoyée (risque : " + (risque ? "oui" : "non") + ").");
}

main().catch(async (e) => {
  console.error("Erreur : " + e.message);
  try {
    if (process.env.NTFY_TOPIC) await envoyer(process.env.NTFY_TOPIC, "Alerte solaire en panne", e.message, 3, ["x"]);
  } catch (e2) { /* rien de plus à faire */ }
  process.exitCode = 1;
});
