/* Calculs solaires partagés : utilisés par la page (navigateur) et, plus tard, par le script d'alerte (Node). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SoleilCalc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Hauteur du soleil en degrés (formules NOAA simplifiées). ms = instant en UTC. */
  function elevation(lat, lon, ms) {
    const rad = Math.PI / 180, d = new Date(ms);
    const doy = Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
    const hr = d.getUTCHours() + d.getUTCMinutes() / 60;
    const g = 2 * Math.PI / 365 * (doy - 1 + (hr - 12) / 24);
    const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const ha = ((hr * 60 + eq + 4 * lon) / 4 - 180) * rad;
    const s = Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha);
    return Math.asin(Math.max(-1, Math.min(1, s))) / rad;
  }

  /* json : réponse Open-Meteo (hourly + utc_offset_seconds)
     S    : réglages {pw, pr, gust, ...}   lieu : {latitude, longitude}
     Retourne un tableau de jours : {jour, flat, tilt, track, couche}
       flat/tilt/track en Wh ; couche = heures de jour où le tracker est couché à cause du vent (décimal). */
  function calculer(json, S, lieu) {
    const h = json.hourly, off = json.utc_offset_seconds || 0;
    const k = S.pw * S.pr / 1000;
    const rafales = h.wind_gusts_10m || null;
    const gb = S.gustBas == null ? S.gust : S.gustBas;      // seuil de relevage
    const delai = S.delai == null ? 20 : S.delai;           // minutes avant de se relever
    let bas = false;                                        // le tracker est-il couché ?
    const par = {};
    h.time.forEach(function (t, i) {
      const jour = t.slice(0, 10);
      const utc = Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10), +t.slice(11, 13), +t.slice(14, 16)) - off * 1000;
      const el = elevation(lieu.latitude, lieu.longitude, utc - 1800000); // milieu de l'heure écoulée
      const ghi = Math.max(0, h.shortwave_radiation[i] || 0);
      const gti = Math.max(0, h.global_tilted_irradiance[i] || 0);
      const dni = Math.max(0, h.direct_normal_irradiance[i] || 0);
      const dif = Math.max(0, h.diffuse_radiation[i] || 0);
      const vent = rafales ? (rafales[i] || 0) : 0;
      // part = fraction de l'heure où le tracker travaille (1 = toute l'heure, 0 = couché)
      let part = 1;
      if (vent > S.gust) { bas = true; part = 0; }
      else if (bas) {
        if (vent >= gb) part = 0;                           // reste couché tant que ça souffle
        else { bas = false; part = Math.max(0, (60 - delai) / 60); } // se relève après le délai
      }
      let suivi = 0;
      if (el > 0) {
        // Par ciel couvert, le tracker revient à plat : on prend le meilleur des deux.
        const normal = Math.max(ghi, dni + dif * (1 + Math.sin(el * Math.PI / 180)) / 2);
        suivi = part * normal + (1 - part) * ghi;
      }
      const j = par[jour] || (par[jour] = { jour: jour, flat: 0, tilt: 0, track: 0, couche: 0 });
      j.flat += ghi * k; j.tilt += gti * k; j.track += suivi * k;
      if (el > 0) j.couche += 1 - part;
    });
    return Object.keys(par).map(function (c) { return par[c]; });
  }

  /* Cap boussole (0 = nord, 90 = est, 180 = sud, 270 = ouest)
     -> azimut attendu par Open-Meteo (0 = sud, -90 = est, 90 = ouest). */
  function azimutApi(cap) { return cap - 180; }

  return { elevation: elevation, calculer: calculer, azimutApi: azimutApi };
});
